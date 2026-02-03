/**
 * Token formatting utilities.
 */

/** Default effective max output tokens (CLI caps at 32k). */
export const DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS = 32000;

/** Buffer tokens reserved before auto-compact triggers. */
export const COMPACT_BUFFER = 13000;

/**
 * Format token count as "x.yk" with exactly one decimal.
 * @example formatTokensK(67516) → "67.5k"
 * @example formatTokensK(13000) → "13.0k"
 */
export function formatTokensK(tokens: number): string {
  return (tokens / 1000).toFixed(1) + 'k';
}

/**
 * Format token count with smart suffix.
 * Numbers >= 1000 get "k" suffix, smaller numbers shown as-is.
 * @example formatTokenCount(1500) → "1.5k"
 * @example formatTokenCount(500) → "500"
 */
export function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/**
 * Compute the token count threshold where auto-compact triggers.
 * Used to calculate "tokens remaining until compact" indicator.
 *
 * Formula: contextWindow - effectiveMaxOutput - COMPACT_BUFFER
 *
 * @param contextWindow - Total context window size
 * @param maxOutputTokens - Model's max output tokens (capped at DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS)
 * @returns Token count threshold where auto-compact triggers
 */
export function computeAutoCompactThreshold(contextWindow: number, maxOutputTokens?: number): number {
  const effectiveMaxOutput = Math.min(
    DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS,
    maxOutputTokens || DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS
  );
  return contextWindow - effectiveMaxOutput - COMPACT_BUFFER;
}
