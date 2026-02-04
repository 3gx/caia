import { describe, it, expect } from 'vitest';
import { markAborted, isAborted, clearAborted, reset } from '../../../opencode/src/abort-tracker.js';

describe('abort-tracker', () => {
  it('tracks aborts', () => {
    reset();
    markAborted('C1');
    expect(isAborted('C1')).toBe(true);
    clearAborted('C1');
    expect(isAborted('C1')).toBe(false);
  });
});
