import { describe, it, expect, vi } from 'vitest';
import { SessionEventStream } from '../../../opencode/src/session-event-stream.js';
import type { GlobalEvent } from '@opencode-ai/sdk';

function streamDisconnects(): AsyncIterable<GlobalEvent> {
  return (async function* () {
    // End immediately to simulate disconnect
  })();
}

function streamWithEvent(): AsyncIterable<GlobalEvent> {
  return (async function* () {
    yield { type: 'session.busy', payload: { type: 'session.busy' } } as GlobalEvent;
  })();
}

describe('sse disconnect recovery', () => {
  it('reconnects after stream ends', async () => {
    vi.useFakeTimers();
    const client = {
      global: {
        event: vi.fn()
          .mockResolvedValueOnce({ stream: streamDisconnects() })
          .mockResolvedValueOnce({ stream: streamWithEvent() }),
      },
    } as any;

    const stream = new SessionEventStream(client, { baseDelayMs: 1, maxDelayMs: 1 });
    const received: string[] = [];
    stream.subscribe((evt) => received.push(evt.type));

    await vi.runAllTimersAsync();

    expect(received).toContain('session.busy');
    expect(client.global.event).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
