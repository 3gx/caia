/**
 * Shared combined status blocks for unified activity window across providers.
 *
 * Combines activity log + status panel + action buttons into a single Slack message.
 * Used by claude/, opencode/, and codex/ providers.
 */
import type { Block } from '../blocks/types.js';
import type { ActivityEntry, StatusLineParams } from './activity-types.js';
import { buildUnifiedStatusLine } from './status-line-builder.js';
import { buildActivityLogText } from './activity-log.js';
import { extractLatestTodos, formatTodoListDisplay } from './todos.js';
import { ACTIVITY_LOG_MAX_CHARS } from '../blocks/constants.js';
import { TODO_LIST_MAX_CHARS } from './todos.js';

// ---------------------------------------------------------------------------
// CombinedStatusParams — unified params for buildCombinedStatusBlocks
// ---------------------------------------------------------------------------

export interface ForkInfo {
  threadTs?: string;
  conversationKey: string;
  sdkMessageId?: string;
  sessionId?: string;
}

export interface RetryUploadInfo {
  activityLogKey: string;
  channelId: string;
  threadTs?: string;
  statusMsgTs: string;
}

export interface CombinedStatusParams {
  // Activity
  activityLog: ActivityEntry[];
  inProgress: boolean;

  // Status
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted' | 'generating';
  errorMessage?: string;
  customStatus?: string;
  spinner?: string;

  // Timing
  elapsedMs: number;

  // Identity (for status line)
  mode: string;       // PermissionMode or UnifiedMode
  model?: string;
  sessionId?: string;
  isNewSession?: boolean;
  sessionTitle?: string;
  workingDir?: string;

  // Model qualifiers
  reasoningTokens?: number;
  reasoningEffort?: string;
  sandboxMode?: string;
  autoApprove?: boolean;

  // Stats
  inputTokens?: number;
  outputTokens?: number;
  contextPercent?: number;
  compactPercent?: number;
  tokensToCompact?: number;
  totalTokensUsed?: number;
  contextWindow?: number;
  contextTokens?: number;
  costUsd?: number;
  rateLimitHits?: number;

  // Actions
  conversationKey: string;
  isFinalSegment?: boolean;
  forkInfo?: ForkInfo;
  hasFailedUpload?: boolean;
  retryUploadInfo?: RetryUploadInfo;

  // User mention
  userId?: string;
  mentionChannelId?: string;
}

// ---------------------------------------------------------------------------
// buildCombinedStatusBlocks
// ---------------------------------------------------------------------------

/**
 * Build combined status blocks (activity log + status panel in single message).
 *
 * Unified layout:
 * - Todo list (if any)
 * - Activity log section
 * - Spinner + elapsed (in-progress only)
 * - Unified status line (always above button)
 * - Button: [Abort] during in-progress, [Fork here]/[Generate Output] on completion
 */
export function buildCombinedStatusBlocks(params: CombinedStatusParams): Block[] {
  const {
    activityLog,
    inProgress,
    status,
    elapsedMs,
    conversationKey,
    errorMessage,
    spinner,
    customStatus,
    isFinalSegment,
    forkInfo,
    hasFailedUpload,
    retryUploadInfo,
    userId,
    mentionChannelId,
  } = params;

  // Build user mention for completion notifications (skip in DMs)
  const userMention = (userId && mentionChannelId && !mentionChannelId.startsWith('D'))
    ? `<@${userId}> `
    : '';

  const blocks: Block[] = [];
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // --- Build StatusLineParams from CombinedStatusParams ---
  const statusLineParams: StatusLineParams = {
    mode: params.mode,
    model: params.model,
    sessionId: params.sessionId,
    isNewSession: params.isNewSession,
    sessionTitle: params.sessionTitle,
    workingDir: params.workingDir,
    reasoningTokens: params.reasoningTokens,
    reasoningEffort: params.reasoningEffort,
    sandboxMode: params.sandboxMode,
    autoApprove: params.autoApprove,
    contextPercent: params.contextPercent,
    compactPercent: params.compactPercent,
    tokensToCompact: params.tokensToCompact,
    totalTokensUsed: params.totalTokensUsed,
    contextWindow: params.contextWindow,
    contextTokens: params.contextTokens,
    rateLimitHits: params.rateLimitHits,
  };

  // 0. Todo section — FIRST if todos exist
  const todos = extractLatestTodos(activityLog);
  const todoText = formatTodoListDisplay(todos, TODO_LIST_MAX_CHARS);
  if (todoText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: todoText },
      expand: true,
    } as Block);
    blocks.push({ type: 'divider' } as Block);
  }

  // 1. Activity log section
  const activityText = buildActivityLogText(activityLog, inProgress, ACTIVITY_LOG_MAX_CHARS);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: activityText },
    expand: true,
  } as Block);

  // Determine if in-progress vs terminal state
  const isInProgressStatus = ['starting', 'thinking', 'tool', 'generating'].includes(status);

  if (isInProgressStatus) {
    // 2. Spinner (context) — in-progress only
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${spinner || '\u280B'} [${elapsedSec}s]`,
      }],
    });

    // 3. Unified status line (context) — no stats during in-progress
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: buildUnifiedStatusLine(statusLineParams),
      }],
    });

    // 4. Actions: [Abort]
    blocks.push({
      type: 'actions',
      block_id: `status_panel_${conversationKey}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_query_${conversationKey}`,
        },
      ],
    });
  } else {
    // Terminal states: complete, aborted, error

    const hasStats = params.contextPercent !== undefined ||
                     params.inputTokens !== undefined ||
                     params.outputTokens !== undefined ||
                     params.costUsd !== undefined;

    // 2. Completion header with user mention (triggers Slack notification)
    if (status === 'complete' && userMention) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${userMention}:white_check_mark: *Complete*`,
        },
      });
    }

    // 3. Unified status line (context) — with full stats at completion
    if (status === 'complete' || status === 'aborted' || (status === 'error' && hasStats)) {
      const terminalParams: StatusLineParams = {
        ...statusLineParams,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cost: params.costUsd,
        durationMs: elapsedMs,
      };
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: buildUnifiedStatusLine(terminalParams),
        }],
      });
    } else if (status === 'error') {
      // Error without stats — show error message in context
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_:x: ${customStatus || errorMessage || 'Unknown error'}_`,
        }],
      });
    }

    // 4. Actions: [Fork here] and/or [Generate Output] on completion
    const actionElements: unknown[] = [];

    // Fork button only on final segment
    if (isFinalSegment && forkInfo && status === 'complete') {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: ':twisted_rightwards_arrows: Fork here',
          emoji: true,
        },
        action_id: `fork_here_${forkInfo.conversationKey}`,
        value: JSON.stringify({
          threadTs: forkInfo.threadTs,
          sdkMessageId: forkInfo.sdkMessageId,
          sessionId: forkInfo.sessionId,
        }),
      });
    }

    // Generate Output button when upload failed (retry mechanism)
    if (hasFailedUpload && retryUploadInfo && status === 'complete') {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: ':page_facing_up: Generate Output',
          emoji: true,
        },
        action_id: `retry_upload_${retryUploadInfo.statusMsgTs}`,
        value: JSON.stringify(retryUploadInfo),
      });
    }

    if (actionElements.length > 0) {
      blocks.push({
        type: 'actions',
        block_id: `status_panel_${conversationKey}`,
        elements: actionElements,
      });
    }
  }

  return blocks;
}
