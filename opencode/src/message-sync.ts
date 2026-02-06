/**
 * Message sync for OpenCode sessions (used by /watch and /ff).
 * Polls session messages via SDK and posts new ones to Slack.
 */

import type { WebClient } from '@slack/web-api';
import type { OpencodeClient, Part } from '@opencode-ai/sdk';
import { markdownToSlack } from './utils.js';
import { truncateWithClosedFormatting, uploadMarkdownWithResponse } from './streaming.js';
import { MESSAGE_SIZE_DEFAULT } from './commands.js';
import { withSlackRetry } from '../../slack/dist/retry.js';
import {
  getSyncedMessageUuids,
  addSyncedMessageUuid,
  isSlackOriginatedUserUuid,
  saveMessageMapping,
} from './session-manager.js';

export interface MessageSyncState {
  conversationKey: string;
  channelId: string;
  threadTs?: string;
  sessionId: string;
  workingDir: string;
  client: WebClient;
  opencode: OpencodeClient;
}

export interface SyncOptions {
  isAborted?: () => boolean;
  onProgress?: (synced: number, total: number) => Promise<void>;
  pacingDelayMs?: number;
  charLimit?: number;
}

export interface SyncResult {
  syncedCount: number;
  totalToSync: number;
  wasAborted: boolean;
  allSucceeded: boolean;
}

function extractText(parts: Part[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      chunks.push(part.text);
    }
  }
  return chunks.join('');
}

async function postText(
  state: MessageSyncState,
  text: string,
  isThread: boolean,
  limit: number
): Promise<string | null> {
  const slackText = markdownToSlack(text);

  if (slackText.length > limit) {
    const truncated = truncateWithClosedFormatting(slackText, limit);
    const result = await uploadMarkdownWithResponse(
      state.client,
      state.channelId,
      text,
      truncated,
      state.threadTs,
      undefined,
      limit
    );
    return result?.ts ?? null;
  }

  const result = await withSlackRetry(() =>
    state.client.chat.postMessage({
      channel: state.channelId,
      thread_ts: isThread ? state.threadTs : undefined,
      text: slackText,
      mrkdwn: true,
    })
  );
  return (result as { ts?: string }).ts ?? null;
}

export async function syncMessagesFromSession(
  state: MessageSyncState,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const { isAborted, onProgress, pacingDelayMs = 0, charLimit = MESSAGE_SIZE_DEFAULT } = options;

  const response = await state.opencode.session.messages({
    path: { id: state.sessionId },
    query: { directory: state.workingDir },
  });

  const messages = response.data ?? [];
  const sorted = messages
    .slice()
    .sort((a, b) => (a.info.time.created || 0) - (b.info.time.created || 0));

  const synced = getSyncedMessageUuids(state.channelId, state.threadTs);
  const totalToSync = sorted.filter((m) => !synced.has(m.info.id)).length;

  let syncedCount = 0;
  let allSucceeded = true;

  for (const msg of sorted) {
    if (isAborted?.()) {
      return { syncedCount, totalToSync, wasAborted: true, allSucceeded: false };
    }

    if (synced.has(msg.info.id)) {
      continue;
    }

    if (msg.info.role === 'user' && isSlackOriginatedUserUuid(state.channelId, msg.info.id, state.threadTs)) {
      await addSyncedMessageUuid(state.channelId, msg.info.id, state.threadTs);
      continue;
    }

    const text = extractText(msg.parts || []);
    if (!text.trim()) {
      await addSyncedMessageUuid(state.channelId, msg.info.id, state.threadTs);
      continue;
    }

    const prefix = msg.info.role === 'user' ? '*User:*\n' : '';
    const postedTs = await postText(state, `${prefix}${text}`, Boolean(state.threadTs), charLimit);

    if (postedTs) {
      syncedCount += 1;
      await addSyncedMessageUuid(state.channelId, msg.info.id, state.threadTs);
      if (msg.info.role === 'assistant') {
        await saveMessageMapping(state.channelId, postedTs, {
          sdkMessageId: msg.info.id,
          sessionId: msg.info.sessionID,
          type: 'assistant',
        });
      }
    } else {
      allSucceeded = false;
    }

    if (onProgress) {
      await onProgress(syncedCount, totalToSync);
    }

    if (pacingDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pacingDelayMs));
    }
  }

  return { syncedCount, totalToSync, wasAborted: false, allSucceeded };
}
