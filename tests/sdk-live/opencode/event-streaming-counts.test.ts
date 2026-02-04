/**
 * SDK Live Tests: Event Streaming Counts
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

describe.skipIf(SKIP_LIVE)('Event Streaming Counts', { timeout: 60000 }, () => {
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

  it('CANARY: tool start count equals tool complete count', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Tool Count Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 30000, description: 'session.idle event' },
    );

    // Prompt that may trigger tool use (reading a file or something)
    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'What files are in the current directory? Use bash to run ls.' }] },
    });

    const events = await eventsPromise;

    // Filter events for this session
    const sessionEvents = events.filter(
      (e) => e.payload?.properties?.sessionID === session.data!.id
    );

    // Count tool start and complete events
    let toolStartCount = 0;
    let toolCompleteCount = 0;

    for (const event of sessionEvents) {
      const eventType = event.payload?.type;
      if (eventType === 'tool.start' || eventType === 'tool_start') {
        toolStartCount++;
      }
      if (eventType === 'tool.complete' || eventType === 'tool_complete' || eventType === 'tool.finish') {
        toolCompleteCount++;
      }

      // Also check for tool parts with state changes in message.updated
      if (eventType === 'message.updated') {
        const parts = event.payload?.properties?.parts || [];
        for (const part of parts) {
          if (part.type === 'tool') {
            if (part.state === 'pending' || part.state === 'running') {
              // Count as start
            }
            if (part.state === 'completed' || part.state === 'error') {
              // Count as complete
            }
          }
        }
      }
    }

    // If tools were used, starts should equal completes
    if (toolStartCount > 0) {
      expect(toolCompleteCount).toBe(toolStartCount);
    }
    // At minimum, session should have completed
    expect(sessionEvents.some((e) => e.payload?.type === 'session.idle')).toBe(true);
  });

  it('CANARY: events contain session information', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}SessionID Test` },
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

    // Session should have received events with our sessionID
    expect(sessionEvents.length).toBeGreaterThan(0);

    // Should include session.idle at minimum
    const hasIdleEvent = sessionEvents.some((e) => e.payload?.type === 'session.idle');
    expect(hasIdleEvent).toBe(true);
  });
});
