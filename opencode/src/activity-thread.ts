/**
 * Thread-based activity posting for Slack bot.
 *
 * Thin wrapper around shared caia-slack activity-thread functions.
 * Injects opencode-specific formatters and upload function as callbacks.
 */

import { WebClient } from '@slack/web-api';
import {
  type ActivityEntry,
  type ActivityBatchState,
  getMessagePermalink as sharedGetMessagePermalink,
  postActivityToThread as sharedPostActivityToThread,
  flushActivityBatch as sharedFlushActivityBatch,
  updatePostedBatch as sharedUpdatePostedBatch,
  postThinkingToThread as sharedPostThinkingToThread,
  postResponseToThread as sharedPostResponseToThread,
  postStartingToThread as sharedPostStartingToThread,
  postErrorToThread as sharedPostErrorToThread,
} from 'caia-slack';
import {
  formatThreadActivityBatch,
  formatThreadThinkingMessage,
  formatThreadResponseMessage,
} from './blocks.js';
import { uploadMarkdownAndPngWithResponse } from './streaming.js';

// Re-export shared types for backward compatibility
export type { ActivityEntry, ActivityBatchState } from 'caia-slack';

// Re-export functions with identical signatures directly
export const getMessagePermalink = sharedGetMessagePermalink;
export const postStartingToThread = sharedPostStartingToThread;
export const postErrorToThread = sharedPostErrorToThread;

/**
 * Post activity content to a thread reply.
 * Wraps shared version with opencode's upload function.
 */
export async function postActivityToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  options?: {
    fullMarkdown?: string;
    charLimit?: number;
    threadTs?: string;
    userId?: string;
  }
): Promise<{ ts: string; attachmentFailed?: boolean } | null> {
  return sharedPostActivityToThread(client, channelId, parentTs, content, {
    ...options,
    uploadFn: uploadMarkdownAndPngWithResponse,
  });
}

/**
 * Flush pending activity batch to thread.
 * Wraps shared version with opencode's batch formatter and upload function.
 */
export async function flushActivityBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  charLimit: number,
  reason: 'timer' | 'long_content' | 'complete',
  userId?: string
): Promise<void> {
  return sharedFlushActivityBatch(
    state,
    client,
    channelId,
    charLimit,
    reason,
    formatThreadActivityBatch,
    { userId, uploadFn: uploadMarkdownAndPngWithResponse }
  );
}

/**
 * Update the most recently posted batch message with new metrics.
 * Wraps shared version with opencode's batch formatter.
 */
export async function updatePostedBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  activityLog: ActivityEntry[],
  toolUseId: string
): Promise<void> {
  return sharedUpdatePostedBatch(
    state,
    client,
    channelId,
    activityLog,
    toolUseId,
    formatThreadActivityBatch
  );
}

/**
 * Post a thinking message to thread.
 * Wraps shared version with opencode's thinking formatter and upload function.
 */
export async function postThinkingToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  entry: ActivityEntry,
  charLimit: number,
  userId?: string
): Promise<string | null> {
  return sharedPostThinkingToThread(
    client,
    channelId,
    parentTs,
    entry,
    charLimit,
    formatThreadThinkingMessage,
    { userId, uploadFn: uploadMarkdownAndPngWithResponse }
  );
}

/**
 * Post a response message to thread.
 * Wraps shared version with opencode's response formatter and upload function.
 */
export async function postResponseToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  durationMs: number | undefined,
  charLimit: number,
  userId?: string
): Promise<{ ts: string; permalink: string; attachmentFailed?: boolean } | null> {
  return sharedPostResponseToThread(
    client,
    channelId,
    parentTs,
    content,
    durationMs,
    charLimit,
    formatThreadResponseMessage,
    { userId, uploadFn: uploadMarkdownAndPngWithResponse }
  );
}
