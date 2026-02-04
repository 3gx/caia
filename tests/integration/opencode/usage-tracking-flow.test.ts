import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession, addSlackOriginatedUserUuid } from '../../../opencode/src/session-manager.js';

const waitForAsync = async () => new Promise((resolve) => setTimeout(resolve, 0));

describe('usage-tracking-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('persists usage on session idle and tracks user message ids', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> track usage', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'user-msg-1', role: 'user', sessionID: 'sess_mock' },
          parts: [],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-1',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: {
              input: 10,
              output: 5,
              reasoning: 2,
              cache: { read: 1, write: 3 },
            },
            cost: 0.01,
          },
          parts: [],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await waitForAsync();

    expect(addSlackOriginatedUserUuid).toHaveBeenCalledWith('C1', 'user-msg-1', undefined);
    expect(saveSession).toHaveBeenCalledWith('C1', expect.objectContaining({
      lastUsage: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 3,
        cost: 0.01,
        model: 'p:m',
      }),
    }));
  });
});
