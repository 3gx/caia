/**
 * OpenCode Slack bot implementation.
 */

import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { Mutex } from 'async-mutex';
import type { GlobalEvent, Part, ToolPart, Todo } from '@opencode-ai/sdk';
import fs from 'fs';

import { ServerPool } from './server-pool.js';
import type { OpencodeClientWrapper } from './opencode-client.js';
import { ConversationTracker, type ActiveContext } from '../../slack/src/session/conversation-tracker.js';
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
} from './blocks.js';
import {
  startStreamingSession,
  makeConversationKey,
  uploadMarkdownAndPngWithResponse,
} from './streaming.js';
import { parseCommand, extractInlineMode, extractMentionMode, extractFirstMentionId, UPDATE_RATE_DEFAULT, MESSAGE_SIZE_DEFAULT, THINKING_MESSAGE_SIZE } from './commands.js';
import { toUserMessage } from './errors.js';
import { markProcessingStart, markApprovalWait, markApprovalDone, markError, markAborted, removeProcessingEmoji } from './emoji-reactions.js';
import { sendDmNotification, clearDmDebounce } from './dm-notifications.js';
import { processSlackFiles, type SlackFile } from '../../slack/src/file-handler.js';
import { buildMessageContent } from './content-builder.js';
import { withSlackRetry } from '../../slack/src/retry.js';
import { startWatching, isWatching, updateWatchRate, stopAllWatchers, onSessionCleared } from './terminal-watcher.js';
import { syncMessagesFromSession } from './message-sync.js';
import { getAvailableModels, getModelInfo, encodeModelId, decodeModelId, isModelAvailable } from './model-cache.js';
import { postThinkingToThread } from './activity-thread.js';

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
  statusMsgTs: string;
  streamingMessageTs: string | null;
  streamingSession: Awaited<ReturnType<typeof startStreamingSession>>;
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
  textParts: Map<string, string>;
  reasoningParts: Map<string, string>;
  toolStates: Map<string, string>;
  generatingEntry?: ActivityEntry;
  thinkingEntry?: ActivityEntry;
  statusUpdateTimer?: NodeJS.Timeout;
  customStatus?: string;
  pendingPermissions: Set<string>;
}

const serverPool = new ServerPool();
const conversationTracker = new ConversationTracker<BusyContext>();

const processingBySession = new Map<string, ProcessingState>();
const processingByConversation = new Map<string, ProcessingState>();
const eventSubscriptions = new Map<OpencodeClientWrapper, () => void>();
const updateMutexes = new Map<string, Mutex>();
const pendingModelSelections = new Map<string, PendingSelection>();
const pendingModeSelections = new Map<string, PendingSelection>();
const pendingPermissions = new Map<string, PendingPermission>();

let app: App | null = null;

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
  if (props?.part?.sessionID) return props.part.sessionID;
  return null;
}

function resolveAgent(session: Session): 'plan' | 'build' | 'explore' | undefined {
  if (session.agent) return session.agent;
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

  const state = processingBySession.get(sessionId);
  if (!state) return;

  switch (type) {
    case 'message.part.updated':
      await handleMessagePartUpdated(payload?.properties?.part as Part | undefined, payload?.properties?.delta as string | undefined, state);
      break;
    case 'message.updated':
      await handleMessageUpdated(payload?.properties, state);
      break;
    case 'permission.updated':
      await handlePermissionUpdated(payload?.properties, state);
      break;
    case 'session.idle':
      await handleSessionIdle(state);
      break;
    case 'session.compacted':
      state.customStatus = 'Compacted';
      break;
    case 'todo.updated':
      await handleTodoUpdated(payload?.properties?.todos as Todo[] | undefined, state);
      break;
    default:
      break;
  }
}

async function handleMessageUpdated(properties: any, state: ProcessingState): Promise<void> {
  const info = properties?.info as { id?: string; role?: string; sessionID?: string; tokens?: any; cost?: number; modelID?: string; providerID?: string; } | undefined;
  const parts = properties?.parts as Part[] | undefined;

  if (parts && Array.isArray(parts)) {
    for (const part of parts) {
      await handleMessagePartUpdated(part, undefined, state);
    }
  }

  if (!info) return;

  if (info.role === 'user' && info.id) {
    await addSlackOriginatedUserUuid(state.channelId, info.id, state.sessionThreadTs);
  }

  if (info.role === 'assistant' && info.id) {
    state.model = info.providerID && info.modelID ? encodeModelId(info.providerID, info.modelID) : state.model;
    state.assistantMessageId = info.id;
    state.lastUsage = {
      inputTokens: info.tokens?.input ?? 0,
      outputTokens: info.tokens?.output ?? 0,
      reasoningTokens: info.tokens?.reasoning ?? 0,
      cacheReadInputTokens: info.tokens?.cache?.read ?? 0,
      cacheCreationInputTokens: info.tokens?.cache?.write ?? 0,
      cost: info.cost ?? 0,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      model: state.model || 'OpenCode',
    };
    state.lastUsage.model = state.model || 'OpenCode';

    // Save mapping if we already have a streaming message ts
    if (state.streamingMessageTs) {
      await saveMessageMapping(state.channelId, state.streamingMessageTs, {
        sdkMessageId: info.id,
        sessionId: state.sessionId,
        type: 'assistant',
        parentSlackTs: state.originalTs,
      });
    }
  }
}

async function handleMessagePartUpdated(part: Part | undefined, delta: string | undefined, state: ProcessingState): Promise<void> {
  if (!part) return;

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
    return;
  }
}

async function appendTextDelta(partId: string | undefined, text: string | undefined, delta: string | undefined, state: ProcessingState): Promise<void> {
  const key = partId || 'text';
  const previous = state.textParts.get(key) || '';
  let chunk = '';

  if (typeof delta === 'string') {
    chunk = delta;
    state.textParts.set(key, previous + delta);
  } else if (text) {
    if (text.startsWith(previous)) {
      chunk = text.slice(previous.length);
    } else if (!previous) {
      chunk = text;
    } else {
      chunk = text; // fallback
    }
    state.textParts.set(key, text);
  }

  if (!chunk) return;

  state.status = 'generating';
  state.fullResponse += chunk;

  if (!state.generatingEntry) {
    state.generatingEntry = {
      timestamp: Date.now(),
      type: 'generating',
      generatingInProgress: true,
      generatingContent: '',
      generatingTruncated: '',
      generatingChars: 0,
    };
    state.activityLog.push(state.generatingEntry);
  }

  state.generatingEntry.generatingContent = state.fullResponse;
  state.generatingEntry.generatingChars = state.fullResponse.length;
  state.generatingEntry.generatingTruncated = state.fullResponse.slice(0, 500);
  state.generatingEntry.generatingInProgress = true;

  await state.streamingSession.appendText(chunk);
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
    next = text.startsWith(previous) ? text : text;
  }

  state.reasoningParts.set(key, next);

  if (!state.thinkingEntry) {
    state.thinkingEntry = {
      timestamp: Date.now(),
      type: 'thinking',
      thinkingContent: '',
      thinkingTruncated: '',
      thinkingInProgress: true,
    };
    state.activityLog.push(state.thinkingEntry);
  }

  state.status = 'thinking';
  state.thinkingEntry.thinkingContent = next;
  state.thinkingEntry.thinkingTruncated = next.length > 500 ? '...' + next.slice(-500) : next;
  state.thinkingEntry.thinkingInProgress = endTime === undefined;
  if (startTime && endTime) {
    state.thinkingEntry.durationMs = Math.max(0, endTime - startTime);
  }

  if (endTime !== undefined && state.thinkingEntry && state.thinkingEntry.thinkingContent) {
    const content = state.thinkingEntry.thinkingContent;
    if (content.length > THINKING_MESSAGE_SIZE && state.statusMsgTs) {
      await postThinkingToThread(
        app!.client as WebClient,
        state.channelId,
        state.statusMsgTs,
        state.thinkingEntry,
        THINKING_MESSAGE_SIZE,
        state.userId
      );
    }
  }
}

async function handleToolPart(part: ToolPart, state: ProcessingState): Promise<void> {
  const toolName = part.tool || 'tool';
  const status = part.state?.status;
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

    if (part.state?.time?.start && part.state?.time?.end) {
      entry.durationMs = Math.max(0, part.state.time.end - part.state.time.start);
    }

    state.activityLog.push(entry);

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

async function handleSessionIdle(state: ProcessingState): Promise<void> {
  if (state.status === 'complete' || state.status === 'error') return;

  const session = state.sessionThreadTs
    ? getThreadSession(state.channelId, state.sessionThreadTs)
    : getSession(state.channelId);

  state.status = state.status === 'aborted' ? 'aborted' : 'complete';
  if (!session) return;

  if (state.statusUpdateTimer) {
    clearInterval(state.statusUpdateTimer);
    state.statusUpdateTimer = undefined;
  }

  if (state.generatingEntry) {
    state.generatingEntry.generatingInProgress = false;
  }
  if (state.thinkingEntry) {
    state.thinkingEntry.thinkingInProgress = false;
  }

  try {
    await state.streamingSession.finish();
  } catch (error) {
    console.error('[opencode] Streaming finish error:', error);
  }

  if (state.assistantMessageId && state.streamingMessageTs) {
    await saveMessageMapping(state.channelId, state.streamingMessageTs, {
      sdkMessageId: state.assistantMessageId,
      sessionId: state.sessionId,
      type: 'assistant',
      parentSlackTs: state.originalTs,
    });
  }

  {
    const update: Partial<Session> = {
      lastUsage: state.lastUsage,
      lastActiveAt: Date.now(),
    };
    if (state.sessionThreadTs) {
      await saveThreadSession(state.channelId, state.sessionThreadTs, update as Partial<ThreadSession>);
    } else {
      await saveSession(state.channelId, update);
    }
  }

  await updateStatusMessage(state, session, app!.client as WebClient);

  if (state.originalTs) {
    if (state.status === 'aborted') {
      await markAborted(app!.client as WebClient, state.channelId, state.originalTs);
    } else {
      await removeProcessingEmoji(app!.client as WebClient, state.channelId, state.originalTs);
    }
  }

  if (state.userId) {
    clearDmDebounce(state.userId, state.conversationKey);
  }

  conversationTracker.stopProcessing(state.sessionId);
  processingBySession.delete(state.sessionId);
  processingByConversation.delete(state.conversationKey);
}

async function updateStatusMessage(state: ProcessingState, session: Session | ThreadSession, client: WebClient): Promise<void> {
  const mutex = getUpdateMutex(state.conversationKey);
  await mutex.runExclusive(async () => {
    const elapsedMs = Date.now() - state.startTime;
    state.spinnerIndex = (state.spinnerIndex + 1) % SPINNER_FRAMES.length;
    const spinner = SPINNER_FRAMES[state.spinnerIndex];

    const usage = state.lastUsage ?? session.lastUsage;
    const { contextPercent, compactPercent, tokensToCompact } = computeContextStats(usage);

    const blocks = buildCombinedStatusBlocks({
      activityLog: state.activityLog,
      inProgress: !['complete', 'error', 'aborted'].includes(state.status),
      status: state.status,
      mode: session.mode as PermissionMode,
      model: state.model ?? session.model,
      currentTool: state.currentTool,
      toolsCompleted: state.toolsCompleted,
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
  state.statusUpdateTimer = setInterval(() => {
    void updateStatusMessage(state, session, client).catch((error) => {
      console.error('[opencode] Status update error:', error);
    });
  }, STATUS_UPDATE_INTERVAL_MS);
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
        agent: 'build',
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
  if (commandResult.handled) {
    if (commandResult.sessionUpdate) {
      if (commandResult.sessionUpdate.pathConfigured) {
        commandResult.sessionUpdate.configuredBy = userId;
      }
      if (sessionThreadTs) {
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
        pendingModeSelections.set(response.ts, { originalTs, channelId, threadTs: postingThreadTs });
        await markApprovalWait(client, channelId, originalTs);
      }
      return;
    }

    if (commandResult.showModelSelection) {
      const instance = await serverPool.getOrCreate(channelId);
      const models = await getAvailableModels(instance.client.getClient());
      const blocks = session!.model && !(await isModelAvailable(instance.client.getClient(), session!.model))
        ? buildModelDeprecatedBlocks(session!.model, models)
        : buildModelSelectionBlocks(models, session!.model, (session as Session).recentModels);

      const response = await withSlackRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          text: 'Select model',
          blocks,
        })
      ) as { ts?: string };

      if (originalTs && response.ts) {
        pendingModelSelections.set(response.ts, { originalTs, channelId, threadTs: postingThreadTs, sessionThreadTs });
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
    processedFiles = await processSlackFiles(params.files, token);
  }

  const parts = buildMessageContent(userText, processedFiles.files, processedFiles.warnings);

  // Post initial status message
  const initialActivity: ActivityEntry = {
    timestamp: Date.now(),
    type: 'starting',
  };
  const statusBlocks = buildCombinedStatusBlocks({
    activityLog: [initialActivity],
    inProgress: true,
    status: 'starting',
    mode: session.mode,
    model: session.model,
    currentTool: undefined,
    toolsCompleted: 0,
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
  });

  const statusMsg = await withSlackRetry(() =>
    client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      text: 'Processing...',
      blocks: statusBlocks,
    })
  ) as { ts?: string };

  const streaming = await startStreamingSession(client, {
    channel: channelId,
    userId,
    threadTs: postingThreadTs,
    forceFallback: true,
  });

  const processingState: ProcessingState = {
    conversationKey,
    channelId,
    sessionThreadTs,
    postingThreadTs,
    sessionId: session.sessionId!,
    statusMsgTs: statusMsg.ts!,
    streamingMessageTs: streaming.messageTs,
    streamingSession: streaming,
    startTime: Date.now(),
    spinnerIndex: 0,
    status: 'starting',
    activityLog: [initialActivity],
    toolsCompleted: 0,
    userId,
    originalTs,
    isNewSession,
    model: session.model,
    queryText: userText,
    fullResponse: '',
    textParts: new Map(),
    reasoningParts: new Map(),
    toolStates: new Map(),
    pendingPermissions: new Set(),
  };

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

    const threadTs = (body as any).message?.thread_ts;
    if (threadTs) {
      await saveThreadSession(channelId, threadTs, { mode });
    } else {
      await saveSession(channelId, { mode });
    }

    await withSlackRetry(() =>
      (client as WebClient).chat.update({
        channel: channelId,
        ts: msgTs,
        text: `Mode set to ${mode}`,
      })
    );

    const pending = pendingModeSelections.get(msgTs);
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

    if (sessionThreadTs) {
      // Save to thread session
      await saveThreadSession(channelId, sessionThreadTs, { model: modelValue });
    } else {
      // Save to channel session with recent models tracking
      const session = getSession(channelId);
      const recent = (session?.recentModels ?? []).filter(m => m !== modelValue);
      recent.unshift(modelValue);
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
      if (name) suggestedName = `${name}-fork`;
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
        agent: sourceSession?.agent,
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
        text: `:twisted_rightwards_arrows: Forked from <https://slack.com/archives/${metadata.sourceChannelId}/p${metadata.sourceMessageTs.replace('.', '')}|this message>. Send a message to continue.`,
      });
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

    const botId = context?.botUserId ?? extractFirstMentionId(evt.text);
    const mentionModeResult = botId ? extractMentionMode(evt.text, botId) : { remainingText: evt.text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim() };

    if (mentionModeResult.error) {
      await (client as WebClient).chat.postMessage({
        channel: evt.channel,
        thread_ts: evt.thread_ts ?? evt.ts,
        text: `❌ ${mentionModeResult.error}`,
      });
      return;
    }

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
}

export async function startBot(): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    throw new Error('Missing Slack credentials (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET)');
  }

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
