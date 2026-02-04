import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getSession, saveSession } from '../../../opencode/src/session-manager.js';
import { startWatching } from '../../../opencode/src/terminal-watcher.js';
import { syncMessagesFromSession } from '../../../opencode/src/message-sync.js';
import { clearSyncedMessageUuids, clearSlackOriginatedUserUuids } from '../../../opencode/src/session-manager.js';
import { onSessionCleared } from '../../../opencode/src/terminal-watcher.js';

describe('slack-bot-commands', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention and message handlers', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
    expect(registeredHandlers['event_message']).toBeDefined();
  });

  it('handles /compact by calling promptAsync', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /compact', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).toHaveBeenCalledWith(
      'sess_mock',
      [{ type: 'text', text: '/compact' }],
      { workingDir: '/tmp' }
    );
    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it('handles /clear by creating a new session', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getSession).mockReturnValueOnce({
      sessionId: 'sess_old',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      previousSessionIds: [],
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /clear', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.createSession).toHaveBeenCalled();
    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', expect.objectContaining({
      sessionId: 'sess_mock',
      previousSessionIds: ['sess_old'],
    }));
    expect(vi.mocked(clearSyncedMessageUuids)).toHaveBeenCalled();
    expect(vi.mocked(clearSlackOriginatedUserUuids)).toHaveBeenCalled();
    expect(vi.mocked(onSessionCleared)).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Session cleared') }));
  });

  it('handles /watch by starting watcher', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /watch', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(startWatching)).toHaveBeenCalled();
  });

  it('handles /ff by syncing messages', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /ff', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(syncMessagesFromSession)).toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalled();
  });
});
