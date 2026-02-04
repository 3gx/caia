/**
 * Terminal session watcher for syncing OpenCode session activity to Slack.
 * Polls session messages via SDK and posts new messages to Slack channels.
 */

import type { WebClient } from '@slack/web-api';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Session } from './session-manager.js';
import { MESSAGE_SIZE_DEFAULT, UPDATE_RATE_DEFAULT } from './commands.js';
import { MessageSyncState, syncMessagesFromSession } from './message-sync.js';

export interface WatchState {
  conversationKey: string;
  channelId: string;
  threadTs?: string;
  sessionId: string;
  workingDir: string;
  intervalId: NodeJS.Timeout;
  statusMsgTs: string;
  client: WebClient;
  opencode: OpencodeClient;
  updateRateMs: number;
  userId?: string;
  pollInProgress?: boolean;
}

const activeWatchers = new Map<string, WatchState>();

function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}

export function isWatching(channelId: string, threadTs?: string): boolean {
  return activeWatchers.has(getConversationKey(channelId, threadTs));
}

export function getWatcher(channelId: string, threadTs?: string): WatchState | undefined {
  return activeWatchers.get(getConversationKey(channelId, threadTs));
}

export function startWatching(
  channelId: string,
  threadTs: string | undefined,
  session: Session,
  client: WebClient,
  opencode: OpencodeClient,
  statusMsgTs: string,
  userId?: string
): { success: boolean; error?: string } {
  const conversationKey = getConversationKey(channelId, threadTs);

  if (activeWatchers.has(conversationKey)) {
    stopWatching(channelId, threadTs);
  }

  if (!session.sessionId) {
    return { success: false, error: 'No active session' };
  }

  const updateRateMs = (session.updateRateSeconds ?? UPDATE_RATE_DEFAULT) * 1000;

  const state: WatchState = {
    conversationKey,
    channelId,
    threadTs,
    sessionId: session.sessionId,
    workingDir: session.workingDir,
    intervalId: null as any,
    statusMsgTs,
    client,
    opencode,
    updateRateMs,
    userId,
  };

  pollForChanges(state);
  state.intervalId = setInterval(async () => {
    await pollForChanges(state);
  }, updateRateMs);

  activeWatchers.set(conversationKey, state);
  console.log(`[TerminalWatcher] Started watching ${conversationKey}, session=${session.sessionId}`);

  return { success: true };
}

export function stopWatching(channelId: string, threadTs?: string): boolean {
  const conversationKey = getConversationKey(channelId, threadTs);
  const state = activeWatchers.get(conversationKey);
  if (!state) return false;

  clearInterval(state.intervalId);
  activeWatchers.delete(conversationKey);
  console.log(`[TerminalWatcher] Stopped watching ${conversationKey}`);
  return true;
}

export function stopAllWatchers(): void {
  for (const [key, state] of activeWatchers) {
    clearInterval(state.intervalId);
    console.log(`[TerminalWatcher] Stopped watcher ${key} (shutdown)`);
  }
  activeWatchers.clear();
}

export function updateWatchRate(channelId: string, threadTs: string | undefined, newRateSeconds: number): boolean {
  const conversationKey = getConversationKey(channelId, threadTs);
  const state = activeWatchers.get(conversationKey);
  if (!state) return false;

  clearInterval(state.intervalId);
  state.updateRateMs = newRateSeconds * 1000;
  state.intervalId = setInterval(async () => {
    await pollForChanges(state);
  }, state.updateRateMs);

  console.log(`[TerminalWatcher] Updated rate for ${conversationKey} to ${newRateSeconds}s`);
  return true;
}

export function onSessionCleared(channelId: string, threadTs?: string): void {
  if (isWatching(channelId, threadTs)) {
    stopWatching(channelId, threadTs);
  }
}

async function pollForChanges(state: WatchState): Promise<void> {
  if (state.pollInProgress) return;
  state.pollInProgress = true;
  try {
    const syncState: MessageSyncState = {
      conversationKey: state.conversationKey,
      channelId: state.channelId,
      threadTs: state.threadTs,
      sessionId: state.sessionId,
      workingDir: state.workingDir,
      client: state.client,
      opencode: state.opencode,
    };

    await syncMessagesFromSession(syncState, {
      charLimit: MESSAGE_SIZE_DEFAULT,
    });
  } catch (error) {
    console.error('[TerminalWatcher] Error polling for changes:', error);
  } finally {
    state.pollInProgress = false;
  }
}
