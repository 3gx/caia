import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession } from '../../../opencode/src/session-manager.js';
import { mockWrapper } from './slack-bot-mocks.js';

describe('slack-bot-mention', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('applies inline mode from mention', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /mode plan make a plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { mode: 'plan' });
  });

  it('dedupes app_mention events with the same message ts', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '9.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '9.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('ignores edited app_mention events', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: {
        user: 'U1',
        text: '<@BOT123> hello',
        channel: 'C1',
        ts: '10.0',
        edited: { user: 'U1', ts: '10.1' },
      },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).not.toHaveBeenCalled();
  });
});
