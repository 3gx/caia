/**
 * SDK Live Tests: Concurrent Sessions
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Concurrent Sessions', { timeout: 120000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = basePort + Atomics.add(counter, 0, 1);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    server = opencode.server;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: multiple sessions can run in parallel', async () => {
    const sessions = await Promise.all([
      client.session.create({ body: { title: 'Session 1' } }),
      client.session.create({ body: { title: 'Session 2' } }),
      client.session.create({ body: { title: 'Session 3' } }),
    ]);

    expect(sessions).toHaveLength(3);
    sessions.forEach(s => expect(s.data?.id).toBeDefined());
  });

  it('CANARY: 10 concurrent sessions work correctly', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      client.session.create({ body: { title: `Session ${i}` } })
    );

    const sessions = await Promise.all(promises);
    expect(sessions).toHaveLength(10);
  });
});
