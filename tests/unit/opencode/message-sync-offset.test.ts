import { describe, it, expect, vi } from 'vitest';
import { syncMessagesFromSession } from '../../../opencode/src/message-sync.js';

vi.mock('../../../slack/src/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

const addSyncedMessageUuid = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../opencode/src/session-manager.js', () => ({
  getSyncedMessageUuids: vi.fn(() => new Set(['m1'])),
  addSyncedMessageUuid,
  isSlackOriginatedUserUuid: vi.fn(() => false),
  saveMessageMapping: vi.fn().mockResolvedValue(undefined),
}));

function makeMessage(id: string, text: string) {
  return {
    info: { id, role: 'assistant', sessionID: 'sess', time: { created: 1 } },
    parts: [{ type: 'text', text }],
  } as any;
}

describe('message-sync offset', () => {
  it('skips messages already synced', async () => {
    const client = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }) },
    } as any;

    const opencode = {
      session: { messages: vi.fn().mockResolvedValue({ data: [makeMessage('m1', 'skip')] }) },
    } as any;

    const state = { conversationKey: 'C1', channelId: 'C1', sessionId: 'sess', workingDir: '/tmp', client, opencode };
    const result = await syncMessagesFromSession(state);

    expect(result.syncedCount).toBe(0);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
