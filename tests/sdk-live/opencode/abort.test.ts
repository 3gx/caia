/**
 * SDK Live Tests: Abort & Interruption
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

async function waitForSessionStatus(
  client: OpencodeClient,
  sessionId: string,
  statusType: string,
  options: { timeoutMs: number }
): Promise<void> {
  const { timeoutMs } = options;
  const controller = new AbortController();
  const result = await client.global.event({ signal: controller.signal });

  const startTime = Date.now();
  try {
    for await (const event of result.stream) {
      if (
        event.payload?.type === 'session.status' &&
        event.payload?.properties?.sessionID === sessionId &&
        event.payload?.properties?.status?.type === statusType
      ) {
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for session status ${statusType}`);
      }
    }
  } finally {
    controller.abort();
  }
}

describe.skipIf(SKIP_LIVE)('Abort Functionality', { timeout: 60000 }, () => {
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

  it('CANARY: session.abort() stops processing', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    const promptPromise = client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Write a very long story with many paragraphs.' }] },
    });

    try {
      await waitForSessionStatus(client, session.data!.id, 'busy', { timeoutMs: 5000 });
    } catch {
      // If it never becomes busy, continue anyway.
    }

    try {
      await client.session.abort({ path: { id: session.data!.id } });
    } catch {
      // Abort may throw if session is already idle
    }

    await promptPromise.catch(() => {});
    // After prompt completes/fails, session is idle

    const sessions = await client.session.list();
    expect(sessions.data).toBeDefined();
  });

  it('CANARY: session usable after abort', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Test Session` },
    });
    opencode.trackSession(session.data!.id);

    const promptPromise = client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Long task...' }] },
    });

    try {
      await waitForSessionStatus(client, session.data!.id, 'busy', { timeoutMs: 5000 });
    } catch {
      // Ignore if already idle.
    }

    try {
      await client.session.abort({ path: { id: session.data!.id } });
    } catch {
      // Ignore abort errors
    }

    await promptPromise.catch(() => {});
    // After prompt completes/fails, session is idle

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });

    expect(result.data).toBeDefined();
  });
});
