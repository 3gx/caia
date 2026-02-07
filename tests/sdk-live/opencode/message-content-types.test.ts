/**
 * SDK Live Tests: Message Content Types
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';
import { MINIMAL_PNG_DATA_URL, findImageCapableModel, promptAsyncAndWaitForIdle, type ModelRef } from './image-test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Content Types', { timeout: 120000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;
  let imageModel: ModelRef | null = null;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    server = opencode.server;
    imageModel = await findImageCapableModel(client);
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
    if (!imageModel) {
      console.log('[SKIP] No image-capable model found in config.providers(); skipping image content test.');
      return;
    }

    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    await promptAsyncAndWaitForIdle(client, session.data!.id, {
      model: imageModel,
      parts: [
        { type: 'text', text: 'Describe this image:' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'test.png',
          url: MINIMAL_PNG_DATA_URL,
        },
      ],
    });

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const userMessage = messages.data?.find((m) => m.info.role === 'user');
    const filePart = userMessage?.parts?.find((p: any) => p?.type === 'file');

    expect(filePart).toBeDefined();
    expect((filePart as any).mime).toBe('image/png');
    expect((filePart as any).url?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('CANARY: mixed content (text + image) works', async () => {
    if (!imageModel) {
      console.log('[SKIP] No image-capable model found in config.providers(); skipping mixed image content test.');
      return;
    }

    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    await promptAsyncAndWaitForIdle(client, session.data!.id, {
      model: imageModel,
      parts: [
        { type: 'text', text: 'What do you see?' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'test.png',
          url: MINIMAL_PNG_DATA_URL,
        },
        { type: 'text', text: 'Be brief.' },
      ],
    });

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const userMessage = messages.data?.find((m) => m.info.role === 'user');
    const fileParts = userMessage?.parts?.filter((p: any) => p?.type === 'file') ?? [];
    const textParts = userMessage?.parts?.filter((p: any) => p?.type === 'text') ?? [];

    expect(fileParts.length).toBe(1);
    expect(textParts.length).toBeGreaterThanOrEqual(2);
  });
});
