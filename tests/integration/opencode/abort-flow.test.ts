import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

describe('abort-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers abort handler', () => {
    expect(registeredHandlers['action_^abort_query_(.+)$']).toBeDefined();
  });

  it('aborts active query on modal submit', async () => {
    const mentionHandler = registeredHandlers['event_app_mention'];
    const abortModalHandler = registeredHandlers['view_abort_confirmation_modal'];
    const client = createMockWebClient();

    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await abortModalHandler({
      ack: async () => undefined,
      view: { private_metadata: JSON.stringify({ key: 'C1' }) },
    });

    expect(mockWrapper.abort).toHaveBeenCalledWith('sess_mock');
  });
});
