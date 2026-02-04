import { describe, it, expect } from 'vitest';

// NOTE: This test documents expected deduplication behavior for event consumers.
// OpenCode event stream may deliver repeated updates; consumers should filter by id+type.

describe('event deduplication (consumer-side)', () => {
  it('deduplicates repeated event keys', () => {
    const seen = new Set<string>();
    const events = [
      { type: 'message.updated', id: 'm1' },
      { type: 'message.updated', id: 'm1' },
      { type: 'message.updated', id: 'm2' },
    ];

    const accepted = events.filter((e) => {
      const key = `${e.type}:${e.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    expect(accepted.map((e) => e.id)).toEqual(['m1', 'm2']);
  });
});
