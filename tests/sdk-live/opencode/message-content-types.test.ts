/**
 * SDK Live Tests: Message Content Types
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const MINIMAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe.skipIf(SKIP_LIVE)('Content Types', { timeout: 120000 }, () => {
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

  it('CANARY: text content type works', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Hello' }] },
    });

    expect(result.data).toBeDefined();
  });

  it('CANARY: image content type works', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: {
        parts: [
          { type: 'text', text: 'Describe this image:' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'test.png',
            url: `data:image/png;base64,${MINIMAL_PNG_BASE64}`,
          },
        ],
      },
    });

    expect(result.data).toBeDefined();
  });

  it('CANARY: mixed content (text + image) works', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: {
        parts: [
          { type: 'text', text: 'What do you see?' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'test.png',
            url: `data:image/png;base64,${MINIMAL_PNG_BASE64}`,
          },
          { type: 'text', text: 'Be brief.' },
        ],
      },
    });

    expect(result.data).toBeDefined();
  });
});
