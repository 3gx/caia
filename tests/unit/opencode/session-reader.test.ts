import { describe, it, expect, vi } from 'vitest';
import { syncMessagesFromSession } from '../../../opencode/src/message-sync.js';

vi.mock('../../../slack/dist/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

vi.mock('../../../opencode/src/session-manager.js', () => ({
  getSyncedMessageUuids: vi.fn(() => new Set()),
  addSyncedMessageUuid: vi.fn().mockResolvedValue(undefined),
  isSlackOriginatedUserUuid: vi.fn(() => false),
  saveMessageMapping: vi.fn().mockResolvedValue(undefined),
}));

function makeMessage(id: string, created: number, text: string, role: 'user' | 'assistant' = 'assistant') {
  return {
    info: { id, role, sessionID: 'sess', time: { created } },
    parts: [{ type: 'text', text }],
  } as any;
}

describe('session reader (message ordering via sync)', () => {
  it('posts messages in chronological order', async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }),
      },
    } as any;

    const opencode = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            makeMessage('m2', 2, 'second'),
            makeMessage('m1', 1, 'first'),
          ],
        }),
      },
    } as any;

    const state = {
      conversationKey: 'C1',
      channelId: 'C1',
      sessionId: 'sess',
      workingDir: '/tmp',
      client,
      opencode,
    };

    await syncMessagesFromSession(state);

    const calls = client.chat.postMessage.mock.calls;
    expect(calls[0][0].text).toContain('first');
    expect(calls[1][0].text).toContain('second');
  });
});
