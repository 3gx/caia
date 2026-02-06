import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getAvailableModels } from '../../../opencode/src/model-cache.js';

const testModels = [
  { value: 'anthropic:claude-4', displayName: 'Anthropic / Claude 4', description: 'Latest model' },
  { value: 'anthropic:claude-3-5-sonnet', displayName: 'Anthropic / Claude 3.5 Sonnet', description: 'Fast model' },
  { value: 'openai:gpt-4o', displayName: 'OpenAI / GPT-4o', description: 'OpenAI model' },
];

describe('model-selection-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers model_select action handler for static_select', () => {
    // New handler uses string pattern 'model_select' instead of regex
    expect(registeredHandlers['action_model_select']).toBeDefined();
  });

  it('shows model selection blocks via /model command', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValueOnce(testModels);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Select model',
    }));
  });

  it('shows model selection with static_select dropdown', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValueOnce(testModels);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Verify blocks contain static_select with option_groups
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            accessory: expect.objectContaining({
              type: 'static_select',
              action_id: 'model_select',
              option_groups: expect.any(Array),
            }),
          }),
        ]),
      })
    );
  });

  it('handles model selection from static_select', async () => {
    const handler = registeredHandlers['action_model_select'];
    const client = createMockWebClient();
    const ack = vi.fn();

    await handler({
      action: {
        action_id: 'model_select',
        selected_option: { value: 'anthropic:claude-4', text: { text: 'Claude 4' } },
      },
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
      ack,
    });

    expect(ack).toHaveBeenCalled();
    // Verify model was saved and message updated
    expect(client.chat.update).toHaveBeenCalled();
  });

  it('groups models by provider in option_groups', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValueOnce(testModels);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const call = (client.chat.postMessage as any).mock.calls[0][0];
    const section = call.blocks?.find((b: any) => b.accessory?.type === 'static_select');
    const optionGroups = section?.accessory?.option_groups;

    // Each group should have a provider label
    expect(optionGroups).toBeDefined();
    expect(optionGroups.length).toBeGreaterThan(0);
    expect(optionGroups.every((g: any) => g.label?.type === 'plain_text')).toBe(true);
    // Verify models are grouped by provider
    expect(optionGroups.find((g: any) => g.label.text === 'Anthropic')).toBeDefined();
    expect(optionGroups.find((g: any) => g.label.text === 'OpenAI')).toBeDefined();
  });
});
