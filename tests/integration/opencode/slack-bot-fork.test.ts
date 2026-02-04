import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

describe('slack-bot-fork', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers fork action handler', () => {
    expect(registeredHandlers['action_^fork_here_(.+)$']).toBeDefined();
  });

  it('opens fork modal on fork action', async () => {
    const handler = registeredHandlers['action_^fork_here_(.+)$'];
    const client = createMockWebClient();

    await handler({
      action: { action_id: 'fork_here_C1', value: JSON.stringify({ threadTs: undefined, sdkMessageId: 'msg_1', sessionId: 'sess_mock' }) },
      ack: async () => undefined,
      body: { trigger_id: 'T1', message: { ts: '1.0' } },
      client,
    });

    expect(client.views.open).toHaveBeenCalled();
  });
});
