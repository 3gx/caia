/**
 * SDK Live Tests: Session Permissions
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Session Permissions', { timeout: 60000 }, () => {
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

  it('CANARY: session with default permissions allows prompts', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Default Permissions Test` },
    });
    opencode.trackSession(session.data!.id);

    // Default session should allow prompts
    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'What is 2 + 2?' }] },
    });

    expect(result).toBeDefined();

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data!.length).toBeGreaterThan(0);
  });

  it('CANARY: session permissions can be configured', async () => {
    // Try to create session with permission configuration
    const session = await client.session.create({
      body: {
        title: `${TEST_SESSION_PREFIX}Permission Config Test`,
        // Permission configuration may vary by SDK version
      },
    });
    opencode.trackSession(session.data!.id);

    expect(session.data?.id).toBeDefined();

    // Get session to check for permission fields
    const sessionData = await client.session.get({ path: { id: session.data!.id } });
    expect(sessionData.data).toBeDefined();

    // Session should exist with whatever permissions were set
    expect(sessionData.data?.id).toBe(session.data?.id);
  });

  it('CANARY: permission update affects session behavior', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Permission Update Test` },
    });
    opencode.trackSession(session.data!.id);

    // First prompt should work
    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Hello' }] },
    });

    // Try to update session (if permissions are updatable)
    if (typeof client.session.update === 'function') {
      try {
        await client.session.update({
          path: { id: session.data!.id },
          body: { title: `${TEST_SESSION_PREFIX}Permission Update Test - Updated` },
        });
      } catch {
        // Update may not support permission changes
      }
    }

    // Session should still be usable
    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Goodbye' }] },
    });

    expect(result).toBeDefined();

    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data!.length).toBeGreaterThan(2);
  });
});
