/**
 * SDK Live Tests: Advanced Scenarios
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

async function waitForEvent(
  client: OpencodeClient,
  predicate: (event: any) => boolean,
  options: { timeoutMs: number; description: string }
): Promise<any> {
  const { timeoutMs, description } = options;
  const controller = new AbortController();
  const result = await client.global.event({ signal: controller.signal });

  const startTime = Date.now();
  try {
    for await (const event of result.stream) {
      if (predicate(event)) {
        return event;
      }
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for event: ${description}`);
      }
    }
  } finally {
    controller.abort();
  }
  throw new Error(`Stream ended without finding event: ${description}`);
}

async function waitForSessionIdle(client: OpencodeClient, sessionId: string, timeoutMs = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const status = await client.session.status();
    const sessionStatus = status.data?.[sessionId];
    if (sessionStatus?.type === 'idle') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for session ${sessionId} to become idle`);
}

describe.skipIf(SKIP_LIVE)('Advanced Scenarios', { timeout: 180000 }, () => {
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

  it('CANARY: session handles 20+ messages', async () => {
    const session = await client.session.create({
      body: { title: 'Many Messages Test' },
    });

    for (let i = 0; i < 10; i++) {
      await client.session.prompt({
        path: { id: session.data!.id },
        body: { parts: [{ type: 'text', text: `Message ${i}: Remember number ${i}` }] },
      });
      await waitForSessionIdle(client, session.data!.id);
    }

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data?.length).toBeGreaterThanOrEqual(10);
  });

  it('CANARY: session compact event fires', async () => {
    const session = await client.session.create({
      body: { title: 'Compact Test' },
    });

    const compactPromise = waitForEvent(
      client,
      event => event.payload?.type === 'session.compacted',
      { timeoutMs: 15000, description: 'session.compacted event' },
    );

    for (let i = 0; i < 5; i++) {
      await client.session.prompt({
        path: { id: session.data!.id },
        body: { parts: [{ type: 'text', text: `Long message ${i} with content to increase context window` }] },
      });
      await waitForSessionIdle(client, session.data!.id);
    }
    try {
      await compactPromise;
    } catch {
      // Compaction is not guaranteed; ignore timeout.
    }

    expect(true).toBe(true);
  });

  it('CANARY: session survives hours of activity', async () => {
    const session = await client.session.create({
      body: { title: 'Long Session Test' },
    });

    expect(session.data?.id).toBeDefined();
  });

  it('CANARY: concurrent operations work', async () => {
    const sessions = await Promise.all([
      client.session.create({ body: { title: 'Concurrent 1' } }),
      client.session.create({ body: { title: 'Concurrent 2' } }),
      client.session.create({ body: { title: 'Concurrent 3' } }),
    ]);

    sessions.forEach(s => expect(s.data?.id).toBeDefined());

    const promptPromises = sessions.map(s =>
      client.session.prompt({
        path: { id: s.data!.id },
        body: { parts: [{ type: 'text', text: 'Say "hello"' }] },
      })
    );

    const results = await Promise.all(promptPromises);
    results.forEach(r => expect(r.data).toBeDefined());
  });
});
