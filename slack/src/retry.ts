/**
 * Retry utilities with exponential backoff.
 * Used to handle transient failures like rate limits and network errors.
 */

import { isRecoverable, getRetryAfter } from './errors.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  shouldRetry: (error) => isRecoverable(error),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfter?: number | null
): number {
  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000;
  }

  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 100;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const shouldRetry = opts.shouldRetry(error, attempt);
      const isLastAttempt = attempt === opts.maxAttempts;

      if (!shouldRetry || isLastAttempt) {
        throw error;
      }

      const retryAfter = getRetryAfter(error);
      const delay = calculateDelay(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        retryAfter
      );

      if (opts.onRetry) {
        opts.onRetry(error, attempt, delay);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

export interface SlackRetryOptions extends Partial<RetryOptions> {
  onRateLimit?: (retryAfter?: number) => void;
}

export async function withSlackRetry<T>(
  fn: () => Promise<T>,
  options: SlackRetryOptions = {}
): Promise<T> {
  const { onRateLimit, ...retryOptions } = options;
  let rateLimitNotified = false;

  return withRetry(fn, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    shouldRetry: (error) => {
      if (isSlackRateLimitError(error)) {
        return true;
      }
      if (isNetworkError(error)) {
        return true;
      }
      return isRecoverable(error);
    },
    onRetry: (error, attempt, delayMs) => {
      const isRateLimit = isSlackRateLimitError(error);
      const errorType = isRateLimit ? 'rate limited' : 'network error';
      console.log(
        `Slack API ${errorType}, retrying in ${delayMs}ms (attempt ${attempt})`
      );

      if (isRateLimit && !rateLimitNotified && onRateLimit) {
        rateLimitNotified = true;
        const retryAfter = getRetryAfter(error) ?? undefined;
        onRateLimit(retryAfter);
      }
    },
    ...retryOptions,
  });
}

function isSlackRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const slackError = error as { data?: { error?: string } };
  return slackError.data?.error === 'ratelimited';
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

export interface InfiniteRetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  onSuccess?: (attempts: number) => void;
}

export async function withInfiniteRetry<T>(
  fn: () => Promise<T>,
  options: InfiniteRetryOptions = {}
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 3000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  let attempt = 0;

  while (true) {
    try {
      const result = await fn();
      if (attempt > 0 && options.onSuccess) {
        options.onSuccess(attempt + 1);
      }
      return result;
    } catch (error) {
      attempt++;

      const retryAfter = getRetryAfter(error);
      let delay: number;
      if (retryAfter && retryAfter > 0) {
        delay = retryAfter * 1000;
      } else {
        delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      }

      delay += Math.random() * 500;

      if (options.onRetry) {
        options.onRetry(error, attempt, delay);
      }

      await sleep(delay);
    }
  }
}
