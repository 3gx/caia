/**
 * Shared activity types for unified activity window across providers.
 *
 * These types are the canonical definitions used by claude/, opencode/, and codex/.
 * Provider-specific fields are optional so each provider only populates what it needs.
 */

// ---------------------------------------------------------------------------
// Activity entry type literals
// ---------------------------------------------------------------------------

/**
 * All possible activity entry types across providers.
 * - claude/opencode: all types
 * - codex: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'generating' | 'error' | 'aborted'
 */
export type ActivityEntryType =
  | 'starting'
  | 'thinking'
  | 'tool_start'
  | 'tool_complete'
  | 'error'
  | 'generating'
  | 'aborted'
  | 'mode_changed'
  | 'context_cleared'
  | 'session_changed';

// ---------------------------------------------------------------------------
// ActivityEntry — unified across all providers
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  timestamp: number;
  type: ActivityEntryType;

  // Tool identification
  tool?: string;
  toolUseId?: string;

  // Timing
  durationMs?: number;

  // General message (error text, status message, etc.)
  message?: string;

  // --- Thinking ---
  thinkingContent?: string;
  thinkingTruncated?: string | boolean;   // string in claude/opencode, boolean in codex
  thinkingInProgress?: boolean;
  /** Provider reasoning part id for retry matching (opencode) */
  thinkingPartId?: string;
  /** Unique ID for thinking segment — like toolUseId for tools (codex) */
  thinkingSegmentId?: string;
  /** Attachment link for long thinking content uploaded as file (codex) */
  thinkingAttachmentLink?: string;

  // --- Generating (text streaming) ---
  generatingChunks?: number;
  generatingChars?: number;
  generatingInProgress?: boolean;
  generatingContent?: string;
  generatingTruncated?: string;
  /** Unique ID for response segment — for interleaved response posting (codex) */
  responseSegmentId?: string;
  /** Character count for generated text (codex) */
  charCount?: number;

  // --- Tool input (populated at content_block_stop) ---
  toolInput?: string | Record<string, unknown>;  // string in codex, Record in claude/opencode

  // --- Result metrics (populated when tool_result arrives) ---
  lineCount?: number;
  matchCount?: number;
  linesAdded?: number;
  linesRemoved?: number;

  // --- Execution timing (for accurate duration display) ---
  toolCompleteTimestamp?: number;
  toolResultTimestamp?: number;
  executionDurationMs?: number;

  // --- Tool output (populated when tool_result arrives) ---
  toolOutput?: string;
  toolOutputPreview?: string;
  toolOutputTruncated?: boolean;
  toolIsError?: boolean;
  toolErrorMessage?: string;

  // --- State change entries ---
  mode?: string;
  previousSessionId?: string;

  // --- Thread message linking (for clickable activity in main status) ---
  threadMessageTs?: string;
  threadMessageLink?: string;
}

// ---------------------------------------------------------------------------
// ActivityBatchState — used by claude/opencode activity-thread functions
// ---------------------------------------------------------------------------

/**
 * Processing state for activity batching in thread messages.
 * Mirrors the fields added to ProcessingState in each provider's slack-bot.ts.
 */
export interface ActivityBatchState {
  activityThreadMsgTs: string | null;
  activityBatch: ActivityEntry[];
  activityBatchStartIndex: number;
  lastActivityPostTime: number;
  threadParentTs: string | null;
  /** Ts of most recently posted batch */
  postedBatchTs: string | null;
  /** tool_use_ids in the posted batch (for update-in-place on tool_result) */
  postedBatchToolUseIds: Set<string>;
}

// ---------------------------------------------------------------------------
// StatusLineParams — params-object for buildUnifiedStatusLine
// ---------------------------------------------------------------------------

/**
 * Parameters for buildUnifiedStatusLine.
 *
 * Uses params-object pattern so callers only pass what they have.
 * The function renders a 3-line status:
 *   Line 1: mode | model [reasoning] | session [| title]
 *   Line 2: workingDir (when provided)
 *   Line 3: ctx | tokens | cost | duration
 */
export interface StatusLineParams {
  // --- Line 1: identity ---
  mode: string;                     // UnifiedMode or PermissionMode (mapped to label by caller or function)
  model?: string;
  sessionId?: string;
  isNewSession?: boolean;
  sessionTitle?: string;

  // --- Line 2: working directory ---
  workingDir?: string;

  // --- Model qualifiers (rendered on Line 1 after model) ---
  /** Number of reasoning tokens used — shows [reasoning] indicator (claude/opencode) */
  reasoningTokens?: number;
  /** Reasoning effort level — shows [effort] indicator (codex) */
  reasoningEffort?: string;
  /** Sandbox mode — shows [sandbox] indicator (codex) */
  sandboxMode?: string;
  /** Auto-approve — appended to sandbox indicator (codex) */
  autoApprove?: boolean;

  // --- Line 3: stats ---
  contextPercent?: number;
  compactPercent?: number;
  tokensToCompact?: number;
  /** Total tokens used in context (for "X% used (Yk / Zk)" format) */
  totalTokensUsed?: number;
  /** Context window size (for "X% used (Yk / Zk)" format) */
  contextWindow?: number;
  /** Tokens currently in context — codex uses this instead of totalTokensUsed */
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Cost in USD — named `cost` not `costUsd` for consistency with claude/opencode */
  cost?: number;
  durationMs?: number;
  rateLimitHits?: number;
}
