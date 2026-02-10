/**
 * OpenCode Slack bot implementation.
 */

import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { Mutex } from 'async-mutex';
import type { GlobalEvent, OpencodeClient, Part, ToolPart, Todo } from '@opencode-ai/sdk';
import fs from 'fs';

import { ServerPool } from './server-pool.js';
import type { OpencodeClientWrapper } from './opencode-client.js';
import { ConversationTracker, type ActiveContext } from '../../slack/dist/session/conversation-tracker.js';
import {
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  getOrCreateThreadSession,
  saveMessageMapping,
  findForkPointMessageId,
  addSlackOriginatedUserUuid,
  clearSyncedMessageUuids,
  clearSlackOriginatedUserUuids,
  deleteSession,
  type Session,
  type ThreadSession,
  type ActivityEntry,
  type LastUsage,
  type PermissionMode,
} from './session-manager.js';
import {
  buildCombinedStatusBlocks,
  buildToolApprovalBlocks,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
  buildForkToChannelModalView,
  buildAbortConfirmationModalView,
  buildModeSelectionBlocks,
  DEFAULT_CONTEXT_WINDOW,
  computeAutoCompactThreshold,
  buildAttachThinkingFileButton,
  formatThreadThinkingMessage,
} from './blocks.js';
import {
  createNoopStreamingSession,
  makeConversationKey,
  uploadMarkdownAndPngWithResponse,
  uploadFilesToThread,
  extractTailWithFormatting,
  type StreamingSession,
} from './streaming.js';
import { parseCommand, extractInlineMode, extractMentionMode, extractMentionModel, extractFirstMentionId, UPDATE_RATE_DEFAULT, MESSAGE_SIZE_DEFAULT, THINKING_MESSAGE_SIZE } from './commands.js';
import { toUserMessage, isRecoverable } from './errors.js';
import { markProcessingStart, markApprovalWait, markApprovalDone, markError, markAborted, removeProcessingEmoji } from './emoji-reactions.js';
import { sendDmNotification, clearDmDebounce } from './dm-notifications.js';
import { processSlackFilesWithGuard } from '../../slack/dist/file-guard.js';
import { writeTempFile, type SlackFile } from '../../slack/dist/file-handler.js';
import { buildMessageContent } from './content-builder.js';
import { withSlackRetry, sleep } from '../../slack/dist/retry.js';
import { startWatching, isWatching, stopWatching, updateWatchRate, stopAllWatchers, onSessionCleared } from './terminal-watcher.js';
import { syncMessagesFromSession } from './message-sync.js';
import { getAvailableModels, getModelInfo, encodeModelId, decodeModelId, isModelAvailable, getCachedContextWindow } from './model-cache.js';
import {
  flushActivityBatch,
  postThinkingToThread,
  postStartingToThread,
  postErrorToThread,
  postResponseToThread,
  updatePostedBatch,
  getMessagePermalink,
} from './activity-thread.js';

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const STATUS_UPDATE_INTERVAL_MS = 1000;

interface BusyContext extends ActiveContext {
  channelId: string;
  threadTs?: string;
}

interface PendingSelection {
  originalTs: string;
  channelId: string;
  threadTs?: string;
  /** The thread ts for the SESSION (undefined = channel session, set = thread session) */
  sessionThreadTs?: string;
  /** Query to execute after model selection */
  deferredQuery?: string;
}

interface PendingPermission {
  approvalId: string;
  sessionId: string;
  channelId: string;
  threadTs?: string;
  userId?: string;
  messageTs?: string;
  originalTs?: string;
}

type StatusState = 'starting' | 'thinking' | 'tool' | 'generating' | 'complete' | 'error' | 'aborted';

interface ProcessingState {
  conversationKey: string;
  channelId: string;
  sessionThreadTs?: string;
  postingThreadTs?: string;
  sessionId: string;
  workingDir: string;
  statusMsgTs: string;
  streamingMessageTs: string | null;
  streamingSession: StreamingSession;
  startTime: number;
  spinnerIndex: number;
  status: StatusState;
  activityLog: ActivityEntry[];
  currentTool?: string;
  toolsCompleted: number;
  userId?: string;
  originalTs?: string;
  isNewSession?: boolean;
  model?: string;
  lastUsage?: LastUsage;
  assistantMessageId?: string;
  queryText?: string;
  fullResponse: string;
  currentResponseSegment: string;
  generatingSegmentStartTime?: number;
  responseMessageTs?: string;
  responseMessageLink?: string;
  responseAttachmentFailed: boolean;
  textParts: Map<string, string>;
  reasoningParts: Map<string, string>;
  toolStates: Map<string, string>;
  generatingEntry?: ActivityEntry;
  thinkingEntry?: ActivityEntry;
  statusUpdateTimer?: NodeJS.Timeout;
  customStatus?: string;
  pendingPermissions: Set<string>;
  updateRateSeconds: number;
  lastThinkingUpdateTime: number;
  currentThinkingPartId?: string;
  completedThinkingPartIds: Set<string>;
  messageRoles: Map<string, 'user' | 'assistant'>;
  pendingMessageParts: Map<string, Array<{ part: Part; delta?: string }>>;
  finalizingResponseSegment: Promise<void> | null;
  seenMessagePartMessageIds: Set<string>;

  // Activity thread batch infrastructure
  activityThreadMsgTs: string | null;
  thinkingThreadMsgMap: Map<string, string>;  // partId → Slack thread msg ts
  activityBatch: ActivityEntry[];
  activityBatchStartIndex: number;
  lastActivityPostTime: number;
  threadParentTs: string | null;
  charLimit: number;
  postedBatchTs: string | null;
  postedBatchToolUseIds: Set<string>;
  pendingThinkingUpdate: Promise<void> | null;
  sessionTitle?: string;
}

const serverPool = new ServerPool();
const conversationTracker = new ConversationTracker<BusyContext>();

const processingBySession = new Map<string, ProcessingState>();
const processingByConversation = new Map<string, ProcessingState>();
const eventSubscriptions = new Map<OpencodeClientWrapper, () => void>();
const eventMutexes = new Map<string, Mutex>();
const updateMutexes = new Map<string, Mutex>();
const pendingModelSelections = new Map<string, PendingSelection>();
const pendingModeSelections = new Map<string, PendingSelection>();
const pendingPermissions = new Map<string, PendingPermission>();

/**
 * Pending activity entries to prepend to the next query's activity log.
 * Keyed by conversation key (channelId or channelId:threadTs).
 * Used by /resume to show session_changed in the activity window.
 */
const pendingActivityEntries = new Map<string, ActivityEntry[]>();

function onSessionResumed(channelId: string, threadTs?: string, entry?: ActivityEntry): void {
  // Stop terminal watcher if active (session changed)
  if (isWatching(channelId, threadTs)) {
    stopWatching(channelId, threadTs);
  }
  // Store activity entry for next query
  if (entry) {
    const key = makeConversationKey(channelId, threadTs);
    const existing = pendingActivityEntries.get(key) ?? [];
    existing.push(entry);
    pendingActivityEntries.set(key, existing);
  }
}
const processedIncomingMessageTs = new Set<string>();

let app: App | null = null;

function shouldProcessIncomingMessage(channelId: string, messageTs?: string): boolean {
  if (!messageTs) return true;
  const key = `${channelId}:${messageTs}`;
  if (processedIncomingMessageTs.has(key)) return false;
  processedIncomingMessageTs.add(key);
  return true;
}

function getEventMutex(sessionId: string): Mutex {
  if (!eventMutexes.has(sessionId)) {
    eventMutexes.set(sessionId, new Mutex());
  }
  return eventMutexes.get(sessionId)!;
}

function getUpdateMutex(key: string): Mutex {
  if (!updateMutexes.has(key)) {
    updateMutexes.set(key, new Mutex());
  }
  return updateMutexes.get(key)!;
}

function normalizeEventType(type?: string): string | undefined {
  if (!type) return type;
  if (type.startsWith('message_part.')) {
    return type.replace('message_part.', 'message.part.');
  }
  if (type.startsWith('message_part')) {
    return type.replace('message_part', 'message.part');
  }
  return type;
}

function getSessionIdFromPayload(payload: any): string | null {
  if (!payload) return null;
  const props = payload.properties;
  if (props?.sessionID) return props.sessionID;
  if (props?.info?.sessionID) return props.info.sessionID;
  if (props?.info?.id) return props.info.id;  // for session.updated events
  if (props?.part?.sessionID) return props.part.sessionID;
  return null;
}

function normalizeToolStatus(status: string | undefined): string | undefined {
  if (!status) return status;
  if (status === 'complete') return 'completed';
  if (status === 'failed') return 'error';
  return status;
}

function hasPendingFinalResponse(state: ProcessingState): boolean {
  const pendingSegment = state.currentResponseSegment || state.fullResponse;
  return Boolean(pendingSegment.trim()) && !state.responseMessageTs;
}

function resolveAgent(session: Session): 'plan' | 'build' {
  if (session.mode === 'plan') return 'plan';
  return 'build';
}

function computeContextStats(usage?: LastUsage): {
  contextPercent?: number;
  compactPercent?: number;
  tokensToCompact?: number;
} {
  if (!usage) return {};
  const total = usage.inputTokens + (usage.cacheCreationInputTokens ?? 0) + usage.cacheReadInputTokens;
  const contextWindow = usage.contextWindow || DEFAULT_CONTEXT_WINDOW;
  if (contextWindow <= 0) return {};
  const contextPercent = Math.min(100, Math.max(0, Number(((total / contextWindow) * 100).toFixed(1))));
  const compactThreshold = computeAutoCompactThreshold(contextWindow, usage.maxOutputTokens);
  const tokensToCompact = Math.max(0, compactThreshold - total);
  const compactPercent = compactThreshold > 0
    ? Math.max(0, Number(((tokensToCompact / compactThreshold) * 100).toFixed(1)))
    : undefined;
  return { contextPercent, compactPercent, tokensToCompact };
}

async function ensureEventSubscription(_channelId: string, wrapper: OpencodeClientWrapper): Promise<void> {
  if (eventSubscriptions.has(wrapper)) return;
  const unsubscribe = wrapper.subscribeToEvents((event: GlobalEvent) => {
    void handleGlobalEvent(event).catch((error) => {
      console.error('[opencode] Event handling error:', error);
    });
  });
  eventSubscriptions.set(wrapper, unsubscribe);
}

async function handleGlobalEvent(event: GlobalEvent): Promise<void> {
  const payload = (event as any)?.payload;
  const type = normalizeEventType(payload?.type);
  const sessionId = getSessionIdFromPayload(payload);
  if (!sessionId || !type) return;

  const mutex = getEventMutex(sessionId);
  await mutex.runExclusive(async () => {
    const state = processingBySession.get(sessionId);
    if (!state) return;

    switch (type) {
      case 'message.part.updated':
        await handleMessagePartUpdated(payload?.properties?.part as Part | undefined, payload?.properties?.delta as string | undefined, state);
        break;
      case 'message.updated':
        await handleMessageUpdated(payload?.properties, state);
        break;
      case 'session.status': {
        const statusType = payload?.properties?.status?.type;
        if (statusType === 'idle') {
          await handleSessionIdle(state);
        }
        break;
      }
      case 'permission.updated':
        await handlePermissionUpdated(payload?.properties, state);
        break;
      case 'session.idle':
        await handleSessionIdle(state);
        break;
      case 'session.compacted':
        state.customStatus = 'Compacted';
        break;
      case 'session.updated': {
        const sessionInfo = payload?.properties?.info;
        if (sessionInfo?.title && !sessionInfo.title.startsWith('Slack ')) {
          state.sessionTitle = sessionInfo.title;
          if (state.sessionThreadTs) {
            await saveThreadSession(state.channelId, state.sessionThreadTs, { sessionTitle: sessionInfo.title });
          } else {
            await saveSession(state.channelId, { sessionTitle: sessionInfo.title });
          }
        }
        break;
      }
      case 'todo.updated':
        await handleTodoUpdated(payload?.properties?.todos as Todo[] | undefined, state);
        break;
      default:
        break;
    }
  });
}

async function handleMessageUpdated(properties: any, state: ProcessingState): Promise<void> {
  const info = properties?.info as {
    id?: string;
    role?: 'user' | 'assistant' | string;
    sessionID?: string;
    tokens?: any;
    cost?: number;
    modelID?: string;
    providerID?: string;
    time?: { completed?: number };
    finish?: any;
  } | undefined;
  const parts = properties?.parts as Part[] | undefined;

  if (!info) return;

  if (info?.id && info.role) {
    if (info.role === 'assistant' || info.role === 'user') {
      state.messageRoles.set(info.id, info.role);
    }
    if (info.role === 'assistant') {
      await flushPendingParts(state, info.id);
    } else if (info.role === 'user') {
      state.pendingMessageParts.delete(info.id);
    }
  }

  if (info.role === 'user' && info.id) {
    await addSlackOriginatedUserUuid(state.channelId, info.id, state.sessionThreadTs);
  }

  if (parts && Array.isArray(parts)) {
    // Always process message.updated parts; append* handlers are idempotent on unchanged content.
    for (const part of parts) {
      await handleMessagePartUpdated(part, undefined, state);
    }
  }

  if (info.role === 'assistant' && info.id) {
    state.model = info.providerID && info.modelID ? encodeModelId(info.providerID, info.modelID) : state.model;
    state.assistantMessageId = info.id;
    // Look up real context window from cached model data (synchronous, no network call)
    const contextWindow = (state.model ? getCachedContextWindow(state.model) : null) ?? DEFAULT_CONTEXT_WINDOW;
    state.lastUsage = {
      inputTokens: info.tokens?.input ?? 0,
      outputTokens: info.tokens?.output ?? 0,
      reasoningTokens: info.tokens?.reasoning ?? 0,
      cacheReadInputTokens: info.tokens?.cache?.read ?? 0,
      cacheCreationInputTokens: info.tokens?.cache?.write ?? 0,
      cost: info.cost ?? 0,
      contextWindow,
      model: state.model || 'OpenCode',
    };
    state.lastUsage.model = state.model || 'OpenCode';

    // Save mapping to the final response message when available
    if (state.responseMessageTs) {
      await saveMessageMapping(state.channelId, state.responseMessageTs, {
        sdkMessageId: info.id,
        sessionId: state.sessionId,
        type: 'assistant',
        parentSlackTs: state.originalTs,
      });
    } else if (state.streamingMessageTs) {
      await saveMessageMapping(state.channelId, state.streamingMessageTs, {
        sdkMessageId: info.id,
        sessionId: state.sessionId,
        type: 'assistant',
        parentSlackTs: state.originalTs,
      });
    }
  }

}

async function processAssistantPart(part: Part, delta: string | undefined, state: ProcessingState): Promise<void> {
  if (part.type === 'text') {
    await appendTextDelta(part.id, part.text, delta, state);
    return;
  }

  if (part.type === 'reasoning') {
    await appendReasoningDelta(part.id, part.text, delta, part.time?.end, part.time?.start, state);
    return;
  }

  if (part.type === 'tool') {
    await handleToolPart(part as ToolPart, state);
  }
}

async function flushPendingParts(state: ProcessingState, messageId: string): Promise<void> {
  const pending = state.pendingMessageParts.get(messageId);
  if (!pending || pending.length === 0) return;
  state.pendingMessageParts.delete(messageId);
  for (const { part, delta } of pending) {
    await processAssistantPart(part, delta, state);
  }
}

async function handleMessagePartUpdated(part: Part | undefined, delta: string | undefined, state: ProcessingState): Promise<void> {
  if (!part) return;
  const messageId = (part as Part & { messageID?: string }).messageID;

  if (messageId) {
    state.seenMessagePartMessageIds.add(messageId);
    const knownRole = state.messageRoles.get(messageId);
    if (knownRole === 'user') return;

    if (!knownRole) {
      if (part.type === 'text') {
        const pending = state.pendingMessageParts.get(messageId) ?? [];
        pending.push({ part, delta });
        state.pendingMessageParts.set(messageId, pending);
        return;
      }
      // Non-text parts imply assistant message; flush any buffered text first.
      state.messageRoles.set(messageId, 'assistant');
      await flushPendingParts(state, messageId);
    }
  }

  await processAssistantPart(part, delta, state);
}

async function appendTextDelta(partId: string | undefined, text: string | undefined, delta: string | undefined, state: ProcessingState): Promise<void> {
  const key = partId || 'text';
  const previous = state.textParts.get(key) || '';
  let next = previous;

  if (typeof delta === 'string') {
    next = previous + delta;
  } else if (text) {
    if (!previous) {
      next = text;
    } else if (text.startsWith(previous)) {
      next = text;
    } else if (previous.startsWith(text)) {
      next = previous;
    } else if (text.length > previous.length) {
      next = text;
    } else {
      next = previous + text;
    }
  }

  if (next === previous) return;

  state.textParts.set(key, next);
  const merged = Array.from(state.textParts.values()).join('');
  if (merged === state.fullResponse) return;

  state.status = 'generating';
  state.fullResponse = merged;
  state.currentResponseSegment = merged;

  if (!state.generatingEntry) {
    const now = Date.now();
    state.generatingEntry = {
      timestamp: now,
      type: 'generating',
      generatingInProgress: true,
      generatingContent: '',
      generatingTruncated: '',
      generatingChars: 0,
    };
    state.generatingSegmentStartTime = now;
    state.activityLog.push(state.generatingEntry);
  }

  state.generatingEntry.generatingContent = state.currentResponseSegment;
  state.generatingEntry.generatingChars = state.currentResponseSegment.length;
  state.generatingEntry.generatingTruncated = state.currentResponseSegment.slice(0, 500);
  state.generatingEntry.generatingInProgress = true;

}

async function finalizeResponseSegment(state: ProcessingState): Promise<void> {
  if (state.finalizingResponseSegment) {
    await state.finalizingResponseSegment;
  }

  const pendingSegment = state.currentResponseSegment || state.fullResponse;
  if (!pendingSegment.trim()) return;

  const entry = state.generatingEntry;
  if (!entry) return;

  const segment = pendingSegment;
  const finalizePromise = (async () => {
    entry.generatingInProgress = false;
    entry.generatingContent = segment;
    entry.generatingChars = segment.length;
    entry.generatingTruncated = segment.slice(0, 500);
    entry.durationMs = Math.max(0, Date.now() - (state.generatingSegmentStartTime ?? entry.timestamp));

    if (state.threadParentTs && segment.trim() && !state.responseMessageTs) {
      const maxAttempts = 3;
      let responseResult: Awaited<ReturnType<typeof postResponseToThread>> = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        responseResult = await postResponseToThread(
          app!.client as WebClient,
          state.channelId,
          state.threadParentTs,
          segment,
          entry.durationMs,
          state.charLimit,
          state.userId
        ).catch((err) => {
          console.error('[Activity Thread] Failed to post response segment:', err);
          return null;
        });

        if (responseResult?.ts) {
          break;
        }
        if (attempt < maxAttempts) {
          await sleep(250 * attempt);
        }
      }

      if (!responseResult?.ts) {
        // Keep pending response state intact so it can be retried/recovered.
        console.error('[Activity Thread] Response segment was not delivered after retries');
        return;
      }

      entry.threadMessageTs = responseResult.ts;
      entry.threadMessageLink = responseResult.permalink;
      state.responseMessageTs = responseResult.ts;
      state.responseMessageLink = responseResult.permalink;
      state.responseAttachmentFailed = Boolean(responseResult.attachmentFailed);

      if (state.assistantMessageId) {
        try {
          await saveMessageMapping(state.channelId, responseResult.ts, {
            sdkMessageId: state.assistantMessageId,
            sessionId: state.sessionId,
            type: 'assistant',
            parentSlackTs: state.originalTs,
          });
        } catch (err) {
          console.error('[opencode] Failed to save message mapping after response post:', err);
        }
      }
    }

    // Clear response segment state only after successful thread post (or no thread parent).
    if (!state.threadParentTs || state.responseMessageTs) {
      state.currentResponseSegment = '';
      state.generatingEntry = undefined;
      state.generatingSegmentStartTime = undefined;
    }
  })();

  state.finalizingResponseSegment = finalizePromise;
  try {
    await finalizePromise;
  } finally {
    if (state.finalizingResponseSegment === finalizePromise) {
      state.finalizingResponseSegment = null;
    }
  }
}

async function getThinkingContentFromSession(
  client: OpencodeClient,
  sessionId: string,
  thinkingTimestamp: number,
  thinkingCharCount: number,
  workingDir: string,
  reasoningPartId?: string
): Promise<string | null> {
  try {
    const response = await client.session.messages({
      path: { id: sessionId },
      query: { directory: workingDir },
    });
    const messages = response.data ?? [];
    for (const msg of messages) {
      if (msg.info?.role !== 'assistant') continue;
      const parts = msg.parts ?? [];
      for (const part of parts) {
        if (part.type !== 'reasoning' || !part.text) continue;
        if (reasoningPartId && part.id === reasoningPartId) {
          return part.text;
        }
        const timeValue = part.time?.end ?? part.time?.start ?? 0;
        const timeMatch = Math.abs(timeValue - thinkingTimestamp) < 1000;
        const charMatch = part.text.length === thinkingCharCount;
        if (timeMatch && charMatch) {
          return part.text;
        }
      }
    }
    console.error('[getThinkingContentFromSession] No matching thinking entry found');
    return null;
  } catch (error) {
    console.error('[getThinkingContentFromSession] Failed:', error);
    return null;
  }
}

async function updateThinkingMessageWithRetry(
  client: WebClient,
  channelId: string,
  messageTs: string,
  text: string,
  maxAttempts: number,
  mainChannelId: string
): Promise<boolean> {
  const permanentErrors = ['message_not_found', 'channel_not_found', 'msg_too_long', 'no_permission'];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.chat.update({ channel: channelId, ts: messageTs, text });
      return true;
    } catch (error: any) {
      const errorCode = error?.data?.error || error?.code;
      if (permanentErrors.includes(errorCode)) {
        console.error(`[updateThinkingMessageWithRetry] Permanent error: ${errorCode}`);
        break;
      }
      if (attempt === maxAttempts) {
        break;
      }
      console.log(`[updateThinkingMessageWithRetry] Attempt ${attempt} failed, retrying... (${errorCode})`);
      await sleep(1000 * attempt);
    }
  }

  try {
    const msgLink = await getMessagePermalink(client, channelId, messageTs);
    await client.chat.postMessage({
      channel: mainChannelId,
      text: `:warning: Failed to update thinking message. File was uploaded but <${msgLink}|message> could not be updated.`,
    });
  } catch {
    await client.chat.postMessage({
      channel: mainChannelId,
      text: ':warning: Failed to update thinking message. File was uploaded but message could not be updated.',
    });
  }
  return false;
}

async function startThinkingEntry(state: ProcessingState, startTime?: number, thinkingPartId?: string): Promise<void> {
  if (state.activityBatch.length > 0 && state.threadParentTs) {
    await flushActivityBatch(
      state,
      app!.client as WebClient,
      state.channelId,
      state.charLimit,
      'long_content',
      state.userId
    );
  }

  // Finalize previous thinking entry before creating new one
  if (state.thinkingEntry && state.thinkingEntry.thinkingInProgress) {
    const prevKey = state.thinkingEntry.thinkingPartId || 'thinking';
    const prevContent = state.reasoningParts.get(prevKey) || state.thinkingEntry.thinkingContent || '';
    if (state.activityThreadMsgTs && state.thinkingEntry.thinkingPartId) {
      state.thinkingThreadMsgMap.set(state.thinkingEntry.thinkingPartId, state.activityThreadMsgTs);
    }
    await finalizeThinkingEntryForPart(state, state.thinkingEntry, prevContent, state.activityThreadMsgTs);
    state.activityThreadMsgTs = null;
  }

  const now = Date.now();
  const elapsedMs = now - state.startTime;
  const entryTimestamp = typeof startTime === 'number' && startTime > 0 ? startTime : now;
  const entry: ActivityEntry = {
    timestamp: entryTimestamp,
    type: 'thinking',
    thinkingContent: '',
    thinkingTruncated: '',
    thinkingInProgress: true,
    durationMs: elapsedMs,
    thinkingPartId,
  };
  state.thinkingEntry = entry;
  const generatingIndex = state.generatingEntry ? state.activityLog.indexOf(state.generatingEntry) : -1;
  if (generatingIndex >= 0) {
    state.activityLog.splice(generatingIndex, 0, entry);
  } else {
    state.activityLog.push(entry);
  }
  state.status = 'thinking';
  state.lastThinkingUpdateTime = 0;

  if (state.threadParentTs) {
    try {
      const result = await (app!.client as WebClient).chat.postMessage({
        channel: state.channelId,
        thread_ts: state.threadParentTs,
        text: ':bulb: *Thinking...*',
        mrkdwn: true,
      });
      if (result.ts) {
        state.activityThreadMsgTs = result.ts as string;
      }
    } catch (err) {
      console.error('[Activity Thread] Failed to post thinking placeholder:', err);
    }
  }
}

function updateThinkingEntryInThread(state: ProcessingState, content: string): void {
  if (!state.activityThreadMsgTs) return;
  const now = Date.now();
  const intervalMs = state.updateRateSeconds * 1000;
  if (now - state.lastThinkingUpdateTime < intervalMs) return;

  const elapsedSec = Math.floor((now - state.startTime) / 1000);
  const preview = content.length > THINKING_MESSAGE_SIZE
    ? extractTailWithFormatting(content, THINKING_MESSAGE_SIZE)
    : content;

  state.pendingThinkingUpdate = (app!.client as WebClient).chat.update({
    channel: state.channelId,
    ts: state.activityThreadMsgTs,
    text: `:bulb: *Thinking...* [${elapsedSec}s] _${content.length} chars_\n> ${preview}`,
  })
    .then(() => {})
    .catch((err) => {
      console.error('[Activity Thread] Failed to update thinking in-place:', err);
    })
    .finally(() => {
      state.pendingThinkingUpdate = null;
    });

  state.lastThinkingUpdateTime = now;
}

async function finalizeThinkingEntryForPart(
  state: ProcessingState,
  entry: ActivityEntry,
  content: string,
  threadMsgTs: string | null
): Promise<void> {
  if (!state.threadParentTs) return;

  const charLimit = THINKING_MESSAGE_SIZE;
  const truncated = content.length > charLimit;

  entry.thinkingContent = content;
  entry.thinkingTruncated = content.length > 500 ? `...${content.slice(-500)}` : content;
  entry.thinkingInProgress = false;

  if (threadMsgTs && truncated) {
    if (state.pendingThinkingUpdate) {
      await state.pendingThinkingUpdate;
    }

    const thinkingMsgLink = await getMessagePermalink(
      app!.client as WebClient,
      state.channelId,
      threadMsgTs
    );

    let attachmentFailed = false;
    const uploadResult = await uploadFilesToThread(
      app!.client as WebClient,
      state.channelId,
      state.threadParentTs,
      content,
      `_Content for <${thinkingMsgLink}|this thinking block>._`,
      state.userId
    );

    if (uploadResult.success && uploadResult.fileMessageTs) {
      const fileMsgLink = await getMessagePermalink(
        app!.client as WebClient,
        state.channelId,
        uploadResult.fileMessageTs
      );
      entry.thinkingAttachmentLink = fileMsgLink;
      const formattedText = formatThreadThinkingMessage(
        entry,
        true,
        charLimit,
        { preserveTail: true, attachmentLink: fileMsgLink }
      );

      await updateThinkingMessageWithRetry(
        app!.client as WebClient,
        state.channelId,
        threadMsgTs,
        formattedText,
        5,
        state.channelId
      );
    } else {
      attachmentFailed = true;
    }

    if (attachmentFailed) {
      const formattedText = formatThreadThinkingMessage(
        entry,
        false,
        charLimit,
        { preserveTail: true }
      );
      const blocks = [
        { type: 'section' as const, text: { type: 'mrkdwn' as const, text: formattedText } },
        buildAttachThinkingFileButton(
          threadMsgTs,
          state.threadParentTs,
          state.channelId,
          state.sessionId,
          state.workingDir,
          entry.timestamp,
          content.length,
          entry.thinkingPartId
        ),
      ];

      try {
        await (app!.client as WebClient).chat.update({
          channel: state.channelId,
          ts: threadMsgTs,
          text: formattedText,
          blocks,
        });
      } catch (err) {
        console.error('[Activity Thread] Failed to update thinking with retry button:', err);
      }
    }

    entry.threadMessageTs = threadMsgTs;
    entry.threadMessageLink = thinkingMsgLink;
    return;
  }

  // Only post new if truncated AND no placeholder exists
  // If placeholder exists, it was already handled in the threadMsgTs && truncated block above
  if (truncated && !threadMsgTs) {
    await postThinkingToThread(
      app!.client as WebClient,
      state.channelId,
      state.threadParentTs,
      entry,
      charLimit,
      state.userId
    );
    return;
  }

  if (threadMsgTs) {
    const formattedText = formatThreadThinkingMessage(entry, false, charLimit);
    try {
      await (app!.client as WebClient).chat.update({
        channel: state.channelId,
        ts: threadMsgTs,
        text: formattedText,
      });
      entry.threadMessageTs = threadMsgTs;
      entry.threadMessageLink = await getMessagePermalink(
        app!.client as WebClient,
        state.channelId,
        threadMsgTs
      );
    } catch (err) {
      console.error('[Activity Thread] Failed to finalize thinking in-place:', err);
    }
    return;
  }

  await postThinkingToThread(
    app!.client as WebClient,
    state.channelId,
    state.threadParentTs,
    entry,
    charLimit,
    state.userId
  );
}

async function finalizeThinkingEntry(state: ProcessingState, content: string): Promise<void> {
  const entry = state.thinkingEntry;
  if (!entry) return;
  await finalizeThinkingEntryForPart(state, entry, content, state.activityThreadMsgTs);
  state.activityThreadMsgTs = null;
}

async function appendReasoningDelta(
  partId: string | undefined,
  text: string | undefined,
  delta: string | undefined,
  endTime: number | undefined,
  startTime: number | undefined,
  state: ProcessingState
): Promise<void> {
  const key = partId || 'thinking';
  const previous = state.reasoningParts.get(key) || '';
  let next = previous;

  if (typeof delta === 'string') {
    next = previous + delta;
  } else if (text) {
    // SDK may send full text or incremental text.
    // Prefer authoritative text when it extends previous content.
    if (!previous) {
      next = text;
    } else if (text.startsWith(previous)) {
      next = text;
    } else if (previous.startsWith(text)) {
      next = previous;
    } else if (text.length > previous.length) {
      next = text;
    } else {
      next = previous + text;
    }
  }

  const hasNewContent = next !== previous;
  if (!hasNewContent && state.completedThinkingPartIds.has(key)) {
    return;
  }

  state.reasoningParts.set(key, next);

  if (state.currentThinkingPartId !== key && !state.completedThinkingPartIds.has(key)) {
    state.currentThinkingPartId = key;
    await startThinkingEntry(state, startTime, partId);
  }

  state.status = 'thinking';
  let entry = state.thinkingEntry;
  if (entry && entry.thinkingPartId !== key) {
    entry = undefined;
  }
  if (!entry) {
    entry = [...state.activityLog].reverse().find((item) => item.type === 'thinking' && item.thinkingPartId === key);
  }

  if (entry) {
    entry.thinkingContent = next;
    entry.thinkingTruncated = next.length > 500 ? '...' + next.slice(-500) : next;
    if (startTime && endTime) {
      entry.durationMs = Math.max(0, endTime - startTime);
    }
    if (endTime === undefined) {
      entry.thinkingInProgress = true;
    }
  }

  if (endTime === undefined) {
    updateThinkingEntryInThread(state, next);
    return;
  }

  if (entry) {
    entry.thinkingInProgress = false;
  }

  const entryToFinalize = state.thinkingEntry?.thinkingPartId === key
    ? state.thinkingEntry
    : [...state.activityLog].reverse().find(
        (item) => item.type === 'thinking' && item.thinkingPartId === key
      );
  if (entryToFinalize) {
    const threadMsgTs = state.thinkingEntry?.thinkingPartId === key
      ? state.activityThreadMsgTs
      : state.thinkingThreadMsgMap.get(key) || null;
    await finalizeThinkingEntryForPart(state, entryToFinalize, next, threadMsgTs);
    if (state.thinkingEntry?.thinkingPartId === key) {
      state.activityThreadMsgTs = null;
    } else {
      state.thinkingThreadMsgMap.delete(key);
    }
  }
  state.completedThinkingPartIds.add(key);
  if (state.currentThinkingPartId === key) {
    state.currentThinkingPartId = undefined;
  }
}

async function handleToolPart(part: ToolPart, state: ProcessingState): Promise<void> {
  const toolName = part.tool || 'tool';
  const status = normalizeToolStatus(part.state?.status);
  const toolKey = part.callID || part.id || toolName;
  const lastStatus = state.toolStates.get(toolKey);

  if (status && lastStatus === status) {
    return;
  }
  if (status) state.toolStates.set(toolKey, status);

  if (status === 'pending' || status === 'running') {
    state.status = 'tool';
    state.currentTool = toolName;
    const entry: ActivityEntry = {
      timestamp: Date.now(),
      type: 'tool_start',
      tool: toolName,
      toolInput: part.state?.input,
      toolUseId: toolKey,
    };
    state.activityLog.push(entry);
    state.activityBatch.push(entry);  // Add to batch for thread posting
    return;
  }

  if (status === 'completed' || status === 'error') {
    state.currentTool = undefined;
    state.toolsCompleted += 1;
    state.status = 'thinking';

    const output = status === 'completed' && part.state && 'output' in part.state && typeof part.state.output === 'string'
      ? part.state.output
      : '';
    const truncated = output.length > 50000;
    const outputSlice = truncated ? output.slice(0, 50000) : output;

    const entry: ActivityEntry = {
      timestamp: Date.now(),
      type: 'tool_complete',
      tool: toolName,
      toolInput: part.state?.input,
      toolUseId: toolKey,
      toolOutput: outputSlice,
      toolOutputPreview: outputSlice ? outputSlice.slice(0, 300) : undefined,
      toolOutputTruncated: truncated,
      toolIsError: status === 'error',
      toolErrorMessage: status === 'error' && part.state && 'error' in part.state
        ? (part.state as { error?: string }).error
        : undefined,
    };

    const toolTime = (part.state as any)?.time;
    if (toolTime?.start && toolTime?.end) {
      entry.durationMs = Math.max(0, toolTime.end - toolTime.start);
    }

    state.activityLog.push(entry);

    // Add to batch: replace tool_start if exists, otherwise add tool_complete
    const batchIdx = state.activityBatch.findIndex(
      e => e.type === 'tool_start' && e.toolUseId === toolKey
    );
    if (batchIdx >= 0) {
      state.activityBatch[batchIdx] = entry;
    } else {
      state.activityBatch.push(entry);
    }

    // If tool was already posted to thread (race condition), update the posted batch
    if (toolKey && state.postedBatchToolUseIds?.has(toolKey) && state.postedBatchTs) {
      void updatePostedBatch(
        state,
        app!.client as WebClient,
        state.channelId,
        state.activityLog,
        toolKey
      ).catch(err => {
        console.error('[Activity Thread] Failed to update posted batch:', err);
      });
    }

    // Detect plan file path in tool input (best-effort)
    const input = part.state?.input as Record<string, unknown> | undefined;
    const planPath = extractPlanFilePath(input);
    if (planPath) {
      await saveSessionPlanPath(state, planPath);
    }
  }
}

async function handleTodoUpdated(todos: Todo[] | undefined, state: ProcessingState): Promise<void> {
  if (!todos || todos.length === 0) return;
  const entry: ActivityEntry = {
    timestamp: Date.now(),
    type: 'tool_complete',
    tool: 'TodoWrite',
    toolInput: { todos },
  };
  state.activityLog.push(entry);
}

async function handlePermissionUpdated(permission: any, state: ProcessingState): Promise<void> {
  if (!permission?.id) return;
  if (state.pendingPermissions.has(permission.id)) return;

  state.pendingPermissions.add(permission.id);
  pendingPermissions.set(permission.id, {
    approvalId: permission.id,
    sessionId: state.sessionId,
    channelId: state.channelId,
    threadTs: state.postingThreadTs,
    userId: state.userId,
    originalTs: state.originalTs,
  });

  const session = state.sessionThreadTs
    ? getThreadSession(state.channelId, state.sessionThreadTs)
    : getSession(state.channelId);

  if (!session) return;

  // Auto-approve in bypass mode
  if (session.mode === 'bypassPermissions') {
    try {
      const instance = await serverPool.getOrCreate(state.channelId);
      await instance.client.respondToPermission(state.sessionId, permission.id, 'always', session.workingDir);
      state.pendingPermissions.delete(permission.id);
    } catch (error) {
      console.error('[opencode] Auto-approve failed:', error);
    }
    return;
  }

  const toolName = permission.title || permission.type || 'tool';
  const toolInput = permission.metadata || {};

  try {
    const response = await withSlackRetry(() =>
      (app!.client as WebClient).chat.postMessage({
        channel: state.channelId,
        thread_ts: state.postingThreadTs,
        text: `OpenCode wants to use ${toolName}`,
        blocks: buildToolApprovalBlocks({
          approvalId: permission.id,
          toolName,
          toolInput: toolInput as Record<string, unknown>,
          userId: state.userId,
          channelId: state.channelId,
        }),
      })
    );

    const messageTs = (response as { ts?: string }).ts;
    if (messageTs) {
      const pending = pendingPermissions.get(permission.id);
      if (pending) pending.messageTs = messageTs;
    }

    if (state.originalTs) {
      await markApprovalWait(app!.client as WebClient, state.channelId, state.originalTs);
    }

    if (state.userId && messageTs) {
      await sendDmNotification({
        client: app!.client as WebClient,
        userId: state.userId,
        channelId: state.channelId,
        messageTs,
        conversationKey: state.conversationKey,
        emoji: ':question:',
        title: 'Approval needed',
        subtitle: `OpenCode wants to use ${toolName}`,
        queryPreview: state.queryText,
      });
    }
  } catch (error) {
    console.error('[opencode] Failed to post tool approval:', error);
  }
}

function getAssistantCompletionTime(message: any): number {
  const completed = message?.info?.time?.completed;
  if (typeof completed === 'number') return completed;
  const created = message?.info?.time?.created;
  if (typeof created === 'number') return created;
  return 0;
}

function hasAuthoritativeAssistantContent(message: any): boolean {
  const parts = message?.parts ?? [];
  const hasText = parts.some((p: any) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0);
  if (hasText) return true;

  const hasReasoning = parts.some((p: any) => p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim().length > 0);
  if (hasReasoning) return true;

  return parts.some((p: any) => p.type === 'tool'
    && (normalizeToolStatus(p?.state?.status) === 'completed' || normalizeToolStatus(p?.state?.status) === 'error'));
}

function hasAssistantTextContent(message: any): boolean {
  const parts = message?.parts ?? [];
  return parts.some((p: any) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0);
}

function selectCurrentAssistantMessage(authMessages: any[], assistantMessageId?: string): any | undefined {
  const assistants = authMessages.filter((m) => m?.info?.role === 'assistant');
  if (assistants.length === 0) return undefined;

  const preferred = assistantMessageId
    ? assistants.find((m) => m.info?.id === assistantMessageId)
    : undefined;
  if (preferred && hasAuthoritativeAssistantContent(preferred)) {
    return preferred;
  }

  const sorted = [...assistants].sort((a, b) => getAssistantCompletionTime(b) - getAssistantCompletionTime(a));
  const bestWithContent = sorted.find((m) => hasAuthoritativeAssistantContent(m));
  if (bestWithContent) return bestWithContent;

  return preferred ?? sorted[0];
}

function selectAssistantMessageForFinalResponse(authMessages: any[], assistantMessageId?: string): any | undefined {
  const assistants = authMessages.filter((m) => m?.info?.role === 'assistant');
  if (assistants.length === 0) return undefined;

  const textAssistants = assistants.filter((m) => hasAssistantTextContent(m));
  if (textAssistants.length === 0) return undefined;

  const sortedByTime = [...textAssistants].sort((a, b) => getAssistantCompletionTime(b) - getAssistantCompletionTime(a));
  const latestText = sortedByTime[0];

  if (!assistantMessageId) return latestText;
  const preferredWithText = textAssistants.find((m) => m.info?.id === assistantMessageId);
  if (!preferredWithText) return latestText;

  // Prefer the latest text-bearing assistant message; if timestamps are equal, keep tracked id.
  if (getAssistantCompletionTime(preferredWithText) === getAssistantCompletionTime(latestText)) {
    return preferredWithText;
  }
  return latestText;
}

async function handleSessionIdle(state: ProcessingState): Promise<void> {
  if ((state.status === 'complete' || state.status === 'error') && !hasPendingFinalResponse(state)) return;

  const session = state.sessionThreadTs
    ? getThreadSession(state.channelId, state.sessionThreadTs)
    : getSession(state.channelId);

  if (state.status !== 'error') {
    state.status = state.status === 'aborted' ? 'aborted' : 'complete';
  }
  if (!session) {
    conversationTracker.stopProcessing(state.sessionId);
    processingBySession.delete(state.sessionId);
    processingByConversation.delete(state.conversationKey);
    return;
  }

  if (state.statusUpdateTimer) {
    clearInterval(state.statusUpdateTimer);
    state.statusUpdateTimer = undefined;
  }

  for (const entry of state.activityLog) {
    if (entry.type === 'thinking' && entry.thinkingInProgress) {
      entry.thinkingInProgress = false;
    }
  }

  try {
    await state.streamingSession.finish();
  } catch (error) {
    console.error('[opencode] Streaming finish error:', error);
  }

  try {
    if (state.assistantMessageId && (state.responseMessageTs || state.streamingMessageTs)) {
      try {
        await saveMessageMapping(state.channelId, state.responseMessageTs ?? state.streamingMessageTs!, {
          sdkMessageId: state.assistantMessageId,
          sessionId: state.sessionId,
          type: 'assistant',
          parentSlackTs: state.originalTs,
        });
      } catch (err) {
        console.error('[opencode] Failed to save message mapping on idle:', err);
      }
    }

    try {
      const update: Partial<Session> = {
        lastUsage: state.lastUsage,
        lastActiveAt: Date.now(),
      };
      if (state.sessionThreadTs) {
        await saveThreadSession(state.channelId, state.sessionThreadTs, update as Partial<ThreadSession>);
      } else {
        await saveSession(state.channelId, update);
      }
    } catch (err) {
      console.error('[opencode] Failed to save session on idle:', err);
    }

    // Flush any remaining activity batch on completion
    if (state.activityBatch.length > 0 && state.threadParentTs) {
      await flushActivityBatch(
        state,
        app!.client as WebClient,
        state.channelId,
        state.charLimit,
        'complete',
        state.userId
      ).catch(err => {
        console.error('[Activity Thread] Failed to flush batch on completion:', err);
      });
    }

    // Flush any pending message parts that haven't been assigned a role yet.
    // When the session is idle, buffered text parts must be from the assistant.
    // Save and restore status because appendTextDelta sets it to 'generating'.
    try {
      const preFlushStatus = state.status;
      for (const [messageId] of state.pendingMessageParts) {
        state.messageRoles.set(messageId, 'assistant');
        await flushPendingParts(state, messageId);
      }
      state.status = preFlushStatus;
    } catch (err) {
      console.error('[opencode] Failed to flush pending parts on idle:', err);
    }

    // Safety net: fetch authoritative messages from session API at idle.
    // This protects against dropped/late SSE events for response/tool/thinking parts.
    if (state.workingDir) {
      try {
        const instance = await serverPool.getOrCreate(state.channelId);
        const client = instance.client.getClient();
        const response = await client.session.messages({
          path: { id: state.sessionId },
          query: { directory: state.workingDir },
        });
        const authMessages = response.data ?? [];

        // Select the best authoritative assistant message for THIS turn.
        // Prefer known assistantMessageId when it has content, otherwise fallback
        // to latest assistant message that contains text/reasoning/terminal tool parts.
        const currentAssistantMsg = selectCurrentAssistantMessage(authMessages, state.assistantMessageId);
        const finalResponseMsg = selectAssistantMessageForFinalResponse(authMessages, state.assistantMessageId);

        if (finalResponseMsg?.info?.id && state.assistantMessageId !== finalResponseMsg.info.id) {
          console.log(`[opencode] Final response source switched to text-bearing message ${finalResponseMsg.info.id}`);
          state.assistantMessageId = finalResponseMsg.info.id;
        }

        if (finalResponseMsg) {
          // Always reconcile the final response with authoritative session data.
          const textParts = (finalResponseMsg.parts ?? []).filter((p: any) => p.type === 'text' && p.text);
          if (textParts.length > 0) {
            const text = textParts.map((p: any) => p.text).join('');
            if (text.trim()) {
              if (state.fullResponse !== text) {
                console.log('[opencode] Using authoritative response from session API');
              }
              state.fullResponse = text;
              state.currentResponseSegment = text;
              if (!state.generatingEntry) {
                const now = Date.now();
                state.generatingEntry = {
                  timestamp: now,
                  type: 'generating',
                  generatingInProgress: false,
                  generatingContent: text,
                  generatingTruncated: text.slice(0, 500),
                  generatingChars: text.length,
                };
                state.generatingSegmentStartTime = now;
                state.activityLog.push(state.generatingEntry);
              } else {
                state.generatingEntry.generatingContent = text;
                state.generatingEntry.generatingChars = text.length;
                state.generatingEntry.generatingTruncated = text.slice(0, 500);
              }
            }
          }
        }

        if (currentAssistantMsg) {
          // Recover reasoning blocks when SSE reasoning events were missed entirely.
          // Only synthesize from authoritative data when no thinking entries exist yet.
          const hasThinkingEntries = state.activityLog.some((entry) => entry.type === 'thinking');
          if (!hasThinkingEntries) {
            const reasoningParts = (currentAssistantMsg.parts ?? [])
              .filter((p: any) => p.type === 'reasoning' && typeof p.text === 'string' && p.text.length > 0);
            for (let i = 0; i < reasoningParts.length; i += 1) {
              const part = reasoningParts[i] as any;
              const reasoningText = part.text as string;
              const now = Date.now();
              const thinkingEntry: ActivityEntry = {
                timestamp: now,
                type: 'thinking',
                thinkingContent: reasoningText,
                thinkingTruncated: reasoningText.length > 500 ? `...${reasoningText.slice(-500)}` : reasoningText,
                thinkingInProgress: false,
                thinkingPartId: part.id || `reasoning-${i}`,
                durationMs: part?.time?.start && part?.time?.end
                  ? Math.max(0, part.time.end - part.time.start)
                  : undefined,
              };
              state.reasoningParts.set(thinkingEntry.thinkingPartId || `reasoning-${i}`, reasoningText);

              const generatingIndex = state.generatingEntry ? state.activityLog.indexOf(state.generatingEntry) : -1;
              if (generatingIndex >= 0) {
                state.activityLog.splice(generatingIndex, 0, thinkingEntry);
              } else {
                state.activityLog.push(thinkingEntry);
              }

              if (state.threadParentTs) {
                await postThinkingToThread(
                  app!.client as WebClient,
                  state.channelId,
                  state.threadParentTs,
                  thinkingEntry,
                  THINKING_MESSAGE_SIZE,
                  state.userId
                ).catch((err) => {
                  console.error('[Activity Thread] Failed to post recovered thinking:', err);
                });
              }
            }
          }

          // Recover missed tool entries from the CURRENT assistant message only.
          // toolStates stores ANY seen status (pending/running/completed/error).
          // Check if the LAST seen status is already a terminal state rather than
          // using has(), since a tool seen as 'running' still needs recovery for 'completed'.
          // handleToolPart sets state.status = 'thinking' on completed/error.
          // Since we already set status to 'complete', save/restore to avoid breaking
          // the finalizeResponseSegment guard.
          const preRecoveryStatus = state.status;
          for (const part of (currentAssistantMsg.parts ?? [])) {
            if ((part as any).type !== 'tool') continue;
            const toolPart = part as ToolPart;
            const toolKey = toolPart.callID || toolPart.id || toolPart.tool || 'tool';
            const status = normalizeToolStatus(toolPart.state?.status);
            const lastSeen = state.toolStates.get(toolKey);
            // Only recover if API has a terminal state AND we haven't already
            // processed a terminal state for this tool (running → completed upgrade)
            if ((status === 'completed' || status === 'error')
                && lastSeen !== 'completed' && lastSeen !== 'error') {
              console.log(`[opencode] Recovering missed tool: ${toolPart.tool} (${toolKey})`);
              await handleToolPart(toolPart, state);
            }
          }
          state.status = preRecoveryStatus;
        }
      } catch (err) {
        console.error('[opencode] Failed to fetch authoritative messages:', err);
      }
    }

    // Re-flush activity batch if tool recovery added new entries
    if (state.activityBatch.length > 0 && state.threadParentTs) {
      await flushActivityBatch(
        state,
        app!.client as WebClient,
        state.channelId,
        state.charLimit,
        'complete',
        state.userId
      ).catch(err => {
        console.error('[Activity Thread] Failed to flush recovered batch:', err);
      });
    }

    try {
      if (state.status === 'complete') {
        await finalizeResponseSegment(state);
        if (hasPendingFinalResponse(state)) {
          state.status = 'error';
          state.customStatus = 'Final response delivery failed';
        } else if (state.threadParentTs && !state.responseMessageTs) {
          state.status = 'error';
          state.customStatus = 'Final response text missing';
        }
      }
    } catch (err) {
      console.error('[opencode] Failed to finalize response on idle:', err);
      state.status = 'error';
      state.customStatus = 'Response finalization failed';
    }

    try {
      await updateStatusMessage(state, session, app!.client as WebClient);
    } catch (err) {
      // Only retry on transient errors (rate limits, network). Permanent errors
      // (channel_not_found, not_in_channel, invalid_auth) are not retryable.
      if (isRecoverable(err)) {
        console.error('[opencode] Final status update failed (transient), retrying after delay:', err);
        try {
          await sleep(2000);
          await updateStatusMessage(state, session, app!.client as WebClient);
        } catch (retryErr) {
          console.error('[opencode] Final status update retry also failed:', retryErr);
        }
      } else {
        console.error('[opencode] Final status update failed (permanent, not retrying):', err);
      }
    }

    if (state.originalTs) {
      try {
        if (state.status === 'aborted') {
          await markAborted(app!.client as WebClient, state.channelId, state.originalTs);
        } else {
          await removeProcessingEmoji(app!.client as WebClient, state.channelId, state.originalTs);
        }
      } catch (err) {
        console.error('[opencode] Failed to update emoji on idle:', err);
      }
    }

    if (state.status === 'complete' && state.userId && state.statusMsgTs) {
      await sendDmNotification({
        client: app!.client as WebClient,
        userId: state.userId,
        channelId: state.channelId,
        messageTs: state.statusMsgTs,
        conversationKey: state.conversationKey,
        emoji: ':white_check_mark:',
        title: 'Query completed',
        queryPreview: state.queryText,
      }).catch((err) => console.error('[opencode] Failed to send completion DM:', err));
    }

    if (state.userId) {
      clearDmDebounce(state.userId, state.conversationKey);
    }
  } finally {
    conversationTracker.stopProcessing(state.sessionId);
    processingBySession.delete(state.sessionId);
    processingByConversation.delete(state.conversationKey);
  }
}

async function updateStatusMessage(state: ProcessingState, session: Session | ThreadSession, client: WebClient): Promise<void> {
  const mutex = getUpdateMutex(state.conversationKey);
  await mutex.runExclusive(async () => {
    const elapsedMs = Date.now() - state.startTime;
    state.spinnerIndex = (state.spinnerIndex + 1) % SPINNER_FRAMES.length;
    const spinner = SPINNER_FRAMES[state.spinnerIndex];

    const usage = state.lastUsage ?? session.lastUsage;
    const { contextPercent, compactPercent, tokensToCompact } = computeContextStats(usage);

    const totalTokensUsed = usage
      ? usage.inputTokens + (usage.cacheCreationInputTokens ?? 0) + usage.cacheReadInputTokens
      : undefined;

    const blocks = buildCombinedStatusBlocks({
      activityLog: state.activityLog,
      inProgress: !['complete', 'error', 'aborted'].includes(state.status),
      status: state.status,
      mode: session.mode as PermissionMode,
      model: state.model ?? session.model,
      elapsedMs,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      contextPercent,
      compactPercent,
      tokensToCompact,
      costUsd: usage?.cost,
      conversationKey: state.conversationKey,
      errorMessage: state.status === 'error' ? state.customStatus : undefined,
      spinner,
      rateLimitHits: undefined,
      customStatus: state.customStatus,
      sessionId: state.sessionId,
      isNewSession: state.isNewSession,
      isFinalSegment: state.status === 'complete',
      forkInfo: {
        threadTs: state.postingThreadTs,
        conversationKey: state.conversationKey,
        sdkMessageId: state.assistantMessageId,
        sessionId: state.sessionId,
      },
      userId: state.userId,
      mentionChannelId: state.channelId,
      sessionTitle: state.sessionTitle ?? session.sessionTitle,
      totalTokensUsed,
      contextWindow: usage?.contextWindow,
      reasoningTokens: usage?.reasoningTokens,
      workingDir: session.workingDir,
    });

    await withSlackRetry(() =>
      client.chat.update({
        channel: state.channelId,
        ts: state.statusMsgTs,
        blocks,
        text: state.status === 'complete' ? 'Complete' : 'Processing',
      })
    );
  });
}

function startStatusUpdater(state: ProcessingState, session: Session | ThreadSession, client: WebClient): void {
  const eventMutex = getEventMutex(state.sessionId);
  state.statusUpdateTimer = setInterval(() => {
    void eventMutex.runExclusive(async () => {
      if (state.status === 'complete' || state.status === 'error' || state.status === 'aborted') {
        return;
      }

      await updateStatusMessage(state, session, client);

      // Flush activity batch on timer
      if (state.activityBatch.length > 0 && state.threadParentTs) {
        await flushActivityBatch(
          state,
          client,
          state.channelId,
          state.charLimit,
          'timer',
          state.userId
        );
      }
    }).catch((error) => {
      console.error('[opencode] Status update error:', error);
    });
  }, state.updateRateSeconds * 1000);
}

function extractPlanFilePath(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  const candidates = ['path', 'filePath', 'file', 'filename', 'target', 'outputPath'];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

async function saveSessionPlanPath(state: ProcessingState, planPath: string): Promise<void> {
  if (state.sessionThreadTs) {
    await saveThreadSession(state.channelId, state.sessionThreadTs, { planFilePath: planPath });
  } else {
    await saveSession(state.channelId, { planFilePath: planPath });
  }
}

async function handleFastForwardSync(
  client: WebClient,
  channelId: string,
  postingThreadTs: string | undefined,
  session: Session,
  userId?: string
): Promise<void> {
  const instance = await serverPool.getOrCreate(channelId);
  const status = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: 'Fast-forwarding session messages...',
    })
  ) as { ts?: string };

  const syncResult = await syncMessagesFromSession(
    {
      conversationKey: makeConversationKey(channelId, postingThreadTs),
      channelId,
      threadTs: postingThreadTs,
      sessionId: session.sessionId!,
      workingDir: session.workingDir,
      client,
      opencode: instance.client.getClient(),
    },
    {
      charLimit: session.threadCharLimit ?? MESSAGE_SIZE_DEFAULT,
    }
  );

  await withSlackRetry(() =>
    client.chat.update({
      channel: channelId,
      ts: status.ts!,
      text: syncResult.wasAborted
        ? 'Fast-forward aborted.'
        : `Fast-forward complete. Synced ${syncResult.syncedCount} of ${syncResult.totalToSync} messages.`,
    })
  );

  startWatching(channelId, postingThreadTs, session, client, instance.client.getClient(), status.ts!, userId);
}

async function runClearSession(
  client: WebClient,
  channelId: string,
  postingThreadTs: string | undefined,
  threadTs: string | undefined,
  session: Session | ThreadSession
): Promise<void> {
  if (!session.sessionId) return;

  const instance = await serverPool.getOrCreate(channelId);
  const newSessionId = await instance.client.createSession(`Slack ${channelId}`, session.workingDir);

  const previous = (session.previousSessionIds ?? []).slice();
  if (session.sessionId && session.sessionId !== newSessionId) {
    previous.push(session.sessionId);
  }

  if (threadTs) {
    await saveThreadSession(channelId, threadTs, {
      sessionId: newSessionId,
      previousSessionIds: previous,
      lastUsage: undefined,
      planFilePath: null,
      planPresentationCount: undefined,
    });
    await clearSyncedMessageUuids(channelId, threadTs);
    await clearSlackOriginatedUserUuids(channelId, threadTs);
  } else {
    await saveSession(channelId, {
      sessionId: newSessionId,
      previousSessionIds: previous,
      lastUsage: undefined,
      planFilePath: null,
      planPresentationCount: undefined,
    });
    await clearSyncedMessageUuids(channelId);
    await clearSlackOriginatedUserUuids(channelId);
  }

  onSessionCleared(channelId, threadTs);

  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: `Session cleared. New session: \`${newSessionId}\``,
    })
  );
}

/**
 * Handle /resume <session-id> — validate session via SDK and switch to it.
 */
async function handleResumeSession(
  client: WebClient,
  channelId: string,
  postingThreadTs: string | undefined,
  sessionThreadTs: string | undefined,
  session: Session | ThreadSession,
  userId: string,
  resumeSessionId: string,
): Promise<void> {
  const instance = await serverPool.getOrCreate(channelId);

  // Validate session exists via OpenCode SDK
  let sessionInfo: { id?: string; title?: string } | null = null;
  try {
    const result = await instance.client.getClient().session.get({
      path: { id: resumeSessionId },
    });
    sessionInfo = result.data ?? null;
  } catch {
    sessionInfo = null;
  }

  if (!sessionInfo?.id) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: `Session \`${resumeSessionId}\` not found. It may have been deleted or created on a different server.`,
      })
    );
    return;
  }

  const oldSessionId = session.sessionId;
  const oldWorkingDir = session.workingDir;

  // Determine new working directory — keep current since OpenCode sessions are server-side
  const newWorkingDir = session.workingDir;

  // Build previous session history
  const previousIds = (session.previousSessionIds ?? []).slice();
  if (oldSessionId && oldSessionId !== resumeSessionId) {
    previousIds.push(oldSessionId);
  }

  const isNewChannel = !session.pathConfigured;

  // Build session update
  const sessionUpdate: Partial<Session> = {
    sessionId: resumeSessionId,
    sessionTitle: sessionInfo.title ?? undefined,
    previousSessionIds: previousIds,
    pathConfigured: true,
    configuredPath: newWorkingDir,
  };

  if (isNewChannel) {
    sessionUpdate.configuredBy = userId;
    sessionUpdate.configuredAt = Date.now();
  }

  // Save session
  if (sessionThreadTs) {
    await saveThreadSession(channelId, sessionThreadTs, sessionUpdate as Partial<ThreadSession>);
  } else {
    await saveSession(channelId, sessionUpdate);
  }

  // Build response
  let response = '';
  if (oldSessionId && oldSessionId !== resumeSessionId) {
    response += `:bookmark: Previous session: \`${oldSessionId}\`\n_Use_ \`/resume ${oldSessionId}\` _to return_\n\n`;
  }
  response += `Resuming session \`${resumeSessionId}\``;
  if (sessionInfo.title) {
    response += ` (${sessionInfo.title})`;
  }
  response += ` in \`${newWorkingDir}\`\n`;

  if (isNewChannel) {
    response += `Path locked to \`${newWorkingDir}\`\n`;
  }

  response += '\nYour next message will continue this session.';

  // Push session_changed activity entry (visible when next query starts)
  const sessionChangedEntry: ActivityEntry = {
    timestamp: Date.now(),
    type: 'session_changed',
    previousSessionId: oldSessionId ?? undefined,
    previousWorkingDir: oldWorkingDir,
    newWorkingDir,
    message: resumeSessionId,
  };
  onSessionResumed(channelId, sessionThreadTs, sessionChangedEntry);

  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: response,
    })
  );
}

async function runCompactSession(
  client: WebClient,
  channelId: string,
  postingThreadTs: string | undefined,
  session: Session | ThreadSession
): Promise<void> {
  if (!session.sessionId) return;

  const instance = await serverPool.getOrCreate(channelId);

  await instance.client.promptAsync(
    session.sessionId,
    [{ type: 'text', text: '/compact' }],
    { workingDir: session.workingDir }
  );

  await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: 'Compaction started.',
    })
  );
}

async function handleUserMessage(params: {
  channelId: string;
  threadTs?: string;
  userId: string;
  userText: string;
  originalTs?: string;
  client: WebClient;
  files?: SlackFile[];
  inlineMode?: PermissionMode;
}): Promise<void> {
  const { channelId, threadTs, userId, originalTs, client } = params;
  let { userText, inlineMode } = params;

  if (!shouldProcessIncomingMessage(channelId, originalTs)) {
    return;
  }

  if (!userText.trim() && params.files && params.files.length > 0) {
    userText = 'Please review the attached files.';
  }
  const isDM = channelId.startsWith('D');
  const sessionThreadTs = !isDM && threadTs ? threadTs : undefined;
  const postingThreadTs = threadTs ?? originalTs;

  let session: Session | ThreadSession | null = null;
  let isNewThreadFork = false;

  if (sessionThreadTs) {
    const forkPoint = findForkPointMessageId(channelId, sessionThreadTs);
    const threadResult = await getOrCreateThreadSession(channelId, sessionThreadTs, forkPoint);
    session = threadResult.session;
    isNewThreadFork = threadResult.isNewFork;
  } else {
    session = getSession(channelId);
    if (!session) {
      session = {
        sessionId: null,
        workingDir: process.cwd(),
        mode: 'bypassPermissions',
        model: undefined,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
        planFilePath: null,
      } as Session;
      await saveSession(channelId, session);
    }
  }

  if (!session) return;

  // Extract inline /mode command when present
  const inlineResult = inlineMode !== undefined
    ? { mode: inlineMode, remainingText: userText }
    : extractInlineMode(userText);

  if (inlineResult.error) {
    const errorText = inlineResult.error ?? 'Invalid mode.';
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: errorText,
      })
    );
    return;
  }

  if (inlineResult.mode) {
    userText = inlineResult.remainingText;
    const update = { mode: inlineResult.mode };
    if (sessionThreadTs) {
      await saveThreadSession(channelId, sessionThreadTs, update);
    } else {
      await saveSession(channelId, update);
    }
    session.mode = inlineResult.mode;
  }

  // Slash commands
  const commandResult = parseCommand(userText.trim(), session as Session, sessionThreadTs);

  // Prevent /resume while a query is active to avoid state corruption
  if (commandResult.resumeSession && session.sessionId && conversationTracker.isBusy(session.sessionId)) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: 'Cannot resume while a request is running. Please wait or abort.',
      })
    );
    return;
  }

  if (commandResult.handled) {
    if (commandResult.sessionUpdate) {
      if (commandResult.sessionUpdate.pathConfigured) {
        commandResult.sessionUpdate.configuredBy = userId;
      }
      const isPathUpdate = 'workingDir' in commandResult.sessionUpdate
        || 'pathConfigured' in commandResult.sessionUpdate
        || 'configuredPath' in commandResult.sessionUpdate
        || 'configuredAt' in commandResult.sessionUpdate
        || 'configuredBy' in commandResult.sessionUpdate;

      if (isPathUpdate) {
        await saveSession(channelId, commandResult.sessionUpdate as Partial<Session>);
        if (sessionThreadTs) {
          await saveThreadSession(channelId, sessionThreadTs, commandResult.sessionUpdate as Partial<ThreadSession>);
        }
      } else if (sessionThreadTs) {
        await saveThreadSession(channelId, sessionThreadTs, commandResult.sessionUpdate as Partial<ThreadSession>);
      } else {
        await saveSession(channelId, commandResult.sessionUpdate as Partial<Session>);
      }
      if (commandResult.sessionUpdate.updateRateSeconds !== undefined && isWatching(channelId, postingThreadTs)) {
        updateWatchRate(channelId, postingThreadTs, commandResult.sessionUpdate.updateRateSeconds);
      }
    }

    if (commandResult.showModeSelection) {
      const response = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: 'Select mode',
          blocks: commandResult.blocks ?? buildModeSelectionBlocks(session!.mode),
        })
      ) as { ts?: string };
      if (originalTs && response.ts) {
        pendingModeSelections.set(response.ts, { originalTs, channelId, threadTs: postingThreadTs, sessionThreadTs });
        await markApprovalWait(client, channelId, originalTs);
      }
      return;
    }

    if (commandResult.showModelSelection) {
      const instance = await serverPool.getOrCreate(channelId);
      const models = await getAvailableModels(instance.client.getClient());
      // Always get recentModels from channel session (threads don't have their own recentModels)
      const channelRecentModels = getSession(channelId)?.recentModels;
      const blocks = session!.model && !(await isModelAvailable(instance.client.getClient(), session!.model))
        ? buildModelDeprecatedBlocks(session!.model, models)
        : buildModelSelectionBlocks(models, session!.model, channelRecentModels);

      const response = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: 'Select model',
          blocks,
        })
      ) as { ts?: string };

      if (originalTs && response.ts) {
        pendingModelSelections.set(response.ts, {
          originalTs,
          channelId,
          threadTs: postingThreadTs,
          sessionThreadTs,
          deferredQuery: commandResult.deferredQuery,
        });
        await markApprovalWait(client, channelId, originalTs);
      }
      return;
    }

    if (commandResult.compactSession) {
      if (session.sessionId && conversationTracker.isBusy(session.sessionId)) {
        await withSlackRetry(() =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: postingThreadTs,
            text: 'Cannot compact while a request is running. Please wait or abort.',
          })
        );
        return;
      }
      await runCompactSession(client, channelId, postingThreadTs, session);
      return;
    }

    if (commandResult.clearSession) {
      if (session.sessionId && conversationTracker.isBusy(session.sessionId)) {
        await withSlackRetry(() =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: postingThreadTs,
            text: 'Cannot clear while a request is running. Please wait or abort.',
          })
        );
        return;
      }
      await runClearSession(client, channelId, postingThreadTs, sessionThreadTs, session);
      return;
    }

    if (commandResult.startTerminalWatch) {
      const response = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: 'Continue in terminal',
          blocks: commandResult.blocks,
        })
      ) as { ts?: string };

      if (session.sessionId && response.ts) {
        const instance = await serverPool.getOrCreate(channelId);
        startWatching(channelId, postingThreadTs, session as Session, client, instance.client.getClient(), response.ts!, userId);
      }
      return;
    }

    if (commandResult.fastForward) {
      await handleFastForwardSync(client, channelId, postingThreadTs, session as Session, userId);
      return;
    }

    if (commandResult.resumeSession && commandResult.resumeSessionId) {
      await handleResumeSession(
        client, channelId, postingThreadTs, sessionThreadTs,
        session, userId, commandResult.resumeSessionId
      );
      return;
    }

    if (commandResult.showPlan && commandResult.planFilePath) {
      try {
        const planContent = await fs.promises.readFile(commandResult.planFilePath, 'utf-8');
        await uploadMarkdownAndPngWithResponse(
          client,
          channelId,
          planContent,
          `:clipboard: *Current Plan*\n\`${commandResult.planFilePath}\`\n` + planContent,
          postingThreadTs,
          userId,
          MESSAGE_SIZE_DEFAULT
        );
      } catch (error) {
        await withSlackRetry(() =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: postingThreadTs,
            text: `❌ Plan file not found at \`${commandResult.planFilePath}\``,
          })
        );
      }
      return;
    }

    if (commandResult.response || commandResult.blocks) {
      await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: commandResult.response ?? 'OK',
          blocks: commandResult.blocks,
        })
      );
      return;
    }

    return;
  }

  if (!session.pathConfigured) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: 'Please set working directory first using /ls, /cd, and /set-current-path.',
      })
    );
    return;
  }

  if (!userText.trim()) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: 'Please provide a message.',
      })
    );
    return;
  }

  // Prepare server instance and ensure event stream
  const instance = await serverPool.getOrCreate(channelId);
  await ensureEventSubscription(channelId, instance.client);

  if (session.model) {
    const models = await getAvailableModels(instance.client.getClient());
    const available = models.some((m) => m.value === session.model);
    if (!available) {
      await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: `Model ${session.model} is no longer available.`,
          blocks: buildModelDeprecatedBlocks(session!.model!, models),
        })
      );
      return;
    }
  }

  // Thread fork if needed
  if (sessionThreadTs && isNewThreadFork) {
    const forkPoint = findForkPointMessageId(channelId, sessionThreadTs);
    const parentSessionId = (session as ThreadSession).forkedFrom || getSession(channelId)?.sessionId || null;
    let forkMessageId = (session as ThreadSession).resumeSessionAtMessageId || forkPoint?.messageId || null;

    if (parentSessionId && !forkMessageId) {
      try {
        const msgs = await instance.client.getClient().session.messages({ path: { id: parentSessionId } });
        const assistants = (msgs.data || []).filter((m: any) => m.info?.role === 'assistant');
        const last = assistants.sort((a: any, b: any) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0)).pop();
        forkMessageId = last?.info?.id || null;
      } catch {
        // Ignore
      }
    }

    if (parentSessionId && forkMessageId) {
      const forkedSessionId = await instance.client.forkSession(parentSessionId, forkMessageId, session.workingDir);
      await saveThreadSession(channelId, sessionThreadTs, {
        sessionId: forkedSessionId,
        forkedFrom: parentSessionId,
        resumeSessionAtMessageId: forkMessageId,
      });
      (session as ThreadSession).sessionId = forkedSessionId;
    }
  }

  // Ensure session exists
  let isNewSession = false;
  if (!session.sessionId) {
    const newSessionId = await instance.client.createSession(`Slack ${channelId}`, session.workingDir, undefined);
    session.sessionId = newSessionId;
    isNewSession = true;
    if (sessionThreadTs) {
      await saveThreadSession(channelId, sessionThreadTs, { sessionId: newSessionId });
    } else {
      await saveSession(channelId, { sessionId: newSessionId });
    }
  }

  // Fetch session title from OpenCode API
  let sessionTitle = session.sessionTitle;
  if (!sessionTitle || sessionTitle.startsWith('Slack ')) {
    try {
      const fetchedTitle = await instance.client.getSessionTitle(session.sessionId!);
      if (fetchedTitle && !fetchedTitle.startsWith('Slack ')) {
        sessionTitle = fetchedTitle;
        // Persist for subsequent queries
        if (sessionThreadTs) {
          await saveThreadSession(channelId, sessionThreadTs, { sessionTitle: fetchedTitle });
        } else {
          await saveSession(channelId, { sessionTitle: fetchedTitle });
        }
      }
    } catch { /* ignore — title is optional */ }
  }

  if (conversationTracker.isBusy(session.sessionId!)) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: 'Another request is already running for this session. Please wait or abort.',
      })
    );
    return;
  }

  const conversationKey = makeConversationKey(channelId, sessionThreadTs);
  const activeContext: BusyContext = {
    conversationKey,
    sessionId: session.sessionId!,
    statusMsgTs: '',
    originalTs: originalTs || '',
    startTime: Date.now(),
    userId,
    query: userText,
    channelId,
    threadTs: sessionThreadTs,
  };

  if (!conversationTracker.startProcessing(session.sessionId!, activeContext)) {
    await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        text: 'Another request is already running for this session. Please wait or abort.',
      })
    );
    return;
  }

  if (originalTs) {
    await markProcessingStart(client, channelId, originalTs);
  }

  // Process files
  let processedFiles = { files: [], warnings: [] } as { files: any[]; warnings: string[] };
  if (params.files && params.files.length > 0) {
    const token = process.env.SLACK_BOT_TOKEN || '';
    const guardResult = await processSlackFilesWithGuard(
      params.files,
      token,
      { writeTempFile, inlineImages: 'always' },
      { allowInlineFallback: true }
    );
    if (guardResult.hasFailedFiles) {
      await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: guardResult.failureMessage ?? 'Some attached files could not be processed.',
        })
      );
      if (originalTs) {
        await markError(client, channelId, originalTs);
      }
      conversationTracker.stopProcessing(session.sessionId!);
      return;
    }
    processedFiles = guardResult;
  }

  const parts = buildMessageContent(userText, processedFiles.files, processedFiles.warnings);

  // Drain any pending activity entries (from /resume, /clear, etc.)
  const pendingEntries = pendingActivityEntries.get(conversationKey) ?? [];
  pendingActivityEntries.delete(conversationKey);

  // Post initial status message
  const initialActivity: ActivityEntry = {
    timestamp: Date.now(),
    type: 'starting',
  };
  const initialLog: ActivityEntry[] = [...pendingEntries, initialActivity];
  const statusBlocks = buildCombinedStatusBlocks({
    activityLog: initialLog,
    inProgress: true,
    status: 'starting',
    mode: session.mode,
    model: session.model,
    elapsedMs: 0,
    conversationKey,
    spinner: SPINNER_FRAMES[0],
    sessionId: session.sessionId!,
    isNewSession,
    isFinalSegment: false,
    forkInfo: {
      threadTs: postingThreadTs,
      conversationKey,
      sdkMessageId: undefined,
      sessionId: session.sessionId!,
    },
    sessionTitle,
    workingDir: session.workingDir,
  });

  const statusMsg = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: 'Processing...',
      blocks: statusBlocks,
    })
  ) as { ts?: string };

  // Post starting entry FIRST (before streaming session) to ensure correct thread order
  const threadParentTs = statusMsg.ts!;
  const startingEntry = initialActivity;
  await postStartingToThread(client, channelId, threadParentTs, startingEntry).catch(err => {
    console.error('[Activity Thread] Failed to post starting entry:', err);
  });

  // Codex-style: do NOT stream response to Slack. Post response once on completion.
  const streaming = createNoopStreamingSession();

  const processingState: ProcessingState = {
    conversationKey,
    channelId,
    sessionThreadTs,
    postingThreadTs,
    sessionId: session.sessionId!,
    workingDir: session.workingDir,
    statusMsgTs: statusMsg.ts!,
    streamingMessageTs: streaming.messageTs,
    streamingSession: streaming,
    startTime: Date.now(),
    spinnerIndex: 0,
    status: 'starting',
    activityLog: initialLog,
    toolsCompleted: 0,
    userId,
    originalTs,
    isNewSession,
    model: session.model,
    sessionTitle,
    queryText: userText,
    fullResponse: '',
    currentResponseSegment: '',
    generatingSegmentStartTime: undefined,
    responseMessageTs: undefined,
    responseMessageLink: undefined,
    responseAttachmentFailed: false,
    textParts: new Map(),
    reasoningParts: new Map(),
    toolStates: new Map(),
    pendingPermissions: new Set(),
    updateRateSeconds: session.updateRateSeconds ?? UPDATE_RATE_DEFAULT,
    lastThinkingUpdateTime: 0,
    currentThinkingPartId: undefined,
    completedThinkingPartIds: new Set(),
    messageRoles: new Map(),
    pendingMessageParts: new Map(),
    finalizingResponseSegment: null,
    seenMessagePartMessageIds: new Set(),

    // Activity thread batch infrastructure
    activityThreadMsgTs: null,
    thinkingThreadMsgMap: new Map(),
    activityBatch: [],
    activityBatchStartIndex: 0,
    lastActivityPostTime: 0,
    threadParentTs: null,  // Will be set to statusMsgTs after posting
    charLimit: (session as any).threadCharLimit ?? MESSAGE_SIZE_DEFAULT,
    postedBatchTs: null,
    postedBatchToolUseIds: new Set(),
    pendingThinkingUpdate: null,
  };

  // Set threadParentTs to statusMsgTs for activity thread replies
  // (starting entry was already posted earlier, before streaming session)
  processingState.threadParentTs = threadParentTs;

  processingBySession.set(session.sessionId!, processingState);
  processingByConversation.set(conversationKey, processingState);

  startStatusUpdater(processingState, session, client);

  const model = session.model ? decodeModelId(session.model) : null;
  const promptOptions = {
    model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
    agent: resolveAgent(session as Session),
    workingDir: session.workingDir,
  };

  try {
    await instance.client.promptAsync(session.sessionId!, parts, promptOptions);
  } catch (error) {
    processingState.status = 'error';
    processingState.customStatus = toUserMessage(error);

    // Flush any pending batch on error
    if (processingState.activityBatch.length > 0 && processingState.threadParentTs) {
      await flushActivityBatch(
        processingState,
        client,
        channelId,
        processingState.charLimit,
        'complete',
        processingState.userId
      ).catch(err => {
        console.error('[Activity Thread] Failed to flush batch on error:', err);
      });
    }

    // Post error to activity thread
    if (processingState.threadParentTs) {
      await postErrorToThread(
        client,
        channelId,
        processingState.threadParentTs,
        toUserMessage(error)
      ).catch(err => {
        console.error('[Activity Thread] Failed to post error:', err);
      });
    }

    await updateStatusMessage(processingState, session, client);
    if (originalTs) {
      await markError(client, channelId, originalTs);
    }
    if (processingState.statusUpdateTimer) {
      clearInterval(processingState.statusUpdateTimer);
      processingState.statusUpdateTimer = undefined;
    }
    conversationTracker.stopProcessing(session.sessionId!);
    processingBySession.delete(session.sessionId!);
    processingByConversation.delete(conversationKey);
  }
}

// Slack action handlers
function registerActionHandlers(appInstance: App): void {
  // Mode selection
  appInstance.action(/^mode_(plan|default|bypassPermissions)$/, async ({ action, ack, body, client }) => {
    await ack();
    const actionId = (action as { action_id: string }).action_id;
    const mode = actionId.replace('mode_', '') as PermissionMode;
    const channelId = (body as any).channel?.id;
    const msgTs = (body as any).message?.ts;

    if (!channelId || !msgTs) return;

    // Get pending selection to know which session type to save to
    const pending = pendingModeSelections.get(msgTs);
    const sessionThreadTs = pending?.sessionThreadTs;

    if (sessionThreadTs) {
      await saveThreadSession(channelId, sessionThreadTs, { mode });
    } else {
      await saveSession(channelId, { mode });
    }

    await withSlackRetry(() =>
      (client as WebClient).chat.update({
        channel: channelId,
        ts: msgTs,
        text: `Mode set to \`${mode}\``,
      })
    );

    if (pending) {
      await markApprovalDone(client as WebClient, pending.channelId, pending.originalTs);
      pendingModeSelections.delete(msgTs);
    }
  });

  // Model selection (static_select dropdown)
  appInstance.action('model_select', async ({ action, ack, body, client }) => {
    await ack();
    const selectedOption = (action as { selected_option?: { value: string; text?: { text: string } } }).selected_option;
    if (!selectedOption) return;

    const modelValue = selectedOption.value;
    const channelId = (body as any).channel?.id;
    const msgTs = (body as any).message?.ts;

    if (!channelId || !msgTs) return;

    // Get pending selection to know which session type to save to
    const pending = pendingModelSelections.get(msgTs);
    const sessionThreadTs = pending?.sessionThreadTs;

    // Always update channel session's recentModels (recent models are channel-level, not thread-level)
    const channelSession = getSession(channelId);
    const recent = (channelSession?.recentModels ?? []).filter(m => m !== modelValue);
    recent.unshift(modelValue);

    if (sessionThreadTs) {
      // Save model to thread session, recentModels to channel session
      await saveThreadSession(channelId, sessionThreadTs, { model: modelValue });
      await saveSession(channelId, { recentModels: recent.slice(0, 5) });
    } else {
      // Save both model and recentModels to channel session
      await saveSession(channelId, {
        model: modelValue,
        recentModels: recent.slice(0, 5),
      });
    }

    const info = await getModelInfo((await serverPool.getOrCreate(channelId)).client.getClient(), modelValue);
    const display = info?.displayName ?? modelValue;

    await withSlackRetry(() =>
      (client as WebClient).chat.update({
        channel: channelId,
        ts: msgTs,
        text: `Model set to ${display}`,
      })
    );

    if (pending) {
      await markApprovalDone(client as WebClient, pending.channelId, pending.originalTs);
      pendingModelSelections.delete(msgTs);

      // If there's a deferred query, process it now with the newly selected model
      if (pending.deferredQuery) {
        await handleUserMessage({
          client: client as WebClient,
          channelId,
          threadTs: pending.threadTs,
          originalTs: pending.originalTs,
          userId: (body as any).user?.id,
          userText: pending.deferredQuery,
        });
      }
    }
  });

  // Model selection cancel button
  appInstance.action('model_cancel', async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const msgTs = (body as any).message?.ts;

    if (!channelId || !msgTs) return;

    // Remove pending model selection tracking
    const pending = pendingModelSelections.get(msgTs);
    if (pending) {
      await markApprovalDone(client as WebClient, pending.channelId, pending.originalTs);
      pendingModelSelections.delete(msgTs);
    }

    // Delete the model selection message
    await withSlackRetry(() =>
      (client as WebClient).chat.delete({
        channel: channelId,
        ts: msgTs,
      })
    );
  });

  // Tool approval
  appInstance.action(/^tool_(approve|deny)_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();
    const actionId = (action as { action_id: string }).action_id;
    const decision = actionId.startsWith('tool_approve_') ? 'once' : 'reject';
    const approvalId = actionId.replace(/^tool_(approve|deny)_/, '');
    const pending = pendingPermissions.get(approvalId);
    if (!pending) return;

    try {
      const instance = await serverPool.getOrCreate(pending.channelId);
      await instance.client.respondToPermission(pending.sessionId, approvalId, decision);

      if (pending.messageTs) {
        await withSlackRetry(() =>
          (client as WebClient).chat.update({
            channel: pending.channelId,
            ts: pending.messageTs!,
            text: decision === 'once' ? 'Approved.' : 'Denied.',
          })
        );
      }

      if (pending.originalTs) {
        await markApprovalDone(client as WebClient, pending.channelId, pending.originalTs);
      }
    } catch (error) {
      console.error('[opencode] Permission response error:', error);
    } finally {
      const state = processingBySession.get(pending.sessionId);
      if (state) {
        state.pendingPermissions.delete(approvalId);
      }
      pendingPermissions.delete(approvalId);
    }
  });

  // Attach thinking file retry button
  appInstance.action(/^attach_thinking_file_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const userId = (body as any).user?.id;
    const activityMsgTs = (body as any).message?.ts;

    if (!channelId || !userId || !activityMsgTs) return;

    let value: {
      threadParentTs?: string;
      sessionId?: string;
      thinkingTimestamp?: number;
      thinkingCharCount?: number;
      workingDir?: string;
      reasoningPartId?: string;
    };
    try {
      value = JSON.parse((action as any).value || '{}');
    } catch {
      return;
    }

    const { threadParentTs, sessionId, thinkingTimestamp, thinkingCharCount, workingDir, reasoningPartId } = value;
    if (!threadParentTs || !sessionId || !workingDir) {
      await (client as WebClient).chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: ':warning: Missing session info. Cannot retry upload.',
      });
      return;
    }

    const instance = await serverPool.getOrCreate(channelId);
    const thinkingContent = await getThinkingContentFromSession(
      instance.client.getClient(),
      sessionId,
      thinkingTimestamp ?? 0,
      thinkingCharCount ?? 0,
      workingDir,
      reasoningPartId
    );

    if (!thinkingContent) {
      await (client as WebClient).chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: ':warning: Could not retrieve thinking content. The session data may be unavailable.',
      });
      return;
    }

    const thinkingMsgLink = await getMessagePermalink(client as WebClient, channelId, activityMsgTs);
    const uploadResult = await uploadFilesToThread(
      client as WebClient,
      channelId,
      threadParentTs,
      thinkingContent,
      `_Content for <${thinkingMsgLink}|this thinking block>._`,
      userId
    );

    if (uploadResult.success && uploadResult.fileMessageTs) {
      const fileMsgLink = await getMessagePermalink(client as WebClient, channelId, uploadResult.fileMessageTs);
      const currentBlocks = (body as any).message?.blocks || [];
      const textBlock = currentBlocks.find((b: any) => b.type === 'section');
      const baseText = textBlock?.text?.text || '';
      const newText = `${baseText}\n_Full response <${fileMsgLink}|attached>._`;

      await (client as WebClient).chat.update({
        channel: channelId,
        ts: activityMsgTs,
        text: newText,
        blocks: undefined,
      });
    } else {
      await (client as WebClient).chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: ':warning: Failed to attach file. Please try again.',
      });
    }
  });

  // Abort button -> confirmation modal
  appInstance.action(/^abort_query_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();
    const actionId = (action as { action_id: string }).action_id;
    const conversationKey = actionId.replace('abort_query_', '');
    const state = processingByConversation.get(conversationKey);
    if (!state) return;
    const triggerId = (body as any).trigger_id;
    if (!triggerId) return;

    await (client as WebClient).views.open({
      trigger_id: triggerId,
      view: buildAbortConfirmationModalView({
        abortType: 'query',
        key: conversationKey,
        channelId: state.channelId,
        messageTs: state.statusMsgTs,
      }),
    });
  });

  // Abort confirmation modal submission
  appInstance.view('abort_confirmation_modal', async ({ ack, view }) => {
    await ack();
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { key } = metadata as { key?: string };
    if (!key) return;
    const state = processingByConversation.get(key);
    if (!state) return;

    try {
      // Add aborted entry to activity log and batch before aborting
      const abortedEntry: ActivityEntry = { timestamp: Date.now(), type: 'aborted' };
      state.activityLog.push(abortedEntry);
      state.activityBatch.push(abortedEntry);

      // Flush activity batch before abort
      if (state.activityBatch.length > 0 && state.threadParentTs) {
        await flushActivityBatch(
          state,
          app!.client as WebClient,
          state.channelId,
          state.charLimit,
          'complete',
          state.userId
        ).catch(err => {
          console.error('[Activity Thread] Failed to flush batch on abort:', err);
        });
      }

      const instance = await serverPool.getOrCreate(state.channelId);
      await instance.client.abort(state.sessionId);
      state.status = 'aborted';
      await handleSessionIdle(state);
    } catch (error) {
      console.error('[opencode] Abort failed:', error);
    }
  });

  // Fork here button -> open modal
  appInstance.action(/^fork_here_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();
    const actionId = (action as { action_id: string }).action_id;
    const conversationKey = actionId.replace('fork_here_', '');
    const triggerId = (body as any).trigger_id;
    const messageTs = (body as any).message?.ts;
    if (!triggerId || !messageTs) return;

    const valueStr = (action as { value?: string }).value || '{}';
    let forkInfo: { threadTs?: string; sdkMessageId?: string; sessionId?: string };
    try {
      forkInfo = JSON.parse(valueStr);
    } catch {
      return;
    }

    const channelId = conversationKey.split('_')[0];
    let suggestedName = `${channelId}-fork`;

    try {
      const channelInfo = await (client as WebClient).conversations.info({ channel: channelId });
      const name = (channelInfo as any).channel?.name;
      if (name) {
        const baseForkName = `${name}-fork`;
        const existingNames = new Set<string>();
        let cursor: string | undefined;
        do {
          const listResult = await (client as WebClient).conversations.list({
            types: 'public_channel,private_channel',
            exclude_archived: false,
            limit: 200,
            cursor,
          });
          if ((listResult as any).ok && (listResult as any).channels) {
            for (const ch of (listResult as any).channels) {
              if (ch.name?.startsWith(baseForkName)) {
                existingNames.add(ch.name);
              }
            }
          }
          cursor = (listResult as any).response_metadata?.next_cursor;
        } while (cursor);

        if (!existingNames.has(baseForkName)) {
          suggestedName = baseForkName;
        } else {
          let num = 1;
          while (existingNames.has(`${baseForkName}-${num}`)) {
            num++;
          }
          suggestedName = `${baseForkName}-${num}`;
        }
      }
    } catch {
      // ignore
    }

    await (client as WebClient).views.open({
      trigger_id: triggerId,
      view: buildForkToChannelModalView({
        sourceChannelId: channelId,
        sourceMessageTs: messageTs,
        conversationKey,
        threadTs: forkInfo.threadTs,
        sdkMessageId: forkInfo.sdkMessageId,
        sessionId: forkInfo.sessionId,
        suggestedChannelName: suggestedName,
      }),
    });
  });

  // Fork modal submission
  appInstance.view('fork_to_channel_modal', async ({ ack, view, client, body }) => {
    const values = view.state?.values as any;
    const channelNameInput = values?.channel_name_block?.channel_name_input?.value as string | undefined;
    if (!channelNameInput) {
      await ack({ response_action: 'errors', errors: { channel_name_block: 'Channel name required' } });
      return;
    }

    await ack();

    const metadata = JSON.parse(view.private_metadata || '{}') as {
      sourceChannelId: string;
      sourceMessageTs: string;
      conversationKey: string;
      threadTs?: string;
      sdkMessageId?: string;
      sessionId?: string;
    };

    const userId = (body as any).user?.id;

    try {
      const created = await (client as WebClient).conversations.create({ name: channelNameInput });
      const newChannelId = (created as any).channel?.id as string;
      if (!newChannelId) throw new Error('Failed to create channel');

      if (userId) {
        try {
          await (client as WebClient).conversations.invite({ channel: newChannelId, users: userId });
        } catch {
          // Ignore invite failures
        }
      }

      const sourceInstance = await serverPool.getOrCreate(metadata.sourceChannelId);
      const sessionId = metadata.sessionId || getSession(metadata.sourceChannelId)?.sessionId;
      if (!sessionId) throw new Error('No source session found for fork');

      const messageId = metadata.sdkMessageId || findForkPointMessageId(metadata.sourceChannelId, metadata.sourceMessageTs)?.messageId;
      if (!messageId) throw new Error('No message ID available for fork');

      const forkedSessionId = await sourceInstance.client.forkSession(sessionId, messageId);
      serverPool.attachChannel(newChannelId, sourceInstance);

      const sourceSession = getSession(metadata.sourceChannelId);
      await saveSession(newChannelId, {
        sessionId: forkedSessionId,
        workingDir: sourceSession?.workingDir ?? process.cwd(),
        mode: sourceSession?.mode ?? 'default',
        model: sourceSession?.model,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: sourceSession?.pathConfigured ?? false,
        configuredPath: sourceSession?.configuredPath ?? null,
        configuredBy: sourceSession?.configuredBy ?? null,
        configuredAt: sourceSession?.configuredAt ?? null,
        forkedFromChannelId: metadata.sourceChannelId,
        forkedFromMessageTs: metadata.sourceMessageTs,
        forkedFromThreadTs: metadata.threadTs,
        forkedFromSdkMessageId: messageId,
        forkedFromSessionId: sessionId,
        forkedFromConversationKey: metadata.conversationKey,
      } as Partial<Session>);

      await (client as WebClient).chat.postMessage({
        channel: newChannelId,
        text: `:twisted_rightwards_arrows: Forked from <https://slack.com/archives/${metadata.sourceChannelId}/p${(metadata.threadTs ?? metadata.sourceMessageTs).replace('.', '')}|source conversation>. Send a message to continue.`,
      });

      if (metadata.sourceChannelId && metadata.sourceMessageTs) {
        try {
          await updateSourceMessageWithForkLink(
            client,
            metadata.sourceChannelId,
            metadata.sourceMessageTs,
            newChannelId,
            {
              threadTs: metadata.threadTs,
              conversationKey: metadata.conversationKey,
              sdkMessageId: messageId,
              sessionId,
            }
          );
        } catch (updateError) {
          console.warn('[opencode] Failed to update source message after fork:', updateError);
        }
      }
    } catch (error) {
      console.error('[opencode] Fork to channel failed:', error);
      if (metadata.sourceChannelId && userId) {
        await (client as WebClient).chat.postEphemeral({
          channel: metadata.sourceChannelId,
          user: userId,
          text: toUserMessage(error),
        });
      }
    }
  });

  // Refresh fork button -> restore Fork here if channel deleted
  appInstance.action(/^refresh_fork_(.+)$/, async ({ action, ack, client }) => {
    await ack();
    const actionId = (action as { action_id: string }).action_id;
    const conversationKey = actionId.replace('refresh_fork_', '');
    const valueStr = (action as { value?: string }).value || '{}';
    let forkInfo: {
      sourceChannelId?: string;
      sourceMessageTs?: string;
      threadTs?: string;
      forkChannelId?: string;
      conversationKey?: string;
      sdkMessageId?: string;
      sessionId?: string;
    };
    try {
      forkInfo = JSON.parse(valueStr);
    } catch {
      return;
    }

    const forkChannelId = forkInfo.forkChannelId;
    if (forkChannelId) {
      try {
        await withSlackRetry(() => (client as WebClient).conversations.info({ channel: forkChannelId }));
        return;
      } catch {
        // Channel missing, restore fork button below
      }
    }

    if (!forkInfo.sourceChannelId || !forkInfo.sourceMessageTs) return;

    await restoreForkHereButton(client, {
      sourceChannelId: forkInfo.sourceChannelId,
      sourceMessageTs: forkInfo.sourceMessageTs,
      threadTs: forkInfo.threadTs,
      conversationKey: forkInfo.conversationKey || conversationKey,
      sdkMessageId: forkInfo.sdkMessageId,
      sessionId: forkInfo.sessionId,
    });
  });
}

interface SlackMessageSummary {
  ts?: string;
  text?: string;
  blocks?: any[];
}

interface SlackMessagesResult {
  messages?: SlackMessageSummary[];
}

async function updateSourceMessageWithForkLink(
  client: any,
  channelId: string,
  messageTs: string,
  forkChannelId: string,
  forkInfo?: {
    threadTs?: string;
    conversationKey?: string;
    sdkMessageId?: string;
    sessionId?: string;
  }
): Promise<void> {
  const threadTs = forkInfo?.threadTs;
  const isThreadReply = Boolean(threadTs && threadTs !== messageTs);
  const mutexKey = `${channelId}_${messageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
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
      forkInfo?.conversationKey
        ? {
            type: 'button',
            text: { type: 'plain_text', text: '🔄 Refresh fork', emoji: true },
            action_id: `refresh_fork_${forkInfo.conversationKey}`,
            value: JSON.stringify({
              forkChannelId,
              sourceChannelId: channelId,
              sourceMessageTs: messageTs,
              threadTs: forkInfo.threadTs,
              conversationKey: forkInfo.conversationKey,
              sdkMessageId: forkInfo.sdkMessageId,
              sessionId: forkInfo.sessionId,
            }),
          }
        : undefined;

    for (const block of msg.blocks) {
      if (block.type === 'actions' && Array.isArray(block.elements)) {
        actionsBlockIndex = updatedBlocks.length;
        const remainingElements = block.elements.filter(
          (el: any) =>
            !(typeof el.action_id === 'string' && el.action_id.startsWith('fork_here_')) &&
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

async function restoreForkHereButton(
  client: any,
  forkInfo: {
    sourceChannelId: string;
    sourceMessageTs: string;
    threadTs?: string;
    conversationKey?: string;
    sdkMessageId?: string;
    sessionId?: string;
  }
): Promise<void> {
  const { sourceChannelId, sourceMessageTs, threadTs, conversationKey, sdkMessageId, sessionId } = forkInfo;

  if (!conversationKey) return;

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
            !(typeof el.action_id === 'string' && el.action_id.startsWith('fork_here_'))
        );
        updatedBlocks.push({ ...block, elements: filteredElements });
        continue;
      }

      updatedBlocks.push(block);
    }

    const forkButton = {
      type: 'button',
      text: { type: 'plain_text', text: ':twisted_rightwards_arrows: Fork here', emoji: true },
      action_id: `fork_here_${conversationKey}`,
      value: JSON.stringify({
        threadTs,
        sdkMessageId,
        sessionId,
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

function registerMessageHandlers(appInstance: App): void {
  // Handle @mentions in channels
  appInstance.event('app_mention', async ({ event, client, context }) => {
    const evt = event as { channel: string; thread_ts?: string; text: string; user: string; ts: string; files?: SlackFile[] };
    if (!evt.channel.startsWith('C')) {
      await (client as WebClient).chat.postMessage({
        channel: evt.channel,
        thread_ts: evt.thread_ts,
        text: '❌ This bot only works in channels, not in direct messages.',
      });
      return;
    }

    if ((evt as { edited?: unknown }).edited || (evt as { subtype?: string }).subtype === 'message_changed') {
      return;
    }

    const botId = context?.botUserId ?? extractFirstMentionId(evt.text);
    if (!botId) {
      // No bot mention found, shouldn't happen in app_mention event but handle gracefully
      return;
    }

    // Extract /mode command (must immediately follow bot mention)
    const mentionModeResult = extractMentionMode(evt.text, botId);

    if (mentionModeResult.error) {
      await (client as WebClient).chat.postMessage({
        channel: evt.channel,
        thread_ts: evt.thread_ts ?? evt.ts,
        text: `❌ ${mentionModeResult.error}`,
      });
      return;
    }

    // Extract /model command (must immediately follow bot mention)
    const mentionModelResult = extractMentionModel(evt.text, botId);

    // If /model command found, show model selection and defer the query
    if (mentionModelResult.hasModelCommand) {
      const instance = await serverPool.getOrCreate(evt.channel);
      const models = await getAvailableModels(instance.client.getClient());
      const channelSession = getSession(evt.channel);
      const channelRecentModels = channelSession?.recentModels;
      const sessionThreadTs = evt.thread_ts;

      const blocks = channelSession?.model && !(await isModelAvailable(instance.client.getClient(), channelSession.model))
        ? buildModelDeprecatedBlocks(channelSession.model, models)
        : buildModelSelectionBlocks(models, channelSession?.model, channelRecentModels);

      const response = await withSlackRetry(() =>
        (client as WebClient).chat.postMessage({
          channel: evt.channel,
          thread_ts: evt.thread_ts ?? evt.ts,
          text: 'Select model',
          blocks,
        })
      ) as { ts?: string };

      if (response.ts) {
        pendingModelSelections.set(response.ts, {
          originalTs: evt.ts,
          channelId: evt.channel,
          threadTs: evt.thread_ts ?? evt.ts,
          sessionThreadTs,
          deferredQuery: mentionModelResult.deferredQuery,
        });
        await markApprovalWait(client as WebClient, evt.channel, evt.ts);
      }
      return;
    }

    // Otherwise, process the message normally with extracted mode (if any)
    await handleUserMessage({
      channelId: evt.channel,
      threadTs: evt.thread_ts,
      userId: evt.user,
      userText: mentionModeResult.remainingText,
      originalTs: evt.ts,
      client: client as WebClient,
      files: evt.files,
      inlineMode: mentionModeResult.mode,
    });
  });

  // Handle DMs and thread replies (non-mentions)
  appInstance.event('message', async ({ event, client }) => {
    const msg = event as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      channel_type?: string;
      thread_ts?: string;
      user?: string;
      text?: string;
      ts: string;
      files?: SlackFile[];
    };

    if (msg.subtype || msg.bot_id) return;

    const isDM = msg.channel_type === 'im' || msg.channel.startsWith('D');
    const isThreadReply = !!msg.thread_ts && msg.channel.startsWith('C');

    if (!isDM && !isThreadReply) return;

    if (!msg.user) return;
    const text = msg.text ?? '';
    if (!text && (!msg.files || msg.files.length === 0)) return;

    // Skip if message contains a mention (handled by app_mention)
    if (text.includes('<@')) return;

    await handleUserMessage({
      channelId: msg.channel,
      threadTs: msg.thread_ts,
      userId: msg.user,
      userText: text,
      originalTs: msg.ts,
      client: client as WebClient,
      files: msg.files,
    });
  });

  // Handle channel deletion - clean up session store for this channel
  appInstance.event('channel_deleted', async ({ event }) => {
    try {
      console.log(`[channel-deleted] Channel deleted: ${event.channel}`);
      await deleteSession(event.channel);
    } catch (error) {
      console.error('[channel-deleted] Error handling channel deletion:', error);
    }
  });
}

export async function startBot(): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    throw new Error('Missing Slack credentials (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET)');
  }

  processedIncomingMessageTs.clear();

  app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  registerMessageHandlers(app);
  registerActionHandlers(app);

  await app.start();
  console.log('OpenCode Slack bot is running.');
}

export async function stopBot(): Promise<void> {
  stopAllWatchers();
  await serverPool.shutdownAll();
  for (const unsubscribe of eventSubscriptions.values()) {
    unsubscribe();
  }
  eventSubscriptions.clear();
  if (app) {
    await app.stop();
    app = null;
  }
}
