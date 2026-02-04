import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, lastServerPool, mockWrapper, eventSubscribers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

describe('server-restart-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });
    await Promise.resolve();
    await Promise.resolve();
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('allocates server instance for new message', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(lastServerPool?.getOrCreate).toHaveBeenCalledWith('C1');
  });

  it('allows a new request after prompt failure', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    mockWrapper.promptAsync.mockRejectedValueOnce(new Error('fail once'));

    await handler({
      event: { user: 'U1', text: '<@BOT123> first', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> second', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).toHaveBeenCalledTimes(2);
  });
});
