/**
 * Global setup for OpenCode SDK tests
 *
 * Creates a SharedArrayBuffer for atomic port allocation across worker threads.
 * Uses Vitest's provide/inject to share the buffer with all test files.
 * Registers SIGINT handler for cleanup on ctrl-c.
 */
import { GlobalSetupContext } from 'vitest/node';
import { cleanupAllRegisteredServers, clearRegistry } from './test-helpers.js';

const sharedBuffer = new SharedArrayBuffer(4);
const BASE_PORT = parseInt(process.env.VITEST_OPENCODE_PORT || '60000', 10);

// Track if cleanup has been run to avoid double cleanup
let cleanupDone = false;

async function handleSignal(signal: string) {
  if (cleanupDone) return;
  cleanupDone = true;

  console.log(`\n[globalSetup] Received ${signal}, cleaning up test servers...`);
  await cleanupAllRegisteredServers();
  console.log('[globalSetup] Cleanup complete');
  process.exit(1);
}

export default function setup({ provide }: GlobalSetupContext) {
  // Clear registry at start of test run
  clearRegistry();

  // Register signal handlers for cleanup on ctrl-c or termination
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  provide('portCounter', sharedBuffer);
  provide('basePort', BASE_PORT);
}
