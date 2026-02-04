import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionEventStream } from '../../../opencode/src/session-event-stream.js';
import type { GlobalEvent } from '@opencode-ai/sdk';

function makeEvent(type: string): GlobalEvent {
  return { type, payload: { type } } as GlobalEvent;
}

function streamFrom(events: GlobalEvent[], opts: { throwAfter?: boolean } = {}) {
  return (async function* () {
    for (const e of events) {
      yield e;
    }
    if (opts.throwAfter) {
      throw new Error('stream error');
    }
  })();
}

describe('SessionEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers events to subscribers', async () => {
    const client = {
      global: {
        event: vi.fn().mockResolvedValue({ stream: streamFrom([makeEvent('session.idle')]) }),
      },
    } as any;

    const stream = new SessionEventStream(client, { baseDelayMs: 1, maxDelayMs: 1 });
    const received: string[] = [];

    stream.subscribe((event) => received.push(event.type));

    await vi.runAllTimersAsync();

    expect(received).toContain('session.idle');
  });

  it('reconnects after stream errors', async () => {
    const client = {
      global: {
        event: vi.fn()
          .mockResolvedValueOnce({ stream: streamFrom([], { throwAfter: true }) })
          .mockResolvedValueOnce({ stream: streamFrom([makeEvent('session.busy')]) }),
      },
    } as any;

    const stream = new SessionEventStream(client, { baseDelayMs: 1, maxDelayMs: 1 });
    const received: string[] = [];
    stream.subscribe((event) => received.push(event.type));

    await vi.runAllTimersAsync();

    expect(received).toContain('session.busy');
    expect(client.global.event).toHaveBeenCalledTimes(2);
  });

  it('stops when last subscriber unsubscribes', async () => {
    const client = {
      global: {
        event: vi.fn().mockResolvedValue({ stream: streamFrom([makeEvent('session.idle')]) }),
      },
    } as any;

    const stream = new SessionEventStream(client, { baseDelayMs: 1, maxDelayMs: 1 });
    const unsubscribe = stream.subscribe(() => {});
    unsubscribe();

    await vi.runAllTimersAsync();

    // Should not keep reconnecting when no listeners
    expect(client.global.event).toHaveBeenCalledTimes(1);
  });
});
