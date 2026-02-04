import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendDmNotification, truncateQueryForPreview } from '../../../opencode/src/dm-notifications.js';

vi.mock('../../../slack/src/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

function createClient() {
  return {
    users: { info: vi.fn().mockResolvedValue({ user: { is_bot: false } }) },
    conversations: {
      info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
      open: vi.fn().mockResolvedValue({ channel: { id: 'D1' } }),
    },
    chat: {
      getPermalink: vi.fn().mockResolvedValue({ permalink: 'https://example/p1' }),
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as any;
}

describe('dm-notifications', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('truncates preview', () => {
    const preview = truncateQueryForPreview('`hello`    world', 5);
    expect(preview).toBe('hello...');
  });

  it('debounces duplicate notifications', async () => {
    const client = createClient();
    const params = {
      client,
      userId: 'U1',
      channelId: 'C1',
      messageTs: '1.0',
      conversationKey: 'C1',
      emoji: ':eyes:',
      title: 'Approval needed',
      subtitle: 'Test',
      queryPreview: 'do thing',
    };

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValueOnce(now + 1000);

    await sendDmNotification(params);
    await sendDmNotification(params);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});
