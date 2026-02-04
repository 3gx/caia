import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getSession, saveSession } from '../../../opencode/src/session-manager.js';
import { startWatching, isWatching, updateWatchRate } from '../../../opencode/src/terminal-watcher.js';
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

  it('blocks /clear when session is busy', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> first', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> /clear', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const texts = client.chat.postMessage.mock.calls.map((call: any) => call[0]?.text || '');
    expect(texts.some((t: string) => t.includes('Cannot clear while a request is running'))).toBe(true);
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

  it('updates message size via /message-size', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /message-size 200', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { threadCharLimit: 200 });
  });

  it('updates watch rate when watching via /update-rate', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(isWatching).mockReturnValueOnce(true);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /update-rate 2', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(updateWatchRate)).toHaveBeenCalledWith('C1', '1.0', 2);
  });

  it('posts status blocks for /status', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getSession).mockReturnValueOnce({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      previousSessionIds: [],
      lastUsage: {
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cost: 0,
        contextWindow: 200000,
        model: 'test',
      },
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /status', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'OK',
      blocks: expect.any(Array),
    }));
  });

  it('updates thinking tokens via /thinking', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /thinking 500', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { maxThinkingTokens: 500 });
  });

  it('returns error when /context has no usage', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getSession).mockReturnValueOnce({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
      previousSessionIds: [],
      lastUsage: undefined,
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /context', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('No usage data yet'),
    }));
  });
});
