/**
 * SDK Live Tests: Cross-Platform Fork (Bot → CLI → Bot)
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

describe.skipIf(SKIP_LIVE)('Fork - Cross-Platform', { timeout: 180000 }, () => {
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

  it('CANARY: bot messages forkable after CLI resume', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Cross-Platform Test` },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Remember A=1111' }] },
    });
    // prompt() blocks until completion

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Remember B=2222' }] },
    });
    // prompt() blocks until completion

    const botMessages = await client.session.messages({ path: { id: session.data!.id } });
    const assistantMsgs = botMessages.data?.filter(m => m.info.role === 'assistant');
    const forkPointId = assistantMsgs?.[1]?.info.id || assistantMsgs?.[0]?.info.id;

    expect(forkPointId).toBeDefined();

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Remember C=3333 (from CLI)' }] },
    });
    // prompt() blocks until completion

    const fork = await client.session.fork({
      path: { id: session.data!.id },
      body: { messageID: forkPointId! },
    });
    opencode.trackSession(fork.data!.id);

    expect(fork.data?.id).toBeDefined();

    const forkMessages = await client.session.messages({ path: { id: fork.data!.id } });

    await client.session.prompt({
      path: { id: fork.data!.id },
      body: { parts: [{ type: 'text', text: 'List all values you remember (A, B, C)' }] },
    });
    // prompt() blocks until completion

    const checkMessages = await client.session.messages({ path: { id: fork.data!.id } });
    const assistantResponses = checkMessages.data?.filter(m => m.info.role === 'assistant');
    const lastAssistant = assistantResponses?.[assistantResponses.length - 1];

    const content = JSON.stringify(lastAssistant);
    expect(content).toContain('1111');
    expect(content).toContain('2222');
  });

  it('CANARY: early bot messages forkable after extended CLI usage', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Extended CLI Test` },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Bot message 1: X=10' }] },
    });
    // prompt() blocks until completion

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Bot message 2: Y=20' }] },
    });
    // prompt() blocks until completion

    const botMessages = await client.session.messages({ path: { id: session.data!.id } });
    const botMsg2Id = botMessages.data?.[1]?.info.id || botMessages.data?.[0]?.info.id;

    for (let i = 0; i < 5; i++) {
      await client.session.prompt({
        path: { id: session.data!.id },
        body: { parts: [{ type: 'text', text: `CLI message ${i}: Z${i}=${i * 100}` }] },
      });
      // prompt() blocks until completion
    }

    const fork = await client.session.fork({
      path: { id: session.data!.id },
      body: { messageID: botMsg2Id! },
    });
    opencode.trackSession(fork.data!.id);

    expect(fork.data?.id).toBeDefined();

    const parentMessages = await client.session.messages({ path: { id: session.data!.id } });
    const forkMessages = await client.session.messages({ path: { id: fork.data!.id } });
    expect(forkMessages.data!.length).toBeLessThan(parentMessages.data!.length);
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

  it('CANARY: fork button works after user switches between CLI and bot', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Fork Button Test` },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Bot: A=1' }] },
    });
    // prompt() blocks until completion

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Bot: B=2' }] },
    });
    // prompt() blocks until completion

    const botMsgs = await client.session.messages({ path: { id: session.data!.id } });
    const forkBtnMsgId = botMsgs.data?.[1]?.info.id || botMsgs.data?.[0]?.info.id;

    for (let i = 0; i < 3; i++) {
      await client.session.prompt({
        path: { id: session.data!.id },
        body: { parts: [{ type: 'text', text: `CLI: C${i}=${i}` }] },
      });
      // prompt() blocks until completion
    }

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Bot: D=4 (fork point)' }] },
    });
    // prompt() blocks until completion

    for (let i = 0; i < 2; i++) {
      await client.session.prompt({
        path: { id: session.data!.id },
        body: { parts: [{ type: 'text', text: `CLI: E${i}=${i}` }] },
      });
      // prompt() blocks until completion
    }

    const fork = await client.session.fork({
      path: { id: session.data!.id },
      body: { messageID: forkBtnMsgId! },
    });
    opencode.trackSession(fork.data!.id);

    expect(fork.data?.id).toBeDefined();

    const forkMsgs = await client.session.messages({ path: { id: fork.data!.id } });
    expect(forkMsgs.data!.length).toBeGreaterThan(0);
  });
});
