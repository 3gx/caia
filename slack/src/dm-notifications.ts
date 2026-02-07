import type { WebClient } from '@slack/web-api';
import { withSlackRetry } from './retry.js';

// Debounce tracking: debounceKey -> lastNotificationTime
const lastDmTime = new Map<string, number>();
export const DM_DEBOUNCE_MS = 15000; // 15 seconds

function buildDebounceKey(userId: string, title: string, conversationKey?: string): string {
  if (conversationKey) return `${userId}:${conversationKey}:${title}`;
  return `${userId}:${title}`;
}

export function truncateQueryForPreview(query: string | undefined, maxLength: number = 50): string {
  if (!query) return '';
  const cleaned = query.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + '...';
}

async function getMessagePermalink(client: WebClient, channelId: string, messageTs: string): Promise<string> {
  try {
    const result = await withSlackRetry(
      () => client.chat.getPermalink({ channel: channelId, message_ts: messageTs }),
      'getPermalink'
    ) as { ok?: boolean; permalink?: string };
    if (result.ok && result.permalink) return result.permalink;
  } catch {
    // Fall through to manual fallback.
  }
  return `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`;
}

export async function sendDmNotification(params: {
  client: WebClient;
  userId: string;
  channelId: string;
  messageTs: string;
  emoji: string;
  title: string;
  subtitle?: string;
  queryPreview?: string;
  conversationKey?: string;
}): Promise<void> {
  const {
    client,
    userId,
    channelId,
    messageTs,
    emoji,
    title,
    subtitle,
    queryPreview,
    conversationKey,
  } = params;

  if (!userId || channelId.startsWith('D')) return;

  try {
    const userInfo = await client.users.info({ user: userId });
    if (userInfo.user?.is_bot) return;
  } catch {
    // If we can't check, proceed anyway.
  }

  const debounceKey = buildDebounceKey(userId, title, conversationKey);
  const now = Date.now();
  const lastTime = lastDmTime.get(debounceKey) || 0;
  if (now - lastTime < DM_DEBOUNCE_MS) return;
  lastDmTime.set(debounceKey, now);

  try {
    let channelName = 'the channel';
    try {
      const channelInfo = await client.conversations.info({ channel: channelId });
      if (channelInfo.ok && channelInfo.channel?.name) {
        channelName = `#${channelInfo.channel.name}`;
      }
    } catch {
      // Keep fallback channel name.
    }

    const permalink = await getMessagePermalink(client, channelId, messageTs);
    const dm = await client.conversations.open({ users: userId });
    if (!dm.channel?.id) return;

    const cleanedPreview = truncateQueryForPreview(queryPreview);
    const queryClause = cleanedPreview ? ` \`${cleanedPreview}\`` : '';
    const text = `${emoji}${queryClause} in ${channelName}`;

    await withSlackRetry(
      () =>
        client.chat.postMessage({
          channel: dm.channel!.id!,
          text,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${text}${subtitle ? `\n${subtitle}` : ''}`,
              },
              accessory: {
                type: 'button',
                text: { type: 'plain_text', text: 'View →', emoji: true },
                url: permalink,
                action_id: 'dm_notification_view',
              },
            },
          ],
          unfurl_links: false,
        }),
      'dm.post'
    );
  } catch (e: unknown) {
    const err = e as { data?: { error?: string } };
    console.error('Failed to send DM notification:', err?.data?.error);
  }
}

export function clearDmDebounce(userId: string, conversationKey: string, title?: string): void {
  if (title) {
    lastDmTime.delete(buildDebounceKey(userId, title, conversationKey));
    return;
  }
  const prefix = `${userId}:${conversationKey}:`;
  for (const key of lastDmTime.keys()) {
    if (key.startsWith(prefix)) {
      lastDmTime.delete(key);
    }
  }
}

export function clearAllDmDebounce(): void {
  lastDmTime.clear();
}
