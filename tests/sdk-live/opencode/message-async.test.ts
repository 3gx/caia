/**
 * SDK Live Tests: Async Prompting
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

describe.skipIf(SKIP_LIVE)('Async Prompting', { timeout: 60000 }, () => {
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

  it('CANARY: session.promptAsync() returns immediately', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    const startTime = Date.now();
    const result = await client.session.promptAsync({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    const endTime = Date.now();

    expect(result.data).toBeDefined();
    expect(endTime - startTime).toBeLessThan(1000);
  });

  it('CANARY: async prompt can be monitored via events', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    const idlePromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 20000, description: 'session.idle event' },
    );

    await client.session.promptAsync({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });

    const event = await idlePromise;
    expect(event.payload?.type).toBe('session.idle');
  });
});
