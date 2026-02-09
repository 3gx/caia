import { describe, it, expect, vi } from 'vitest';
import {
  getMessagePermalink,
  postActivityToThread,
  flushActivityBatch,
  type ActivityBatchState,
} from '../../../opencode/src/activity-thread.js';

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

function createBatchState(entries: any[] = []): ActivityBatchState {
  return {
    activityThreadMsgTs: null,
    activityBatch: entries,
    activityBatchStartIndex: 0,
    lastActivityPostTime: 0,
    threadParentTs: 'thread-1',
    postedBatchTs: null,
    postedBatchToolUseIds: new Set<string>(),
  };
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

  it('serializes concurrent flushes and does not duplicate the same batch', async () => {
    const client = createClient();
    let notifyFirstPostStarted!: () => void;
    const firstPostStarted = new Promise<void>((resolve) => {
      notifyFirstPostStarted = resolve;
    });
    let releaseFirstPost!: () => void;
    const firstPost = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });

    client.chat.postMessage
      .mockImplementationOnce(async () => {
        notifyFirstPostStarted();
        await firstPost;
        return { ts: '1.0' };
      })
      .mockResolvedValueOnce({ ts: '2.0' });

    const firstEntry = {
      timestamp: Date.now(),
      type: 'tool_complete',
      tool: 'Read',
      toolUseId: 'tool-1',
      toolInput: { path: '/tmp/first' },
    } as any;
    const secondEntry = {
      timestamp: Date.now() + 1,
      type: 'tool_complete',
      tool: 'Write',
      toolUseId: 'tool-2',
      toolInput: { filePath: '/tmp/second' },
    } as any;
    const state = createBatchState([firstEntry]);

    const firstFlush = flushActivityBatch(state, client, 'C1', 500, 'timer', 'U1');
    await firstPostStarted;

    // Simulate a new entry arriving after first flush captured its snapshot.
    state.activityBatch.push(secondEntry);
    const secondFlush = flushActivityBatch(state, client, 'C1', 500, 'timer', 'U1');

    releaseFirstPost();
    await Promise.all([firstFlush, secondFlush]);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const firstText = client.chat.postMessage.mock.calls[0][0].text as string;
    const secondText = client.chat.postMessage.mock.calls[1][0].text as string;
    expect(firstText).toContain('Read');
    expect(firstText).not.toContain('Write');
    expect(secondText).toContain('Write');
    expect(state.activityBatch).toHaveLength(0);
  });

  it('requeues snapshot on post failure so entries are not lost', async () => {
    const client = createClient();
    client.chat.postMessage
      .mockRejectedValueOnce(new Error('slack down'))
      .mockResolvedValueOnce({ ts: '2.0' });

    const entry = {
      timestamp: Date.now(),
      type: 'tool_complete',
      tool: 'Read',
      toolUseId: 'tool-1',
      toolInput: { path: '/tmp/retry' },
    } as any;
    const state = createBatchState([entry]);

    await flushActivityBatch(state, client, 'C1', 500, 'timer', 'U1');
    expect(state.activityBatch).toHaveLength(1);

    await flushActivityBatch(state, client, 'C1', 500, 'timer', 'U1');
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(state.activityBatch).toHaveLength(0);
  });

  it('tracks tool_start IDs in postedBatchToolUseIds for late completion updates', async () => {
    const client = createClient();
    const entry = {
      timestamp: Date.now(),
      type: 'tool_start',
      tool: 'Read',
      toolUseId: 'tool-start-1',
      toolInput: { path: '/tmp/file' },
    } as any;
    const state = createBatchState([entry]);

    await flushActivityBatch(state, client, 'C1', 500, 'timer', 'U1');

    expect(state.postedBatchTs).toBe('1.0');
    expect(state.postedBatchToolUseIds.has('tool-start-1')).toBe(true);
  });
});
