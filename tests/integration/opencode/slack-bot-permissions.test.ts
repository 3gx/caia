import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, eventSubscribers, mockWrapper, lastAppClient } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getSession } from '../../../opencode/src/session-manager.js';

describe('slack-bot-permissions', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers tool approval handlers', () => {
    expect(registeredHandlers['action_^tool_(approve|deny)_(.+)$']).toBeDefined();
  });

  it('auto-approves permissions in bypass mode', async () => {
    const mentionHandler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    const bypassSession = {
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'bypassPermissions',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      previousSessionIds: [],
    } as any;

    vi.mocked(getSession)
      .mockReturnValueOnce(bypassSession)
      .mockReturnValueOnce(bypassSession);

    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'permission.updated',
        properties: { id: 'perm1', sessionID: 'sess_mock', title: 'Write', metadata: { path: '/tmp' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWrapper.respondToPermission).toHaveBeenCalledWith('sess_mock', 'perm1', 'always', '/tmp');
    expect(lastAppClient?.chat.postMessage).not.toHaveBeenCalled();
  });
});
