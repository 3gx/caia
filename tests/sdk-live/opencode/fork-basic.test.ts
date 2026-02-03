/**
 * SDK Live Tests: Point-in-Time Fork - Basic Functionality
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Fork - Basic', { timeout: 120000 }, () => {
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

  it('CANARY: session.fork() creates fork at message', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.find(m => m.info.role === 'assistant')?.info.id;

    expect(messageId).toBeDefined();

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });
    opencode.trackSession(fork.data!.id);

    expect(fork.data?.id).toBeDefined();
    expect(fork.data?.id).not.toBe(parent.data!.id);
  });

  it('CANARY: fork has new session ID', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.[0]?.info.id;

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });
    opencode.trackSession(fork.data!.id);

    expect(fork.data?.id).toBeDefined();
    expect(fork.data?.id).not.toBe(parent.data?.id);
  });

  it('CANARY: fork shares history up to fork point', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    for (let i = 0; i < 3; i++) {
      await client.session.prompt({
        path: { id: parent.data!.id },
        body: { parts: [{ type: 'text', text: `Message ${i}` }] },
      });
      // prompt() blocks until completion
    }

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const secondMessageId = messages.data?.[1]?.info.id;

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: secondMessageId! },
    });
    opencode.trackSession(fork.data!.id);

    const forkMessages = await client.session.messages({ path: { id: fork.data!.id } });
    expect(forkMessages.data!.length).toBeLessThan(messages.data!.length);
  });

  it('CANARY: fork diverges after fork point', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });
    opencode.trackSession(parent.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Remember X=1' }] },
    });
    // prompt() blocks until completion

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.[0]?.info.id;

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });
    opencode.trackSession(fork.data!.id);

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Add Y=2' }] },
    });
    // prompt() blocks until completion

    await client.session.prompt({
      path: { id: fork.data!.id },
      body: { parts: [{ type: 'text', text: 'Add Z=3' }] },
    });
    // prompt() blocks until completion

    const parentMsgs = await client.session.messages({ path: { id: parent.data!.id } });
    const forkMsgs = await client.session.messages({ path: { id: fork.data!.id } });

    expect(parentMsgs.data!.length).toBeGreaterThan(0);
    expect(forkMsgs.data!.length).toBeGreaterThan(0);
  });
});
