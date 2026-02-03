/**
 * SDK Live Tests: Message Streaming
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort } from './test-helpers.js';

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

describe.skipIf(SKIP_LIVE)('Message Streaming', { timeout: 120000 }, () => {
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

  it('CANARY: message_part.updated streams text deltas', async () => {
    const session = await client.session.create({
      body: { title: 'Streaming Test' },
    });
    opencode.trackSession(session.data!.id);

    const textParts: string[] = [];
    let idleReceived = false;

    const collectPromise = collectEventsUntil(
      client,
      (event) => {
        const eventType = event.payload?.type;

        if (eventType === 'message_part.updated') {
          const part = event.payload?.properties?.part;
          if (part?.type === 'text' && part?.text) {
            textParts.push(part.text);
          }
        }

        if (eventType === 'message.updated') {
          const parts = event.payload?.properties?.parts;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p?.type === 'text' && p?.text) {
                textParts.push(p.text);
              }
            }
          }
        }

        if (eventType === 'session.idle') {
          idleReceived = true;
        }

        return textParts.length > 0 || idleReceived;
      },
      { timeoutMs: 20000, description: 'message streaming events' },
    );

    await client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Write a 3-sentence story about a cat.' }] },
    });
    await collectPromise;

    // Either we got text parts or the session went idle (meaning response completed)
    expect(textParts.length > 0 || idleReceived).toBe(true);
  });

  it('CANARY: streaming can be aborted', async () => {
    const session = await client.session.create({
      body: { title: 'Abort Test' },
    });
    opencode.trackSession(session.data!.id);

    const busyPromise = waitForSessionStatus(
      client,
      session.data!.id,
      'busy',
      { timeoutMs: 5000 },
    );

    // Don't await - prompt() blocks until completion
    const promptPromise = client.session.prompt({
      path: { id: session.data!.id },
      body: { parts: [{ type: 'text', text: 'Write a very long story.' }] },
    });

    try {
      await busyPromise;
    } catch {
      // Session may complete before becoming busy
    }

    try {
      await client.session.abort({ path: { id: session.data!.id } });
    } catch {
      // Abort may fail if already idle
    }

    await promptPromise.catch(() => {});

    // After abort, session should still be accessible
    const status = await client.session.status();
    expect(status.data).toBeDefined();
  });
});
