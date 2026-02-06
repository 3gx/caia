import { describe, it, expect, vi } from 'vitest';
import { getMessagePermalink, postActivityToThread } from '../../../opencode/src/activity-thread.js';

vi.mock('../../../slack/dist/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

vi.mock('../../../opencode/src/streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn().mockResolvedValue({ ts: '2.0' }),
}));

function createClient() {
  return {
    chat: {
      getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://example/slack/p1' }),
      postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }),
    },
  } as any;
}

describe('activity-thread', () => {
  it('returns permalink from Slack API', async () => {
    const client = createClient();
    const link = await getMessagePermalink(client, 'C1', '1.0');
    expect(link).toBe('https://example/slack/p1');
  });

  it('falls back to archive URL when API fails', async () => {
    const client = createClient();
    client.chat.getPermalink.mockRejectedValueOnce(new Error('fail'));
    const link = await getMessagePermalink(client, 'C1', '1.0');
    expect(link).toContain('slack.com/archives/C1');
  });

  it('uploads long markdown as attachment', async () => {
    const client = createClient();
    const result = await postActivityToThread(client, 'C1', '1.0', 'short', {
      fullMarkdown: 'x'.repeat(1000),
      charLimit: 10,
    });
    expect(result?.ts).toBe('2.0');
  });
});
