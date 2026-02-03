/**
 * Shared types for unified UI formatting across providers.
 */
import type { UnifiedMode } from '../session/types.js';

/**
 * Status states for the status panel.
 * Unified across providers - each provider maps their internal states to these.
 */
export type StatusState =
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'generating'
  | 'complete'
  | 'error'
  | 'aborted';

/**
 * Provider session information for status line display.
 * Providers declare their session info, and the shared UI renders it uniformly.
 */
export interface ProviderSessionInfo {
  mode: UnifiedMode;  // 'plan' | 'ask' | 'bypass'
  model: string;      // e.g., "claude-opus-4-5-20251101" or "gpt-5.2-codex [xhigh]"
  sessionId: string;  // UUID (truncated for display)
  isNewSession?: boolean;  // true = first turn in thread, shows [new] prefix
}

/**
 * Provider stats for stats line display.
 * Providers pass whatever stats they have - UI renders all available, skips missing.
 */
export interface ProviderStats {
  // Token counts
  inputTokens?: number;       // e.g., 135900
  outputTokens?: number;      // e.g., 12000

  // Context usage
  contextPercent?: number;    // e.g., 9.5 (percentage used)
  contextWindow?: number;     // Total context window size

  // Auto-compact indicators (Claude-specific)
  compactPercent?: number;    // % remaining until compact (for ⚡ indicator)
  tokensToCompact?: number;   // Tokens remaining until compact

  // Cost and timing
  costUsd?: number;           // Both providers support this
  durationMs?: number;        // Elapsed time

  // Activity counts
  toolsCompleted?: number;    // e.g., 10 (completed tool calls)
  totalTools?: number;        // e.g., 48 (for "10/48" format)
  rateLimitHits?: number;     // Shows if rate limited
}

/**
 * Base activity entry structure for activity log.
 * Used by both providers for extracting todo items and formatting tool summaries.
 * The `type` field is a string to accommodate provider-specific entry types.
 */
export interface BaseActivityEntry {
  type: string;  // Provider-specific entry types (e.g., 'tool_start', 'tool_complete', 'thinking', etc.)
  tool?: string;
  toolInput?: string | Record<string, unknown>;  // string for legacy support (Codex)
  // Result metrics
  matchCount?: number;
  lineCount?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * Todo item structure.
 * Used for todo list extraction and display.
 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;  // Optional - display text for in_progress items
}
