/**
 * Thread-based activity posting for Claude Slack bot.
 *
 * Thin wrapper around shared caia-slack activity-thread functions,
 * binding claude-specific formatters and upload function.
 */

import { WebClient } from '@slack/web-api';
import {
  flushActivityBatch as sharedFlush,
  updatePostedBatch as sharedUpdate,
  postThinkingToThread as sharedPostThinking,
  postResponseToThread as sharedPostResponse,
  type UploadMarkdownFn,
  type ActivityEntry,
  type ActivityBatchState,
} from 'caia-slack';
import {
  formatThreadActivityBatch,
  formatThreadThinkingMessage,
  formatThreadResponseMessage,
} from './blocks.js';
import { uploadMarkdownAndPngWithResponse } from './streaming.js';

// Re-export shared types and unchanged functions
export type { ActivityEntry, ActivityBatchState } from 'caia-slack';
export {
  getMessagePermalink,
  postActivityToThread,
  postStartingToThread,
  postErrorToThread,
} from 'caia-slack';

/** Claude upload adapter — maps uploadSucceeded to attachmentFailed */
const claudeUploadFn: UploadMarkdownFn = async (client, channelId, markdown, slackFormatted, threadTs, userId, charLimit) => {
  const result = await uploadMarkdownAndPngWithResponse(client, channelId, markdown, slackFormatted, threadTs, userId, charLimit);
  if (!result?.ts) return null;
  return { ts: result.ts, attachmentFailed: result.uploadSucceeded === false };
};

/**
 * Flush pending activity batch to thread.
 * Wraps shared implementation with claude-specific formatThreadActivityBatch.
 */
export async function flushActivityBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  charLimit: number,
  reason: 'timer' | 'long_content' | 'complete',
  userId?: string
): Promise<void> {
  return sharedFlush(state, client, channelId, charLimit, reason, formatThreadActivityBatch, {
    userId,
    uploadFn: claudeUploadFn,
  });
}

/**
 * Update posted batch with new tool result metrics.
 * Wraps shared implementation with claude-specific formatThreadActivityBatch.
 */
export async function updatePostedBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  activityLog: ActivityEntry[],
  toolUseId: string
): Promise<void> {
  return sharedUpdate(state, client, channelId, activityLog, toolUseId, formatThreadActivityBatch);
}

/**
 * Post thinking message to thread.
 * Wraps shared implementation with claude-specific formatThreadThinkingMessage.
 */
export async function postThinkingToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  entry: ActivityEntry,
  charLimit: number,
  userId?: string
): Promise<string | null> {
  return sharedPostThinking(client, channelId, parentTs, entry, charLimit, formatThreadThinkingMessage, {
    userId,
    uploadFn: claudeUploadFn,
  });
}

/**
 * Post response message to thread.
 * Wraps shared implementation with claude-specific formatThreadResponseMessage.
 */
export async function postResponseToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  durationMs: number | undefined,
  charLimit: number,
  userId?: string
): Promise<{ ts: string; permalink: string } | null> {
  return sharedPostResponse(client, channelId, parentTs, content, durationMs, charLimit, formatThreadResponseMessage, {
    userId,
    uploadFn: claudeUploadFn,
  });
}
