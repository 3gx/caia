import { describe, it, expect, vi } from 'vitest';
import { syncMessagesFromSession } from '../../../opencode/src/message-sync.js';

vi.mock('../../../slack/src/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
}));

const addSyncedMessageUuid = vi.fn().mockResolvedValue(undefined);
const saveMessageMapping = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../opencode/src/session-manager.js', () => ({
  getSyncedMessageUuids: vi.fn(() => new Set()),
  addSyncedMessageUuid,
  isSlackOriginatedUserUuid: vi.fn(() => false),
  saveMessageMapping,
}));

function makeMessage(id: string, role: 'user' | 'assistant', text: string, created = 1) {
  return {
    info: { id, role, sessionID: 'sess', time: { created } },
    parts: [{ type: 'text', text }],
  } as any;
}

describe('message-sync', () => {
  it('posts assistant messages and records mappings', async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }),
      },
    } as any;

    const opencode = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [makeMessage('m1', 'assistant', 'hello', 1)],
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

    const result = await syncMessagesFromSession(state);

    expect(result.syncedCount).toBe(1);
    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(addSyncedMessageUuid).toHaveBeenCalled();
    expect(saveMessageMapping).toHaveBeenCalled();
  });
});
