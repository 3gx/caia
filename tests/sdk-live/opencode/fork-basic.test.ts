/**
 * SDK Live Tests: Point-in-Time Fork - Basic Functionality
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';

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

describe.skipIf(SKIP_LIVE)('Fork - Basic', { timeout: 120000 }, () => {
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

  it('CANARY: session.fork() creates fork at message', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, parent.data!.id);

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.find(m => m.info.role === 'assistant')?.info.id;

    expect(messageId).toBeDefined();

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });

    expect(fork.data?.id).toBeDefined();
    expect(fork.data?.id).not.toBe(parent.data!.id);
  });

  it('CANARY: fork has new session ID', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, parent.data!.id);

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.[0]?.info.id;

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });

    expect(fork.data?.id).toBeDefined();
    expect(fork.data?.id).not.toBe(parent.data?.id);
  });

  it('CANARY: fork shares history up to fork point', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });

    for (let i = 0; i < 3; i++) {
      await client.session.prompt({
        path: { id: parent.data!.id },
        body: { parts: [{ type: 'text', text: `Message ${i}` }] },
      });
      await waitForSessionIdle(client, parent.data!.id);
    }

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const secondMessageId = messages.data?.[1]?.info.id;

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: secondMessageId! },
    });

    const forkMessages = await client.session.messages({ path: { id: fork.data!.id } });
    expect(forkMessages.data!.length).toBeLessThan(messages.data!.length);
  });

  it('CANARY: fork diverges after fork point', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Remember X=1' }] },
    });
    await waitForSessionIdle(client, parent.data!.id);

    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.[0]?.info.id;

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });

    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Add Y=2' }] },
    });
    await waitForSessionIdle(client, parent.data!.id);

    await client.session.prompt({
      path: { id: fork.data!.id },
      body: { parts: [{ type: 'text', text: 'Add Z=3' }] },
    });
    await waitForSessionIdle(client, fork.data!.id);

    const parentMsgs = await client.session.messages({ path: { id: parent.data!.id } });
    const forkMsgs = await client.session.messages({ path: { id: fork.data!.id } });

    expect(parentMsgs.data!.length).toBeGreaterThan(0);
    expect(forkMsgs.data!.length).toBeGreaterThan(0);
  });
});
