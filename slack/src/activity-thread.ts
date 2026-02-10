/**
 * Shared thread-based activity posting for Slack bot.
 *
 * Provides functions to post activity entries as thread replies,
 * with support for batching, rate limiting, and .md attachments for long content.
 *
 * Provider-specific dependencies (upload function, formatters) are injected as callbacks.
 */

import { WebClient } from '@slack/web-api';
import type { ActivityEntry, ActivityBatchState } from './formatting/activity-types.js';
import { withSlackRetry } from './retry.js';
import { formatThreadStartingMessage, formatThreadErrorMessage } from './blocks/thread.js';

// Re-export types so consumers can import from this module
export type { ActivityEntry, ActivityBatchState } from './formatting/activity-types.js';

// ---------------------------------------------------------------------------
// Provider-specific callback types
// ---------------------------------------------------------------------------

/**
 * Upload function for posting markdown as .md attachment when content exceeds limits.
 * Each provider implements this differently (different streaming modules).
 */
export type UploadMarkdownFn = (
  client: WebClient,
  channelId: string,
  markdown: string,
  slackFormattedResponse: string,
  threadTs?: string,
  userId?: string,
  threadCharLimit?: number,
) => Promise<{ ts?: string; attachmentFailed?: boolean } | null>;

/**
 * Format a batch of activity entries for thread posting.
 * Each provider may format tool entries slightly differently.
 */
export type FormatBatchFn = (entries: ActivityEntry[]) => string;

/**
 * Format a thinking entry for thread posting.
 */
export type FormatThinkingFn = (entry: ActivityEntry, truncated: boolean, charLimit: number) => string;

/**
 * Format a response entry for thread posting.
 */
export type FormatResponseFn = (
  charCount: number,
  durationMs: number | undefined,
  content: string,
  truncated: boolean,
  charLimit: number,
) => string;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THREAD_CHAR_LIMIT = 500;

// ---------------------------------------------------------------------------
// getMessagePermalink
// ---------------------------------------------------------------------------

/**
 * Get permalink URL for a message using Slack API.
 * Returns workspace-specific URL that works properly on iOS mobile app.
 * Falls back to manual URL construction if API call fails.
 */
export async function getMessagePermalink(
  client: WebClient,
  channel: string,
  messageTs: string
): Promise<string> {
  try {
    const result = await withSlackRetry(() =>
      client.chat.getPermalink({
        channel,
        message_ts: messageTs,
      })
    ) as { ok?: boolean; permalink?: string };
    if (result.ok && result.permalink) {
      return result.permalink;
    }
  } catch (error) {
    console.error('[getMessagePermalink] Failed to get permalink, using fallback:', error);
  }
  return `https://slack.com/archives/${channel}/p${messageTs.replace('.', '')}`;
}

// ---------------------------------------------------------------------------
// postActivityToThread
// ---------------------------------------------------------------------------

/**
 * Post activity content to a thread reply.
 *
 * If fullMarkdown is provided and exceeds the limit, uses the upload function
 * to attach as .md file. Otherwise posts as a simple text message.
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
    uploadFn?: UploadMarkdownFn;
  }
): Promise<{ ts: string; attachmentFailed?: boolean } | null> {
  const charLimit = options?.charLimit ?? DEFAULT_THREAD_CHAR_LIMIT;
  const threadTs = options?.threadTs ?? parentTs;

  try {
    // If we have long content that needs .md attachment
    if (options?.fullMarkdown && options.fullMarkdown.length > charLimit && options.uploadFn) {
      const result = await options.uploadFn(
        client,
        channelId,
        options.fullMarkdown,
        content,
        threadTs,
        options.userId,
        charLimit
      );
      return result?.ts ? { ts: result.ts, attachmentFailed: result.attachmentFailed } : null;
    }

    // Simple text message to thread
    const result = await withSlackRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: content,
        mrkdwn: true,
      })
    );

    return result.ts ? { ts: result.ts as string, attachmentFailed: false } : null;
  } catch (error) {
    console.error('[activity-thread] Failed to post to thread:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// enqueueActivityFlush — serializes flush operations per state
// ---------------------------------------------------------------------------

const ACTIVITY_FLUSH_QUEUES = new WeakMap<ActivityBatchState, Promise<void>>();

function enqueueActivityFlush(
  state: ActivityBatchState,
  work: () => Promise<void>
): Promise<void> {
  const previous = ACTIVITY_FLUSH_QUEUES.get(state) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(work)
    .finally(() => {
      if (ACTIVITY_FLUSH_QUEUES.get(state) === next) {
        ACTIVITY_FLUSH_QUEUES.delete(state);
      }
    });

  ACTIVITY_FLUSH_QUEUES.set(state, next);
  return next;
}

// ---------------------------------------------------------------------------
// flushActivityBatch
// ---------------------------------------------------------------------------

/**
 * Flush pending activity batch to thread.
 *
 * Uses snapshot-and-clear pattern: captures batch, clears immediately,
 * then posts. On failure, requeues entries to preserve ordering.
 */
export async function flushActivityBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  charLimit: number,
  reason: 'timer' | 'long_content' | 'complete',
  formatBatchFn: FormatBatchFn,
  options?: {
    userId?: string;
    uploadFn?: UploadMarkdownFn;
  }
): Promise<void> {
  return enqueueActivityFlush(state, async () => {
    if (state.activityBatch.length === 0) return;

    if (!state.threadParentTs) {
      console.warn('[activity-thread] No thread parent ts, cannot flush batch');
      return;
    }

    // Snapshot and clear immediately to avoid duplicate/lost entries when flushes overlap
    const batchEntries = [...state.activityBatch];
    state.activityBatch = [];

    const content = formatBatchFn(batchEntries);
    if (!content) return;

    try {
      const result = await postActivityToThread(
        client,
        channelId,
        state.threadParentTs,
        content,
        { charLimit, userId: options?.userId, uploadFn: options?.uploadFn }
      );

      if (result?.ts) {
        // Store for potential updates when tool_result arrives.
        // Include tool_start IDs too, so completions can update previously posted starts.
        state.postedBatchTs = result.ts;
        state.postedBatchToolUseIds = new Set(
          batchEntries
            .filter(e => e.toolUseId)
            .map(e => e.toolUseId!)
        );
        state.lastActivityPostTime = Date.now();

        // Capture permalink for clickable activity links
        try {
          const permalink = await getMessagePermalink(client, channelId, result.ts);
          for (const entry of batchEntries) {
            entry.threadMessageTs = result.ts;
            entry.threadMessageLink = permalink;
          }
        } catch (permalinkError) {
          console.error('[activity-thread] Failed to get permalink for batch:', permalinkError);
        }
      } else {
        // Post failed/empty response: requeue to avoid dropping activity
        state.activityBatch = [...batchEntries, ...state.activityBatch];
      }
    } catch (error) {
      console.error('[activity-thread] Failed to flush batch:', error);
      // Requeue failed batch in front to preserve original ordering
      state.activityBatch = [...batchEntries, ...state.activityBatch];
    }
  });
}

// ---------------------------------------------------------------------------
// updatePostedBatch
// ---------------------------------------------------------------------------

/**
 * Update the most recently posted batch message with new metrics.
 * Called when tool_result arrives after batch was already flushed.
 */
export async function updatePostedBatch(
  state: ActivityBatchState,
  client: WebClient,
  channelId: string,
  activityLog: ActivityEntry[],
  toolUseId: string,
  formatBatchFn: FormatBatchFn
): Promise<void> {
  if (!state.postedBatchTs || !state.postedBatchToolUseIds?.has(toolUseId)) return;

  const batchEntries = activityLog.filter(
    e => e.type === 'tool_complete' && e.toolUseId && state.postedBatchToolUseIds.has(e.toolUseId)
  );

  const content = formatBatchFn(batchEntries);
  if (!content) return;

  try {
    await client.chat.update({
      channel: channelId,
      ts: state.postedBatchTs,
      text: content,
    });
    console.log(`[activity-thread] Updated posted batch with tool result metrics for ${toolUseId}`);
  } catch (error) {
    console.warn('[activity-thread] Failed to update posted batch:', error);
  }
}

// ---------------------------------------------------------------------------
// postThinkingToThread
// ---------------------------------------------------------------------------

/**
 * Post a thinking message to thread.
 * Thinking gets its own message (not batched with tools).
 * If content exceeds limit, attaches .md file.
 */
export async function postThinkingToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  entry: ActivityEntry,
  charLimit: number,
  formatThinkingFn: FormatThinkingFn,
  options?: {
    userId?: string;
    uploadFn?: UploadMarkdownFn;
  }
): Promise<string | null> {
  const content = entry.thinkingContent || (typeof entry.thinkingTruncated === 'string' ? entry.thinkingTruncated : '') || '';
  const truncated = content.length > charLimit;
  const formattedText = formatThinkingFn(entry, truncated, charLimit);

  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formattedText,
    {
      fullMarkdown: truncated ? content : undefined,
      charLimit,
      userId: options?.userId,
      uploadFn: options?.uploadFn,
    }
  );

  const ts = result?.ts ?? null;

  if (ts) {
    try {
      entry.threadMessageTs = ts;
      entry.threadMessageLink = await getMessagePermalink(client, channelId, ts);
    } catch (error) {
      console.error('[postThinkingToThread] Failed to get permalink:', error);
    }
  }

  return ts;
}

// ---------------------------------------------------------------------------
// postResponseToThread
// ---------------------------------------------------------------------------

/**
 * Post a response message to thread.
 * Response gets its own message (not batched with tools).
 * If content exceeds limit, attaches .md file.
 */
export async function postResponseToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  content: string,
  durationMs: number | undefined,
  charLimit: number,
  formatResponseFn: FormatResponseFn,
  options?: {
    userId?: string;
    uploadFn?: UploadMarkdownFn;
  }
): Promise<{ ts: string; permalink: string; attachmentFailed?: boolean } | null> {
  const truncated = content.length > charLimit;
  const formattedText = formatResponseFn(
    content.length,
    durationMs,
    content,
    truncated,
    charLimit
  );

  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formattedText,
    {
      fullMarkdown: truncated ? content : undefined,
      charLimit,
      userId: options?.userId,
      uploadFn: options?.uploadFn,
    }
  );

  const ts = result?.ts;
  if (!ts) return null;

  let permalink: string;
  try {
    permalink = await getMessagePermalink(client, channelId, ts);
  } catch (error) {
    console.error('[postResponseToThread] Failed to get permalink:', error);
    permalink = `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  }

  return { ts, permalink, attachmentFailed: result?.attachmentFailed };
}

// ---------------------------------------------------------------------------
// postStartingToThread
// ---------------------------------------------------------------------------

/**
 * Post a starting message to thread.
 */
export async function postStartingToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  entry?: ActivityEntry
): Promise<string | null> {
  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formatThreadStartingMessage()
  );

  const ts = result?.ts ?? null;

  if (ts && entry) {
    try {
      entry.threadMessageTs = ts;
      entry.threadMessageLink = await getMessagePermalink(client, channelId, ts);
    } catch (error) {
      console.error('[postStartingToThread] Failed to get permalink:', error);
    }
  }

  return ts;
}

// ---------------------------------------------------------------------------
// postErrorToThread
// ---------------------------------------------------------------------------

/**
 * Post an error message to thread.
 */
export async function postErrorToThread(
  client: WebClient,
  channelId: string,
  parentTs: string,
  message: string
): Promise<string | null> {
  const result = await postActivityToThread(
    client,
    channelId,
    parentTs,
    formatThreadErrorMessage(message)
  );

  return result?.ts ?? null;
}
