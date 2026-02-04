import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession } from '../../../opencode/src/session-manager.js';

describe('plan-mode-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers mode selection handler', () => {
    expect(registeredHandlers['action_^mode_(plan|default|bypassPermissions)$']).toBeDefined();
  });

  it('updates mode via /mode plan command', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /mode plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { mode: 'plan' });
    expect(client.chat.postMessage).toHaveBeenCalled();
  });
});
