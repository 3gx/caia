import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getOrCreateThreadSession } from '../../../opencode/src/session-manager.js';

describe('point-in-time-fork', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers fork action handler', () => {
    expect(registeredHandlers['action_^fork_here_(.+)$']).toBeDefined();
  });

  it('forks new thread session at specific message', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getOrCreateThreadSession).mockResolvedValueOnce({
      session: {
        sessionId: null,
        forkedFrom: 'sess_mock',
        resumeSessionAtMessageId: 'msg_1',
        workingDir: '/tmp',
        mode: 'default',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: true,
        configuredPath: '/tmp',
      } as any,
      isNewFork: true,
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0', thread_ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.forkSession).toHaveBeenCalledWith('sess_mock', 'msg_1', '/tmp');
  });
});
