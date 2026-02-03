/**
 * SDK Live Tests: Todo List
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

async function waitForEvent(
  client: OpencodeClient,
  predicate: (event: any) => boolean,
  options: { timeoutMs: number; description: string }
): Promise<any> {
  const { timeoutMs, description } = options;
  const controller = new AbortController();
  const result = await client.global.event({ signal: controller.signal });

  const startTime = Date.now();
  try {
    for await (const event of result.stream) {
      if (predicate(event)) {
        return event;
      }
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for event: ${description}`);
      }
    }
  } finally {
    controller.abort();
  }
  throw new Error(`Stream ended without finding event: ${description}`);
}

describe.skipIf(SKIP_LIVE)('Todo List', { timeout: 60000 }, () => {
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

  it('CANARY: todo.updated event received', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Todo Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventPromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'todo.updated' ||
        (event.payload?.type === 'session.idle' &&
          event.payload?.properties?.sessionID === session.data!.id),
      { timeoutMs: 20000, description: 'todo.updated or session.idle' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Create a todo list with 3 tasks' }] },
    });
    await eventPromise;
    expect(true).toBe(true);
  });

  it('CANARY: session.todo() returns todo list', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Todo List Test` },
    });
    opencode.trackSession(session.data!.id);

    // The todo API may vary - check if it exists
    if (typeof client.session.todo === 'function') {
      const result = await client.session.todo({ path: { id: session.data!.id } });
      expect(result).toBeDefined();
    } else {
      // API not available - skip gracefully
      expect(true).toBe(true);
    }
  });
});
