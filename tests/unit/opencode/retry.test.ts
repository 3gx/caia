import { describe, it, expect, vi } from 'vitest';
import { withRetry, withSlackRetry } from '../../../opencode/src/retry.js';
import { SlackBotError, ErrorCode } from '../../../opencode/src/errors.js';

describe('retry', () => {
  it('retries and eventually succeeds', async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new SlackBotError('fail', ErrorCode.SLACK_RATE_LIMITED, true))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('withSlackRetry calls onRateLimit', async () => {
    vi.useFakeTimers();
    const err = { data: { error: 'ratelimited', response_metadata: { retry_after: 1 } } };
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const onRateLimit = vi.fn();
    const promise = withSlackRetry(fn, { onRateLimit, baseDelayMs: 1, maxDelayMs: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(onRateLimit).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
