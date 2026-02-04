import { describe, it, expect } from 'vitest';

describe('event ordering', () => {
  it('sorts events by timestamp', () => {
    const events = [
      { ts: 3, type: 'message.updated' },
      { ts: 1, type: 'session.busy' },
      { ts: 2, type: 'message.updated' },
    ];

    const ordered = events.sort((a, b) => a.ts - b.ts).map((e) => e.ts);
    expect(ordered).toEqual([1, 2, 3]);
  });
});
