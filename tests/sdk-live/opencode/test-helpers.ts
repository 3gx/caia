/**
 * Test helpers for OpenCode SDK tests
 *
 * Provides safe process cleanup by tracking PIDs at server creation time.
 * Uses port-busy check to avoid killing unrelated processes.
 */
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';
import { execSync } from 'child_process';

/**
 * Check if a port is busy (has any process listening on it).
 */
function isPortBusy(port: number): boolean {
  try {
    const output = execSync(`lsof -ti:${port} 2>/dev/null || echo ""`, { encoding: 'utf-8' });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Find PIDs listening on a specific port.
 * Returns an array of PIDs (may be multiple due to parent/child processes).
 */
function findPidsOnPort(port: number): number[] {
  try {
    const output = execSync(`lsof -ti:${port} 2>/dev/null || echo ""`, { encoding: 'utf-8' });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n));
  } catch {
    return [];
  }
}

/**
 * Kill a specific PID with SIGTERM (graceful).
 */
function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may already be dead
  }
}

/**
 * Find a free port using atomic increment.
 * Skips ports that are already in use.
 */
export function findFreePort(counter: Int32Array, basePort: number, maxAttempts = 100): number {
  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + Atomics.add(counter, 0, 1);
    if (!isPortBusy(port)) {
      return port;
    }
    // Port is busy, loop will try next port
  }
  throw new Error(`Could not find free port after ${maxAttempts} attempts`);
}

export interface OpencodeTestServer {
  client: OpencodeClient;
  server: { close(): void; url: string };
  port: number;
  /**
   * Clean up the server AND its spawned processes.
   * NOTE: Sessions are NOT automatically deleted because parallel tests
   * share session storage and cleanup would cause race conditions.
   */
  cleanup: () => Promise<void>;
}

/**
 * Create an OpenCode server with proper cleanup.
 *
 * The SDK's server.close() doesn't kill the spawned process, leaving orphans.
 * This wrapper tracks the PIDs at creation time and kills them on cleanup.
 *
 * SAFETY: We verify the port is FREE before using it, so any PIDs found
 * after server creation are guaranteed to be ours.
 *
 * IMPORTANT: Only use cleanup() - don't call server.close() directly.
 */
export async function createOpencodeWithCleanup(port: number): Promise<OpencodeTestServer> {
  // Verify port is free - if not, caller should use findFreePort first
  if (isPortBusy(port)) {
    throw new Error(`Port ${port} is already in use. Use findFreePort() to get a free port.`);
  }

  const result = await createOpencode({ port });

  // Wait a moment for the process to fully spawn
  await new Promise(resolve => setTimeout(resolve, 100));

  // Capture PIDs - safe because we verified port was free before creating server
  const trackedPids = findPidsOnPort(port);

  return {
    client: result.client,
    server: result.server,
    port,
    cleanup: async () => {
      // NOTE: We do NOT delete sessions here because parallel tests share
      // session storage. Deleting sessions would cause race conditions.
      // Sessions can be cleaned up manually: opencode session list | xargs -I{} opencode session delete {}

      // Try graceful close
      result.server.close();

      // Give it a moment to close gracefully
      await new Promise(resolve => setTimeout(resolve, 100));

      // Then kill our tracked PIDs (the SDK doesn't do this)
      trackedPids.forEach(pid => killPid(pid));
    },
  };
}
