/**
 * SDK Live Tests: Message ID mapping survives CLI session usage
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

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

describe.skipIf(SKIP_LIVE)('Fork - Cross-Platform Message ID', { timeout: 180000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: message ID mapping survives CLI session usage', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Message ID Mapping Test` },
    });
    opencode.trackSession(session.data!.id);

    const capturePromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'message.updated' &&
        event.payload?.properties?.info?.sessionID === session.data!.id,
      { timeoutMs: 20000, description: 'message.updated event' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Capture this message ID' }] },
    });

    let capturedMessageId: string | null = null;
    try {
      const capturedEvent = await capturePromise;
      capturedMessageId = capturedEvent?.payload?.properties?.info?.id ?? null;
    } catch {
      // Fallback to messages if no event captured.
    }

    if (!capturedMessageId) {
      const messages = await client.session.messages({ path: { id: session.data!.id } });
      capturedMessageId = messages.data?.[0]?.info.id || null;
    }

    expect(capturedMessageId).toBeDefined();

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'CLI message' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const foundMessage = messages.data?.find(m => m.info.id === capturedMessageId);

    expect(foundMessage).toBeDefined();

    const fork = await client.session.fork({
      path: { id: session.data!.id },
      body: { messageID: capturedMessageId! },
    });
    opencode.trackSession(fork.data!.id);

    expect(fork.data?.id).toBeDefined();
  });
});
