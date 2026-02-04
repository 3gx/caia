import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getSession } from '../../../opencode/src/session-manager.js';
import { getAvailableModels, isModelAvailable } from '../../../opencode/src/model-cache.js';
import { buildModelDeprecatedBlocks } from '../../../opencode/src/blocks.js';

const baseSession = {
  sessionId: 'sess_mock',
  workingDir: '/tmp',
  mode: 'default',
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  pathConfigured: false,
  configuredPath: null,
  previousSessionIds: [],
} as any;

describe('model-deprecated-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('shows deprecated model blocks for /model when current model is unavailable', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getSession).mockReturnValueOnce({ ...baseSession, model: 'p:m' });
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { value: 'other:model', label: 'Other' } as any,
    ]);
    vi.mocked(isModelAvailable).mockResolvedValueOnce(false);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /model', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(buildModelDeprecatedBlocks).toHaveBeenCalledWith('p:m', expect.any(Array));
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Select model',
    }));
  });

  it('blocks prompts when selected model is no longer available', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getSession).mockReturnValueOnce({ ...baseSession, model: 'p:m' });
    vi.mocked(getAvailableModels).mockResolvedValueOnce([
      { value: 'other:model', label: 'Other' } as any,
    ]);

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Model p:m is no longer available'),
    }));
    expect(mockWrapper.promptAsync).not.toHaveBeenCalled();
  });
});
