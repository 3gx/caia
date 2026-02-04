import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionEventStream } from '../../../opencode/src/session-event-stream.js';

function createClient() {
  const streams: Array<() => AsyncGenerator<any>> = [
    async function* () {
      yield { payload: { type: 'first' } };
      throw new Error('boom');
    },
    async function* () {
      yield { payload: { type: 'second' } };
    },
  ];

  return {
    global: {
      event: vi.fn().mockImplementation(() => ({
        stream: streams.shift()?.(),
      })),
    },
  } as any;
}

describe('session-event-stream-flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    (Math.random as any).mockRestore?.();
  });

  it('reconnects after stream error and delivers subsequent events', async () => {
    const client = createClient();
    const events: any[] = [];
    const stream = new SessionEventStream(client, { baseDelayMs: 1, maxDelayMs: 1 });

    let unsubscribe: () => void = () => undefined;
    unsubscribe = stream.subscribe((event) => {
      events.push(event);
      if (events.length >= 2) {
        unsubscribe();
      }
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(client.global.event).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.payload?.type)).toEqual(['first', 'second']);
  });
});
