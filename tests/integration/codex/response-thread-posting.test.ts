/**
 * Integration test for response thread posting.
 *
 * Verifies that short responses are always posted to the thread on turn completion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../../codex/src/codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../../codex/src/streaming.js';

function createSlackMock() {
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ts: '123.456' }),
      postMessage: vi.fn().mockResolvedValue({ ts: 'thread.msg.ts' }),
      getPermalink: vi.fn().mockImplementation(({ channel, message_ts }: { channel: string; message_ts: string }) =>
        Promise.resolve({
          ok: true,
          permalink: `https://slack.com/archives/${channel}/p${String(message_ts).replace('.', '')}`,
        })
      ),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
  } as unknown as WebClient;
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    updateRateMs: 1000,
    model: 'codex-mini',
    startTime: Date.now() - 1000,
    query: 'tell me a joke',
  };
}

describe('Response Thread Posting', () => {
  let slack: WebClient;
  let codex: EventEmitter;
  let streaming: StreamingManager;

  beforeEach(() => {
    slack = createSlackMock();
    codex = new EventEmitter();
    streaming = new StreamingManager(slack, codex as unknown as CodexClient);
  });

  it('posts short response to thread on turn completion', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const state = (streaming as any).states.get(conversationKey);
    state.text = 'Short response content';

    codex.emit('turn:completed', { threadId: context.threadId, turnId: context.turnId, status: 'completed' });

    // Wait for async handler to finish
    await new Promise((resolve) => setImmediate(resolve));

    const calls = (slack.chat.postMessage as any).mock.calls;
    const texts = calls.map((call: any[]) => call[0]?.text || '');
    expect(texts.some((t: string) => t.includes('Short response content'))).toBe(true);
  });

  it('reuses existing segment message instead of posting a duplicate when segments were streamed', async () => {
    const context = createContext();
    streaming.startStreaming(context);

    codex.emit('item:delta', { itemId: 'msg-1', delta: 'Segment text from streaming' });
    await tick();

    codex.emit('turn:completed', {
      threadId: context.threadId,
      turnId: context.turnId,
      status: 'completed',
    });
    await tick(30);

    const payloads = (slack.chat.postMessage as any).mock.calls.map((call: any[]) => call[0]);
    const responseTexts = payloads
      .map((payload: any) => String(payload?.text || ''))
      .filter((text: string) => text.includes(':speech_balloon: *Response*') && text.includes('Segment text from streaming'));

    // Should have exactly ONE response message (the segment), not two.
    expect(responseTexts.length).toBe(1);
  });
});
