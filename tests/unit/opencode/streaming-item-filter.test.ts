import { describe, it, expect } from 'vitest';
import { buildActivityLogText } from '../../../opencode/src/blocks.js';
import type { ActivityEntry } from '../../../opencode/src/session-manager.js';

describe('streaming item filter', () => {
  it('builds activity log text for minimal entries', () => {
    const entries: ActivityEntry[] = [{ timestamp: Date.now(), type: 'starting' }];
    const text = buildActivityLogText(entries, false, 1000);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
