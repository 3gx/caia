import { describe, it, expect, vi } from 'vitest';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

vi.mock('../../../slack/src/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

vi.mock('../../../opencode/src/streaming.js', () => ({
  uploadMarkdownAndPngWithResponse: vi.fn().mockResolvedValue({ ts: '2.0' }),
}));

import { flushActivityBatch, postThinkingToThread, type ActivityBatchState } from '../../../opencode/src/activity-thread.js';
import { uploadMarkdownAndPngWithResponse } from '../../../opencode/src/streaming.js';

describe('activity-thread-flow', () => {
  it('flushes activity batch, posts permalink, and clears batch', async () => {
    const client = createMockWebClient();

    const entry = {
      timestamp: Date.now(),
      type: 'tool_complete',
      tool: 'Read',
      toolUseId: 'tool-1',
      toolInput: { path: '/tmp/file' },
    } as any;

    const state: ActivityBatchState = {
      activityThreadMsgTs: null,
      activityBatch: [entry],
      activityBatchStartIndex: 0,
      lastActivityPostTime: 0,
      threadParentTs: '1.0',
      postedBatchTs: null,
      postedBatchToolUseIds: new Set(),
    };

    await flushActivityBatch(state, client as any, 'C1', 500, 'complete', 'U1');

    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(client.chat.getPermalink).toHaveBeenCalled();
    expect(state.activityBatch).toHaveLength(0);
    expect(entry.threadMessageLink).toContain('example.slack.com');
  });

  it('uploads long thinking content as attachment and captures permalink', async () => {
    const client = createMockWebClient();
    const entry = {
      timestamp: Date.now(),
      type: 'thinking',
      thinkingContent: 'x'.repeat(200),
    } as any;

    const ts = await postThinkingToThread(client as any, 'C1', '1.0', entry, 50, 'U1');

    expect(uploadMarkdownAndPngWithResponse).toHaveBeenCalled();
    expect(ts).toBe('2.0');
    expect(entry.threadMessageLink).toContain('example.slack.com');
  });
});
