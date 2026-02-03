/**
 * SDK Live Tests: Server Restart
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, inject } from 'vitest';
import { createOpencodeWithCleanup } from './test-helpers.js';
import net from 'net';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

async function waitForPortAvailable(port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const available = await new Promise<boolean>(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (available) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Port ${port} not available after ${timeoutMs}ms`);
}

describe.skipIf(SKIP_LIVE)('Server Restart', { timeout: 60000 }, () => {
  it('CANARY: server can be stopped and restarted', async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    const testPort = findFreePort(counter, basePort);

    // Start first server
    const opencode1 = await createOpencodeWithCleanup(testPort);
    expect(opencode1.server.url).toMatch(new RegExp(`:${testPort}`));

    // Close first server (with proper cleanup)
    await opencode1.cleanup();

    // Wait for port to be released
    await waitForPortAvailable(testPort, 5000);

    // Start second server on same port
    const opencode2 = await createOpencodeWithCleanup(testPort);
    expect(opencode2.server.url).toMatch(new RegExp(`:${testPort}`));

    // Clean up
    await opencode2.cleanup();
  });
});
