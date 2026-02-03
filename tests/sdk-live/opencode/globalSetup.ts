/**
 * Global setup for OpenCode SDK tests
 *
 * Creates a SharedArrayBuffer for atomic port allocation across worker threads.
 * Uses Vitest's provide/inject to share the buffer with all test files.
 */
import { GlobalSetupContext } from 'vitest/node';

const sharedBuffer = new SharedArrayBuffer(4);
const BASE_PORT = parseInt(process.env.VITEST_OPENCODE_PORT || '60000', 10);

export default function setup({ provide }: GlobalSetupContext) {
  provide('portCounter', sharedBuffer);
  provide('basePort', BASE_PORT);
}
