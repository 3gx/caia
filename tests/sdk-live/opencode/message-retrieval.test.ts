/**
 * SDK Live Tests: Message Retrieval
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

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

describe.skipIf(SKIP_LIVE)('Message Retrieval', { timeout: 120000 }, () => {
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

  it('CANARY: session.message() gets specific message', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, session.data!.id);

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const firstMessageId = messages.data?.[0]?.info.id;

    const retrieved = await client.session.message({
      path: { id: session.data!.id, messageID: firstMessageId! },
    });

    expect(retrieved.data?.info.id).toBe(firstMessageId);
  });

  it('CANARY: assistant message has token usage', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, session.data!.id);

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const assistantMsg = messages.data?.find(m => m.info.role === 'assistant');

    // Token usage is on assistant messages
    if (assistantMsg?.info.role === 'assistant') {
      expect(assistantMsg.info.tokens).toBeDefined();
      expect(assistantMsg.info.tokens?.input).toBeGreaterThan(0);
    }
  });
});
