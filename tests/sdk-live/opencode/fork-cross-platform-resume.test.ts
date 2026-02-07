/**
 * SDK Live Tests: Bot messages forkable after CLI resume
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Fork - Cross-Platform Resume', { timeout: 180000 }, () => {
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
});
