/**
 * SDK Live Tests: Message History
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Message History', { timeout: 120000 }, () => {
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

  it('CANARY: session.messages() lists all messages', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion, no need to wait

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data?.length).toBeGreaterThanOrEqual(2);
  });

  it('CANARY: messages have correct roles (user/assistant)', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion, no need to wait

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const roles = messages.data?.map(m => m.info.role);

    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('CANARY: messages have timestamps', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    // prompt() blocks until completion, no need to wait

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data?.[0]?.info.time?.created).toBeDefined();
  });
});
