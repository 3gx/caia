import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { postResponseToThread } from '../../../opencode/src/activity-thread.js';
import { removeProcessingEmoji } from '../../../opencode/src/emoji-reactions.js';

describe('message-role-filter', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('ignores user message parts when building response segments', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'user_msg_1',
            sessionID: 'sess_mock',
            role: 'user',
            time: { created: 0 },
            agent: 'user',
            model: { providerID: 'p', modelID: 'm' },
          },
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            id: 't_user',
            messageID: 'user_msg_1',
            sessionID: 'sess_mock',
            text: 'User message:\nhello',
          },
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((postResponseToThread as any).mock.calls.length).toBe(0);
  });

  it('does not mark turn complete from assistant message.updated completion alone', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant_msg_1',
            sessionID: 'sess_mock',
            role: 'assistant',
            time: { created: 0, completed: 1 },
            parentID: 'user_msg_1',
            modelID: 'm',
            providerID: 'p',
            mode: 'build',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeProcessingEmoji).not.toHaveBeenCalled();
  });
});
