/**
 * Shared formatting utilities for unified UI across providers.
 *
 * This module provides consistent formatting for:
 * - Status lines (mode | model | session)
 * - Stats display (context, tokens, cost, duration)
 * - Markdown to Slack conversion
 * - Tool name/emoji formatting
 * - Todo list display
 * - Text truncation with formatting preservation
 */

// Types
export type { StatusState, ProviderSessionInfo, ProviderStats, BaseActivityEntry, TodoItem } from './types.js';

// Activity types (shared across all providers)
export type { ActivityEntryType, ActivityEntry, ActivityBatchState, StatusLineParams } from './activity-types.js';

// Status line formatting
export { formatStatusLine } from './status-line.js';

// Unified status line builder (shared across all providers)
export { buildUnifiedStatusLine } from './status-line-builder.js';

// Activity log rendering (shared across all providers)
// Note: THINKING_TRUNCATE_LENGTH and ACTIVITY_LOG_MAX_CHARS are exported from blocks/constants
// and re-exported here only as values — the blocks barrel already exports them.
export {
  renderEntry,
  buildActivityLogText,
  linkifyActivityLabel,
  formatToolResultSummary,
  MAX_DISPLAY_ENTRIES,
} from './activity-log.js';

// Combined status blocks (shared across all providers)
export {
  buildCombinedStatusBlocks,
} from './status-blocks.js';
export type {
  CombinedStatusParams,
  ForkInfo,
  RetryUploadInfo,
} from './status-blocks.js';

// Stats formatting
export { formatStatsLine } from './stats.js';

// Token utilities
export {
  formatTokensK,
  formatTokenCount,
  computeAutoCompactThreshold,
  DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS,
  COMPACT_BUFFER,
} from './tokens.js';

// Markdown utilities
export { markdownToSlack, stripMarkdownCodeFence, normalizeTable } from './markdown.js';

// Tool formatting
export {
  getToolEmoji,
  formatToolName,
  formatToolNameWithEmoji,
  normalizeToolName,
  formatToolInputSummary,
} from './tools.js';

// Todo utilities
export {
  isTodoItem,
  extractLatestTodos,
  formatTodoListDisplay,
  TODO_LIST_MAX_CHARS,
} from './todos.js';

// Truncation utilities
export {
  truncatePath,
  truncateText,
  truncateUrl,
  truncateWithClosedFormatting,
} from './truncation.js';
