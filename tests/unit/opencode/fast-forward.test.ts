import { describe, it, expect, vi } from 'vitest';
import { syncMessagesFromSession } from '../../../opencode/src/message-sync.js';

vi.mock('../../../slack/src/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

vi.mock('../../../opencode/src/session-manager.js', () => ({
  getSyncedMessageUuids: vi.fn(() => new Set()),
  addSyncedMessageUuid: vi.fn().mockResolvedValue(undefined),
  isSlackOriginatedUserUuid: vi.fn(() => false),
  saveMessageMapping: vi.fn().mockResolvedValue(undefined),
}));

function makeMessage(id: string, text: string, created: number) {
  return {
    info: { id, role: 'assistant', sessionID: 'sess', time: { created } },
    parts: [{ type: 'text', text }],
  } as any;
}

describe('fast-forward', () => {
  it('syncs multiple messages in order', async () => {
    const client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }) } } as any;
    const opencode = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            makeMessage('m1', 'one', 1),
            makeMessage('m2', 'two', 2),
          ],
        }),
      },
    } as any;

    const state = { conversationKey: 'C1', channelId: 'C1', sessionId: 'sess', workingDir: '/tmp', client, opencode };
    const result = await syncMessagesFromSession(state);

    expect(result.syncedCount).toBe(2);
  });
});
