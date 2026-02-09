import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../../codex/src/codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../../codex/src/streaming.js';

vi.mock('../../../slack/dist/markdown-png.js', () => ({
  markdownToPng: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
}));

class MockCodex extends EventEmitter {
  async getThreadLatestAssistantMessage() {
    return null;
  }

  async getThreadTurnCount() {
    return 1;
  }

  async interruptTurn() {
    return;
  }
}

function createSlackMock(): WebClient {
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
    files: {
      uploadV2: vi.fn().mockResolvedValue({
        files: [
          {
            id: 'FSEGMENT1',
            shares: {
              public: {
                C123: [{ ts: 'file.1' }],
              },
            },
          },
        ],
      }),
      info: vi.fn().mockResolvedValue({
        file: {
          shares: {
            public: {
              C123: [{ ts: 'file.1' }],
            },
          },
        },
      }),
    },
  } as unknown as WebClient;
}

function createContext(updateRateMs: number): StreamingContext {
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
    updateRateMs,
    model: 'codex-mini',
    startTime: Date.now() - 1000,
    query: 'test query',
  };
}

function countResponseThreadUpdates(slack: WebClient): number {
  return (slack.chat.update as any).mock.calls.filter((call: any[]) =>
    String(call?.[0]?.ts || '').startsWith('thread.')
  ).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('response sync throttling', () => {
  it('coalesces rapid response deltas and syncs on update-rate cadence', async () => {
    vi.useFakeTimers();

    const slack = createSlackMock();
    const codex = new MockCodex() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);
    const context = createContext(1000);
    const key = makeConversationKey(context.channelId, context.threadTs);

    streaming.startStreaming(context);

    // Bootstrap the first response segment immediately.
    codex.emit('item:delta', { itemId: 'msg-1', delta: 'first chunk' });
    await vi.advanceTimersByTimeAsync(0);

    const baselineResponseUpdates = countResponseThreadUpdates(slack);
    expect(baselineResponseUpdates).toBeGreaterThanOrEqual(1);

    // Rapid deltas should be coalesced, not synced one-by-one.
    for (let i = 0; i < 10; i++) {
      codex.emit('item:delta', { itemId: 'msg-1', delta: ` chunk-${i}` });
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(countResponseThreadUpdates(slack)).toBe(baselineResponseUpdates);

    // Next sync should happen when update-rate timer fires.
    await vi.advanceTimersByTimeAsync(context.updateRateMs);
    expect(countResponseThreadUpdates(slack)).toBeGreaterThan(baselineResponseUpdates);

    streaming.stopStreaming(key);
  });

  it('cancels pending response sync timers after turn completion', async () => {
    vi.useFakeTimers();

    const slack = createSlackMock();
    const codex = new MockCodex() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);
    const context = createContext(1000);
    const key = makeConversationKey(context.channelId, context.threadTs);

    streaming.startStreaming(context);
    codex.emit('item:delta', { itemId: 'msg-1', delta: 'bootstrap' });
    await vi.advanceTimersByTimeAsync(0);

    // Queue a throttled sync.
    for (let i = 0; i < 8; i++) {
      codex.emit('item:delta', { itemId: 'msg-1', delta: ` late-${i}` });
    }
    await vi.advanceTimersByTimeAsync(0);

    codex.emit('turn:completed', {
      threadId: context.threadId,
      turnId: context.turnId,
      status: 'completed',
    });
    await vi.advanceTimersByTimeAsync(50);

    const updatesAfterCompletion = countResponseThreadUpdates(slack);
    await vi.advanceTimersByTimeAsync(context.updateRateMs * 3);

    // No delayed response-sync timer should fire after completion.
    expect(countResponseThreadUpdates(slack)).toBe(updatesAfterCompletion);

    streaming.stopStreaming(key);
  });
});

