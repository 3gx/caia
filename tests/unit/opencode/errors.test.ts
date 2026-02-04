import { describe, it, expect } from 'vitest';
import { SlackBotError, ErrorCode, toUserMessage, isRecoverable, getRetryAfter, Errors } from '../../../opencode/src/errors.js';

describe('errors', () => {
  it('formats SlackBotError messages', () => {
    const err = new SlackBotError('boom', ErrorCode.OPENCODE_SDK_ERROR, true);
    expect(toUserMessage(err)).toContain('OpenCode encountered');
  });

  it('treats rate limit as recoverable', () => {
    const err = { data: { error: 'ratelimited' } };
    expect(isRecoverable(err)).toBe(true);
  });

  it('returns retry-after metadata when present', () => {
    const err = { data: { response_metadata: { retry_after: 3 } } };
    expect(getRetryAfter(err)).toBe(3);
  });

  it('Errors helpers produce SlackBotError', () => {
    const err = Errors.sessionNotFound('sess');
    expect(err).toBeInstanceOf(SlackBotError);
    expect(err.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });
});
