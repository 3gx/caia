/**
 * SDK Live Tests: Message History
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

describe.skipIf(SKIP_LIVE)('Message History', { timeout: 120000 }, () => {
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

  it('CANARY: session.messages() lists all messages', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, session.data!.id);

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data?.length).toBeGreaterThanOrEqual(2);
  });

  it('CANARY: messages have correct roles (user/assistant)', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, session.data!.id);

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const roles = messages.data?.map(m => m.info.role);

    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('CANARY: messages have timestamps', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    await waitForSessionIdle(client, session.data!.id);

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data?.[0]?.info.time?.created).toBeDefined();
  });
});
