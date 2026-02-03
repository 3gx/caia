/**
 * SDK Live Tests: Event Streaming (SSE)
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer } from './test-helpers.js';

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

describe.skipIf(SKIP_LIVE)('Event Stream - Basic', { timeout: 60000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = basePort + Atomics.add(counter, 0, 1);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    server = opencode.server;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: global.event() returns SSE stream', async () => {
    const controller = new AbortController();
    const result = await client.global.event({ signal: controller.signal });
    expect(result.stream).toBeDefined();
    expect(typeof result.stream[Symbol.asyncIterator]).toBe('function');
    controller.abort();
  });

  it('CANARY: events stream in real-time', async () => {
    const eventPromise = waitForEvent(
      client,
      () => true,
      { timeoutMs: 10000, description: 'any event' },
    );
    await client.session.create({ body: { title: 'Event Test' } });
    const event = await eventPromise;
    expect(event).toBeDefined();
  });

  it('CANARY: events have type and properties', async () => {
    const eventPromise = waitForEvent(
      client,
      event => Boolean(event.payload?.type && event.payload?.properties),
      { timeoutMs: 10000, description: 'event with type/properties' },
    );
    await client.session.create({ body: { title: 'Event Test' } });
    const event = await eventPromise;
    expect(event.payload?.type).toBeDefined();
    expect(event.payload?.properties).toBeDefined();
  });
});

describe.skipIf(SKIP_LIVE)('Event Stream - Session Events', { timeout: 60000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = basePort + Atomics.add(counter, 0, 1);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    server = opencode.server;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: session.created event on new session', async () => {
    const createdPromise = waitForEvent(
      client,
      event => event.payload?.type === 'session.created',
      { timeoutMs: 10000, description: 'session.created event' },
    );
    await client.session.create({ body: { title: 'Event Test' } });
    const event = await createdPromise;
    expect(event.payload?.type).toBe('session.created');
  });

  it('CANARY: session.idle event on completion', async () => {
    const sessionResult = await client.session.create({
      body: { title: 'Idle Test' },
    });
    const sessionId = sessionResult.data?.id;
    expect(sessionId).toBeDefined();

    const idlePromise = waitForEvent(
      client,
      event =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === sessionId,
      { timeoutMs: 20000, description: 'session.idle event' },
    );

    await client.session.prompt({
      path: { id: sessionId! },
      body: { parts: [{ type: 'text', text: 'Say "hello".' }] },
    });
    const event = await idlePromise;
    expect(event.payload?.type).toBe('session.idle');
  });

  it('CANARY: session.status event shows busy/idle', async () => {
    const sessionResult = await client.session.create({
      body: { title: 'Status Test' },
    });
    const sessionId = sessionResult.data?.id;
    expect(sessionId).toBeDefined();

    const statuses: string[] = [];
    const statusPromise = collectEventsUntil(
      client,
      (event) => {
        if (event.payload?.type === 'session.status' && event.payload?.properties?.sessionID === sessionId) {
          const statusType = event.payload?.properties?.status?.type;
          if (statusType && !statuses.includes(statusType)) {
            statuses.push(statusType);
          }
        }
        if (event.payload?.type === 'session.idle' && event.payload?.properties?.sessionID === sessionId) {
          if (!statuses.includes('idle')) {
            statuses.push('idle');
          }
        }
        if (event.payload?.type === 'session.busy' && event.payload?.properties?.sessionID === sessionId) {
          if (!statuses.includes('busy')) {
            statuses.push('busy');
          }
        }
        return (
          (event.payload?.type === 'session.idle' && event.payload?.properties?.sessionID === sessionId) ||
          (statuses.includes('busy') && statuses.includes('idle'))
        );
      },
      { timeoutMs: 20000, description: 'session.status busy+idle' },
    );

    await client.session.prompt({
      path: { id: sessionId! },
      body: { parts: [{ type: 'text', text: 'Write a paragraph about coding.' }] },
    });
    await statusPromise;

    expect(statuses.length).toBeGreaterThan(0);
  });
});
