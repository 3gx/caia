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

// Status line formatting
export { formatStatusLine } from './status-line.js';

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
