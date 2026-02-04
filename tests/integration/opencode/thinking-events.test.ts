import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { postThinkingToThread } from '../../../opencode/src/activity-thread.js';

describe('thinking-events', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('posts thinking to thread on reasoning completion', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const longText = 'x'.repeat(4000);
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            text: longText,
            time: { start: 0, end: 1 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postThinkingToThread).toHaveBeenCalled();
  });
});
