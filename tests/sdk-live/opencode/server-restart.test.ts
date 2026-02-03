/**
 * SDK Live Tests: Server Restart
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, inject } from 'vitest';
import { createOpencode } from '@opencode-ai/sdk';
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
    const testPort = basePort + Atomics.add(counter, 0, 1);

    // Start first server
    const { server: server1 } = await createOpencode({ port: testPort });
    expect(server1.url).toMatch(new RegExp(`:${testPort}`));

    // Close first server
    server1.close();

    // Wait for port to be released
    await waitForPortAvailable(testPort, 5000);

    // Start second server on same port
    const { server: server2 } = await createOpencode({ port: testPort });
    expect(server2.url).toMatch(new RegExp(`:${testPort}`));

    // Clean up
    server2.close();
  });
});
