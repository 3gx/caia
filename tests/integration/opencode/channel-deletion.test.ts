import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

describe('channel-deletion', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('ignores bot messages in message event', async () => {
    const handler = registeredHandlers['event_message'];
    const client = createMockWebClient();

    await handler({
      event: { channel: 'C1', bot_id: 'B1', text: 'bot', ts: '1.0' },
      client,
    });

    expect(mockWrapper.promptAsync).not.toHaveBeenCalled();
  });
});
