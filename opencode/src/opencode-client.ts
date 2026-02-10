import { createOpencode, type OpencodeClient, type AssistantMessage } from '@opencode-ai/sdk';
import { execSync } from 'child_process';
import type { MessagePartInput, AgentType } from './types.js';
import { SessionEventStream } from './session-event-stream.js';

export interface PromptOptions {
  model?: { providerID: string; modelID: string };
  agent?: AgentType;
  system?: string;
  messageID?: string;
  noReply?: boolean;
  workingDir?: string;
}

export interface OpencodeServerInstance {
  client: OpencodeClient;
  server: { url: string; close(): void };
  port: number;
  trackedPids: number[];
}

function isPortBusy(port: number): boolean {
  try {
    const output = execSync(`lsof -ti:${port} 2>/dev/null || echo \"\"`, { encoding: 'utf-8' });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function findPidsOnPort(port: number): number[] {
  try {
    const output = execSync(`lsof -ti:${port} 2>/dev/null || echo \"\"`, { encoding: 'utf-8' });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s: string) => parseInt(s, 10))
      .filter((n: number) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore
  }
}

export class OpencodeClientWrapper {
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private port: number | null = null;
  private trackedPids: number[] = [];
  private eventStream: SessionEventStream | null = null;

  async start(port?: number): Promise<void> {
    if (this.client && this.server) {
      return;
    }

    if (port && isPortBusy(port)) {
      throw new Error(`Port ${port} is already in use`);
    }

    const result = await createOpencode(port ? { port } : undefined);
    this.client = result.client;
    this.server = result.server;
    this.port = port ?? null;

    if (port) {
      // Wait for server to spawn so lsof sees the process
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.trackedPids = findPidsOnPort(port);
    }

    this.eventStream = new SessionEventStream(this.client);
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    try {
      this.eventStream?.stop();
      this.server.close();
    } finally {
      // Give it a moment to close gracefully, then kill tracked PIDs
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const pid of this.trackedPids) {
        killPid(pid);
      }
      this.trackedPids = [];
      this.server = null;
      this.client = null;
      this.port = null;
      this.eventStream = null;
    }
  }

  async restart(): Promise<void> {
    const port = this.port ?? undefined;
    await this.stop();
    await this.start(port);
  }

  isHealthy(): boolean {
    return Boolean(this.client && this.server);
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.session.list();
      return true;
    } catch {
      return false;
    }
  }

  getClient(): OpencodeClient {
    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }
    return this.client;
  }

  getServer(): { url: string; close(): void } {
    if (!this.server) {
      throw new Error('OpenCode server not initialized');
    }
    return this.server;
  }

  getPort(): number | null {
    return this.port;
  }

  subscribeToEvents(callback: (event: any) => void): () => void {
    if (!this.eventStream) {
      throw new Error('Event stream not initialized');
    }
    return this.eventStream.subscribe(callback);
  }

  async createSession(title: string, workingDir: string, parentId?: string): Promise<string> {
    const client = this.getClient();
    const result = await client.session.create({
      body: { title, parentID: parentId },
      query: { directory: workingDir },
    });
    if (!result.data?.id) {
      throw new Error('Failed to create session');
    }
    return result.data.id;
  }

  async getSessionTitle(sessionId: string): Promise<string | null> {
    const client = this.getClient();
    try {
      const result = await client.session.get({ path: { id: sessionId } });
      return result.data?.title ?? null;
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string, workingDir?: string): Promise<void> {
    const client = this.getClient();
    await client.session.delete({
      path: { id: sessionId },
      query: workingDir ? { directory: workingDir } : undefined,
    });
  }

  async forkSession(sessionId: string, messageId: string, workingDir?: string): Promise<string> {
    const client = this.getClient();
    const result = await client.session.fork({
      path: { id: sessionId },
      body: { messageID: messageId },
      query: workingDir ? { directory: workingDir } : undefined,
    });
    if (!result.data?.id) {
      throw new Error('Failed to fork session');
    }
    return result.data.id;
  }

  async prompt(
    sessionId: string,
    parts: MessagePartInput[],
    options: PromptOptions = {}
  ): Promise<AssistantMessage> {
    const client = this.getClient();
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts,
        model: options.model,
        agent: options.agent,
        system: options.system,
        messageID: options.messageID,
        noReply: options.noReply,
      },
      query: options.workingDir ? { directory: options.workingDir } : undefined,
    });
    if (!result.data?.info) {
      throw new Error('Prompt did not return assistant message');
    }
    return result.data.info;
  }

  async promptAsync(
    sessionId: string,
    parts: MessagePartInput[],
    options: PromptOptions = {}
  ): Promise<void> {
    const client = this.getClient();
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts,
        model: options.model,
        agent: options.agent,
        system: options.system,
        messageID: options.messageID,
        noReply: options.noReply,
      },
      query: options.workingDir ? { directory: options.workingDir } : undefined,
    });
  }

  async abort(sessionId: string, workingDir?: string): Promise<void> {
    const client = this.getClient();
    await client.session.abort({
      path: { id: sessionId },
      query: workingDir ? { directory: workingDir } : undefined,
    });
  }

  async respondToPermission(sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject', workingDir?: string): Promise<void> {
    const client = this.getClient();
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
      query: workingDir ? { directory: workingDir } : undefined,
    });
  }
}
