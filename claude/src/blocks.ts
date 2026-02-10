/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import { PermissionMode, LastUsage } from './session-manager.js';
import type { ModelInfo } from './model-cache.js';
import { MESSAGE_SIZE_DEFAULT } from './commands.js';
import {
  markdownToSlack,
  formatTokensK,
  formatTokenCount,
  computeAutoCompactThreshold,
  DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS,
  COMPACT_BUFFER,
  getToolEmoji,
  formatToolName,
  formatToolInputSummary,
  isTodoItem,
  extractLatestTodos,
  formatTodoListDisplay,
  TODO_LIST_MAX_CHARS,
  truncatePath,
  truncateText,
  truncateUrl,
  buildUnifiedStatusLine,
  buildActivityLogText,
  buildCombinedStatusBlocks,
  linkifyActivityLabel,
  formatToolResultSummary,
  ACTIVITY_LOG_MAX_CHARS,
  type Block,
  type TodoItem,
  type ActivityEntry,
  type StatusLineParams,
  type CombinedStatusParams,
} from 'caia-slack';

// Re-export shared types, constants, builders, and formatters for backwards compatibility
export type { Block, ActivityEntry, StatusLineParams, CombinedStatusParams } from 'caia-slack';
export {
  DEFAULT_CONTEXT_WINDOW,
  buildPathSetupBlocks,
  formatThreadStartingMessage,
  formatThreadErrorMessage,
  buildUnifiedStatusLine,
  buildActivityLogText,
  buildCombinedStatusBlocks,
  linkifyActivityLabel,
  formatToolResultSummary,
  ACTIVITY_LOG_MAX_CHARS,
  formatTokenCount,
} from 'caia-slack';

export interface StatusBlockParams {
  status: 'processing' | 'aborted' | 'error';
  messageTs?: string;
  errorMessage?: string;
}

export interface HeaderBlockParams {
  status: 'starting' | 'processing' | 'complete' | 'aborted' | 'error';
  mode: PermissionMode;
  conversationKey?: string; // For abort button
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Parameters for SDK AskUserQuestion tool blocks.
 * SDK uses {label, description} objects for options (vs simple strings in MCP ask_user).
 */
export interface SdkQuestionBlockParams {
  question: string;
  header: string;  // Short label (max 12 chars), e.g., "Auth method"
  options: Array<{ label: string; description: string }>;
  questionId: string;
  multiSelect: boolean;
  userId?: string;      // Optional - user to mention
  channelId?: string;   // Optional - skip mention in DMs
}

/**
 * Build blocks for SDK AskUserQuestion tool.
 * Displays questions with label+description options, matching CLI fidelity.
 */
export function buildSdkQuestionBlocks(params: SdkQuestionBlockParams): Block[] {
  const { question, header, options, questionId, multiSelect, userId, channelId } = params;
  const blocks: Block[] = [];
  const mention = (userId && channelId && !channelId.startsWith('D')) ? `<@${userId}> ` : '';

  // Header chip + question WITH mention
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${mention}*[${header}]* ${question}`,
    },
  });

  if (options && options.length > 0) {
    const useMultiSelect = multiSelect || options.length > 5;

    if (useMultiSelect) {
      // Show descriptions as context above the dropdown
      const descriptions = options.map(opt => `*${opt.label}:* ${opt.description}`).join('\n');
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: descriptions,
        },
      });

      // Multi-select dropdown
      blocks.push({
        type: "section",
        block_id: `sdkq_multiselect_${questionId}`,
        text: { type: "mrkdwn", text: "_Select one or more options:_" },
        accessory: {
          type: "multi_static_select",
          action_id: `sdkq_multi_${questionId}`,
          placeholder: { type: "plain_text", text: "Select options..." },
          options: options.map(opt => ({
            text: { type: "plain_text", text: opt.label },
            value: opt.label,
          })),
        },
      });

      // Submit + Abort buttons
      blocks.push({
        type: "actions",
        block_id: `sdkq_actions_${questionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Submit" },
            action_id: `sdkq_submit_${questionId}`,
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            action_id: `sdkq_abort_${questionId}`,
            style: "danger",
          },
        ],
      });
    } else {
      // Option buttons with descriptions shown in section text
      for (let i = 0; i < options.length; i++) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${options[i].label}*\n${options[i].description}`,
          },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Select" },
            action_id: `sdkq_${questionId}_${i}`,
            value: options[i].label,
          },
        });
      }

      // "Other" + Abort buttons
      blocks.push({ type: "divider" });
      blocks.push({
        type: "actions",
        block_id: `sdkq_extra_${questionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Other..." },
            action_id: `sdkq_other_${questionId}`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            action_id: `sdkq_abort_${questionId}`,
            style: "danger",
          },
        ],
      });
    }
  } else {
    // No options - show text input hint and abort
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Reply to this message with your answer_",
        },
      ],
    });

    blocks.push({
      type: "actions",
      block_id: `sdkq_extra_${questionId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Abort" },
          style: "danger",
          action_id: `sdkq_abort_${questionId}`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks for processing status messages.
 */
export function buildStatusBlocks(params: StatusBlockParams): Block[] {
  const { status, messageTs, errorMessage } = params;
  const blocks: Block[] = [];

  switch (status) {
    case 'processing':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "_Processing..._",
        },
      });
      if (messageTs) {
        blocks.push({
          type: "actions",
          block_id: `status_${messageTs}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Abort" },
              style: "danger",
              action_id: `abort_query_${messageTs}`,
            },
          ],
        });
      }
      break;

    case 'aborted':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Aborted*",
        },
      });
      break;

    case 'error':
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Error:* ${errorMessage || 'Unknown error'}`,
        },
      });
      break;
  }

  return blocks;
}

/**
 * Build blocks for header message showing processing status.
 * Shows: mode | model + Abort during processing
 * Shows: mode | model | tokens | time when complete
 */
export function buildHeaderBlocks(params: HeaderBlockParams): Block[] {
  const { status, mode, conversationKey, model, inputTokens, outputTokens, durationMs, errorMessage } = params;
  const blocks: Block[] = [];

  // SDK mode labels for UNIFIED display (maps to UnifiedMode: 'plan' | 'ask' | 'bypass')
  const modeLabels: Record<PermissionMode, string> = {
    plan: 'Plan',
    default: 'Ask',
    bypassPermissions: 'Bypass',
  };
  const modeLabel = modeLabels[mode] || mode;

  switch (status) {
    case 'starting':
      // Only mode known, waiting for init message
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${modeLabel}_`,
        }],
      });
      if (conversationKey) {
        blocks.push({
          type: "actions",
          block_id: `header_${conversationKey}`,
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            style: "danger",
            action_id: `abort_query_${conversationKey}`,
          }],
        });
      }
      break;

    case 'processing':
      // Model known, show mode | model
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${modeLabel} | ${model || 'Claude'}_`,
        }],
      });
      if (conversationKey) {
        blocks.push({
          type: "actions",
          block_id: `header_${conversationKey}`,
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "Abort" },
            style: "danger",
            action_id: `abort_query_${conversationKey}`,
          }],
        });
      }
      break;

    case 'complete':
      // Show mode | model | tokens | time
      const totalTokens = (inputTokens || 0) + (outputTokens || 0);
      const tokensStr = totalTokens > 0 ? `${totalTokens.toLocaleString()} tokens` : '';
      const durationStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';

      const parts = [modeLabel, model || 'Claude'];
      if (tokensStr) parts.push(tokensStr);
      if (durationStr) parts.push(durationStr);

      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${parts.join(' | ')}_`,
        }],
      });
      // No abort button when complete
      break;

    case 'aborted':
      // Show mode | model | aborted (or just mode | aborted if no model yet)
      const abortedParts = model ? [modeLabel, model, 'aborted'] : [modeLabel, 'aborted'];
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_${abortedParts.join(' | ')}_`,
        }],
      });
      break;

    case 'error':
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `_Error: ${errorMessage || 'Unknown error'}_`,
        }],
      });
      break;
  }

  return blocks;
}

/**
 * Build blocks for answered question display.
 */
export function buildAnsweredBlocks(question: string, answer: string): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Claude asked:* ${question}\n\n*You answered:* ${answer}`,
      },
    },
  ];
}

// ============================================================================
// Phase 3: Command Response Blocks
// ============================================================================

export interface StatusDisplayParams {
  sessionId: string | null;
  mode: PermissionMode;
  workingDir: string;
  lastActiveAt: number;
  pathConfigured: boolean;
  configuredBy: string | null;
  configuredAt: number | null;
  lastUsage?: LastUsage;
  maxThinkingTokens?: number;  // undefined = default (31,999), 0 = disabled
  updateRateSeconds?: number;  // undefined = 3 (default), range 1-10
  messageSize?: number;        // undefined = 500 (default), range 100-36000
  planFilePath?: string | null;  // Plan file path for plan mode
  planPresentationCount?: number;  // Count of plan presentations in current session
}

// Default thinking tokens for display
const THINKING_TOKENS_DEFAULT = 31999;
// Default update rate for display
const UPDATE_RATE_DEFAULT = 3;

/**
 * Build blocks for /status command response.
 */
export function buildStatusDisplayBlocks(params: StatusDisplayParams): Block[] {
  const { sessionId, mode, workingDir, lastActiveAt, pathConfigured, configuredBy, configuredAt, lastUsage, maxThinkingTokens, updateRateSeconds, messageSize, planFilePath, planPresentationCount } = params;

  // SDK mode emojis for display
  const modeEmoji: Record<PermissionMode, string> = {
    plan: ':clipboard:',
    default: ':question:',
    bypassPermissions: ':rocket:',
  };
  const lastActive = new Date(lastActiveAt).toLocaleString();

  const statusLines = [
    `*Session ID:* \`${sessionId || 'None'}\``,
    `*Mode:* ${modeEmoji[mode] || ''} ${mode}`,
    `*Working Directory:* \`${workingDir}\``,
    `*Last Active:* ${lastActive}`,
  ];

  // Add plan file path if set (only relevant in plan mode)
  if (planFilePath) {
    statusLines.push(`*Plan File:* \`${planFilePath}\``);
  }

  // Add plan presentation count if any plans have been shown
  if (planPresentationCount && planPresentationCount > 0) {
    statusLines.push(`*Plan Presentations:* ${planPresentationCount}`);
  }

  // Add model and context info if available
  if (lastUsage) {
    statusLines.push(`*Model:* ${lastUsage.model}`);
    const totalTokens = lastUsage.inputTokens + (lastUsage.cacheCreationInputTokens ?? 0) + lastUsage.cacheReadInputTokens;
    const contextPercent = lastUsage.contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((totalTokens / lastUsage.contextWindow) * 100)))
      : 0;
    statusLines.push(`*Context:* ${contextPercent}% (${totalTokens.toLocaleString()} / ${lastUsage.contextWindow.toLocaleString()} tokens)`);
  }

  // Add thinking tokens info
  if (maxThinkingTokens === 0) {
    statusLines.push(`*Thinking Tokens:* disabled`);
  } else if (maxThinkingTokens === undefined) {
    statusLines.push(`*Thinking Tokens:* ${THINKING_TOKENS_DEFAULT.toLocaleString()} (default)`);
  } else {
    statusLines.push(`*Thinking Tokens:* ${maxThinkingTokens.toLocaleString()}`);
  }

  // Add update rate info
  if (updateRateSeconds === undefined) {
    statusLines.push(`*Update Rate:* ${UPDATE_RATE_DEFAULT}s (default)`);
  } else {
    statusLines.push(`*Update Rate:* ${updateRateSeconds}s`);
  }

  // Add message size info
  if (messageSize === undefined) {
    statusLines.push(`*Message Size:* ${MESSAGE_SIZE_DEFAULT} (default)`);
  } else {
    statusLines.push(`*Message Size:* ${messageSize.toLocaleString()}`);
  }

  if (pathConfigured) {
    const configuredDate = new Date(configuredAt!).toLocaleString();
    statusLines.push(`*Path Configured:* ✅ Yes (by <@${configuredBy}> on ${configuredDate})`);
    statusLines.push(`*Path Locked:* Yes (cannot be changed)`);
  } else {
    statusLines.push(`*Path Configured:* ❌ No - use \`/path <directory>\` to set`);
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Session Status" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: statusLines.join('\n'),
      },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        // NOTE: Terminal detection disabled - see README.md for details
        text: ":warning: *Terminal detection:* _disabled (coming soon)_",
      }],
    },
  ];
}

// Re-export additional shared functions for backwards compatibility
export { computeAutoCompactThreshold, formatTokensK } from 'caia-slack';

/**
 * Build blocks for /context command response.
 * Shows context window usage with a visual progress bar.
 */
export function buildContextDisplayBlocks(usage: LastUsage): Block[] {
  const { inputTokens, outputTokens, cacheReadInputTokens, contextWindow, model } = usage;
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const percent = contextWindow > 0
    ? Number(((totalTokens / contextWindow) * 100).toFixed(1))
    : 0;
  const remaining = contextWindow - totalTokens;

  // Calculate % left until auto-compact triggers (CLI formula: denominator = threshold, not contextWindow)
  const autoCompactThreshold = computeAutoCompactThreshold(contextWindow, usage.maxOutputTokens);
  const compactPercent = autoCompactThreshold > 0
    ? Math.max(0, Number(((autoCompactThreshold - totalTokens) / autoCompactThreshold * 100).toFixed(1)))
    : 0;
  const tokensToCompact = Math.max(0, autoCompactThreshold - totalTokens);

  // Build visual progress bar using block characters (20 blocks total)
  const filled = Math.min(20, Math.max(0, Math.round(percent / 5)));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);

  // Determine health status
  let healthText: string;
  let healthEmoji: string;
  if (compactPercent <= 0) {
    healthText = 'Auto-compact imminent. Use `/compact` now.';
    healthEmoji = ':x:';
  } else if (compactPercent <= 10) {
    healthText = 'Context nearly full. Use `/compact` to reduce.';
    healthEmoji = ':x:';
  } else if (compactPercent <= 20) {
    healthText = 'Context usage high. Consider `/compact` to reduce.';
    healthEmoji = ':warning:';
  } else {
    healthText = 'Healthy context usage';
    healthEmoji = ':white_check_mark:';
  }

  // Format compact status
  const compactStatus = compactPercent > 0
    ? `*Auto-compact:* ${compactPercent.toFixed(1)}% remaining (${formatTokensK(tokensToCompact)} tok)`
    : `*Auto-compact:* imminent`;

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Context Usage" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Model:* ${model}`,
          `\n\`${bar}\` *${percent}%*`,
          `\n*Tokens used:* ${totalTokens.toLocaleString()} / ${contextWindow.toLocaleString()}`,
          `*Remaining:* ${remaining.toLocaleString()} tokens`,
          compactStatus,
          `\n_Breakdown:_`,
          `\u2022 Input: ${inputTokens.toLocaleString()}`,
          `\u2022 Output: ${outputTokens.toLocaleString()}`,
          `\u2022 Cache creation: ${cacheCreationInputTokens.toLocaleString()}`,
          `\u2022 Cache read: ${cacheReadInputTokens.toLocaleString()}`,
        ].join('\n'),
      },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `${healthEmoji} ${healthText}`,
      }],
    },
  ];
}

/**
 * Parameters for plan approval blocks.
 */
export interface PlanApprovalBlockParams {
  conversationKey: string;  // Used to identify the conversation for the response
  allowedPrompts?: { tool: string; prompt: string }[];  // Requested permissions from ExitPlanMode
  userId?: string;      // Optional for backwards compat - user to mention
  channelId?: string;   // Optional for backwards compat - skip mention in DMs
}

/**
 * Build blocks for plan approval prompt.
 * Shows CLI-fidelity 5-option approval UI matching the CLI behavior.
 * Displays requested permissions if provided.
 */
export function buildPlanApprovalBlocks(params: PlanApprovalBlockParams): Block[] {
  const { conversationKey, allowedPrompts, userId, channelId } = params;
  const blocks: Block[] = [];

  // User mention header (skip in DMs, skip if no userId)
  const mention = (userId && channelId && !channelId.startsWith('D')) ? `<@${userId}> ` : '';
  if (mention) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${mention}:clipboard: *Plan ready for approval*` },
    });
  }

  blocks.push({ type: "divider" });

  // Show requested permissions (matches CLI)
  if (allowedPrompts && allowedPrompts.length > 0) {
    const permList = allowedPrompts
      .map(p => `  · ${p.tool}(prompt: ${p.prompt})`)
      .join('\n');
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Requested permissions:*\n\`\`\`\n${permList}\n\`\`\`` },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Would you like to proceed?*" },
  });

  // 4 options:
  // 1. Yes, clear context and bypass permissions
  // 2. Yes, and bypass permissions
  // 3. Yes, manually approve edits
  // 4. Type here to tell Claude what to change
  blocks.push({
    type: "actions",
    block_id: `plan_approval_1_${conversationKey}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "1. Clear context & bypass" },
        action_id: `plan_clear_bypass_${conversationKey}`,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "2. Bypass permissions" },
        action_id: `plan_bypass_${conversationKey}`,
        style: "primary",
      },
    ],
  });

  blocks.push({
    type: "actions",
    block_id: `plan_approval_2_${conversationKey}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "3. Manual approve" },
        action_id: `plan_manual_${conversationKey}`,
      },
    ],
  });

  blocks.push({
    type: "actions",
    block_id: `plan_approval_3_${conversationKey}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "4. Change the plan" },
        action_id: `plan_reject_${conversationKey}`,
        style: "danger",
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: "_1: Fresh start + auto. 2: Auto-accept all. 3: Ask for each. 4: Revise plan._",
    }],
  });

  return blocks;
}

/**
 * Build blocks for /mode command (button selection).
 * Uses SDK permission mode names directly.
 */
export function buildModeSelectionBlocks(currentMode: PermissionMode): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Select Permission Mode*\nCurrent: \`${currentMode}\``,
      },
    },
    {
      type: "actions",
      block_id: "mode_selection",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":clipboard: plan" },
          action_id: "mode_plan",
          value: "plan",
          ...(currentMode === 'plan' ? { style: "primary" } : {}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":question: ask" },
          action_id: "mode_default",
          value: "default",
          ...(currentMode === 'default' ? { style: "primary" } : {}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":rocket: bypass" },
          action_id: "mode_bypassPermissions",
          value: "bypassPermissions",
          ...(currentMode === 'bypassPermissions' ? { style: "primary" } : {}),
        },
      ],
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "• *plan* - Read-only, writes to plan file\n• *ask* - Prompts for approval\n• *bypass* - Runs without approval",
      }],
    },
  ];
}

/**
 * Build model selection UI from dynamic model list.
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
    value: model.value,
    ...(currentModel === model.value ? { style: 'primary' as const } : {}),
  }));

  // Build description context
  const descriptions = models.slice(0, 5).map(m =>
    `• *${m.displayName}*: ${m.description}`
  ).join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Select Model*\nCurrent: \`${currentModel || 'default (SDK chooses)'}\``,
      },
    },
    {
      type: 'actions',
      block_id: 'model_selection',
      elements: buttons,
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: descriptions,
      }],
    },
  ];
}

/**
 * Build UI for when stored model is no longer available.
 * Shows warning and model selection.
 */
export function buildModelDeprecatedBlocks(
  deprecatedModel: string,
  models: ModelInfo[]
): Block[] {
  const selectionBlocks = buildModelSelectionBlocks(models, undefined);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *Model No Longer Available*\n\nYour selected model \`${deprecatedModel}\` is no longer supported. Please select a new model to continue.`,
      },
    },
    { type: 'divider' },
    ...selectionBlocks,
  ];
}

// ============================================================================
// Tool Approval Blocks (for manual approval mode)
// ============================================================================

/**
 * Parameters for tool approval blocks.
 */
export interface ToolApprovalBlockParams {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  userId?: string;      // Optional - user to mention
  channelId?: string;   // Optional - skip mention in DMs
}

/**
 * Format tool input for display in Slack.
 * Truncates long values to keep the message readable.
 */
export function formatToolInput(input: Record<string, unknown>): string {
  const str = JSON.stringify(input, null, 2);
  return str.length > 500 ? str.slice(0, 500) + '...' : str;
}

/**
 * Build blocks for tool approval request.
 * Shown when in default mode and Claude wants to use a tool.
 */
export function buildToolApprovalBlocks(params: ToolApprovalBlockParams): Block[] {
  const { approvalId, toolName, toolInput, userId, channelId } = params;
  const inputPreview = formatToolInput(toolInput);
  const mention = (userId && channelId && !channelId.startsWith('D')) ? `<@${userId}> ` : '';

  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${mention}*Claude wants to use:* \`${toolName}\`\n\`\`\`${inputPreview}\`\`\``,
      },
    },
    {
      type: 'actions',
      block_id: `tool_approval_${approvalId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: `tool_approve_${approvalId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger',
          action_id: `tool_deny_${approvalId}`,
        },
      ],
    },
  ];
}

// ============================================================================
// Thread-to-Thread Fork Blocks
// ============================================================================

/**
 * Parameters for fork anchor blocks.
 */
export interface ForkAnchorBlockParams {
  forkPointLink: string;
}

/**
 * Build blocks for the anchor message when forking from thread to thread.
 * This message serves as the parent for the new forked thread.
 */
export function buildForkAnchorBlocks(params: ForkAnchorBlockParams): Block[] {
  const { forkPointLink } = params;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔀 Point-in-time fork from <${forkPointLink}|this message>`,
      },
    },
  ];
}

// ============================================================================
// Fork to Channel Modal
// ============================================================================

export interface ForkToChannelModalMetadata {
  sourceChannelId: string;
  sourceMessageTs: string;
  conversationKey: string;
  threadTs?: string;
  sdkMessageId?: string;
  sessionId?: string;
}

/**
 * Build modal view for "Fork here" → new channel creation.
 * User enters channel name, modal creates channel with forked session.
 */
export function buildForkToChannelModalView(params: {
  sourceChannelId: string;
  sourceMessageTs: string;
  conversationKey: string;
  threadTs?: string;
  sdkMessageId?: string;
  sessionId?: string;
  suggestedChannelName?: string;
}): any {
  const inputElement: any = {
    type: 'plain_text_input',
    action_id: 'channel_name_input',
    placeholder: { type: 'plain_text', text: 'my-fork-channel' },
    max_length: 80,
  };

  // Prefill with suggested name if provided
  if (params.suggestedChannelName) {
    inputElement.initial_value = params.suggestedChannelName;
  }

  return {
    type: 'modal',
    callback_id: 'fork_to_channel_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Fork to New Channel' },
    submit: { type: 'plain_text', text: 'Create Channel' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Create a new channel with a forked conversation state from this point.',
        },
      },
      {
        type: 'input',
        block_id: 'channel_name_block',
        element: inputElement,
        label: { type: 'plain_text', text: 'Channel Name' },
        hint: { type: 'plain_text', text: 'Lowercase letters, numbers, hyphens, and underscores only' },
      },
    ],
  };
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

/**
 * Build modal view for abort confirmation (prevents accidental fat-finger clicks).
 */
export function buildAbortConfirmationModalView(params: {
  abortType: 'query' | 'question' | 'sdk_question';
  key: string;
  channelId: string;
  messageTs: string;
}): any {
  let bodyText: string;
  switch (params.abortType) {
    case 'query':
      bodyText = 'This will interrupt Claude\'s current processing.';
      break;
    case 'question':
      bodyText = 'This will abort the current question.';
      break;
    case 'sdk_question':
      bodyText = 'This will abort Claude\'s question.';
      break;
  }

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
        text: { type: 'mrkdwn', text: `:warning: *${bodyText}*` },
      },
    ],
  };
}

// ============================================================================
// Real-Time Processing Feedback Blocks
// ============================================================================

// Re-export TODO_LIST_MAX_CHARS for backwards compatibility
export { TODO_LIST_MAX_CHARS } from 'caia-slack';

// Re-export todo functions for backwards compatibility
export { isTodoItem, extractLatestTodos, formatTodoListDisplay, type TodoItem } from 'caia-slack';

/**
 * Parameters for status panel blocks.
 */
export interface StatusPanelParams {
  status: 'starting' | 'thinking' | 'tool' | 'complete' | 'error' | 'aborted' | 'generating';
  mode: PermissionMode;
  model?: string;
  currentTool?: string;
  toolsCompleted: number;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  contextPercent?: number;
  compactPercent?: number;  // % left until auto-compact triggers
  tokensToCompact?: number;  // Tokens remaining before auto-compact
  costUsd?: number;
  conversationKey: string;
  errorMessage?: string;
  spinner?: string;  // Current spinner frame (cycles to show bot is alive)
  rateLimitHits?: number;  // Number of Slack rate limits encountered
  customStatus?: string;  // Custom status text (overrides default for thinking/complete)
}

// Re-export tool formatting functions for backwards compatibility
export { getToolEmoji, formatToolName, formatToolInputSummary } from 'caia-slack';

// formatToolResultSummary re-exported from caia-slack at top of file

/**
 * Format tool details as bullet points for thread display.
 * Returns an array of detail lines to be prefixed with "• ".
 */
export function formatToolDetails(entry: ActivityEntry): string[] {
  const details: string[] = [];
  const tool = formatToolName(entry.tool || '').toLowerCase();
  const input = entry.toolInput;

  // Tools with special UI - show duration only
  if (tool === 'askuserquestion') {
    // Has its own button UI, just show duration (added at end)
    if (entry.durationMs !== undefined) {
      details.push(`Duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
    }
    return details;
  }

  if (tool === 'read' && entry.lineCount !== undefined) {
    details.push(`Read: ${entry.lineCount} lines`);
  }
  if (tool === 'edit' && (entry.linesAdded !== undefined || entry.linesRemoved !== undefined)) {
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
  if (tool === 'bash' && input?.command) {
    details.push(`Command: \`${input.command}\``);
  }
  if (tool === 'task') {
    if (input?.subagent_type) details.push(`Type: ${input.subagent_type}`);
    if (input?.description) details.push(`Task: ${input.description}`);
  }
  if (tool === 'lsp') {
    if (input?.operation) details.push(`Operation: ${input.operation}`);
    if (input?.filePath) details.push(`File: \`${input.filePath}\``);
    if (input?.line) details.push(`Line: ${input.line}`);
  }
  if (tool === 'websearch') {
    if (input?.query) details.push(`Query: "${input.query}"`);
  }
  if (tool === 'todowrite') {
    const todoItems = Array.isArray(input?.todos) ? input.todos.filter(isTodoItem) : [];
    if (todoItems.length > 0) {
      const completedCnt = todoItems.filter((t: TodoItem) => t.status === 'completed').length;
      const inProgressItems = todoItems.filter((t: TodoItem) => t.status === 'in_progress');
      const pendingCnt = todoItems.filter((t: TodoItem) => t.status === 'pending').length;
      const total = todoItems.length;

      // All completed special case
      if (completedCnt === total) {
        details.push(`All tasks completed`);
      } else {
        // Show breakdown
        if (completedCnt > 0) details.push(`✓ ${completedCnt} completed`);
        // Show each in_progress task
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
  } else if (entry.toolOutputPreview) {
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
 * Format tool output preview for display.
 * Handles different tool types with appropriate formatting.
 */
export function formatOutputPreview(tool: string, preview: string): string {
  const cleaned = preview.replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  switch (tool) {
    case 'bash':
      return `\`${cleaned.slice(0, 150)}\`${cleaned.length > 150 ? '...' : ''}`;
    case 'grep':
    case 'glob':
      const matches = preview.split('\n').filter(l => l.trim()).slice(0, 3);
      return matches.length ? matches.map(m => `\`${m.slice(0, 50)}\``).join(', ') : 'No matches';
    case 'read':
      return `\`${cleaned.slice(0, 100)}\`${cleaned.length > 100 ? '...' : ''}`;
    default:
      return cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned;
  }
}

/**
 * Build blocks for status panel (Message 1).
 * Shows mode, model, current activity, and abort button during processing.
 * Shows final stats (tokens, context %, cost) on completion.
 */
export function buildStatusPanelBlocks(params: StatusPanelParams): Block[] {
  const {
    status,
    mode,
    model,
    currentTool,
    toolsCompleted,
    elapsedMs,
    inputTokens,
    outputTokens,
    contextPercent,
    compactPercent,
    tokensToCompact,
    costUsd,
    conversationKey,
    errorMessage,
    spinner,
    rateLimitHits,
    customStatus,
  } = params;

  const blocks: Block[] = [];

  // SDK mode labels for UNIFIED display (maps to UnifiedMode: 'plan' | 'ask' | 'bypass')
  const modeLabels: Record<PermissionMode, string> = {
    plan: 'Plan',
    default: 'Ask',
    bypassPermissions: 'Bypass',
  };
  const modeLabel = modeLabels[mode] || mode;

  // Format elapsed time
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  switch (status) {
    case 'starting':
      // Header with spinner and elapsed time
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:robot_face: *Claude is working...* ${spinner || ''} [${elapsedSec}s]`,
        },
      });
      // Status line
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${modeLabel} | Starting..._`,
        }],
      });
      // Abort button only (no View Log)
      blocks.push({
        type: 'actions',
        block_id: `status_panel_${conversationKey}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_query_${conversationKey}`,
        }],
      });
      break;

    case 'thinking':
    case 'tool':
    case 'generating':
      // Header with spinner and elapsed time
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:robot_face: *Claude is working...* ${spinner || ''} [${elapsedSec}s]`,
        },
      });
      // Build status line with current activity
      const activityParts = [modeLabel];
      if (model) activityParts.push(model);
      if (customStatus) {
        activityParts.push(customStatus);
      } else if (status === 'thinking') {
        activityParts.push('Thinking...');
      } else if (status === 'generating') {
        activityParts.push('Generating...');
      } else if (currentTool) {
        activityParts.push(`Running: ${currentTool}`);
      }
      if (toolsCompleted > 0) {
        activityParts.push(`Tools: ${toolsCompleted}`);
      }
      activityParts.push(`${elapsedSec}s`);
      if (rateLimitHits && rateLimitHits > 0) {
        activityParts.push(`:warning: ${rateLimitHits} rate limit${rateLimitHits > 1 ? 's' : ''}`);
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${activityParts.join(' | ')}_`,
        }],
      });
      // Abort button only (no View Log)
      blocks.push({
        type: 'actions',
        block_id: `status_panel_${conversationKey}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_query_${conversationKey}`,
        }],
      });
      break;

    case 'complete':
      // Header
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':white_check_mark: *Complete*',
        },
      });
      // Build final stats line
      const statsParts = [modeLabel];
      if (model) statsParts.push(model);
      if (customStatus) {
        // Use custom status text for completion (e.g., compaction results)
        statsParts.push(customStatus);
      } else {
        if (inputTokens || outputTokens) {
          const inStr = inputTokens ? inputTokens.toLocaleString() : '0';
          const outStr = outputTokens ? outputTokens.toLocaleString() : '0';
          statsParts.push(`${inStr} in / ${outStr} out`);
        }
        if (contextPercent !== undefined) {
          if (compactPercent !== undefined && compactPercent > 0) {
            statsParts.push(`${contextPercent}% ctx (${compactPercent}% to compact)`);
          } else if (compactPercent !== undefined && compactPercent <= 0) {
            statsParts.push(`${contextPercent}% ctx (compact soon)`);
          } else {
            statsParts.push(`${contextPercent}% ctx`);
          }
        }
        if (costUsd !== undefined) {
          statsParts.push(`$${costUsd.toFixed(4)}`);
        }
      }
      statsParts.push(`${elapsedSec}s`);
      if (rateLimitHits && rateLimitHits > 0) {
        statsParts.push(`:warning: ${rateLimitHits} rate limit${rateLimitHits > 1 ? 's' : ''}`);
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${statsParts.join(' | ')}_`,
        }],
      });
      // No abort button when complete
      break;

    case 'error':
      // Header
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':x: *Error*',
        },
      });
      // Error message (customStatus takes precedence if provided)
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${customStatus || errorMessage || 'Unknown error'}_`,
        }],
      });
      break;

    case 'aborted':
      // Header
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':octagonal_sign: *Aborted*',
        },
      });
      // Status line
      const abortedParts = [modeLabel];
      if (model) abortedParts.push(model);
      abortedParts.push('aborted');
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_${abortedParts.join(' | ')}_`,
        }],
      });
      break;
  }

  return blocks;
}

// CombinedStatusParams re-exported from caia-slack at top of file

// MODE_LABELS and formatTokenCount now imported from caia-slack

// buildUnifiedStatusLine re-exported from caia-slack at top of file

// buildCombinedStatusBlocks and buildActivityLogText re-exported from caia-slack at top of file



/**
 * Build blocks for LIVE activity display (during processing).
 * Shows rolling activity with thinking previews, tool durations, etc.
 * Used by /watch and /ff for in-progress turns AND completed turns.
 * Fork button shown only on final segment when forkInfo is provided.
 *
 * @param activityEntries - Activity entries to display
 * @param inProgress - Whether this segment is still in progress
 * @param isFinalSegment - Whether this is the final segment (shows Fork button)
 * @param forkInfo - Fork button info (required for Fork button to show)
 */
export function buildLiveActivityBlocks(
  activityEntries: ActivityEntry[],
  inProgress: boolean = true,
  isFinalSegment: boolean = false,
  forkInfo?: { threadTs?: string; conversationKey: string; sdkMessageId?: string; sessionId?: string }
): Block[] {
  const activityText = buildActivityLogText(activityEntries, inProgress, ACTIVITY_LOG_MAX_CHARS);

  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: activityText,
      },
    },
  ];

  // Fork button only on final segment when forkInfo is provided
  if (isFinalSegment && forkInfo) {
    blocks.push({
      type: 'actions',
      block_id: `activity_actions_fork`,
      elements: [
        {
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
        },
      ],
    });
  }

  return blocks;
}

// ============================================================================
// Terminal Watcher Blocks
// ============================================================================

/**
 * Build a "Stop Watching" button for terminal watch mode.
 * Used by both /watch and /ff commands to show consistent button styling.
 *
 * @param sessionId - The session ID being watched
 * @param threadTs - Optional thread ts for watcher lookup (anchor ts for thread-based output)
 * @returns Block with danger-styled button
 */
export function buildStopWatchingButton(sessionId: string, threadTs?: string): Block {
  return {
    type: 'actions',
    block_id: `terminal_watch_${sessionId}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '🛑 Stop Watching', emoji: true },
      action_id: 'stop_terminal_watch',
      style: 'danger',
      value: JSON.stringify({ sessionId, threadTs }),
    }],
  };
}

/**
 * Build a Stop Watching button that includes the update rate in the button text.
 * Compact single-element display for terminal watch status.
 *
 * @param sessionId - The session ID being watched
 * @param updateRateSeconds - Update rate in seconds (e.g., 2)
 * @param threadTs - Optional thread ts for watcher lookup (anchor ts for thread-based output)
 * @returns Actions block with stop button including rate info
 */
export function buildWatchingStatusSection(sessionId: string, updateRateSeconds: number, threadTs?: string): Block {
  return {
    type: 'actions',
    block_id: `terminal_watch_${sessionId}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: `🛑 Stop Watching (${updateRateSeconds}s)`, emoji: true },
      action_id: 'stop_terminal_watch',
      style: 'danger',
      value: JSON.stringify({ sessionId, threadTs }),
    }],
  };
}

// ============================================================================
// Thread Activity Formatting Functions
// ============================================================================

/**
 * Format batched activity entries for thread posting.
 * Shows completed tools with checkmarks, in-progress tools with gear.
 *
 * @param entries - Activity entries to format (typically tool_start/tool_complete)
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadActivityBatch(entries: ActivityEntry[]): string {
  if (entries.length === 0) return '';

  // Build set of completed tools to avoid showing both start and complete
  const completedTools = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'tool_complete' && entry.tool) {
      completedTools.add(entry.tool);
    }
  }

  const lines: string[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case 'starting':
        lines.push(':brain: *Analyzing request...*');
        break;
      case 'tool_start':
        // Only show tool_start if tool hasn't completed yet
        if (!completedTools.has(entry.tool || '')) {
          const emoji = getToolEmoji(entry.tool);
          const inputSummary = formatToolInputSummary(entry.tool || '', entry.toolInput);
          lines.push(`${emoji} *${formatToolName(entry.tool || 'Unknown')}*${inputSummary} [in progress]`);
        }
        break;
      case 'tool_complete':
        const tcEmoji = getToolEmoji(entry.tool);
        const tcInputSummary = formatToolInputSummary(entry.tool || '', entry.toolInput);
        lines.push(`${tcEmoji} *${formatToolName(entry.tool || 'Unknown')}*${tcInputSummary}`);

        // Add detail bullet points
        const details = formatToolDetails(entry);
        for (const detail of details) {
          lines.push(`• ${detail}`);
        }
        lines.push('');  // Empty line between tools
        break;
      case 'error':
        lines.push(`:x: *Error:* ${entry.message || 'Unknown error'}`);
        break;
      case 'mode_changed':
        lines.push(`:gear: *Mode changed* → \`${entry.mode}\``);
        break;
      case 'context_cleared':
        lines.push('────── Context Cleared ──────');
        break;
      case 'session_changed':
        if (entry.previousSessionId) {
          lines.push(`:bookmark: *Previous session:* \`${entry.previousSessionId}\``);
          lines.push('• _Use_ `/resume` _to return to this session_');
        }
        break;
      case 'aborted':
        lines.push(':octagonal_sign: *Aborted by user*');
        break;
      // Thinking and generating get their own messages, not batched
    }
  }

  return lines.join('\n').trim();
}

/**
 * Options for formatting thinking messages.
 */
export interface ThinkingMessageOptions {
  /** If true, show rolling tail (last N chars) instead of head (first N chars) */
  preserveTail?: boolean;
  /** Link to file message for cross-linking */
  attachmentLink?: string;
}

/**
 * Format thinking message for thread posting.
 * Shows thinking duration, char count, and preview.
 *
 * @param entry - Thinking activity entry
 * @param truncated - Whether the content was truncated (will have .md attachment)
 * @param charLimit - Character limit for display
 * @param options - Optional settings for formatting
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadThinkingMessage(
  entry: ActivityEntry,
  truncated: boolean,
  charLimit: number,
  options?: ThinkingMessageOptions
): string {
  const content = entry.thinkingContent || entry.thinkingTruncated || '';
  const charCount = content.length;
  const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
  const charInfo = charCount > 0 ? ` _${charCount.toLocaleString()} chars_` : '';

  const lines: string[] = [];

  if (entry.thinkingInProgress) {
    // During streaming: keep rolling tail format with markdown preserved
    lines.push(`:brain: *Thinking...*${duration}${charInfo}`);
    // Show rolling tail (last N chars) of thinking content
    if (content) {
      const preview = content.length > charLimit
        ? content.substring(content.length - charLimit)  // last N chars
        : content;
      lines.push(preview);
    }
  } else {
    // Completed: apply markdownToSlack, preserve newlines
    lines.push(`:bulb: *Thinking*${duration}${charInfo}`);

    if (content) {
      const slackFormatted = markdownToSlack(content);
      let displayText: string;

      if (options?.preserveTail && slackFormatted.length > charLimit) {
        // Preserve tail (rolling window) - shows conclusion
        displayText = '...' + slackFormatted.substring(slackFormatted.length - charLimit);
      } else if (slackFormatted.length > charLimit) {
        // Default: show head (first N chars)
        displayText = slackFormatted.substring(0, charLimit) + '...';
      } else {
        displayText = slackFormatted;
      }

      lines.push(displayText);
    }

    // Add suffix based on truncation and attachment link
    if (truncated && options?.attachmentLink) {
      // Cross-link to file message
      lines.push(`_Full response <${options.attachmentLink}|attached>._`);
    } else if (truncated && options && !options.attachmentLink) {
      // Options provided but no link - waiting for upload or showing retry button
      // (button will be added separately in blocks)
    } else if (truncated) {
      // Legacy fallback (no options provided)
      lines.push('_Full content attached._');
    }
  }

  return lines.join('\n');
}

/**
 * Metadata stored in retry button value for retrieving thinking content.
 */
export interface AttachThinkingButtonValue {
  threadParentTs: string;
  channelId: string;
  sessionId: string;
  thinkingTimestamp: number;
  thinkingCharCount: number;
  activityMsgTs: string;
}

/**
 * Build "Attach Response" button for failed file uploads.
 * Button stores minimal metadata; content is read from session file on click.
 *
 * @param activityMsgTs - The thinking message ts to update
 * @param threadParentTs - Thread parent ts for uploading files
 * @param channelId - Channel ID
 * @param sessionId - Session ID for looking up thinking content
 * @param thinkingTimestamp - entry.timestamp for session file lookup
 * @param thinkingCharCount - content.length for verification
 * @returns Actions block with retry button
 */
export function buildAttachThinkingFileButton(
  activityMsgTs: string,
  threadParentTs: string,
  channelId: string,
  sessionId: string,
  thinkingTimestamp: number,
  thinkingCharCount: number
): Block {
  const value: AttachThinkingButtonValue = {
    threadParentTs,
    channelId,
    sessionId,
    thinkingTimestamp,
    thinkingCharCount,
    activityMsgTs,
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
  };
}

/**
 * Format response message for thread posting.
 * Shows response duration, char count, and preview.
 *
 * @param charCount - Number of characters in the response
 * @param durationMs - Duration in milliseconds
 * @param preview - Preview text (first ~300 chars)
 * @param truncated - Whether the content was truncated (will have .md attachment)
 * @returns Formatted mrkdwn text for thread message
 */
export function formatThreadResponseMessage(
  charCount: number,
  durationMs: number | undefined,
  content: string,
  truncated: boolean,
  charLimit: number
): string {
  // Convert markdown to Slack format (same as main channel)
  const slackFormatted = markdownToSlack(content);

  const lines: string[] = [];
  lines.push(':speech_balloon: *Response*');  // Same emoji as main channel

  // Show content with newlines preserved (up to charLimit)
  if (slackFormatted) {
    const displayText = slackFormatted.length > charLimit
      ? slackFormatted.substring(0, charLimit) + '...'
      : slackFormatted;
    lines.push(displayText);
  }

  if (truncated) {
    lines.push('_Full content attached._');
  }

  return lines.join('\n');
}
