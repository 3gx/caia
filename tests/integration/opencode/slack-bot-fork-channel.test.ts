import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper, lastServerPool } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession } from '../../../opencode/src/session-manager.js';

describe('slack-bot-fork-channel', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers fork-to-channel view handler', () => {
    expect(registeredHandlers['view_fork_to_channel_modal']).toBeDefined();
  });

  it('creates forked channel and session on modal submit', async () => {
    const handler = registeredHandlers['view_fork_to_channel_modal'];
    const client = createMockWebClient();

    await handler({
      ack: async () => undefined,
      view: {
        state: { values: { channel_name_block: { channel_name_input: { value: 'new-channel' } } } },
        private_metadata: JSON.stringify({
          sourceChannelId: 'C1',
          sourceMessageTs: '1.0',
          conversationKey: 'C1',
          sdkMessageId: 'msg_1',
          sessionId: 'sess_mock',
        }),
      },
      client,
      body: { user: { id: 'U1' } },
    });

    expect(client.conversations.create).toHaveBeenCalledWith({ name: 'new-channel' });
    expect(mockWrapper.forkSession).toHaveBeenCalledWith('sess_mock', 'msg_1');
    expect(lastServerPool?.attachChannel).toHaveBeenCalled();
    expect(vi.mocked(saveSession)).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalled();
  });
});
