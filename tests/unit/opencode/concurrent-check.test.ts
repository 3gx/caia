import { describe, it, expect } from 'vitest';
import { isSessionActiveInTerminal, getContinueCommand, buildConcurrentWarningBlocks } from '../../../opencode/src/concurrent-check.js';

describe('concurrent-check', () => {
  it('returns inactive by default', async () => {
    const result = await isSessionActiveInTerminal('sess');
    expect(result.active).toBe(false);
  });

  it('builds continue command', () => {
    expect(getContinueCommand('sess-1')).toContain('opencode session resume');
  });

  it('builds warning blocks', () => {
    const blocks = buildConcurrentWarningBlocks(123, 'sess-1');
    expect(blocks.length).toBeGreaterThan(0);
  });
});
