/**
 * Test helpers for OpenCode SDK tests
 *
 * Provides safe process cleanup by tracking PIDs at server creation time.
 */
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';
import { execSync } from 'child_process';

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

export interface OpencodeTestServer {
  client: OpencodeClient;
  server: { close(): void; url: string };
  /**
   * Clean up the server AND its spawned processes.
   * This is necessary because server.close() doesn't terminate the child process.
   */
  cleanup: () => Promise<void>;
}

/**
 * Create an OpenCode server with proper cleanup.
 *
 * The SDK's server.close() doesn't kill the spawned process, leaving orphans.
 * This wrapper tracks the PIDs at creation time and kills them on cleanup.
 *
 * IMPORTANT: Only use cleanup() - don't call server.close() directly.
 */
export async function createOpencodeWithCleanup(port: number): Promise<OpencodeTestServer> {
  const result = await createOpencode({ port });

  // Wait a moment for the process to fully spawn
  await new Promise(resolve => setTimeout(resolve, 100));

  // Capture PIDs immediately after creation - these are OUR processes
  const trackedPids = findPidsOnPort(port);

  return {
    client: result.client,
    server: result.server,
    cleanup: async () => {
      // First try graceful close
      result.server.close();

      // Give it a moment to close gracefully
      await new Promise(resolve => setTimeout(resolve, 100));

      // Then kill our tracked PIDs (the SDK doesn't do this)
      trackedPids.forEach(pid => killPid(pid));
    },
  };
}
