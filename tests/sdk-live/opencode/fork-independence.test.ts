/**
 * SDK Live Tests: Fork Independence
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Fork - Independence', { timeout: 120000 }, () => {
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

  it('CANARY: forked session is independent', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Base message' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messages.data![0].info.id },
    });
    opencode.trackSession(fork.data!.id);

    const parentStatus = await client.session.get({ path: { id: parent.data!.id } });
    const forkStatus = await client.session.get({ path: { id: fork.data!.id } });

    expect(parentStatus.data).toBeDefined();
    expect(forkStatus.data).toBeDefined();
  });

  it('CANARY: parent changes do not affect fork', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Base' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messages.data![0].info.id },
    });
    opencode.trackSession(fork.data!.id);

    const forkMsgCountBefore = (await client.session.messages({ path: { id: fork.data!.id } })).data!.length;

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'New parent message' }] },
    });
    // prompt() blocks until completion

    const forkMsgCountAfter = (await client.session.messages({ path: { id: fork.data!.id } })).data!.length;

    expect(forkMsgCountAfter).toBe(forkMsgCountBefore);
  });

  it('CANARY: fork can be deleted independently', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Base' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messages.data![0].info.id },
    });
    // Don't track fork - this test deletes it manually

    await client.session.delete({ path: { id: fork.data!.id } });

    const parentStatus = await client.session.get({ path: { id: parent.data!.id } });
    expect(parentStatus.data).toBeDefined();

    const forkStatus = await client.session.get({ path: { id: fork.data!.id } });
    expect(forkStatus.error).toBeDefined();
  });
});
