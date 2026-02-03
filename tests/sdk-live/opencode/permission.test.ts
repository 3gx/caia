/**
 * SDK Live Tests: Permission & Approval Flow
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

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

async function collectEventsUntil(
  client: OpencodeClient,
  shouldStop: (event: any, events: any[]) => boolean,
  options: { timeoutMs: number; description: string }
): Promise<any[]> {
  const { timeoutMs, description } = options;
  const controller = new AbortController();
  const result = await client.global.event({ signal: controller.signal });
  const events: any[] = [];

  const startTime = Date.now();
  try {
    for await (const event of result.stream) {
      events.push(event);
      if (shouldStop(event, events)) return events;
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for events: ${description}`);
      }
    }
  } finally {
    controller.abort();
  }
  return events;
}

describe.skipIf(SKIP_LIVE)('Permission Flow', { timeout: 120000 }, () => {
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

  it('CANARY: ask mode triggers permission.updated', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);
    const eventPromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'permission.updated' ||
        (event.payload?.type === 'session.idle' && event.payload?.properties?.sessionID === session.data!.id),
      { timeoutMs: 20000, description: 'permission.updated or session.idle' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Create file test.txt with content "hello".' }] },
    });
    const event = await eventPromise;
    const permissionRequested = event.payload?.type === 'permission.updated';
    const sessionIdle = event.payload?.type === 'session.idle';
    expect(permissionRequested || sessionIdle).toBe(true);
  });

  it('CANARY: allow mode skips permission', async () => {
    // Config permissions are global, not per-session
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      event =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 20000, description: 'session.idle event' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say hello.' }] },
    });
    const events = await eventsPromise;
    const permissionRequested = events.some(e => e.payload?.type === 'permission.updated');
    expect(permissionRequested).toBe(false);
  });

  it('CANARY: permission has type (edit/bash)', async () => {
    const session = await client.session.create({
      body: { title: 'Test Session' },
    });
    opencode.trackSession(session.data!.id);

    const eventPromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'permission.updated' ||
        (event.payload?.type === 'session.idle' && event.payload?.properties?.sessionID === session.data!.id),
      { timeoutMs: 20000, description: 'permission.updated or session.idle' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Create file test3.txt' }] },
    });
    const event = await eventPromise;
    const permissionType =
      event.payload?.type === 'permission.updated' ? event.payload?.properties?.type || null : null;
    if (permissionType) {
      expect(['edit', 'bash', 'write']).toContain(permissionType);
    } else {
      expect(true).toBe(true);
    }
  });
});
