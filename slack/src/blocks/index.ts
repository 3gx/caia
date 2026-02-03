/**
 * Shared Slack Block Kit utilities.
 *
 * This module provides:
 * - Block type definitions
 * - Shared constants (context window, text limits)
 * - Generic block builders (path setup, error, text splitting)
 * - Thread message formatters
 */

// Types
export type { Block, InputBlock, ModalBlock } from './types.js';

// Constants
export {
  DEFAULT_CONTEXT_WINDOW,
  MAX_BLOCK_TEXT_LENGTH,
  ACTIVITY_LOG_MAX_CHARS,
  MAX_LIVE_ENTRIES,
  ROLLING_WINDOW_SIZE,
  THINKING_TRUNCATE_LENGTH,
} from './constants.js';

// Block builders
export {
  buildPathSetupBlocks,
  buildErrorBlocks,
  buildTextBlocks,
  buildContextBlock,
  buildDividerBlock,
} from './builders.js';

// Thread formatters
export {
  formatThreadStartingMessage,
  formatThreadErrorMessage,
} from './thread.js';
