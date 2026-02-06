/**
 * SDK Live Tests: Compaction - Command Trigger
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Compaction - Command', { timeout: 120000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: compact triggered by /compact command', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Compact Command Test` },
    });
    opencode.trackSession(session.data!.id);

    // Add some context
    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Explain what a hash table is.' }] },
    });

    // /compact should not throw an error
    const compactResult = await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: '/compact' }] },
    });

    expect(compactResult).toBeDefined();

    // Session should remain accessible
    const sessionData = await client.session.get({ path: { id: session.data!.id } });
    expect(sessionData.data?.id).toBe(session.data!.id);
  });
});
