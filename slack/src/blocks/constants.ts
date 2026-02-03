/**
 * Shared constants for Slack block builders.
 */

/**
 * Default context window size for AI models.
 * All current Claude models (opus-4, sonnet-4, haiku-4, etc.) and Codex models
 * have a context window of 200,000 tokens.
 *
 * Used as a fallback when contextWindow is not yet available (first query after
 * /clear, /resume, or fresh channel).
 */
export const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Maximum characters for a single Slack block text field.
 * Slack's actual limit is 3000, but we use 2900 for safety margin.
 */
export const MAX_BLOCK_TEXT_LENGTH = 2900;

/**
 * Maximum characters for activity log display.
 */
export const ACTIVITY_LOG_MAX_CHARS = 1000;

/**
 * Maximum entries before applying rolling window.
 */
export const MAX_LIVE_ENTRIES = 300;

/**
 * Number of entries to show in rolling window mode.
 */
export const ROLLING_WINDOW_SIZE = 20;

/**
 * Characters to show for thinking content preview.
 */
export const THINKING_TRUNCATE_LENGTH = 500;
