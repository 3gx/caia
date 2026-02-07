/**
 * SDK Live Tests: Image Upload Flows (base64, resume, fork)
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';
import { MINIMAL_PNG_DATA_URL, findImageCapableModel, promptAsyncAndWaitForIdle, type ModelRef } from './image-test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Image Support', { timeout: 120000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let testPort: number;
  let imageModel: ModelRef | null = null;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    imageModel = await findImageCapableModel(client);
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: file content block accepted', async () => {
    if (!imageModel) {
      console.log('[SKIP] No image-capable model found in config.providers(); skipping image file content test.');
      return;
    }

    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Image Test` },
    });
    opencode.trackSession(session.data!.id);

    await promptAsyncAndWaitForIdle(
      client,
      session.data!.id,
      {
        model: imageModel,
        parts: [
          { type: 'text', text: 'Describe briefly.' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'test.png',
            url: MINIMAL_PNG_DATA_URL,
          },
        ],
      },
      60000
    );

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const userMessage = messages.data?.find((m) => m.info.role === 'user');
    const filePart = userMessage?.parts?.find((p: any) => p?.type === 'file');

    expect(filePart).toBeDefined();
    expect((filePart as any).mime).toBe('image/png');
  });

  it('CANARY: text + file in same resumed session', async () => {
    if (!imageModel) {
      console.log('[SKIP] No image-capable model found in config.providers(); skipping resumed image test.');
      return;
    }

    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Image Resume Test` },
    });
    opencode.trackSession(session.data!.id);

    await promptAsyncAndWaitForIdle(client, session.data!.id, {
      parts: [{ type: 'text', text: 'Remember the word banana. Reply only "remembered".' }],
    });

    await promptAsyncAndWaitForIdle(client, session.data!.id, {
      model: imageModel,
      parts: [
        { type: 'text', text: 'Describe this image briefly.' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'test.png',
          url: MINIMAL_PNG_DATA_URL,
        },
      ],
    });

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    const userMessages = messages.data?.filter((m) => m.info.role === 'user') ?? [];
    const latestUser = userMessages.at(-1);
    const filePart = latestUser?.parts?.find((p: any) => p?.type === 'file');

    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(filePart).toBeDefined();
  });

  it('CANARY: image prompt works in forked session', async () => {
    if (!imageModel) {
      console.log('[SKIP] No image-capable model found in config.providers(); skipping forked image test.');
      return;
    }

    const parent = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Image Fork Parent` },
    });
    opencode.trackSession(parent.data!.id);

    await promptAsyncAndWaitForIdle(client, parent.data!.id, {
      parts: [{ type: 'text', text: 'Say "session started".' }],
    });

    const parentMessages = await client.session.messages({ path: { id: parent.data!.id } });
    const forkPoint = parentMessages.data?.find((m) => m.info.role === 'assistant')?.info.id;
    expect(forkPoint).toBeDefined();

    const fork = await client.session.fork({
      path: { id: parent.data!.id },
      body: { messageID: forkPoint! },
    });
    opencode.trackSession(fork.data!.id);

    await promptAsyncAndWaitForIdle(client, fork.data!.id, {
      model: imageModel,
      parts: [
        { type: 'text', text: 'What color is this pixel? Reply with one color word.' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'test.png',
          url: MINIMAL_PNG_DATA_URL,
        },
      ],
    });

    const forkMessages = await client.session.messages({ path: { id: fork.data!.id } });
    const forkUserMessage = forkMessages.data?.find((m) => m.info.role === 'user' && m.parts.some((p: any) => p?.type === 'file'));
    const filePart = forkUserMessage?.parts?.find((p: any) => p?.type === 'file');

    expect(fork.data!.id).not.toBe(parent.data!.id);
    expect(filePart).toBeDefined();
  });
});
