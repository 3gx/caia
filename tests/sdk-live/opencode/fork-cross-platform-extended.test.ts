/**
 * SDK Live Tests: Early bot messages forkable after extended CLI usage
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Fork - Cross-Platform Extended', { timeout: 180000 }, () => {
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
});
