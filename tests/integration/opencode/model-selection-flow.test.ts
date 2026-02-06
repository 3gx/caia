import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getAvailableModels } from '../../../opencode/src/model-cache.js';
import { getSession, saveSession } from '../../../opencode/src/session-manager.js';

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

  it('registers model_cancel action handler', () => {
    expect(registeredHandlers['action_model_cancel']).toBeDefined();
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

  it('includes Cancel button in model selection blocks', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValueOnce(testModels);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const call = (client.chat.postMessage as any).mock.calls[0][0];
    const actionsBlock = call.blocks?.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].action_id).toBe('model_cancel');
  });

  it('handles cancel button to delete model selection message', async () => {
    const handler = registeredHandlers['action_model_cancel'];
    const client = createMockWebClient();
    const ack = vi.fn();

    await handler({
      action: { action_id: 'model_cancel' },
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(client.chat.delete).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C1',
      ts: '1.0',
    }));
  });

  it('tracks recent models when selecting a model', async () => {
    const handler = registeredHandlers['action_model_select'];
    const client = createMockWebClient();
    const ack = vi.fn();

    // Mock getSession to return a session without recent models
    vi.mocked(getSession).mockReturnValueOnce({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      recentModels: ['openai:gpt-4o'],
    } as any);

    await handler({
      action: {
        action_id: 'model_select',
        selected_option: { value: 'anthropic:claude-4', text: { text: 'Claude 4' } },
      },
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
      ack,
    });

    // Verify saveSession was called with recentModels including the new model
    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', expect.objectContaining({
      model: 'anthropic:claude-4',
      recentModels: expect.arrayContaining(['anthropic:claude-4']),
    }));
  });

  it('saves model to session and shows it on next /model call', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValue(testModels);

    // First, mock session with a previously selected model
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_test',
      workingDir: '/tmp',
      mode: 'default',
      model: 'anthropic:claude-4',  // Previously selected model
      recentModels: ['anthropic:claude-4'],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    // Call /model command
    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Verify the dropdown shows the current model in the header
    // blocks[0] = context (Recent status), blocks[1] = section with dropdown
    const call = (client.chat.postMessage as any).mock.calls[0][0];
    expect(call.blocks[1].text.text).toContain('Anthropic / Claude 4');
  });

  it('shows "not set" when no model selected', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValue(testModels);

    // Mock session with no model
    vi.mocked(getSession).mockReturnValue({
      sessionId: null,
      workingDir: '/tmp',
      mode: 'default',
      model: undefined,  // No model selected
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    // Call /model command
    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '3.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Verify the dropdown shows "not set" in the header
    // blocks[0] = context (Recent status), blocks[1] = section with dropdown
    const call = (client.chat.postMessage as any).mock.calls[0][0];
    expect(call.blocks[1].text.text).toContain('not set');
  });

  it('shows Recent status in context block (always visible)', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValue(testModels);

    // Mock session with no recent models
    vi.mocked(getSession).mockReturnValue({
      sessionId: null,
      workingDir: '/tmp',
      mode: 'default',
      recentModels: [],  // No recent models
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '4.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const call = (client.chat.postMessage as any).mock.calls[0][0];

    // blocks[0] = context block showing Recent status
    expect(call.blocks[0].type).toBe('context');
    expect(call.blocks[0].elements[0].text).toContain('Recent:');
    expect(call.blocks[0].elements[0].text).toContain('(none yet)');

    // Dropdown should NOT have Recent group when empty (Slack requires ≥1 option)
    const section = call.blocks?.find((b: any) => b.accessory?.type === 'static_select');
    const optionGroups = section?.accessory?.option_groups;
    expect(optionGroups[0].label.text).toBe('Anthropic'); // First provider, not Recent
  });

  it('shows Recent in both context and dropdown when populated', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    vi.mocked(getAvailableModels).mockResolvedValue(testModels);

    // Mock session with recent models
    vi.mocked(getSession).mockReturnValue({
      sessionId: null,
      workingDir: '/tmp',
      mode: 'default',
      recentModels: ['anthropic:claude-4'],  // Has recent models
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '5.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const call = (client.chat.postMessage as any).mock.calls[0][0];

    // blocks[0] = context block showing Recent status with model names
    expect(call.blocks[0].type).toBe('context');
    expect(call.blocks[0].elements[0].text).toContain('Recent:');
    expect(call.blocks[0].elements[0].text).toContain('Claude 4');

    // Dropdown SHOULD have Recent group when populated
    const section = call.blocks?.find((b: any) => b.accessory?.type === 'static_select');
    const optionGroups = section?.accessory?.option_groups;
    expect(optionGroups[0].label.text).toBe('Recent');
    expect(optionGroups[0].options).toHaveLength(1);
    expect(optionGroups[0].options[0].value).toBe('anthropic:claude-4');
  });
});
