/**
 * SDK Live Tests: Message Retrieval
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Message Retrieval', { timeout: 120000 }, () => {
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

  it('CANARY: session.message() gets specific message', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion

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
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const assistantMsg = messages.data?.find(m => m.info.role === 'assistant');

    // Token usage is on assistant messages
    if (assistantMsg?.info.role === 'assistant') {
      expect(assistantMsg.info.tokens).toBeDefined();
      expect(assistantMsg.info.tokens?.input).toBeGreaterThan(0);
    }
  });
});
