import { describe, it, expect, vi } from 'vitest';
import { SessionEventStream } from '../../../opencode/src/session-event-stream.js';
import type { GlobalEvent } from '@opencode-ai/sdk';

function streamThatThrows(): AsyncIterable<GlobalEvent> {
  return (async function* () {
    throw new Error('boom');
  })();
}

function streamWithEvent(): AsyncIterable<GlobalEvent> {
  return (async function* () {
    yield { type: 'session.idle', payload: { type: 'session.idle' } } as GlobalEvent;
  })();
}

describe('event reconnection', () => {
  it('reconnects after stream error', async () => {
    vi.useFakeTimers();

    const client = {
      global: {
        event: vi.fn()
          .mockResolvedValueOnce({ stream: streamThatThrows() })
          .mockResolvedValueOnce({ stream: streamWithEvent() }),
      },
    } as any;

    const stream = new SessionEventStream(client, { baseDelayMs: 1, maxDelayMs: 1 });
    const received: string[] = [];
    const unsubscribe = stream.subscribe((evt) => {
      received.push(evt.type);
      if (received.length >= 1) {
        unsubscribe();
      }
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(client.global.event).toHaveBeenCalledTimes(2);
    expect(received).toContain('session.idle');

    vi.useRealTimers();
  });
});
