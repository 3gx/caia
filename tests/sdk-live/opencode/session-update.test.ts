/**
 * SDK Live Tests: Session Updates
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Session Updates', { timeout: 30000 }, () => {
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

  it('CANARY: session.update() changes properties', async () => {
    const created = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Original Title` },
    });
    opencode.trackSession(created.data!.id);

    await client.session.update({
      path: { id: created.data!.id },
      body: { title: `${TEST_SESSION_PREFIX}Updated Title` },
    });

    const updated = await client.session.get({ path: { id: created.data!.id } });
    expect(updated.data?.title).toBe(`${TEST_SESSION_PREFIX}Updated Title`);
  });
});
