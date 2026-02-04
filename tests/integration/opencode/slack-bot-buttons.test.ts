import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession } from '../../../opencode/src/session-manager.js';

describe('slack-bot-buttons', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers button handlers', () => {
    expect(registeredHandlers['action_^mode_(plan|default|bypassPermissions)$']).toBeDefined();
    expect(registeredHandlers['action_^model_select_(.+)$']).toBeDefined();
    expect(registeredHandlers['action_^abort_query_(.+)$']).toBeDefined();
  });

  it('handles mode selection action', async () => {
    const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions)$'];
    const client = createMockWebClient();

    await handler({
      action: { action_id: 'mode_plan' },
      ack: async () => undefined,
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { mode: 'plan' });
    expect(client.chat.update).toHaveBeenCalled();
  });

  it('handles model selection action', async () => {
    const handler = registeredHandlers['action_^model_select_(.+)$'];
    const client = createMockWebClient();

    await handler({
      action: { action_id: 'model_select_provider:model' },
      ack: async () => undefined,
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { model: 'provider:model' });
    expect(client.chat.update).toHaveBeenCalled();
  });

  it('opens abort confirmation modal when abort action clicked', async () => {
    const mentionHandler = registeredHandlers['event_app_mention'];
    const abortHandler = registeredHandlers['action_^abort_query_(.+)$'];
    const client = createMockWebClient();

    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).toHaveBeenCalled();

    await abortHandler({
      action: { action_id: 'abort_query_C1' },
      ack: async () => undefined,
      body: { trigger_id: 'T1', message: { ts: '2.0' } },
      client,
    });

    expect(client.views.open).toHaveBeenCalled();
  });
});
