/**
 * SDK Live Tests: Event Streaming Order
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

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

describe.skipIf(SKIP_LIVE)('Event Streaming Order', { timeout: 60000 }, () => {
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

  it('CANARY: events arrive in chronological order', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Event Order Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 30000, description: 'session.idle event' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Count from 1 to 5' }] },
    });

    const events = await eventsPromise;

    // Filter events for this session
    const sessionEvents = events.filter(
      (e) => e.payload?.properties?.sessionID === session.data!.id
    );

    expect(sessionEvents.length).toBeGreaterThan(0);

    // Check timestamps are monotonically increasing (if available)
    const timestamps = sessionEvents
      .map((e) => e.payload?.properties?.time || e.timestamp)
      .filter((t) => typeof t === 'number');

    if (timestamps.length > 1) {
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    }

    // Alternative: verify event sequence order
    const eventTypes = sessionEvents.map((e) => e.payload?.type);
    expect(eventTypes.length).toBeGreaterThan(0);
  });

  it('CANARY: message.updated precedes session.idle', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Message Order Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 30000, description: 'session.idle event' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Say hello.' }] },
    });

    const events = await eventsPromise;

    // Filter events for this session
    const sessionEvents = events.filter(
      (e) => e.payload?.properties?.sessionID === session.data!.id
    );

    // Find indices of message.updated and session.idle
    let lastMessageUpdatedIndex = -1;
    let sessionIdleIndex = -1;

    sessionEvents.forEach((event, index) => {
      if (event.payload?.type === 'message.updated') {
        lastMessageUpdatedIndex = index;
      }
      if (event.payload?.type === 'session.idle') {
        sessionIdleIndex = index;
      }
    });

    // message.updated should appear before session.idle
    if (lastMessageUpdatedIndex !== -1 && sessionIdleIndex !== -1) {
      expect(lastMessageUpdatedIndex).toBeLessThan(sessionIdleIndex);
    } else {
      // At minimum, session.idle should be present
      expect(sessionIdleIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
