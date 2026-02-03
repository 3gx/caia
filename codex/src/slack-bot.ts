/**
 * Main Slack bot for Codex integration.
 *
 * Uses Slack Bolt framework with Socket Mode for real-time events.
 * Integrates with Codex App-Server for AI capabilities.
 */

import { App, LogLevel } from '@slack/bolt';
import type { UnifiedMode } from '../../slack/src/session/types.js';
import { Mutex } from 'async-mutex';
import { ApprovalRequestWithId, TurnContent, ReasoningEffort } from './codex-client.js';
import { makeConversationKey, StreamingContext } from './streaming.js';
import { CodexPool } from './codex-pool.js';
import { ConversationTracker, type ActiveContext } from '../../slack/src/session/conversation-tracker.js';
import {
  handleCommand,
  CommandContext,
  parseCommand,
  FALLBACK_MODELS,
  getModelInfo,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
} from './commands.js';
import {
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  getOrCreateThreadSession,
  getEffectiveWorkingDir,
  getEffectiveMode,
  getEffectiveThreadId,
  recordTurn,
  deleteChannelSession,
  saveModelSettings,
  saveMode,
  mapModeToApprovalPolicy,
} from './session-manager.js';
import {
  buildActivityBlocks,
  buildModeStatusBlocks,
  buildModelSelectionBlocks,
  buildReasoningSelectionBlocks,
  buildModelConfirmationBlocks,
  buildModelPickerCancelledBlocks,
  buildModePickerCancelledBlocks,
  buildErrorBlocks,
  buildTextBlocks,
  buildAbortConfirmationModalView,
  buildForkToChannelModalView,
  formatThreadResponseMessage,
  buildActivityEntryBlocks,
  formatThreadActivityEntry,
  buildPathSetupBlocks,
  Block,
} from './blocks.js';
import { withSlackRetry } from '../../slack/src/retry.js';
import { toUserMessage } from '../../slack/src/errors.js';
import { markProcessingStart, markApprovalWait, removeProcessingEmoji } from './emoji-reactions.js';
import { markAborted } from './abort-tracker.js';
import { processSlackFiles, SlackFile, writeTempFile } from '../../slack/src/file-handler.js';
import { buildMessageContent } from './content-builder.js';
import { uploadFilesToThread, uploadMarkdownAndPngWithResponse, getMessagePermalink, type ActivityEntry } from './activity-thread.js';
import { THINKING_MESSAGE_SIZE } from './commands.js';

// ============================================================================
// Pending Model Selection Tracking (for emoji cleanup)
// ============================================================================

interface PendingModelSelection {
  originalTs: string;   // User's message timestamp (for emoji cleanup)
  channelId: string;
  threadTs?: string;
}

// Track pending model selections for emoji cleanup
export const pendingModelSelections = new Map<string, PendingModelSelection>();
interface PendingModeSelection {
  originalTs: string;
  channelId: string;
  threadTs?: string;
}
export const pendingModeSelections = new Map<string, PendingModeSelection>();

interface BusyContext extends ActiveContext {
  channelId: string;
  threadTs?: string;
}

const conversationTracker = new ConversationTracker<BusyContext>();

// Global instances
let app: App;
let codexPool: CodexPool;

// Helper functions for runtime access
async function getRuntime(conversationKey: string) {
  return await codexPool.getRuntime(conversationKey);
}

function getRuntimeIfExists(conversationKey: string) {
  return codexPool.getRuntimeIfExists(conversationKey);
}

// Mutex management for message updates (fork link/refresh)
const updateMutexes = new Map<string, Mutex>();
function getUpdateMutex(key: string): Mutex {
  if (!updateMutexes.has(key)) {
    updateMutexes.set(key, new Mutex());
  }
  return updateMutexes.get(key)!;
}

/**
 * Extract the bot user ID from an app mention.
 */
function extractBotMention(text: string, botUserId: string): string {
  const mentionPattern = new RegExp(`<@${botUserId}>\\s*`, 'g');
  return text.replace(mentionPattern, '').trim();
}

export function getAppMentionRejection(
  channelId: string,
  threadTs?: string
): { text: string; threadTs?: string } | null {
  if (!channelId.startsWith('C')) {
    return {
      text: '❌ This bot only works in channels, not in direct messages.',
      threadTs,
    };
  }
  if (threadTs) {
    return {
      text: '❌ @bot can only be mentioned in the main channel, not in threads.',
      threadTs,
    };
  }
  return null;
}

/**
 * Start the Slack bot.
 */
export async function startBot(): Promise<void> {
  // Validate environment
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    console.error('Missing required environment variables:');
    if (!botToken) console.error('  - SLACK_BOT_TOKEN');
    if (!appToken) console.error('  - SLACK_APP_TOKEN');
    if (!signingSecret) console.error('  - SLACK_SIGNING_SECRET');
    process.exit(1);
  }

  // Start a temporary Codex client to verify authentication
  const { CodexClient } = await import('./codex-client.js');
  const authCodex = new CodexClient();
  authCodex.on('error', (error) => {
    console.error('Codex auth check error:', error);
  });
  console.log('Starting Codex App-Server (auth check)...');
  await authCodex.start();

  // Verify authentication
  const account = await authCodex.getAccount();
  if (!account) {
    console.error('Codex not authenticated. Please run `codex auth login` first.');
    process.exit(1);
  }
  console.log(`Codex authenticated as ${account.type}${account.email ? ` (${account.email})` : ''}`);
  await authCodex.stop();

  // Initialize Slack app
  app = new App({
    token: botToken,
    appToken: appToken,
    signingSecret: signingSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Initialize per-session Codex pool
  codexPool = new CodexPool(app.client, {
    onTurnCompleted: (context) => {
      conversationTracker.stopProcessing(context.threadId);
    },
  });

  // Register event handlers
  setupEventHandlers();

  // Start the app
  await app.start();
  console.log('Codex Slack bot is running!');
}

/**
 * Stop the Slack bot.
 */
export async function stopBot(): Promise<void> {
  console.log('Stopping Codex Slack bot...');
  // Stop all Codex runtimes (streaming + codex processes)
  await codexPool?.stopAll();
  await app?.stop();
  console.log('Codex Slack bot stopped.');
}

/**
 * Set up Slack event handlers.
 */
function setupEventHandlers(): void {
  // Handle app mentions (@codex)
  app.event('app_mention', async ({ event, say, client }) => {
    const channelId: string = event.channel;
    const threadTs: string | undefined = event.thread_ts;
    const messageTs: string = event.ts;
    const eventFiles = (event as unknown as { files?: SlackFile[] }).files;
    // Always reply in a thread: use existing thread or create new one under user's message
    const replyThreadTs = threadTs ?? messageTs;

    try {
      const rejection = getAppMentionRejection(channelId, threadTs);
      if (rejection) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: rejection.threadTs ?? replyThreadTs,
          text: rejection.text,
        });
        return;
      }
      const userId: string = event.user || '';
      const botUserId = (await client.auth.test()).user_id as string;
      const text: string = extractBotMention(event.text, botUserId);

      if (!text) {
        await say({
          thread_ts: replyThreadTs,
          text: 'Hello! How can I help you? Try asking me a question or use `/help` for commands.',
        });
        return;
      }

      await handleUserMessage(channelId, threadTs, userId, text, messageTs, eventFiles);
    } catch (error) {
      console.error('Error handling app_mention:', error);
      await say({
        thread_ts: replyThreadTs,
        text: toUserMessage(error),
      });
    }
  });

  // Handle direct messages
  app.event('message', async ({ event, say }) => {
    // Type guard for message events
    const msg = event as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      thread_ts?: string;
      user?: string;
      text?: string;
      ts: string;
      files?: SlackFile[];
    };

    // Skip bot messages and app mentions (handled separately)
    if (msg.bot_id || msg.subtype) {
      return;
    }

    // Only handle DMs (channel IDs starting with D)
    if (!msg.channel.startsWith('D')) {
      return;
    }

    const channelId = msg.channel;
    const threadTs = msg.thread_ts;
    const messageTs = msg.ts;
    const userId = msg.user || '';
    const text = msg.text || '';
    // For DMs, always reply in thread to keep conversation organized
    const replyThreadTs = threadTs ?? messageTs;

    if (!text.trim() || !userId) {
      return;
    }

    try {
      await handleUserMessage(channelId, threadTs, userId, text, messageTs, msg.files);
    } catch (error) {
      console.error('Error handling message:', error);
      await say({
        thread_ts: replyThreadTs,
        text: toUserMessage(error),
      });
    }
  });

  // Handle abort confirmation modal submission
  app.view('abort_confirmation_modal', async ({ ack, view }) => {
    await ack();
    // Mark as aborted before interrupting so status transition knows
    // Modal private_metadata contains: { conversationKey, channelId, messageTs }
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { conversationKey } = metadata;
    if (conversationKey) {
      const runtime = getRuntimeIfExists(conversationKey);
      if (runtime) {
        // IMMEDIATELY clear the timer (don't wait for turn:completed)
        runtime.streaming.clearTimer(conversationKey);
        markAborted(conversationKey);
        // Queue abort - will execute immediately if turnId available,
        // or wait for turn:started/context:turnId if not
        runtime.streaming.queueAbort(conversationKey);
      }
    }
  });

  // Handle fork-to-channel modal submission
  app.view('fork_to_channel_modal', async ({ ack, view, client, body }) => {
    // Get channel name from input
    const channelNameInput = view.state?.values?.channel_name_block?.channel_name_input?.value;
    if (!channelNameInput) {
      await ack({
        response_action: 'errors',
        errors: { channel_name_block: 'Channel name is required' },
      });
      return;
    }

    // Validate channel name format (lowercase, numbers, hyphens only)
    const normalizedName = channelNameInput.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (normalizedName.length < 1 || normalizedName.length > 80) {
      await ack({
        response_action: 'errors',
        errors: { channel_name_block: 'Channel name must be 1-80 characters' },
      });
      return;
    }

    await ack();

    // Parse metadata - contains turnIndex (queried from Codex at button creation time)
    const metadata = JSON.parse(view.private_metadata || '{}') as {
      sourceChannelId: string;
      sourceChannelName: string;
      sourceMessageTs: string;
      sourceThreadTs: string;
      conversationKey: string;
      turnIndex: number;
    };

    const userId = body.user.id;

    try {
      // Create the fork channel and session
      // turnIndex was queried from Codex at button creation time
      const result = await createForkChannel({
        channelName: normalizedName,
        sourceChannelId: metadata.sourceChannelId,
        sourceThreadTs: metadata.sourceThreadTs,
        conversationKey: metadata.conversationKey,
        turnIndex: metadata.turnIndex,
        userId,
        client,
      });

      // Update source message to show fork link (preserve activity blocks)
      if (metadata.sourceMessageTs && metadata.sourceChannelId) {
        try {
          await updateSourceMessageWithForkLink(
            client,
            metadata.sourceChannelId,
            metadata.sourceMessageTs,
            result.channelId,
            {
              threadTs: metadata.sourceThreadTs || undefined,
              conversationKey: metadata.conversationKey,
              turnIndex: metadata.turnIndex,
            }
          );
        } catch (updateError) {
          console.warn('Failed to update source message after fork:', updateError);
        }
      }
    } catch (error) {
      console.error('Fork to channel failed:', error);
      // Post ephemeral error to user
      await client.chat.postEphemeral({
        channel: metadata.sourceChannelId,
        user: userId,
        text: toUserMessage(error),
      });
    }
  });

  // Handle button actions (approve/deny/abort/fork)
  app.action(/^(approve|deny|abort|fork)_/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = (action as { action_id: string }).action_id;
    const channelId = body.channel?.id;

    if (!channelId) {
      console.error('No channel ID in action');
      return;
    }

    try {
      if (actionId.startsWith('approve_') || actionId.startsWith('deny_')) {
        // Approval action
        const requestId = parseInt(actionId.split('_')[1], 10);
        const decision = actionId.startsWith('approve_') ? 'accept' : 'decline';
        const runtime = codexPool.findRuntimeByApprovalRequestId(requestId);
        if (runtime) {
          await runtime.approval.handleApprovalDecision(requestId, decision as 'accept' | 'decline');
        }
      } else if (actionId.startsWith('abort_')) {
        // Abort action - open confirmation modal
        const conversationKey = actionId.replace('abort_', '');
        const runtime = getRuntimeIfExists(conversationKey);
        const context = runtime?.streaming.getContext(conversationKey);
        if (context) {
          const triggerBody = body as { trigger_id?: string };
          if (triggerBody.trigger_id) {
            await client.views.open({
              trigger_id: triggerBody.trigger_id,
              view: buildAbortConfirmationModalView({
                conversationKey,
                channelId: context.channelId,
                messageTs: context.messageTs,
              }),
            });
          }
        }
      } else if (actionId.startsWith('fork_')) {
        // Fork action - open modal for channel name input
        // Button value contains turnIndex (queried from Codex at button creation)
        const value = (action as { value: string }).value;
        const { turnIndex, slackTs, conversationKey } = JSON.parse(value);
        const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
        const threadTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts ?? messageTs;

        // Get channel name and find next available fork name
        const triggerBody = body as { trigger_id?: string };
        if (triggerBody.trigger_id) {
          let channelName = 'channel';
          let suggestedName = 'channel-fork';

          try {
            const channelInfo = await client.conversations.info({ channel: channelId });
            channelName = (channelInfo.channel as { name?: string })?.name ?? 'channel';
            const baseForkName = `${channelName}-fork`;

            // List channels to find existing forks with this pattern
            // Include archived channels since Slack blocks names even for archived channels
            const existingNames = new Set<string>();
            let cursor: string | undefined;
            do {
              const listResult = await client.conversations.list({
                types: 'public_channel,private_channel',
                exclude_archived: false,
                limit: 200,
                cursor,
              });
              if (listResult.ok && listResult.channels) {
                for (const ch of listResult.channels) {
                  if (ch.name?.startsWith(baseForkName)) {
                    existingNames.add(ch.name);
                  }
                }
              }
              cursor = listResult.response_metadata?.next_cursor;
            } while (cursor);
            console.log(`[Fork] Found existing fork channels: ${[...existingNames].join(', ') || 'none'}`);

            // Find next available name: -fork, then -fork-1, -fork-2, etc.
            if (!existingNames.has(baseForkName)) {
              suggestedName = baseForkName;
            } else {
              let num = 1;
              while (existingNames.has(`${baseForkName}-${num}`)) {
                num++;
              }
              suggestedName = `${baseForkName}-${num}`;
            }
            console.log(`[Fork] Suggested name: ${suggestedName}`);
          } catch (error) {
            // Use default name if channel info unavailable
            console.log('[Fork] Could not get channel name for prefill:', error);
          }

          await client.views.open({
            trigger_id: triggerBody.trigger_id,
            view: buildForkToChannelModalView({
              sourceChannelId: channelId,
              sourceChannelName: channelName,
              sourceMessageTs: messageTs ?? '',
              sourceThreadTs: threadTs ?? '',
              conversationKey,
              turnIndex,
              suggestedName,
            }),
          });
        }
      }
    } catch (error) {
      console.error('Error handling action:', error);
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: toUserMessage(error),
      });
    }
  });

  // Handle attach-thinking retry button
  app.action(/^attach_thinking_file_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const rawValue = (action as { value?: string }).value;
    const channelId = body.channel?.id;
    const userId = body.user?.id;

    if (!rawValue || !channelId) {
      console.error('[attach_thinking] Missing action value or channel');
      return;
    }

    let payload: {
      threadParentTs: string;
      channelId: string;
      activityMsgTs: string;
      thinkingCharCount: number;
    };

    try {
      payload = JSON.parse(rawValue);
    } catch (error) {
      console.error('[attach_thinking] Failed to parse action value:', error);
      return;
    }

    const { threadParentTs, activityMsgTs, thinkingCharCount } = payload;

    const threadSession = getThreadSession(channelId, threadParentTs);
    const content = threadSession?.lastThinkingContent;

    if (!content) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Thinking content is no longer available for attachment.',
        });
      }
      return;
    }

    if (thinkingCharCount && content.length !== thinkingCharCount) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Thinking content has changed and cannot be attached. Please re-run the request.',
        });
      }
      return;
    }

    let thinkingMsgLink: string | undefined;
    try {
      thinkingMsgLink = await getMessagePermalink(client, channelId, activityMsgTs);
    } catch (error) {
      console.error('[attach_thinking] Failed to get thinking permalink:', error);
    }

    const uploadResult = await uploadFilesToThread(
      client,
      channelId,
      threadParentTs,
      content,
      thinkingMsgLink ? `_Content for <${thinkingMsgLink}|this thinking block>._` : undefined,
      userId
    );

    if (!uploadResult.success || !uploadResult.fileMessageTs) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Failed to attach response files. Please try again.',
        });
      }
      return;
    }

    let fileMsgLink: string | undefined;
    try {
      fileMsgLink = await getMessagePermalink(client, channelId, uploadResult.fileMessageTs);
    } catch (error) {
      console.error('[attach_thinking] Failed to get file permalink:', error);
    }

    if (!fileMsgLink) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Attached files, but could not generate link.',
        });
      }
      return;
    }

    const display = threadSession?.lastThinkingDisplay
      ?? (content.length > THINKING_MESSAGE_SIZE
        ? `...${content.slice(-THINKING_MESSAGE_SIZE)}`
        : content);

    const entry: ActivityEntry = {
      type: 'thinking',
      timestamp: Date.now(),
      thinkingInProgress: false,
      thinkingContent: display,
      thinkingTruncated: content.length > THINKING_MESSAGE_SIZE,
      thinkingAttachmentLink: fileMsgLink,
      charCount: threadSession?.lastThinkingCharCount ?? content.length,
      durationMs: threadSession?.lastThinkingDurationMs,
    };

    const text = formatThreadActivityEntry(entry);
    const blocks = buildActivityEntryBlocks({ text });

    await client.chat.update({
      channel: channelId,
      ts: activityMsgTs,
      text,
      blocks,
    });
  });

  // Handle attach-response retry button
  app.action(/^attach_response_file_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const rawValue = (action as { value?: string }).value;
    const channelId = body.channel?.id;
    const userId = body.user?.id;

    if (!rawValue || !channelId) {
      console.error('[attach_response] Missing action value or channel');
      return;
    }

    let payload: {
      threadParentTs: string;
      channelId: string;
      responseMsgTs: string;
      responseCharCount: number;
    };

    try {
      payload = JSON.parse(rawValue);
    } catch (error) {
      console.error('[attach_response] Failed to parse action value:', error);
      return;
    }

    const { threadParentTs, responseMsgTs, responseCharCount } = payload;
    const threadSession = getThreadSession(channelId, threadParentTs);
    const content = threadSession?.lastResponseContent;
    const responseText = threadSession?.lastResponseText;
    const durationMs = threadSession?.lastResponseDurationMs;

    if (!content || !responseText) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Response content is no longer available for attachment.',
        });
      }
      return;
    }

    if (responseCharCount && content.length !== responseCharCount) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Response content has changed and cannot be attached. Please re-run the request.',
        });
      }
      return;
    }

    const header = formatThreadResponseMessage(content, durationMs);
    const slackFormattedResponse = responseText.includes('Full response not attached')
      ? responseText.replace('Full response not attached', 'Full response attached')
      : `${header}\n\n_Full response attached._`;

    const uploadResult = await uploadMarkdownAndPngWithResponse(
      client,
      channelId,
      content,
      slackFormattedResponse,
      threadParentTs,
      userId,
      threadSession?.threadCharLimit
    );

    if (!uploadResult?.ts || uploadResult.attachmentFailed) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Failed to attach response files. Please try again.',
        });
      }
      return;
    }

    let fileMsgLink: string | undefined;
    try {
      fileMsgLink = await getMessagePermalink(client, channelId, uploadResult.ts);
    } catch (error) {
      console.error('[attach_response] Failed to get file permalink:', error);
    }

    if (!fileMsgLink) {
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Attached files, but could not generate link.',
        });
      }
      return;
    }

    const newText = responseText.includes('Full response not attached')
      ? responseText.replace('Full response not attached._', `Full response <${fileMsgLink}|attached>._`)
      : `${responseText}\n_Full response <${fileMsgLink}|attached>._`;

    await client.chat.update({
      channel: channelId,
      ts: responseMsgTs,
      text: newText,
      blocks: undefined,
    });
  });

  // Handle "Refresh fork" button click - restore Fork here if forked channel was deleted
  app.action(/^refresh_fork_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const bodyWithMessage = body as { channel?: { id?: string }; message?: { ts?: string } };
    const channelId = bodyWithMessage.channel?.id;
    const messageTs = bodyWithMessage.message?.ts;

    if (!channelId || !messageTs) {
      console.error('[RefreshFork] Missing channel or message info');
      return;
    }

    const valueStr = 'value' in action ? (action.value || '{}') : '{}';
    let forkInfo: {
      forkChannelId?: string;
      threadTs?: string;
      conversationKey?: string;
      turnIndex?: number;
    };
    try {
      forkInfo = JSON.parse(valueStr);
    } catch {
      console.error('[RefreshFork] Invalid button value');
      return;
    }

    if (forkInfo.forkChannelId) {
      try {
        await withSlackRetry(
          () => (client as any).conversations.info({ channel: forkInfo.forkChannelId }),
          'refresh.info'
        );
        console.log(`[RefreshFork] Channel ${forkInfo.forkChannelId} still exists, no action needed`);
        return;
      } catch {
        console.log(`[RefreshFork] Channel ${forkInfo.forkChannelId} not found, restoring Fork here button`);
      }
    }

    await restoreForkHereButton(client, {
      sourceChannelId: channelId,
      sourceMessageTs: messageTs,
      threadTs: forkInfo.threadTs,
      conversationKey: forkInfo.conversationKey,
      turnIndex: forkInfo.turnIndex,
    });
  });

  // Handle /mode selection buttons
  app.action(/^mode_select_(ask|bypass)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = (action as { action_id: string }).action_id;
    const newMode = actionId.replace('mode_select_', '') as UnifiedMode;
    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    const threadTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts
      ?? messageTs;

    if (!channelId || !messageTs) {
      return;
    }

    const currentMode = getEffectiveMode(channelId, threadTs);

    await saveMode(channelId, threadTs, newMode);

    // Update active context for status display (applies next turn)
    const conversationKey = makeConversationKey(channelId, threadTs);
    const runtime = getRuntimeIfExists(conversationKey);
    const context = runtime?.streaming.getContext(conversationKey);
    if (context) {
      context.mode = newMode;
      context.approvalPolicy = mapModeToApprovalPolicy(newMode);
    }

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Mode changed: ${currentMode} → ${newMode}`,
      blocks: buildModeStatusBlocks({ currentMode, newMode }),
    });

    const pending = pendingModeSelections.get(messageTs);
    if (pending) {
      await removeProcessingEmoji(client, pending.channelId, pending.originalTs);
      pendingModeSelections.delete(messageTs);
    }
  });

  // Handle /mode cancel button
  app.action('mode_picker_cancel', async ({ ack, body, client }) => {
    await ack();

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    const pending = pendingModeSelections.get(messageTs);
    if (pending) {
      await removeProcessingEmoji(client, pending.channelId, pending.originalTs);
      pendingModeSelections.delete(messageTs);
    }

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: 'Mode selection cancelled',
      blocks: buildModePickerCancelledBlocks(),
    });
  });

  // Handle model button clicks (Step 1 of 2)
  // Pattern matches model_select_<model_value>
  app.action(/^model_select_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = 'action_id' in action ? action.action_id : '';
    const modelValue = actionId.replace('model_select_', '');

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    // Use stored threadTs from pending selection (more reliable than message.thread_ts)
    const pending = pendingModelSelections.get(messageTs);
    const threadTs = pending?.threadTs ||
      (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts ||
      messageTs;

    console.log(`[model] Model button clicked: ${modelValue} for channel: ${channelId}, thread: ${threadTs}`);

    const conversationKey = makeConversationKey(channelId, threadTs);
    const runtime = getRuntimeIfExists(conversationKey);
    if (runtime?.streaming.isStreaming(conversationKey)) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Cannot change model while processing',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: Cannot change model while a turn is running. Please wait or abort.',
            },
          },
        ],
      });
      return;
    }

    // Get model info for display name
    const modelInfo = getModelInfo(modelValue);
    const displayName = modelInfo?.displayName || modelValue;

    // Get current reasoning for initial selection
    const session = getThreadSession(channelId, threadTs) ?? getSession(channelId);

    // Show reasoning selection (Step 2)
    // Keep pending selection tracking for emoji cleanup
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Select reasoning for ${displayName}`,
      blocks: buildReasoningSelectionBlocks(modelValue, displayName, session?.reasoningEffort),
    });
  });

  // Handle reasoning button clicks (Step 2 of 2)
  // Pattern matches reasoning_select_<reasoning_value>
  app.action(/^reasoning_select_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = 'action_id' in action ? action.action_id : '';
    const reasoningValue = actionId.replace('reasoning_select_', '');

    // Value contains JSON with model and reasoning
    const actionValue = 'value' in action ? (action.value as string) : '';
    let modelValue = '';
    try {
      const parsed = JSON.parse(actionValue);
      modelValue = parsed.model;
    } catch {
      console.error('[model] Failed to parse reasoning action value:', actionValue);
      return;
    }

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    // Use stored threadTs from pending selection (more reliable than message.thread_ts)
    const pending = pendingModelSelections.get(messageTs);
    const threadTs = pending?.threadTs ||
      (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts ||
      messageTs;

    console.log(`[model] Reasoning selected: ${reasoningValue} for model: ${modelValue}, thread: ${threadTs}`);
    if (pending) {
      await removeProcessingEmoji(client, pending.channelId, pending.originalTs);
      pendingModelSelections.delete(messageTs);
    }

    const conversationKey = makeConversationKey(channelId, threadTs);
    const runtime = getRuntimeIfExists(conversationKey);
    if (runtime?.streaming.isStreaming(conversationKey)) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Cannot change settings while processing',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: Cannot change settings while a turn is running. Please wait or abort.',
            },
          },
        ],
      });
      return;
    }

    // Save both model and reasoning to session
    const reasoningEffort = reasoningValue as ReasoningEffort;
    console.log(`[model] Saving to session: channel=${channelId}, thread=${threadTs}, model=${modelValue}, reasoning=${reasoningEffort}`);
    await saveModelSettings(channelId, threadTs, modelValue, reasoningEffort);

    // Verify save worked
    const savedSession = getThreadSession(channelId, threadTs);
    console.log(`[model] Verified saved session: model=${savedSession?.model}, reasoning=${savedSession?.reasoningEffort}`);

    // Get model info for display name
    const modelInfo = getModelInfo(modelValue);
    const displayName = modelInfo?.displayName || modelValue;

    // Show confirmation
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Settings updated: ${displayName}, ${reasoningValue}`,
      blocks: buildModelConfirmationBlocks(displayName, modelValue, reasoningValue),
    });
  });

  // Handle model picker cancel button
  app.action('model_picker_cancel', async ({ ack, body, client }) => {
    await ack();

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    console.log('[model] Model picker cancelled');

    // Remove emojis from original message
    const pending = pendingModelSelections.get(messageTs);
    if (pending) {
      await removeProcessingEmoji(client, pending.channelId, pending.originalTs);
      pendingModelSelections.delete(messageTs);
    }

    // Show cancellation message
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: 'Model selection cancelled',
      blocks: buildModelPickerCancelledBlocks(),
    });
  });

  // Handle channel deletion - clean up all sessions for this channel
  app.event('channel_deleted', async ({ event }) => {
    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[channel-deleted] Channel deleted: ${event.channel}`);
      console.log(`${'='.repeat(60)}`);

      await deleteChannelSession(event.channel);

      console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
      console.error('[channel-deleted] Error handling channel deletion:', error);
      // Don't throw - cleanup failure shouldn't crash the bot
    }
  });
}

/**
 * Handle a user message.
 */
async function handleUserMessage(
  channelId: string,
  threadTs: string | undefined,
  userId: string,
  text: string,
  messageTs: string,
  files?: SlackFile[]
): Promise<void> {
  // CRITICAL: All bot responses go into threads, never pollute the main channel.
  // If user mentions bot in main channel, use their message as thread anchor.
  // If user is already in a thread, continue in that thread.
  const postingThreadTs = threadTs ?? messageTs;
  const conversationKey = makeConversationKey(channelId, postingThreadTs);

  const parsedCommand = parseCommand(text);

  // Prevent /resume while a turn is streaming to avoid state corruption
  const existingRuntime = getRuntimeIfExists(conversationKey);
  if (parsedCommand?.command === 'resume' && existingRuntime?.streaming.isStreaming(conversationKey)) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: buildErrorBlocks('Cannot resume while a turn is running. Abort first, or wait for completion.'),
      text: 'Cannot resume while a turn is running. Abort first, or wait for completion.',
    });
    return;
  }

  // Check if this is a command
  const commandContext: CommandContext = {
    channelId,
    threadTs: postingThreadTs, // Use posting thread for session lookup
    userId,
    text,
  };

  // Get runtime for this conversation (creates if needed)
  const runtime = await getRuntime(conversationKey);
  const commandResult = await handleCommand(commandContext, runtime.codex);
  if (commandResult) {
    // Handle /model command with emoji tracking
    if (commandResult.showModelSelection) {
      await markProcessingStart(app.client, channelId, messageTs);
      const response = await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        blocks: commandResult.blocks,
        text: commandResult.text,
      });

      // Track pending selection for emoji cleanup
      if (response.ts) {
        pendingModelSelections.set(response.ts, {
          originalTs: messageTs,
          channelId,
          threadTs: postingThreadTs,
        });
        await markApprovalWait(app.client, channelId, messageTs);
      }
      return;
    }

    if (commandResult.showModeSelection) {
      await markProcessingStart(app.client, channelId, messageTs);
      const response = await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        blocks: commandResult.blocks,
        text: commandResult.text,
      });

      if (response.ts) {
        pendingModeSelections.set(response.ts, {
          originalTs: messageTs,
          channelId,
          threadTs: postingThreadTs,
        });
        await markApprovalWait(app.client, channelId, messageTs);
      }
      return;
    }

    // Send command response in thread
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: commandResult.blocks,
      text: commandResult.text,
    });

    // Live update: adjust update rate for active streaming
    if (parsedCommand?.command === 'update-rate') {
      const session = getThreadSession(channelId, postingThreadTs) ?? getSession(channelId);
      const newRate = session?.updateRateSeconds ?? 3;
      runtime.streaming.updateRate(conversationKey, newRate * 1000);
    }
    return;
  }

  // GUARD: Path must be configured before processing messages
  // Check channel session (authoritative source for path config)
  const channelSession = getSession(channelId);
  if (!channelSession?.pathConfigured) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: buildPathSetupBlocks(),
      text: 'Please set working directory first using /ls, /cd, and /set-current-path',
    });

    // Remove eyes reaction
    if (messageTs) {
      try {
        await app.client.reactions.remove({
          channel: channelId,
          timestamp: messageTs,
          name: 'eyes',
        });
      } catch {
        // Ignore - reaction may not exist
      }
    }

    return; // Don't process the message
  }

  // Regular message - send to Codex
  // Use postingThreadTs for all session lookups since that's our thread key
  const workingDir = getEffectiveWorkingDir(channelId, postingThreadTs);
  const mode = getEffectiveMode(channelId, postingThreadTs);
  const approvalPolicy = mapModeToApprovalPolicy(mode);
  let threadId = getEffectiveThreadId(channelId, postingThreadTs);

  // Get session info - always use thread session since all conversations are in threads
  const session = getThreadSession(channelId, postingThreadTs) ?? getSession(channelId);
  console.log(`[message] Session lookup: channel=${channelId}, slackThread=${postingThreadTs}, codexThread=${threadId}, model=${session?.model}, reasoning=${session?.reasoningEffort}`);

  if (threadId && conversationTracker.isBusy(threadId)) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: buildErrorBlocks(
        'Another request is already running for this session. Please wait for it to finish or click Abort on the active status panel.'
      ),
      text: 'Another request is already running for this session. Please wait or abort.',
    });
    return;
  }

  // Start or resume thread
  if (!threadId) {
    console.log(`[message] No existing Codex thread, will create new one`);
    // Check if this is a Slack thread that needs forking (only for existing threads, not new anchors)
    if (threadTs) {
      const result = await getOrCreateThreadSession(channelId, postingThreadTs);
      if (result.isNewFork && result.session.forkedFrom) {
        // Fork the Codex thread at the specified turn
        // forkThreadAtTurn now gets actual turn count from Codex (source of truth)
        const forkTurnIndex = result.session.forkedAtTurnIndex ?? 0;
        const forkedThread = await runtime.codex.forkThreadAtTurn(
          result.session.forkedFrom,
          forkTurnIndex
        );
        threadId = forkedThread.id;
        await saveThreadSession(channelId, postingThreadTs, { threadId });
      } else {
        // Start new thread
        const newThread = await runtime.codex.startThread(workingDir);
        threadId = newThread.id;
        await saveThreadSession(channelId, postingThreadTs, { threadId });
      }
    } else {
      // New conversation from main channel mention - start new Codex thread
      // Save to BOTH channel session (for subsequent main channel mentions)
      // and thread session (for this specific thread anchor)
      const newThread = await runtime.codex.startThread(workingDir);
      threadId = newThread.id;
      await saveSession(channelId, { threadId });
      await saveThreadSession(channelId, postingThreadTs, { threadId });
    }
  } else {
    // Resume existing thread
    console.log(`[message] Resuming existing Codex thread: ${threadId}`);
    await runtime.codex.resumeThread(threadId);
    // Ensure this thread anchor also has the threadId saved
    await saveThreadSession(channelId, postingThreadTs, { threadId });
  }

  // Use defaults when model/reasoning not explicitly set
  const effectiveModel = session?.model || DEFAULT_MODEL;
  const effectiveReasoning = session?.reasoningEffort || DEFAULT_REASONING;
  const effectiveSandbox = runtime.codex.getSandboxMode();

  // Post initial "processing" message IN THE THREAD using activity format
  const initialResult = await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: postingThreadTs, // Always post in thread!
    blocks: buildActivityBlocks({
      activityText: ':gear: Starting...',
      status: 'running',
      conversationKey,
      elapsedMs: 0,
      mode,
      model: effectiveModel,
      reasoningEffort: effectiveReasoning,
      sandboxMode: effectiveSandbox,
      sessionId: threadId,
      spinner: '\u25D0',
    }),
    text: 'Starting...',
  });

  if (!initialResult.ts) {
    throw new Error('Failed to post message');
  }

  const busyContext: BusyContext = {
    conversationKey,
    sessionId: threadId,
    statusMsgTs: initialResult.ts,
    originalTs: messageTs,
    startTime: Date.now(),
    userId,
    query: text,
    channelId,
    threadTs: postingThreadTs,
  };

  if (!conversationTracker.startProcessing(threadId, busyContext)) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: buildErrorBlocks(
        'Another request is already running for this session. Please wait for it to finish or click Abort on the active status panel.'
      ),
      text: 'Another request is already running for this session. Please wait or abort.',
    });
    return;
  }

  // Start streaming context
  const streamingContext: StreamingContext = {
    channelId,
    threadTs: postingThreadTs, // Track the thread we're posting to
    messageTs: initialResult.ts,
    originalTs: messageTs, // User's original message for emoji reactions
    userId, // Track user for DM notifications
    query: text,
    threadId,
    turnId: '', // Will be set when turn starts
    approvalPolicy,
    mode,
    updateRateMs: (session?.updateRateSeconds ?? 3) * 1000,
    model: effectiveModel,
    reasoningEffort: effectiveReasoning,
    sandboxMode: effectiveSandbox,
    startTime: Date.now(),
  };

  runtime.streaming.startStreaming(streamingContext);

  // Build turn input (files first, then text)
  let input: TurnContent[] = [{ type: 'text', text }];
  if (files && files.length > 0) {
    try {
      const { files: processedFiles, warnings } = await processSlackFiles(
        files,
        process.env.SLACK_BOT_TOKEN!,
        { writeTempFile }
      );
      input = buildMessageContent(text, processedFiles, warnings);
    } catch (error) {
      console.error('[FileUpload] Error processing files:', error);
      // Fallback to plain text input
      input = [{ type: 'text', text }];
    }
  }

  // Start the turn
  let turnId: string;
  try {
    turnId = await runtime.codex.startTurn(threadId, input, {
      approvalPolicy,
      reasoningEffort: effectiveReasoning,
      model: effectiveModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start turn';
    console.error('[message] startTurn failed:', err);
    await runtime.streaming.failTurnStart(
      conversationKey,
      `Start failed: ${message}`
    );
    conversationTracker.stopProcessing(threadId);
    return;
  }

  // Update context with turn ID (and register for turnId routing)
  runtime.streaming.registerTurnId(conversationKey, turnId);

  // Record turn for fork tracking
  const turnIndex = (session as { turns?: unknown[] })?.turns?.length ?? 0;
  await recordTurn(channelId, postingThreadTs, {
    turnId,
    turnIndex,
    slackTs: initialResult.ts,
  });
}

/**
 * Create a fork channel with a forked Codex session.
 */
interface CreateForkChannelParams {
  channelName: string;
  sourceChannelId: string;
  sourceThreadTs: string;
  conversationKey: string;
  /** Turn index (0-based) - queried from Codex at button creation time */
  turnIndex: number;
  userId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any; // Slack WebClient - using any for flexibility with Slack API types
}

interface CreateForkChannelResult {
  channelId: string;
  threadId: string;
}

async function createForkChannel(params: CreateForkChannelParams): Promise<CreateForkChannelResult> {
  const { channelName, sourceChannelId, sourceThreadTs, conversationKey, turnIndex, userId, client } = params;

  // Parse source conversation key to get source thread info
  const parts = conversationKey.split('_');
  const sourceConvChannelId = parts[0];
  const sourceConvThreadTs = parts[1];

  // Get source Codex thread ID
  const sourceThreadId = getEffectiveThreadId(sourceConvChannelId, sourceConvThreadTs);
  if (!sourceThreadId) {
    throw new Error('Cannot fork: No active session found in source thread.');
  }

  // Get the source runtime (needed for fork operations)
  const sourceRuntime = await getRuntime(conversationKey);

  // turnIndex was queried from Codex at button creation time - use it directly
  // Validation: Codex.forkThreadAtTurn will validate bounds
  console.log(`[createForkChannel] Using turnIndex=${turnIndex} (stored at button creation time)`);

  // Inherit working directory lock from source session
  const sourceThreadSession = sourceConvThreadTs
    ? getThreadSession(sourceConvChannelId, sourceConvThreadTs)
    : null;
  const sourceChannelSession = getSession(sourceConvChannelId);
  const sourceWorkingDir =
    sourceThreadSession?.configuredPath ||
    sourceThreadSession?.workingDir ||
    sourceChannelSession?.configuredPath ||
    sourceChannelSession?.workingDir ||
    process.env.DEFAULT_WORKING_DIR ||
    process.cwd();
  const configuredBy =
    sourceThreadSession?.configuredBy ??
    sourceChannelSession?.configuredBy ??
    userId ??
    null;
  const configuredAt =
    sourceThreadSession?.configuredAt ??
    sourceChannelSession?.configuredAt ??
    Date.now();

  // 1. Create new Slack channel
  let createResult;
  try {
    createResult = await client.conversations.create({
      name: channelName,
      is_private: false,
    });
  } catch (error) {
    const errMsg = (error as { data?: { error?: string } })?.data?.error;
    switch (errMsg) {
      case 'name_taken':
        throw new Error(`Channel name "${channelName}" is already taken. Please choose a different name.`);
      case 'invalid_name_specials':
      case 'invalid_name_punctuation':
        throw new Error(`Channel name "${channelName}" contains invalid characters. Use only lowercase letters, numbers, and hyphens.`);
      case 'invalid_name':
      case 'invalid_name_required':
        throw new Error(`Invalid channel name "${channelName}". Channel names must be lowercase with no spaces.`);
      case 'invalid_name_maxlength':
        throw new Error(`Channel name "${channelName}" is too long. Maximum 80 characters allowed.`);
      case 'restricted_action':
        throw new Error('Channel creation is restricted by your workspace policy. Contact your admin.');
      case 'user_is_restricted':
        throw new Error('You do not have permission to create channels in this workspace.');
      case 'no_permission':
        throw new Error('The bot does not have permission to create channels. Please check bot permissions.');
      default:
        // Show the actual Slack error for debugging
        throw new Error(`Failed to create channel: ${errMsg || (error as Error)?.message || 'Unknown error'}`);
    }
  }

  if (!createResult.ok || !createResult.channel?.id) {
    throw new Error(`Failed to create channel: ${createResult.error || 'Unknown error'}`);
  }

  const newChannelId = createResult.channel.id;

  // 2. Invite user to the channel
  try {
    await client.conversations.invite({
      channel: newChannelId,
      users: userId,
    });
  } catch (error) {
    // Ignore 'already_in_channel' error
    const errMsg = (error as { data?: { error?: string } })?.data?.error;
    if (errMsg !== 'already_in_channel') {
      console.warn('Failed to invite user to fork channel:', error);
    }
  }

  // 3. Fork the Codex session at the specified turn (using fork + rollback)
  // ROBUST: forkThreadAtTurn gets actual turn count from Codex (source of truth)
  const forkedThread = await sourceRuntime.codex.forkThreadAtTurn(sourceThreadId, turnIndex);

  // 4. Save the forked session for the new channel
  await saveSession(newChannelId, {
    threadId: forkedThread.id,
    forkedFrom: sourceThreadId,
    forkedAtTurnIndex: turnIndex,
    pathConfigured: true,
    configuredPath: sourceWorkingDir,
    workingDir: sourceWorkingDir,
    configuredBy,
    configuredAt,
  });

  // 5. Post initial message in the new channel
  const sourceLink = `<https://slack.com/archives/${sourceChannelId}/p${sourceThreadTs.replace('.', '')}|source conversation>`;
  await client.chat.postMessage({
    channel: newChannelId,
    text: `:twisted_rightwards_arrows: Forked from ${sourceLink}.\n\nThis channel continues from that point in the conversation. Send a message to continue.`,
  });

  return {
    channelId: newChannelId,
    threadId: forkedThread.id,
  };
}

interface SlackMessageSummary {
  ts?: string;
  text?: string;
  blocks?: any[];
}

interface SlackMessagesResult {
  messages?: SlackMessageSummary[];
}

// Update source activity message: remove Fork button and add fork link, preserving blocks.
async function updateSourceMessageWithForkLink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  channelId: string,
  messageTs: string,
  forkChannelId: string,
  forkInfo?: {
    threadTs?: string;
    conversationKey?: string;
    /** Turn index (0-based) - stored at button creation time */
    turnIndex?: number;
  }
): Promise<void> {
  const threadTs = forkInfo?.threadTs;
  const isThreadReply = Boolean(threadTs && threadTs !== messageTs);
  const mutexKey = `${channelId}_${messageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
    // Fetch the original message to preserve blocks
    let historyResult: SlackMessagesResult | undefined;

    if (isThreadReply) {
      historyResult = (await withSlackRetry(
        () =>
          client.conversations.replies({
            channel: channelId,
            ts: threadTs,
          }),
        'fork.replies'
      )) as SlackMessagesResult;
    } else {
      historyResult = (await withSlackRetry(
        () =>
          client.conversations.history({
            channel: channelId,
            latest: messageTs,
            inclusive: true,
            limit: 1,
          }),
        'fork.history'
      )) as SlackMessagesResult;
    }

    // Fallback to replies if history didn't find the message and we have a thread parent
    let messages = historyResult?.messages || [];
    let msg = isThreadReply ? messages.find((m) => m.ts === messageTs) : messages[0];
    if (!msg && threadTs && threadTs !== messageTs) {
      const repliesResult = (await withSlackRetry(
        () =>
          client.conversations.replies({
            channel: channelId,
            ts: threadTs,
          }),
        'fork.replies.fallback'
      )) as SlackMessagesResult;
      messages = repliesResult?.messages || [];
      msg = messages.find((m) => m.ts === messageTs);
    }

    if (!msg?.blocks) {
      console.warn('[Fork] Source message blocks not found; skipping update');
      return;
    }

    const updatedBlocks: any[] = [];
    let forkContextAdded = false;
    let refreshButtonAdded = false;
    let actionsBlockIndex = -1;

    const refreshButton =
      forkInfo?.conversationKey && forkInfo?.turnIndex !== undefined
        ? {
            type: 'button',
            text: { type: 'plain_text', text: '🔄 Refresh fork', emoji: true },
            action_id: `refresh_fork_${forkInfo.conversationKey}`,
            value: JSON.stringify({
              forkChannelId,
              threadTs: forkInfo.threadTs,
              conversationKey: forkInfo.conversationKey,
              turnIndex: forkInfo.turnIndex,
            }),
          }
        : undefined;

    for (const block of msg.blocks) {
      if (block.type === 'actions' && Array.isArray(block.elements)) {
        actionsBlockIndex = updatedBlocks.length;
        const remainingElements = block.elements.filter(
          (el: any) =>
            !(typeof el.action_id === 'string' && el.action_id.startsWith('fork_')) &&
            !(typeof el.action_id === 'string' && el.action_id.startsWith('refresh_fork_'))
        );
        if (!forkContextAdded) {
          updatedBlocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `:twisted_rightwards_arrows: Forked to <#${forkChannelId}>`,
              },
            ],
          });
          forkContextAdded = true;
        }
        if (refreshButton) {
          remainingElements.push(refreshButton);
          refreshButtonAdded = true;
        }
        updatedBlocks.push({ ...block, elements: remainingElements });
        continue;
      }
      updatedBlocks.push(block);
    }

    if (!forkContextAdded) {
      updatedBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:twisted_rightwards_arrows: Forked to <#${forkChannelId}>`,
          },
        ],
      });
    }

    if (refreshButton && !refreshButtonAdded) {
      const actionsBlock = {
        type: 'actions',
        block_id: `fork_${messageTs}`,
        elements: [refreshButton],
      };
      if (actionsBlockIndex >= 0) {
        updatedBlocks.splice(actionsBlockIndex + 1, 0, actionsBlock);
      } else {
        updatedBlocks.push(actionsBlock);
      }
    }

    await withSlackRetry(
      () =>
        client.chat.update({
          channel: channelId,
          ts: messageTs,
          blocks: updatedBlocks,
          text: msg.text,
        }),
      'fork.update'
    );
  });
}

// Restore Fork here button when a forked channel is deleted
async function restoreForkHereButton(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  forkInfo: {
    sourceChannelId: string;
    sourceMessageTs: string;
    threadTs?: string;
    conversationKey?: string;
    /** Turn index (0-based) - stored at button creation time */
    turnIndex?: number;
  }
): Promise<void> {
  const { sourceChannelId, sourceMessageTs, threadTs, conversationKey, turnIndex } = forkInfo;

  if (!conversationKey || turnIndex === undefined) {
    console.log('[RestoreForkHere] Missing fork point info, cannot restore button');
    return;
  }

  const mutexKey = `${sourceChannelId}_${sourceMessageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
    const historyResult = threadTs
      ? (await withSlackRetry(
          () =>
            client.conversations.replies({
              channel: sourceChannelId,
              ts: threadTs,
            }),
          'refresh.replies'
        )) as SlackMessagesResult
      : (await withSlackRetry(
          () =>
            client.conversations.history({
              channel: sourceChannelId,
              latest: sourceMessageTs,
              inclusive: true,
              limit: 1,
            }),
          'refresh.history'
        )) as SlackMessagesResult;

    const msg = threadTs
      ? historyResult.messages?.find((m) => m.ts === sourceMessageTs)
      : historyResult.messages?.[0];
    if (!msg?.blocks) {
      console.warn('[RestoreForkHere] Source message blocks not found; skipping update');
      return;
    }

    const updatedBlocks: any[] = [];
    let actionsBlockIndex = -1;

    for (const block of msg.blocks) {
      if (
        block.type === 'context' &&
        block.elements?.[0]?.text &&
        (block.elements[0].text.includes('Forked to') || block.elements[0].text.includes('Fork:'))
      ) {
        continue;
      }

      if (block.type === 'actions' && Array.isArray(block.elements)) {
        actionsBlockIndex = updatedBlocks.length;
        const filteredElements = block.elements.filter(
          (el: any) =>
            !(typeof el.action_id === 'string' && el.action_id.startsWith('refresh_fork_')) &&
            !(typeof el.action_id === 'string' && el.action_id.startsWith('fork_'))
        );
        updatedBlocks.push({ ...block, elements: filteredElements });
        continue;
      }

      updatedBlocks.push(block);
    }

    const forkButton = {
      type: 'button',
      text: { type: 'plain_text', text: ':twisted_rightwards_arrows: Fork here', emoji: true },
      action_id: `fork_${conversationKey}_${turnIndex}`,
      value: JSON.stringify({
        turnIndex,
        slackTs: sourceMessageTs,
        conversationKey,
      }),
    };

    if (actionsBlockIndex >= 0) {
      updatedBlocks[actionsBlockIndex].elements.push(forkButton);
    } else {
      updatedBlocks.push({
        type: 'actions',
        block_id: `fork_${sourceMessageTs}`,
        elements: [forkButton],
      });
    }

    await withSlackRetry(
      () =>
        client.chat.update({
          channel: sourceChannelId,
          ts: sourceMessageTs,
          blocks: updatedBlocks,
          text: msg.text,
        }),
      'refresh.update'
    );
  });
}

/**
 * Handle fork action (legacy - forks in same thread, not new channel).
 */
async function handleFork(
  sourceConversationKey: string,
  turnIndex: number,
  channelId: string,
  triggerMessageTs?: string
): Promise<void> {
  // Parse source conversation
  const parts = sourceConversationKey.split('_');
  const sourceChannelId = parts[0];
  const sourceThreadTs = parts[1];

  // Get source thread ID and turn count
  const sourceThreadId = getEffectiveThreadId(sourceChannelId, sourceThreadTs);
  if (!sourceThreadId) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Cannot fork: No active session found.',
    });
    return;
  }

  // Get the source runtime (needed for fork operations)
  const sourceRuntime = await getRuntime(sourceConversationKey);

  // Fork the Codex thread at the specified turn (using fork + rollback)
  // ROBUST: forkThreadAtTurn gets actual turn count from Codex (source of truth)
  const forkedThread = await sourceRuntime.codex.forkThreadAtTurn(sourceThreadId, turnIndex);

  // Create new thread in Slack
  const forkResult = await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: triggerMessageTs,
    text: `:fork_and_knife: Forked from turn ${turnIndex}. New thread started.`,
  });

  if (forkResult.ts) {
    // Save the forked session
    await saveThreadSession(channelId, forkResult.ts, {
      threadId: forkedThread.id,
      forkedFrom: sourceThreadId,
      forkedAtTurnIndex: turnIndex,
    });
  }
}

// Export for testing
export { app, codexPool, updateSourceMessageWithForkLink, restoreForkHereButton };
