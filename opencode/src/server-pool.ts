import { execSync } from 'child_process';
import { OpencodeClientWrapper } from './opencode-client.js';

export interface ServerInstance {
  client: OpencodeClientWrapper;
  server: { url: string; close(): void };
  createdAt: number;
  lastUsedAt: number;
  healthCheckTimer?: NodeJS.Timeout;
  channelId: string;
  restartAttempts: number;
  refCount: number;
  channelIds: Set<string>;
}

const DEFAULT_BASE_PORT = parseInt(process.env.OPENCODE_PORT_BASE || '60000', 10);
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HEALTH_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_RESTARTS = 3;

function isPortBusy(port: number): boolean {
  try {
    const output = execSync(`lsof -ti:${port} 2>/dev/null || echo ""`, { encoding: 'utf-8' });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function findFreePort(counter: Int32Array, basePort: number, maxAttempts = 100): number {
  for (let i = 0; i < maxAttempts; i += 1) {
    const port = basePort + Atomics.add(counter, 0, 1);
    if (!isPortBusy(port)) {
      return port;
    }
  }
  throw new Error(`Could not find free port after ${maxAttempts} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ServerPool {
  private instances = new Map<string, ServerInstance>();
  private portCounter = new Int32Array(new SharedArrayBuffer(4));
  private basePort = DEFAULT_BASE_PORT;
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  private healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS;
  private maxRestartAttempts = DEFAULT_MAX_RESTARTS;

  async getOrCreate(channelId: string): Promise<ServerInstance> {
    const existing = this.instances.get(channelId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const port = findFreePort(this.portCounter, this.basePort);
    const client = new OpencodeClientWrapper();
    await client.start(port);

    const instance: ServerInstance = {
      client,
      server: client.getServer(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      channelId,
      restartAttempts: 0,
      refCount: 1,
      channelIds: new Set([channelId]),
    };

    this.instances.set(channelId, instance);
    this.startHealthChecks(instance);
    return instance;
  }

  attachChannel(channelId: string, instance: ServerInstance): void {
    if (this.instances.has(channelId)) {
      return;
    }
    instance.channelIds.add(channelId);
    instance.refCount += 1;
    this.instances.set(channelId, instance);
    instance.lastUsedAt = Date.now();
  }

  async shutdown(channelId: string): Promise<void> {
    const instance = this.instances.get(channelId);
    if (!instance) return;

    this.instances.delete(channelId);
    instance.channelIds.delete(channelId);
    instance.refCount = Math.max(0, instance.refCount - 1);

    if (instance.refCount > 0) {
      return;
    }

    await this.shutdownInstance(instance);
  }

  async shutdownAll(): Promise<void> {
    const uniqueInstances = new Set(this.instances.values());
    this.instances.clear();
    for (const instance of uniqueInstances) {
      await this.shutdownInstance(instance);
    }
  }

  private startHealthChecks(instance: ServerInstance): void {
    instance.healthCheckTimer = setInterval(async () => {
      // Idle timeout
      if (Date.now() - instance.lastUsedAt > this.idleTimeoutMs) {
        console.log(`[opencode] Shutting down idle server for ${instance.channelId}`);
        await this.shutdownInstance(instance);
        return;
      }

      // Health check
      const healthy = await instance.client.healthCheck();
      if (!healthy) {
        await this.handleCrash(instance.channelId, new Error('Health check failed'));
      }
    }, this.healthIntervalMs);
  }

  private async handleCrash(channelId: string, error: Error): Promise<void> {
    const instance = this.instances.get(channelId);
    if (!instance) return;

    instance.restartAttempts += 1;
    const attempt = instance.restartAttempts;
    if (attempt > this.maxRestartAttempts) {
      console.error(`[opencode] Server restart failed (${attempt}/${this.maxRestartAttempts}):`, error);
      await this.shutdown(channelId);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    console.warn(`[opencode] Server crash detected, restarting in ${delay}ms (attempt ${attempt})`);
    await sleep(delay);

    try {
      await instance.client.restart();
      instance.restartAttempts = 0;
      instance.lastUsedAt = Date.now();
    } catch (restartError) {
      console.error('[opencode] Failed to restart server:', restartError);
    }
  }

  private async shutdownInstance(instance: ServerInstance): Promise<void> {
    if (instance.healthCheckTimer) {
      clearInterval(instance.healthCheckTimer);
    }
    try {
      await instance.client.stop();
    } finally {
      // Remove all channel mappings for this instance
      for (const id of instance.channelIds) {
        this.instances.delete(id);
      }
      instance.channelIds.clear();
    }
  }
}
