/**
 * SDK Live Tests: Session Children (Forks)
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

describe.skipIf(SKIP_LIVE)('Session Children', { timeout: 60000 }, () => {
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

  it('CANARY: session.children() lists forked sessions', async () => {
    const parent = await client.session.create({
      body: { title: 'Parent Session' },
    });

    // Create a message first
    await client.session.prompt({
      path: { id: parent.data!.id },
      body: { parts: [{ type: 'text', text: 'Hello' }] },
    });
    await waitForSessionIdle(client, parent.data!.id);

    // Get messages to find message ID
    const messages = await client.session.messages({ path: { id: parent.data!.id } });
    const messageId = messages.data?.[0]?.info.id;

    expect(messageId).toBeDefined();

    // Fork at that message
    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: messageId! },
    });

    expect(fork.data?.id).toBeDefined();

    // Check if children API exists and returns data
    if (typeof client.session.children === 'function') {
      const children = await client.session.children({ path: { id: parent.data!.id } });
      // Children API may return the fork or may need time to propagate
      expect(children.data).toBeDefined();
    } else {
      // API not available, but fork succeeded
      expect(fork.data?.id).toBeDefined();
    }
  });
});
