/**
 * SDK Live Tests: Basic Text Prompt
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

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

describe.skipIf(SKIP_LIVE)('Text Prompt', { timeout: 120000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    server = opencode.server;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: session.prompt() with text succeeds', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello" and nothing else.' }] },
    });

    expect(result.data).toBeDefined();
  });

  it('CANARY: message.updated event received', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    const eventPromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'message.updated' &&
        event.payload?.properties?.info?.sessionID === session.data!.id,
      { timeoutMs: 20000, description: 'message.updated event' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    const event = await eventPromise;
    expect(event.payload?.type).toBe('message.updated');
  });

  it('CANARY: session.idle event received on completion', async () => {
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

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    const event = await idlePromise;
    expect(event.payload?.type).toBe('session.idle');
  });
});
