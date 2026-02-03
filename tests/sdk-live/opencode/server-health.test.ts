/**
 * SDK Live Tests: Server Health & Monitoring
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Server Health', { timeout: 60000 }, () => {
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = basePort + Atomics.add(counter, 0, 1);

    const result = await createOpencode({ port: testPort });
    client = result.client;
    server = result.server;
  });

  afterAll(() => {
    server.close();
  });

  it('CANARY: server responds to health checks', async () => {
    const result = await client.session.list();
    expect(result.data).toBeDefined();
  });

  it('CANARY: server survives idle periods', async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const result = await client.session.list();
    expect(result.data).toBeDefined();
  });

  it('CANARY: server handles concurrent requests', async () => {
    const promises = Array.from({ length: 5 }, () => client.session.list());
    const results = await Promise.all(promises);
    results.forEach(result => expect(result.data).toBeDefined());
  });
});
