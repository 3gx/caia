import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../../codex/src/codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../../codex/src/streaming.js';

function createSlackMock() {
  let postCounter = 0;
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ts: 'activity.ts' }),
      postMessage: vi.fn().mockImplementation(() => {
        postCounter += 1;
        return Promise.resolve({ ts: `thread.${postCounter}` });
      }),
      getPermalink: vi.fn().mockImplementation(({ channel, message_ts }: { channel: string; message_ts: string }) => {
        return Promise.resolve({
          ok: true,
          permalink: `https://slack.com/archives/${channel}/p${String(message_ts).replace('.', '')}`,
        });
      }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
  } as unknown as WebClient;
}

function createContext(): StreamingContext {
  return {
    channelId: 'C123',
    threadTs: '123.456',
    messageTs: '123.456',
    originalTs: '123.456',
    userId: 'U123',
    threadId: 'thread-abc',
    turnId: 'turn-1',
    approvalPolicy: 'on-request',
    mode: 'ask',
    reasoningEffort: 'high',
    sandboxMode: 'workspace-write',
    updateRateMs: 1000,
    model: 'codex-mini',
    startTime: Date.now() - 1000,
    query: 'test query',
  };
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('response segment posting linearity', () => {
  it('posts first response segment during streaming and links Response only after completion', async () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);
    const context = createContext();

    streaming.startStreaming(context);
    const key = makeConversationKey(context.channelId, context.threadTs);

    codex.emit('item:delta', { itemId: 'msg-1', delta: 'First streamed response segment' });
    await tick();

    const threadPosts = (slack.chat.postMessage as any).mock.calls.map((call: any[]) => call[0]);
    expect(
      threadPosts.some(
        (payload: any) =>
          String(payload?.text || '').includes('*Generating*') &&
          String(payload?.text || '').includes('First streamed response segment')
      )
    ).toBe(true);

    await (streaming as any).updateActivityMessage(key);
    const updateCalls = (slack.chat.update as any).mock.calls;
    const latestUpdate = updateCalls[updateCalls.length - 1]?.[0];
    const activityText = latestUpdate?.blocks?.[0]?.text?.text || '';

    expect(activityText).not.toContain(':speech_balloon:');
    expect(activityText).not.toContain('|Response>');

    codex.emit('turn:completed', { threadId: context.threadId, turnId: context.turnId, status: 'completed' });
    await tick(30);

    const finalUpdateCalls = (slack.chat.update as any).mock.calls;
    const finalUpdate = finalUpdateCalls[finalUpdateCalls.length - 1]?.[0];
    const finalActivityText = finalUpdate?.blocks?.[0]?.text?.text || '';

    expect(finalActivityText).toContain(':speech_balloon:');
    expect(finalActivityText).toContain('|Response>');

    streaming.stopStreaming(key);
  });

  it('posts separate response segments around interleaved tool activity in order', async () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);
    const context = createContext();

    streaming.startStreaming(context);
    const key = makeConversationKey(context.channelId, context.threadTs);

    codex.emit('item:delta', { itemId: 'msg-1', delta: 'First response batch' });
    await tick();

    codex.emit('item:started', { itemId: 'tool-1', itemType: 'FileChange' });
    await tick();

    codex.emit('item:completed', { itemId: 'tool-1' });
    await tick();

    codex.emit('item:delta', { itemId: 'msg-1', delta: 'Second response batch' });
    await tick();

    const postedTexts = (slack.chat.postMessage as any).mock.calls.map((call: any[]) => String(call[0]?.text || ''));

    const firstGeneratingIndex = postedTexts.findIndex(
      (text: string) => text.includes('*Generating*') && text.includes('First response batch')
    );
    const toolStartIndex = postedTexts.findIndex((text: string) => text.includes('*FileChange*'));
    const secondGeneratingIndex = postedTexts.findIndex(
      (text: string, index: number) =>
        index > toolStartIndex && text.includes('*Generating*') && text.includes('Second response batch')
    );

    expect(firstGeneratingIndex).toBeGreaterThanOrEqual(0);
    expect(toolStartIndex).toBeGreaterThan(firstGeneratingIndex);
    expect(secondGeneratingIndex).toBeGreaterThan(toolStartIndex);

    const entries = (streaming as any).activityManager.getEntries(key);
    const responseSegments = entries.filter((entry: any) => entry.type === 'generating' && entry.responseSegmentId);

    expect(responseSegments.length).toBeGreaterThanOrEqual(2);
    expect(responseSegments[0].responseSegmentId).toBe('response-0');
    expect(responseSegments[1].responseSegmentId).toBe('response-1');

    streaming.stopStreaming(key);
  });
});
