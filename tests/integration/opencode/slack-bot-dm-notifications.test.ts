import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, lastAppClient } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { sendDmNotification } from '../../../opencode/src/dm-notifications.js';

const waitForAsync = async () => new Promise((resolve) => setTimeout(resolve, 0));

describe('slack-bot-dm-notifications', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('sends DM notification when approval is needed', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'permission.updated',
        properties: { id: 'perm1', sessionID: 'sess_mock', title: 'Write', metadata: { path: '/tmp' } },
      },
    });

    await waitForAsync();

    expect(lastAppClient?.chat.postMessage).toHaveBeenCalled();
    expect(sendDmNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'U1',
      channelId: 'C1',
      messageTs: '1.0',
      conversationKey: 'C1',
    }));
  });

  it('sends DM notification when session completes', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't_complete', text: 'Final response text', messageID: 'assistant_msg_complete' },
          sessionID: 'sess_mock',
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await waitForAsync();

    expect(sendDmNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'U1',
      channelId: 'C1',
      conversationKey: 'C1',
      title: 'Query completed',
    }));
  });
});
