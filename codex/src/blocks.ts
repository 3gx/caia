/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import type { ReasoningEffort, SandboxMode } from './codex-client.js';
import type { UnifiedMode } from '../../slack/dist/session/types.js';
import {
  markdownToSlack,
  stripMarkdownCodeFence,
  formatTokensK,
  formatTokenCount,
  computeAutoCompactThreshold,
  getToolEmoji,
  formatToolName as sharedFormatToolName,
  normalizeToolName,
  formatToolInputSummary,
  isTodoItem,
  extractLatestTodos,
  formatTodoListDisplay,
  TODO_LIST_MAX_CHARS,
  truncatePath,
  truncateText,
  truncateUrl,
  truncateWithClosedFormatting,
  type Block,
  type TodoItem,
} from 'caia-slack';

// Re-export shared types, constants, builders, and formatters for backwards compatibility
export type { Block } from 'caia-slack';
export {
  DEFAULT_CONTEXT_WINDOW,
  buildPathSetupBlocks,
  formatThreadStartingMessage,
  formatThreadErrorMessage,
} from 'caia-slack';

// ============================================================================
// Status Blocks
// ============================================================================

export interface StatusBlockParams {
  status: 'processing' | 'aborted' | 'error' | 'complete';
  messageTs?: string;
  errorMessage?: string;
  conversationKey?: string; // For abort button
  durationMs?: number; // For complete status
}

/**
 * Build blocks for processing status messages.
 */
export function buildStatusBlocks(params: StatusBlockParams): Block[] {
  const { status, messageTs, errorMessage, conversationKey, durationMs } = params;
  const blocks: Block[] = [];

  switch (status) {
    case 'processing':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':gear: *Processing...*',
        },
      });

      // Add abort button if we have a conversation key
      if (conversationKey) {
        blocks.push({
          type: 'actions',
          block_id: `abort_${messageTs || 'unknown'}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Abort' },
              action_id: `abort_${conversationKey}`,
              style: 'danger',
            },
          ],
        });
      }
      break;

    case 'aborted':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':octagonal_sign: *Aborted*',
        },
      });
      break;

    case 'error':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:x: *Error*${errorMessage ? `\n${errorMessage}` : ''}`,
        },
      });
      break;

    case 'complete': {
      // Complete status shows checkmark with duration
      const durationText = durationMs ? ` | ${(durationMs / 1000).toFixed(1)}s` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *Complete*${durationText}`,
        },
      });
      break;
    }
  }

  return blocks;
}

// ============================================================================
// Header Blocks
// ============================================================================

export interface HeaderBlockParams {
  status: 'starting' | 'processing' | 'complete' | 'aborted' | 'error';
  mode: UnifiedMode;
  conversationKey?: string; // For abort button
  model?: string;
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Build a compact header block showing status and metadata.
 */
export function buildHeaderBlock(params: HeaderBlockParams): Block {
  const { status, mode, model, durationMs, errorMessage } = params;

  const statusEmoji = {
    starting: ':hourglass_flowing_sand:',
    processing: ':gear:',
    complete: ':white_check_mark:',
    aborted: ':stop_sign:',
    error: ':x:',
  }[status];

  const parts: string[] = [];

  // Status
  parts.push(`${statusEmoji} *${status.charAt(0).toUpperCase() + status.slice(1)}*`);

  // Mode badge
  const modeBadge: Record<UnifiedMode, string> = {
    plan: ':clipboard:',
    ask: ':question:',
    bypass: ':rocket:',
  };
  parts.push(`${modeBadge[mode]} ${mode}`);

  // Model (if provided)
  if (model) {
    parts.push(`| ${model}`);
  }

  // Duration (if complete)
  if (status === 'complete' && durationMs) {
    const seconds = (durationMs / 1000).toFixed(1);
    parts.push(`| ${seconds}s`);
  }

  // Error message (if error)
  if (status === 'error' && errorMessage) {
    parts.push(`\n${errorMessage}`);
  }

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: parts.join(' '),
    },
  };
}

// ============================================================================
// Approval Blocks
// ============================================================================

export interface CommandApprovalBlockParams {
  itemId: string;
  threadId: string;
  turnId: string;
  parsedCmd: string;
  risk: string;
  sandboxed: boolean;
  requestId: number;
}

export interface FileChangeApprovalBlockParams {
  itemId: string;
  threadId: string;
  turnId: string;
  filePath: string;
  reason: string;
  requestId: number;
}

/**
 * Build blocks for command execution approval request.
 */
export function buildCommandApprovalBlocks(params: CommandApprovalBlockParams): Block[] {
  const { parsedCmd, risk, sandboxed, requestId } = params;
  const blocks: Block[] = [];

  // Command preview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:terminal: *Command Approval Requested*\n\`\`\`${parsedCmd}\`\`\``,
    },
  });

  // Risk level and sandbox status
  const riskEmoji = {
    low: ':white_check_mark:',
    medium: ':warning:',
    high: ':exclamation:',
  }[risk] || ':question:';

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${riskEmoji} Risk: ${risk} | ${sandboxed ? ':shield: Sandboxed' : ':warning: Not sandboxed'}`,
      },
    ],
  });

  // Approve/Deny buttons
  blocks.push({
    type: 'actions',
    block_id: `approval_${requestId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve' },
        action_id: `approve_${requestId}`,
        style: 'primary',
        value: JSON.stringify({ requestId, decision: 'accept' }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Deny' },
        action_id: `deny_${requestId}`,
        style: 'danger',
        value: JSON.stringify({ requestId, decision: 'decline' }),
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for file change approval request.
 */
export function buildFileChangeApprovalBlocks(params: FileChangeApprovalBlockParams): Block[] {
  const { filePath, reason, requestId } = params;
  const blocks: Block[] = [];

  // File change preview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:page_facing_up: *File Change Approval Requested*\n*File:* \`${filePath}\`\n*Reason:* ${reason}`,
    },
  });

  // Approve/Deny buttons
  blocks.push({
    type: 'actions',
    block_id: `approval_${requestId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve' },
        action_id: `approve_${requestId}`,
        style: 'primary',
        value: JSON.stringify({ requestId, decision: 'accept' }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Deny' },
        action_id: `deny_${requestId}`,
        style: 'danger',
        value: JSON.stringify({ requestId, decision: 'decline' }),
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks showing approval was granted.
 */
export function buildApprovalGrantedBlocks(command?: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: command
          ? `:white_check_mark: *Approved*\n\`\`\`${command}\`\`\``
          : ':white_check_mark: *Approved*',
      },
    },
  ];
}

/**
 * Build blocks showing approval was denied.
 */
export function buildApprovalDeniedBlocks(command?: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: command
          ? `:no_entry_sign: *Denied*\n\`\`\`${command}\`\`\``
          : ':no_entry_sign: *Denied*',
      },
    },
  ];
}

// ============================================================================
// Fork Blocks
// ============================================================================

export interface ForkBlockParams {
  /** Turn index (0-based) - queried from Codex at button creation time */
  turnIndex: number;
  slackTs: string;
  conversationKey: string;
}

/**
 * Build blocks for "Fork here" button.
 * Matches ccslack style: emoji + text, shown only after query completes.
 *
 * NOTE: We store turnIndex (queried from Codex at button creation time).
 * This is robust across bot restarts and CLI usage because:
 * - turnIndex is immutable once stored
 * - forkThreadAtTurn validates index is still valid
 */
export function buildForkButton(params: ForkBlockParams): Block {
  const { turnIndex, slackTs, conversationKey } = params;

  return {
    type: 'actions',
    block_id: `fork_${slackTs}`,
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: ':twisted_rightwards_arrows: Fork here',
          emoji: true,
        },
        action_id: `fork_${conversationKey}_${turnIndex}`,
        value: JSON.stringify({ turnIndex, slackTs, conversationKey }),
      },
    ],
  };
}

// ============================================================================
// Activity Entry Blocks
// ============================================================================

export interface ActivityEntryActionParams {
  conversationKey: string;
  /** Codex turn ID - used for activity entry actions (fork is always disabled here) */
  turnId: string;
  slackTs: string;
  includeFork?: boolean;
  includeAttachThinking?: boolean;
}

export function buildActivityEntryActions(params: ActivityEntryActionParams): Block {
  const { conversationKey, turnId, slackTs, includeFork = true, includeAttachThinking = true } = params;
  const elements: any[] = [];
  if (includeFork) {
    // NOTE: Fork is always disabled for activity entries (see buildActivityEntryActionParams)
    // This code path is kept for API completeness but never executes in practice
    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: ':twisted_rightwards_arrows: Fork here',
        emoji: true,
      },
      action_id: `fork_${conversationKey}_${turnId}`,
      value: JSON.stringify({ turnId, slackTs, conversationKey }),
    });
  }
  if (includeAttachThinking) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Attach Response' },
      action_id: `attach_thinking_${slackTs}`,
      value: JSON.stringify({ conversationKey, slackTs }),
    });
  }
  return {
    type: 'actions',
    block_id: `activity_actions_${slackTs}`,
    elements,
  } as Block;
}

export interface ActivityEntryBlockParams {
  text: string;
  actions?: ActivityEntryActionParams;
}

export function buildActivityEntryBlocks(params: ActivityEntryBlockParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: params.text },
      expand: true,
    } as Block,
  ];
  if (params.actions) {
    blocks.push(buildActivityEntryActions(params.actions));
  }
  return blocks;
}

export interface AttachThinkingButtonValue {
  threadParentTs: string;
  channelId: string;
  activityMsgTs: string;
  thinkingCharCount: number;
}

export function buildAttachThinkingFileButton(
  activityMsgTs: string,
  threadParentTs: string,
  channelId: string,
  thinkingCharCount: number
): Block {
  const value: AttachThinkingButtonValue = {
    threadParentTs,
    channelId,
    activityMsgTs,
    thinkingCharCount,
  };

  return {
    type: 'actions',
    block_id: `attach_thinking_${activityMsgTs}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: ':page_facing_up: Attach Response', emoji: true },
      action_id: `attach_thinking_file_${activityMsgTs}`,
      value: JSON.stringify(value),
    }],
  } as Block;
}

export interface AttachResponseButtonValue {
  threadParentTs: string;
  channelId: string;
  responseMsgTs: string;
  responseCharCount: number;
}

export function buildAttachResponseFileButton(
  responseMsgTs: string,
  threadParentTs: string,
  channelId: string,
  responseCharCount: number
): Block {
  const value: AttachResponseButtonValue = {
    threadParentTs,
    channelId,
    responseMsgTs,
    responseCharCount,
  };

  return {
    type: 'actions',
    block_id: `attach_response_${responseMsgTs}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: ':page_facing_up: Attach Response', emoji: true },
      action_id: `attach_response_file_${responseMsgTs}`,
      value: JSON.stringify(value),
    }],
  } as Block;
}

// Helper for mapping tool/thinking entries to block actions in thread activity
// NOTE: Fork button should ONLY appear on the main activity/status panel (buildActivityBlocks),
// NOT on individual per-entry thread posts. This matches ccslack behavior.
export function buildActivityEntryActionParams(
  entry: import('./activity-thread.js').ActivityEntry,
  conversationKey: string,
  turnId: string,
  slackTs: string,
  includeAttachThinking: boolean
): ActivityEntryActionParams | undefined {
  // Fork button is DISABLED on per-entry posts - it should only appear on the status panel
  // This matches ccslack behavior where fork is only on the main activity message
  const includeFork = false;
  const isThinking = entry.type === 'thinking';
  if (!includeFork && !(includeAttachThinking && isThinking)) {
    return undefined;
  }
  return {
    conversationKey,
    turnId,
    slackTs,
    includeFork,
    includeAttachThinking: includeAttachThinking && isThinking,
  };
}


// ============================================================================
// Command Response Blocks
// ============================================================================

export interface ModeStatusBlockParams {
  currentMode: UnifiedMode;
  newMode?: UnifiedMode;
}

export interface SandboxStatusBlockParams {
  currentSandbox: SandboxMode;
  newSandbox?: SandboxMode;
}

/**
 * Build blocks for /mode command response.
 */
export function buildModeStatusBlocks(params: ModeStatusBlockParams): Block[] {
  const { currentMode, newMode } = params;
  const blocks: Block[] = [];

  const descriptions: Record<UnifiedMode, string> = {
    plan: 'Plan-only responses (not supported in Codex)',
    ask: 'Ask before tool use (default)',
    bypass: 'Run tools without approval',
  };

  if (newMode) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:arrows_counterclockwise: Mode changed: *${currentMode}* → *${newMode}*`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Current Mode:* ${currentMode}\n_${descriptions[currentMode]}_`,
      },
    });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Available modes: ask, bypass',
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks for /mode command selection prompt.
 */
export function buildModeSelectionBlocks(currentMode: UnifiedMode): Block[] {
  const button = (mode: UnifiedMode, label: string) => ({
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: `mode_select_${mode}`,
    value: mode,
    ...(currentMode === mode ? { style: 'primary' as const } : {}),
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Select Mode*\nCurrent: *${currentMode}*`,
      },
    },
    {
      type: 'actions',
      block_id: 'mode_selection',
      elements: [
        button('ask', ':question: ask'),
        button('bypass', ':rocket: bypass'),
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '- *ask* - Ask before tool use (default)\n- *bypass* - Run tools without approval',
        },
      ],
    },
    {
      type: 'actions',
      block_id: 'mode_cancel',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel' },
        action_id: 'mode_picker_cancel',
      }],
    },
  ];
}

/**
 * Build blocks for mode picker cancellation.
 */
export function buildModePickerCancelledBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':x: Mode selection cancelled.',
      },
    },
  ];
}

/**
 * Build blocks for /sandbox command response.
 */
export function buildSandboxStatusBlocks(params: SandboxStatusBlockParams): Block[] {
  const { currentSandbox, newSandbox } = params;
  const blocks: Block[] = [];

  const descriptions: Record<SandboxMode, string> = {
    'read-only': 'Read-only sandbox (no writes)',
    'workspace-write': 'Allow writes inside workspace only',
    'danger-full-access': 'Full access (no sandbox restrictions)',
  };

  if (newSandbox) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: Sandbox changed: *${currentSandbox}* → *${newSandbox}*`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: *Current Sandbox:* ${currentSandbox}\n_${descriptions[currentSandbox]}_`,
      },
    });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Available sandbox modes: read-only, workspace-write, danger-full-access',
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks for /sandbox selection prompt.
 */
export function buildSandboxSelectionBlocks(currentSandbox: SandboxMode): Block[] {
  const button = (mode: SandboxMode, label: string) => ({
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: `sandbox_select_${mode}`,
    value: mode,
    ...(currentSandbox === mode ? { style: 'primary' as const } : {}),
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: *Select Sandbox*\nCurrent: *${currentSandbox}*`,
      },
    },
    {
      type: 'actions',
      block_id: 'sandbox_selection',
      elements: [
        button('read-only', ':lock: read-only'),
        button('workspace-write', ':hammer_and_wrench: workspace-write'),
        button('danger-full-access', ':warning: danger-full-access'),
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '- *read-only* - No filesystem writes\n- *workspace-write* - Write only in workspace\n- *danger-full-access* - No sandbox restrictions',
        },
      ],
    },
    {
      type: 'actions',
      block_id: 'sandbox_cancel',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'sandbox_picker_cancel',
        },
      ],
    },
  ];
}

/**
 * Build blocks for sandbox picker cancellation.
 */
export function buildSandboxPickerCancelledBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':x: Sandbox selection cancelled.',
      },
    },
  ];
}

/**
 * Build blocks for /clear command response.
 */
export function buildClearBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':broom: *Session cleared.* Starting fresh conversation.',
      },
    },
  ];
}

/**
 * Build blocks for /model command response.
 */
export function buildModelStatusBlocks(
  currentModel: string | undefined,
  availableModels: string[],
  newModel?: string
): Block[] {
  const blocks: Block[] = [];

  if (newModel) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:robot_face: Model changed: *${currentModel || 'default'}* → *${newModel}*`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:robot_face: *Current Model:* ${currentModel || 'default'}`,
      },
    });

    if (availableModels.length > 0) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Available models: ${availableModels.join(', ')}`,
          },
        ],
      });
    }
  }

  return blocks;
}

// ============================================================================
// Model Selection Blocks (Button-based two-step flow like ccslack)
// ============================================================================

export interface ModelInfo {
  value: string;       // e.g., "gpt-5.2-codex"
  displayName: string; // e.g., "GPT-5.2 Codex"
  description: string; // Human-readable description
}

/**
 * Build blocks for model selection (Step 1 of 2).
 * Shows model buttons - user clicks one to proceed to reasoning selection.
 */
export function buildModelSelectionBlocks(
  models: ModelInfo[],
  currentModel?: string
): Block[] {
  // Create buttons for each model (max 5 for Slack actions block)
  const buttons = models.slice(0, 5).map(model => ({
    type: 'button' as const,
    text: {
      type: 'plain_text' as const,
      text: model.displayName,
      emoji: true,
    },
    action_id: `model_select_${model.value}`,
    value: JSON.stringify({
      model: model.value,
      displayName: model.displayName,
    }),
    ...(currentModel === model.value ? { style: 'primary' as const } : {}),
  }));

  // Build description context
  const descriptions = models.slice(0, 5).map(m =>
    `• *${m.displayName}*: ${m.description}`
  ).join('\n');

  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Select Model* (Step 1/2)\nCurrent: \`${currentModel || 'default'}\``,
      },
    },
  ];

  if (buttons.length > 0) {
    blocks.push({
      type: 'actions',
      block_id: 'model_selection',
      elements: buttons,
    });
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: descriptions,
      }],
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: No models available. Using default.',
      },
    });
  }

  // Cancel button
  blocks.push({
    type: 'actions',
    block_id: 'model_cancel',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Cancel' },
      action_id: 'model_picker_cancel',
    }],
  });

  return blocks;
}

/**
 * Build blocks for reasoning selection (Step 2 of 2).
 * Shows reasoning buttons after model is selected.
 */
export function buildReasoningSelectionBlocks(
  selectedModel: string,
  selectedModelDisplayName: string,
  currentReasoning?: ReasoningEffort
): Block[] {
  const reasoningLevels: Array<{ value: string; label: string; description: string }> = [
    { value: 'minimal', label: 'Minimal', description: 'Fastest, minimal reasoning' },
    { value: 'low', label: 'Low', description: 'Fast responses with light reasoning' },
    { value: 'medium', label: 'Medium', description: 'Balanced speed and depth (default)' },
    { value: 'high', label: 'High', description: 'Greater depth for complex problems' },
    { value: 'xhigh', label: 'Extra High', description: 'Maximum reasoning depth' },
  ];

  const buttons = reasoningLevels.map(level => ({
    type: 'button' as const,
    text: {
      type: 'plain_text' as const,
      text: level.label,
      emoji: true,
    },
    action_id: `reasoning_select_${level.value}`,
    value: JSON.stringify({
      model: selectedModel,
      displayName: selectedModelDisplayName,
      reasoning: level.value,
    }),
    ...(currentReasoning === level.value ? { style: 'primary' as const } : {}),
  }));

  const descriptions = reasoningLevels.map(l =>
    `• *${l.label}*: ${l.description}`
  ).join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Select Reasoning Level* (Step 2/2)\nModel: \`${selectedModelDisplayName}\``,
      },
    },
    {
      type: 'actions',
      block_id: 'reasoning_selection',
      elements: buttons,
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: descriptions,
      }],
    },
    {
      type: 'actions',
      block_id: 'reasoning_cancel',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel' },
        action_id: 'model_picker_cancel',
      }],
    },
  ];
}

/**
 * Build blocks for model selection confirmation.
 */
export function buildModelConfirmationBlocks(
  modelDisplayName: string,
  modelValue: string,
  reasoning: string
): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Settings Updated*\nModel: \`${modelDisplayName}\`\nReasoning: \`${reasoning}\``,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Changes apply on the next turn.',
      }],
    },
  ];
}

/**
 * Build blocks for model picker cancellation.
 */
export function buildModelPickerCancelledBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':x: Model selection cancelled.',
      },
    },
  ];
}

/**
 * Build blocks for /reasoning command response.
 */
export function buildReasoningStatusBlocks(
  currentEffort: string | undefined,
  newEffort?: string
): Block[] {
  const blocks: Block[] = [];

  if (newEffort) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:brain: Reasoning effort changed: *${currentEffort || 'default'}* → *${newEffort}*`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:brain: *Current Reasoning Effort:* ${currentEffort || 'default'}`,
      },
    });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Available levels: minimal, low, medium, high, xhigh',
        },
      ],
    });
  }

  return blocks;
}

// ============================================================================
// Message Content Blocks
// ============================================================================

/**
 * Build blocks for a text message response.
 */
export function buildTextBlocks(text: string): Block[] {
  // Split long messages into multiple blocks if needed (Slack has 3000 char limit per block)
  const MAX_BLOCK_LENGTH = 2900;
  const blocks: Block[] = [];

  if (text.length <= MAX_BLOCK_LENGTH) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
      expand: true, // Prevent Slack "See more" collapse
    } as Block);
  } else {
    // Split at paragraph boundaries when possible
    let remaining = text;
    while (remaining.length > 0) {
      let chunk: string;
      if (remaining.length <= MAX_BLOCK_LENGTH) {
        chunk = remaining;
        remaining = '';
      } else {
        // Try to split at paragraph boundary
        let splitIndex = remaining.lastIndexOf('\n\n', MAX_BLOCK_LENGTH);
        if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
          // No good paragraph boundary, split at line boundary
          splitIndex = remaining.lastIndexOf('\n', MAX_BLOCK_LENGTH);
        }
        if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
          // No good line boundary, split at word boundary
          splitIndex = remaining.lastIndexOf(' ', MAX_BLOCK_LENGTH);
        }
        if (splitIndex === -1) {
          // No good boundary, hard split
          splitIndex = MAX_BLOCK_LENGTH;
        }

        chunk = remaining.slice(0, splitIndex);
        remaining = remaining.slice(splitIndex).trimStart();
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: chunk,
        },
        expand: true, // Prevent Slack "See more" collapse
      } as Block);
    }
  }

  return blocks;
}

// ============================================================================
// Resume Confirmation Blocks
// ============================================================================

export interface ResumeConfirmationParams {
  resumedThreadId: string;
  workingDir: string;
  previousThreadId?: string;
  isNewChannel: boolean;
  previousPath?: string;
}

/**
 * Build blocks for a resume confirmation message.
 * Mirrors ccslack style with explicit path lock/change messaging.
 */
export function buildResumeConfirmationBlocks(params: ResumeConfirmationParams): Block[] {
  const { resumedThreadId, workingDir, previousThreadId, isNewChannel, previousPath } = params;
  const lines: string[] = [];

  if (previousThreadId) {
    lines.push(`:bookmark: Previous session: \`${previousThreadId}\``);
    lines.push(`_Use_ \`/resume ${previousThreadId}\` _to return_`);
    lines.push('');
  }

  lines.push(`Resuming session \`${resumedThreadId}\` in \`${workingDir}\``);

  if (isNewChannel) {
    lines.push(`Path locked to \`${workingDir}\``);
  } else if (previousPath && previousPath !== workingDir) {
    lines.push(`Path changed from \`${previousPath}\` to \`${workingDir}\``);
  }

  lines.push('');
  lines.push('Your next message will continue this session.');

  return buildTextBlocks(lines.join('\n'));
}

/**
 * Build blocks for an error message.
 */
export function buildErrorBlocks(message: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:x: *Error*\n${message}`,
      },
    },
  ];
}

// ============================================================================
// Progress Indicators
// ============================================================================

// Re-export additional shared token functions for backwards compatibility
export { computeAutoCompactThreshold, formatTokensK } from 'caia-slack';

export interface UnifiedStatusLineParams {
  mode: UnifiedMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  sessionId?: string;
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  // COMMENTED OUT: compactPercent and tokensToCompact use assumed values (COMPACT_BUFFER=13000,
  // DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS=32000) that Codex does NOT provide via API.
  // Verified via test-token-fields.ts: Codex only sends model_context_window, not maxOutputTokens.
  // Keep these fields in case Codex adds this info in the future.
  compactPercent?: number;
  tokensToCompact?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Build a unified status line showing mode, model, session, and stats.
 * Line 1: mode | model [reason] | session (NO sandbox - unified with Claude format)
 * Line 2: ctx | tokens | cost | duration (only when available)
 */
export function buildUnifiedStatusLine(params: UnifiedStatusLineParams): string {
  const line1Parts: string[] = [];
  const line2Parts: string[] = [];

  // Default to gpt-5.2-codex with xhigh reasoning when not explicitly set
  const modelLabel = params.model || 'gpt-5.2-codex';
  const reasoningLabel = params.reasoningEffort || 'xhigh';
  const modelWithReasoning = `${modelLabel} [${reasoningLabel}]`;
  // NOTE: sandboxMode removed from display per unified UX plan - Codex always uses danger-full-access
  // so displaying it adds no information and differs from Claude's format
  const sessionLabel = params.sessionId || 'n/a';

  line1Parts.push(params.mode);
  line1Parts.push(modelWithReasoning);
  line1Parts.push(sessionLabel);

  // Show context usage: "X% left, Y used / Z"
  // Uses only verified data from Codex (contextWindow is sent via model_context_window)
  if (params.contextPercent !== undefined && params.contextTokens !== undefined && params.contextWindow !== undefined) {
    const percentLeft = (100 - params.contextPercent).toFixed(0);
    const usedK = formatTokensK(params.contextTokens);
    const windowK = formatTokensK(params.contextWindow);
    line2Parts.push(`${percentLeft}% left, ${usedK} / ${windowK}`);
  } else if (params.contextPercent !== undefined) {
    line2Parts.push(`${params.contextPercent.toFixed(1)}% ctx`);
  }

  // COMMENTED OUT: Auto-compact threshold display uses assumed values that Codex does NOT provide.
  // Verified via test-token-fields.ts: Codex only sends model_context_window, not maxOutputTokens.
  // Keep this code in case Codex adds maxOutputTokens in the future.
  // if (params.compactPercent !== undefined && params.tokensToCompact !== undefined) {
  //   line2Parts.push(
  //     `${params.contextPercent?.toFixed(1)}% ctx (${params.compactPercent.toFixed(1)}% ${formatTokensK(
  //       params.tokensToCompact
  //     )} tok to :zap:)`
  //   );
  // }

  if (params.inputTokens !== undefined || params.outputTokens !== undefined) {
    const inStr = formatTokenCount(params.inputTokens ?? 0);
    const outStr = formatTokenCount(params.outputTokens ?? 0);
    line2Parts.push(`${inStr}/${outStr}`);
  }

  if (params.costUsd !== undefined) {
    line2Parts.push(`$${params.costUsd.toFixed(2)}`);
  }

  if (params.durationMs !== undefined) {
    line2Parts.push(`${(params.durationMs / 1000).toFixed(1)}s`);
  }

  const line1 = `_${line1Parts.join(' | ')}_`;
  if (line2Parts.length === 0) {
    return line1;
  }
  return `${line1}\n_${line2Parts.join(' | ')}_`;
}

// ============================================================================
// Todo Extraction (simple, conservative)
// ============================================================================

const TODO_PATTERN = /^\s*[-*]\s*\[\s?\]\s*(.+)$/;

export function extractTodosFromText(text: string, maxItems = 5): string[] {
  const lines = text.split(/\r?\n/);
  const todos: string[] = [];
  for (const line of lines) {
    const match = line.match(TODO_PATTERN);
    if (match && match[1].trim()) {
      todos.push(match[1].trim());
      if (todos.length >= maxItems) break;
    }
  }
  return todos;
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

export interface AbortConfirmationModalParams {
  conversationKey: string;
  channelId: string;
  messageTs: string;
}

// ============================================================================
// Fork to Channel Modal
// ============================================================================

export interface ForkToChannelModalParams {
  sourceChannelId: string;
  sourceChannelName: string;
  sourceMessageTs: string;
  sourceThreadTs: string;
  conversationKey: string;
  /** Turn index (0-based) - queried from Codex at button creation time */
  turnIndex: number;
  /** Suggested channel name (computed by checking existing forks) */
  suggestedName: string;
}

/**
 * Build a modal view for fork-to-channel.
 * User can specify the new channel name (prefilled with {channelName}-fork).
 */
// Input block type for modals (uses singular 'element' not 'elements')
interface InputBlock {
  type: 'input';
  block_id: string;
  element: {
    type: 'plain_text_input';
    action_id: string;
    placeholder?: { type: 'plain_text'; text: string };
    initial_value?: string;
    max_length?: number;
  };
  label: { type: 'plain_text'; text: string };
  hint?: { type: 'plain_text'; text: string };
}

type ModalBlock = Block | InputBlock;

export function buildForkToChannelModalView(params: ForkToChannelModalParams): {
  type: 'modal';
  callback_id: string;
  private_metadata: string;
  title: { type: 'plain_text'; text: string };
  submit: { type: 'plain_text'; text: string };
  close: { type: 'plain_text'; text: string };
  blocks: ModalBlock[];
} {
  return {
    type: 'modal',
    callback_id: 'fork_to_channel_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Fork to Channel' },
    submit: { type: 'plain_text', text: 'Create Fork' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:twisted_rightwards_arrows: *Fork conversation from this point*\n\nThis will create a new channel with a forked copy of the conversation up to this point.`,
        },
      },
      {
        type: 'input',
        block_id: 'channel_name_block',
        element: {
          type: 'plain_text_input',
          action_id: 'channel_name_input',
          placeholder: { type: 'plain_text', text: 'Enter channel name' },
          initial_value: params.suggestedName,
          max_length: 80,
        },
        label: { type: 'plain_text', text: 'New Channel Name' },
        hint: { type: 'plain_text', text: 'Channel names can only contain lowercase letters, numbers, and hyphens.' },
      },
    ],
  };
}

// ============================================================================
// Activity Blocks
// ============================================================================

export interface ActivityBlockParams {
  activityText: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  conversationKey: string;
  elapsedMs: number;
  entries?: ActivityEntry[]; // For todo extraction
  mode: UnifiedMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  sessionId?: string;
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  compactPercent?: number;
  tokensToCompact?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  spinner?: string;
  /** Turn index (0-based) for fork button - queried from Codex at button creation */
  forkTurnIndex?: number;
  forkSlackTs?: string;
  /** User ID for @mention in Complete notification (Claude-style) */
  userId?: string;
  /** Channel ID - skip mention in DMs */
  channelId?: string;
}

/**
 * Build blocks for activity message with rolling window of entries.
 * Includes spinner (in-progress), unified status line, and abort button during processing.
 * If entries are provided, extracts and prepends todo list.
 */
export function buildActivityBlocks(params: ActivityBlockParams): Block[] {
  const {
    activityText,
    status,
    conversationKey,
    elapsedMs,
    entries,
    mode,
    model,
    reasoningEffort,
    sandboxMode,
    sessionId,
    contextPercent,
    contextTokens,
    contextWindow,
    compactPercent,
    tokensToCompact,
    inputTokens,
    outputTokens,
    costUsd,
    spinner,
  } = params;
  const blocks: Block[] = [];
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // Extract and format todo list if we have entries
  let displayText = '';
  if (entries && entries.length > 0) {
    const todos = extractLatestTodos(entries);
    const todoText = formatTodoListDisplay(todos);
    if (todoText) {
      displayText = todoText + '\n────\n';
    }
  }
  // Append inline todos from final text (simple) when no extracted todos
  if (!displayText && activityText && status !== 'running') {
    const inlineTodos = extractTodosFromText(activityText);
    if (inlineTodos.length > 0) {
      const todoLines = inlineTodos.map(t => `- [ ] ${t}`).join('\n');
      displayText = `*Todo*\n${todoLines}\n────\n`;
    }
  }
  displayText += activityText || ':gear: Starting...';

  // Activity log section - expand: true prevents Slack "See more" collapse
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: displayText,
    },
    expand: true,
  } as Block);

  const isRunning = status === 'running';

  // Spinner line (in-progress only)
  if (isRunning) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${spinner || '\u25D0'} [${elapsedSec}s]` }],
    });
  }

  // Unified status line (mode | model | session [+ stats])
  const durationForStats = isRunning ? undefined : elapsedMs;
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: buildUnifiedStatusLine({
          mode,
          model,
          reasoningEffort,
          sandboxMode,
          sessionId,
          contextPercent,
          contextTokens,
          contextWindow,
          compactPercent,
          tokensToCompact,
          inputTokens,
          outputTokens,
          costUsd,
          durationMs: durationForStats,
        }),
      },
    ],
  });

  // Complete header with user mention (Claude-style - triggers Slack notification)
  // Only show in non-DM channels (DMs don't need @mention)
  if (status === 'completed' && params.userId && params.channelId && !params.channelId.startsWith('D')) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${params.userId}> :white_check_mark: *Complete*`,
      },
    });
  }

  // Abort button (only during processing)
  if (isRunning) {
    blocks.push({
      type: 'actions',
      block_id: `status_panel_${conversationKey}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_${conversationKey}`,
        },
      ],
    });
  }

  // Fork button on main activity/status panel - ONLY after query completes (matches ccslack UX)
  // During processing: show Abort button
  // After completion: show Fork button (replaces Abort)
  if (!isRunning && params.forkTurnIndex !== undefined && params.forkSlackTs) {
    blocks.push(
      buildForkButton({
        turnIndex: params.forkTurnIndex,
        slackTs: params.forkSlackTs,
        conversationKey,
      })
    );
  }

  return blocks;
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

/**
 * Build a modal view for abort confirmation.
 */
export function buildAbortConfirmationModalView(params: AbortConfirmationModalParams): {
  type: 'modal';
  callback_id: string;
  private_metadata: string;
  title: { type: 'plain_text'; text: string };
  submit: { type: 'plain_text'; text: string };
  close: { type: 'plain_text'; text: string };
  blocks: Block[];
} {
  return {
    type: 'modal',
    callback_id: 'abort_confirmation_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Confirm Abort' },
    submit: { type: 'plain_text', text: 'Abort' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':warning: *This will interrupt the current processing.*',
        },
      },
    ],
  };
}

// ============================================================================
// Thread Message Formatting (Ported from ccslack)
// ============================================================================

import type { ActivityEntry } from './activity-thread.js';

// Re-export shared markdown and truncation functions for backwards compatibility
export { stripMarkdownCodeFence, markdownToSlack, truncateWithClosedFormatting } from 'caia-slack';

// ============================================================================
// Thread Activity Formatting
// ============================================================================

// Re-export shared tool formatting functions for backwards compatibility
// Note: formatToolName here includes emoji (formatToolNameWithEmoji from shared)
export { normalizeToolName, getToolEmoji, formatToolInputSummary } from 'caia-slack';
import { formatToolNameWithEmoji } from 'caia-slack';

/**
 * Get formatted tool name with emoji.
 * Wrapper to maintain backwards compatibility - calls formatToolNameWithEmoji from shared.
 */
export function formatToolName(tool: string): string {
  return formatToolNameWithEmoji(tool);
}

/**
 * Format result metrics as inline summary for display.
 * Shows line counts, match counts, or edit diff depending on tool type.
 * Tool-aware: only shows lineCount for Read/Write, not for Bash.
 */
export function formatToolResultSummary(entry: ActivityEntry): string {
  const tool = normalizeToolName(entry.tool || '').toLowerCase();

  if (entry.matchCount !== undefined) {
    return ` → ${entry.matchCount} ${entry.matchCount === 1 ? 'match' : 'matches'}`;
  }
  // Only show lineCount for Read/Write tools, NOT for Bash commands
  if (entry.lineCount !== undefined && (tool === 'read' || tool === 'write')) {
    return ` (${entry.lineCount} lines)`;
  }
  if (entry.linesAdded !== undefined || entry.linesRemoved !== undefined) {
    return ` (+${entry.linesAdded || 0}/-${entry.linesRemoved || 0})`;
  }
  return '';
}

/**
 * Format tool output preview for display.
 * Handles different tool types with appropriate formatting.
 */
export function formatOutputPreview(tool: string, preview: string): string {
  const cleaned = preview.replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const toolLower = normalizeToolName(tool).toLowerCase();
  switch (toolLower) {
    case 'bash':
    case 'commandexecution':
      return `\`${cleaned.slice(0, 150)}\`${cleaned.length > 150 ? '...' : ''}`;
    case 'grep':
    case 'glob':
      const matches = preview.split('\n').filter(l => l.trim()).slice(0, 3);
      return matches.length ? matches.map(m => `\`${m.slice(0, 50)}\``).join(', ') : 'No matches';
    case 'read':
      return `\`${cleaned.slice(0, 100)}\`${cleaned.length > 100 ? '...' : ''}`;
    case 'websearch':
      return cleaned;
    default:
      return cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned;
  }
}

/**
 * Format tool details as bullet points for thread display.
 * Returns an array of detail lines to be prefixed with "• ".
 * Ported from ccslack - comprehensive tool-specific details.
 */
export function formatToolDetails(entry: ActivityEntry): string[] {
  const details: string[] = [];
  const tool = normalizeToolName(entry.tool || '').toLowerCase();
  const input = typeof entry.toolInput === 'object' ? entry.toolInput as Record<string, unknown> : undefined;

  // Tools with special UI - show duration only
  if (tool === 'askuserquestion') {
    if (entry.durationMs !== undefined) {
      details.push(`Duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
    }
    return details;
  }

  if (tool === 'read' && entry.lineCount !== undefined) {
    details.push(`Read: ${entry.lineCount} lines`);
  }
  if ((tool === 'edit' || tool === 'filechange') && (entry.linesAdded !== undefined || entry.linesRemoved !== undefined)) {
    details.push(`Changed: +${entry.linesAdded || 0}/-${entry.linesRemoved || 0} lines`);
  }
  if (tool === 'write' && entry.lineCount !== undefined) {
    details.push(`Wrote: ${entry.lineCount} lines`);
  }
  if (tool === 'grep') {
    if (input?.path) details.push(`Path: \`${input.path}\``);
    if (entry.matchCount !== undefined) details.push(`Found: ${entry.matchCount} matches`);
  }
  if (tool === 'glob' && entry.matchCount !== undefined) {
    details.push(`Found: ${entry.matchCount} files`);
  }
  if ((tool === 'bash' || tool === 'commandexecution') && input?.command) {
    details.push(`Command: \`${truncateText(input.command as string, 60)}\``);
  }
  if (tool === 'task') {
    if (input?.subagent_type) details.push(`Type: ${input.subagent_type}`);
    if (input?.description) details.push(`Task: ${truncateText(input.description as string, 50)}`);
  }
  if (tool === 'websearch') {
    if (input?.query) details.push(`Query: "${truncateText(input.query as string, 40)}"`);
    const url = entry.toolOutput || entry.toolOutputPreview;
    if (url) details.push(`URL: ${url}`);
  }
  if (tool === 'todowrite') {
    const todoItems = Array.isArray(input?.todos) ? input.todos.filter(isTodoItem) : [];
    if (todoItems.length > 0) {
      const completedCnt = todoItems.filter((t: TodoItem) => t.status === 'completed').length;
      const inProgressItems = todoItems.filter((t: TodoItem) => t.status === 'in_progress');
      const pendingCnt = todoItems.filter((t: TodoItem) => t.status === 'pending').length;
      const total = todoItems.length;

      if (completedCnt === total) {
        details.push(`All tasks completed`);
      } else {
        if (completedCnt > 0) details.push(`✓ ${completedCnt} completed`);
        for (const t of inProgressItems) {
          const text = t.activeForm || t.content;
          const truncated = text.length > 40 ? text.slice(0, 37) + '...' : text;
          details.push(`→ ${truncated}`);
        }
        if (pendingCnt > 0) details.push(`☐ ${pendingCnt} pending`);
      }
    }
  }

  // Generic fallback for unknown tools: show first 2 params
  if (details.length === 0 && input) {
    const params = Object.entries(input)
      .filter(([k, v]) => !k.startsWith('_') && v !== undefined && v !== null)
      .slice(0, 2);
    for (const [key, value] of params) {
      const displayValue = typeof value === 'string'
        ? truncateText(value, 40)
        : JSON.stringify(value).slice(0, 40);
      details.push(`${key}: \`${displayValue}\``);
    }
  }

  // Add output preview or error message before duration
  if (entry.toolIsError) {
    details.push(`:warning: Error: ${entry.toolErrorMessage?.slice(0, 100) || 'Unknown error'}`);
  } else if (entry.toolOutputPreview && tool !== 'websearch') {
    const outputPreview = formatOutputPreview(tool, entry.toolOutputPreview);
    if (outputPreview) {
      details.push(`Output: ${outputPreview}`);
    }
  }

  if (entry.durationMs !== undefined) {
    details.push(`Duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
  }

  return details;
}

/**
 * Format activity batch entries for thread posting.
 * Groups tool_start and tool_complete for the same tool.
 */
export function formatThreadActivityBatch(entries: ActivityEntry[]): string {
  if (entries.length === 0) return '';

  // Build set of completed tool IDs
  const completedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'tool_complete' && entry.toolUseId) {
      completedIds.add(entry.toolUseId);
    }
  }

  const lines: string[] = [];
  for (const entry of entries) {
    // Skip tool_start if we have a tool_complete for the same tool
    if (entry.type === 'tool_start' && entry.toolUseId && completedIds.has(entry.toolUseId)) {
      continue;
    }

    const line = formatThreadActivityEntry(entry);
    if (line) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

export function formatThreadActivityEntry(entry: ActivityEntry): string {
  const toolEmoji = entry.tool ? getToolEmoji(entry.tool) : ':gear:';
  const toolInput = entry.toolInput ? formatToolInputSummary(entry.tool || '', entry.toolInput) : '';
  const resultSummary = formatToolResultSummary(entry);

  switch (entry.type) {
    case 'starting':
      return ':brain: *Analyzing request...*';
    case 'thinking': {
      // Use :bulb: for thinking (matches ccslack)
      const thinkingStatus = entry.thinkingInProgress ? '...' : '';
      const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      const header = `:bulb: *Thinking${thinkingStatus}*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
      const lines: string[] = [header];
      if (entry.thinkingContent) {
        lines.push(entry.thinkingContent);
      }
      if (!entry.thinkingInProgress && entry.thinkingTruncated) {
        if (entry.thinkingAttachmentLink) {
          lines.push(`_Full response <${entry.thinkingAttachmentLink}|attached>._`);
        } else {
          lines.push('_Full content not attached._');
        }
      }
      return lines.join('\n');
    }
    case 'tool_start':
      return `${toolEmoji} *${normalizeToolName(entry.tool || '')}*${toolInput} [in progress]`;
    case 'tool_complete': {
      const lines: string[] = [];
      // Use tool emoji instead of :white_check_mark: for thread messages
      const header = `${toolEmoji} *${normalizeToolName(entry.tool || '')}*${toolInput}`;
      lines.push(header);

      // Add bullet point details
      const details = formatToolDetails(entry);
      if (details.length > 0) {
        lines.push(...details.map(d => `• ${d}`));
      }

      return lines.join('\n');
    }
    case 'generating': {
      const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      return `:memo: *Generating*...${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
    }
    case 'error':
      return `:x: *Error:* ${entry.message || 'Unknown error'}`;
    case 'aborted':
      return ':octagonal_sign: *Aborted by user*';
    default: {
      const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      return `${toolEmoji} ${entry.message || entry.type}${duration}`;
    }
  }
}

/**
 * Format thinking message for thread.
 * Shows duration and character count.
 * Uses :bulb: emoji (matches ccslack).
 */
export function formatThreadThinkingMessage(content: string, durationMs?: number): string {
  const durationStr = durationMs ? ` [${(durationMs / 1000).toFixed(1)}s]` : '';
  const charStr = ` _[${content.length} chars]_`;
  return `:bulb: *Thinking*${durationStr}${charStr}`;
}

/**
 * Format response message for thread.
 * Shows duration and character count.
 */
export function formatThreadResponseMessage(content: string, durationMs?: number): string {
  const durationStr = durationMs ? ` [${(durationMs / 1000).toFixed(1)}s]` : '';
  const charStr = ` _[${content.length} chars]_`;
  return `:speech_balloon: *Response*${durationStr}${charStr}`;
}

// ============================================================================
// Todo List Display (Ported from ccslack)
// ============================================================================

// Re-export shared todo functions for backwards compatibility
export { TODO_LIST_MAX_CHARS, isTodoItem, extractLatestTodos, formatTodoListDisplay, type TodoItem } from 'caia-slack';
