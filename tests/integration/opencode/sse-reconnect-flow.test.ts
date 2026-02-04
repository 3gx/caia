import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, eventUnsubscribers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

describe('sse-reconnect-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('subscribes to SSE events after first message', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(eventSubscribers.length).toBeGreaterThan(0);
    expect(mockWrapper.subscribeToEvents).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate SSE subscriptions for subsequent messages', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

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

    expect(eventSubscribers.length).toBe(1);
    expect(mockWrapper.subscribeToEvents).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from SSE events on stop', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(eventUnsubscribers.length).toBe(1);

    await teardownBot();

    expect(eventUnsubscribers[0]).toHaveBeenCalled();
  });
});
