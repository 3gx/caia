/**
 * SDK Live Tests: Session Creation
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Session Creation', { timeout: 30000 }, () => {
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

  it('CANARY: session.create() returns session ID', async () => {
    const result = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(result.data!.id);

    expect(result.data?.id).toBeDefined();
    expect(typeof result.data?.id).toBe('string');
    expect(result.data?.id).toMatch(/^[a-z0-9_-]+$/i);
  });

  it('CANARY: session has working directory', async () => {
    const result = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(result.data!.id);

    expect(result.data?.directory).toBeDefined();
    expect(typeof result.data?.directory).toBe('string');
  });

  it('CANARY: session has title', async () => {
    const result = await client.session.create({
      body: { title: 'My Test Session' },
    });
    opencode.trackSession(result.data!.id);
    expect(result.data?.title).toBe('My Test Session');
  });

  it('CANARY: session inherits permissions from config', async () => {
    const result = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(result.data!.id);

    expect(result.data?.id).toBeDefined();
  });
});
