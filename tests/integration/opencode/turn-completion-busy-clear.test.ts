import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

describe('turn-completion-busy-clear', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('clears busy state after session.idle', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> first', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    // Complete the session
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await handler({
      event: { user: 'U1', text: '<@BOT123> second', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('clears busy state after session.status idle', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> first', channel: 'C1', ts: '3.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    eventSubscribers[0]?.({
      payload: { type: 'session.status', properties: { sessionID: 'sess_mock', status: { type: 'idle' } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await handler({
      event: { user: 'U1', text: '<@BOT123> second', channel: 'C1', ts: '4.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
