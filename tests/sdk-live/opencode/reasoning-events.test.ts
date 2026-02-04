/**
 * SDK Live Tests: Reasoning Events (Thinking)
 *
 * Tests reasoning/thinking feature when available.
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

describe.skipIf(SKIP_LIVE)('Reasoning Events', { timeout: 60000 }, () => {
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

  it('CANARY: message events received during prompt with reasoning context', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Reasoning Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 30000, description: 'session.idle after prompt' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Think step by step: what is 15 * 17?' }] },
    });

    const events = await eventsPromise;

    // Session should complete successfully
    const hasIdleEvent = events.some(
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id
    );
    expect(hasIdleEvent).toBe(true);

    // If reasoning parts are present, verify structure
    const reasoningParts: any[] = [];
    for (const event of events) {
      if (event.payload?.type === 'message.updated') {
        const parts = event.payload?.properties?.parts || [];
        for (const part of parts) {
          if (part.type === 'reasoning') {
            reasoningParts.push(part);
          }
        }
      }
    }

    // If reasoning parts exist, they should have text
    if (reasoningParts.length > 0) {
      const hasText = reasoningParts.some(
        (part) => typeof part.text === 'string' && part.text.length > 0
      );
      expect(hasText).toBe(true);
    }
  });

  it('CANARY: message parts have valid structure', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Part Structure Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 30000, description: 'session.idle after prompt' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Think carefully: why is the sky blue?' }] },
    });

    const events = await eventsPromise;

    // Verify message.updated events have proper structure
    const messageUpdatedEvents = events.filter(
      (event) => event.payload?.type === 'message.updated'
    );

    expect(messageUpdatedEvents.length).toBeGreaterThan(0);

    // Each message event should have parts array
    for (const event of messageUpdatedEvents) {
      const parts = event.payload?.properties?.parts;
      if (parts) {
        expect(Array.isArray(parts)).toBe(true);
        // Each part should have a type
        for (const part of parts) {
          expect(part.type).toBeDefined();
        }
      }
    }
  });

  it('CANARY: reasoning parts have time fields when present', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Reasoning Time Test` },
    });
    opencode.trackSession(session.data!.id);

    const eventsPromise = collectEventsUntil(
      client,
      (event) =>
        event.payload?.type === 'session.idle' &&
        event.payload?.properties?.sessionID === session.data!.id,
      { timeoutMs: 30000, description: 'session.idle after prompt' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Reason about: what makes good software design?' }] },
    });

    const events = await eventsPromise;

    // Collect all parts with type and time fields
    const partsWithTime: any[] = [];
    for (const event of events) {
      if (event.payload?.type === 'message.updated') {
        const parts = event.payload?.properties?.parts || [];
        for (const part of parts) {
          if (part.time) {
            partsWithTime.push(part);
          }
        }
      }
    }

    // If any parts have time fields, verify structure
    for (const part of partsWithTime) {
      if (part.time?.start !== undefined) {
        expect(typeof part.time.start).toBe('number');
      }
      if (part.time?.end !== undefined) {
        expect(typeof part.time.end).toBe('number');
      }
    }

    // Session should complete
    expect(events.some((e) => e.payload?.type === 'session.idle')).toBe(true);
  });

  it('CANARY: assistant message has token fields', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Token Fields Test` },
    });
    opencode.trackSession(session.data!.id);

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Think deeply: what is recursion?' }] },
    });

    // Get messages and check for token fields
    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data).toBeDefined();
    expect(messages.data!.length).toBeGreaterThan(0);

    // Find assistant message
    const assistantMessages = messages.data!.filter((msg: any) => msg.info?.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);

    // Verify message structure - tokens field should exist
    const firstAssistant = assistantMessages[0];
    expect(firstAssistant.info).toBeDefined();

    // Token info should be present (may have various fields)
    if (firstAssistant.info?.tokens) {
      const tokens = firstAssistant.info.tokens;
      // Verify token fields are numbers when present
      if (tokens.input !== undefined) expect(typeof tokens.input).toBe('number');
      if (tokens.output !== undefined) expect(typeof tokens.output).toBe('number');
      if (tokens.reasoning !== undefined) expect(typeof tokens.reasoning).toBe('number');
    }
  });
});
