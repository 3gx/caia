/**
 * Test helpers for OpenCode SDK tests
 *
 * Provides safe process cleanup by tracking PIDs at server creation time.
 * Uses port-busy check to avoid killing unrelated processes.
 * Uses file-based registry for cleanup on SIGINT (ctrl-c).
 */
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Session title prefix for easy identification.
 * Use: `opencode session list | grep vitest-opencode`
 */
export const TEST_SESSION_PREFIX = 'vitest-opencode-';

/**
 * Registry file for tracking active test servers.
 * Uses PID to avoid collisions between parallel test runs.
 */
const REGISTRY_FILE = path.join(__dirname, `.test-cleanup-registry.${process.pid}.json`);

interface RegistryEntry {
  port: number;
  pids: number[];
  sessionIds: string[];
}

function readRegistry(): RegistryEntry[] {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch {
    // Ignore read errors
  }
  return [];
}

function writeRegistry(entries: RegistryEntry[]): void {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
  } catch {
    // Ignore write errors
  }
}

function addToRegistry(entry: RegistryEntry): void {
  const entries = readRegistry();
  entries.push(entry);
  writeRegistry(entries);
}

function updateRegistrySessionIds(port: number, sessionIds: string[]): void {
  const entries = readRegistry();
  const entry = entries.find(e => e.port === port);
  if (entry) {
    entry.sessionIds = sessionIds;
    writeRegistry(entries);
  }
}

function removeFromRegistry(port: number): void {
  const entries = readRegistry().filter(e => e.port !== port);
  writeRegistry(entries);
}

/**
 * Clean up all registered servers. Called by globalSetup on SIGINT.
 * NOTE: Only kills processes. Sessions cannot be deleted via CLI.
 * Sessions with 'vitest-opencode-' prefix can be identified and cleaned manually.
 */
export async function cleanupAllRegisteredServers(): Promise<void> {
  const entries = readRegistry();

  // Kill all PIDs
  for (const entry of entries) {
    for (const pid of entry.pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may already be dead
      }
    }
  }

  // Clear registry
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      fs.unlinkSync(REGISTRY_FILE);
    }
  } catch {
    // Ignore
  }
}

/**
 * Clear the registry file. Called at start of test run.
 */
export function clearRegistry(): void {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      fs.unlinkSync(REGISTRY_FILE);
    }
  } catch {
    // Ignore
  }
}

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
   * Track a session ID for cleanup.
   * Call this after creating a session to ensure it gets deleted during cleanup.
   */
  trackSession: (sessionId: string) => void;
  /**
   * Clean up the server AND its spawned processes.
   * Deletes only sessions that were tracked via trackSession().
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

  // Track session IDs created by this test instance
  const trackedSessionIds: string[] = [];

  // Register in file-based registry for SIGINT cleanup
  addToRegistry({ port, pids: trackedPids, sessionIds: [] });

  return {
    client: result.client,
    server: result.server,
    port,
    trackSession: (sessionId: string) => {
      trackedSessionIds.push(sessionId);
      // Update registry with session IDs for SIGINT cleanup
      updateRegistrySessionIds(port, trackedSessionIds);
    },
    cleanup: async () => {
      // Delete only OUR tracked sessions - safe for parallel tests
      for (const sessionId of trackedSessionIds) {
        try {
          await result.client.session.delete({ path: { id: sessionId } });
        } catch {
          // Session may already be deleted
        }
      }

      // Try graceful close
      result.server.close();

      // Give it a moment to close gracefully
      await new Promise(resolve => setTimeout(resolve, 100));

      // Then kill our tracked PIDs (the SDK doesn't do this)
      trackedPids.forEach(pid => killPid(pid));

      // Remove from registry - cleanup completed normally
      removeFromRegistry(port);
    },
  };
}
