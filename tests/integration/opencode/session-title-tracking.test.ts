import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, eventSubscribers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { buildCombinedStatusBlocks } from '../../../opencode/src/blocks.js';
import { saveSession, getSession } from '../../../opencode/src/session-manager.js';

const waitForAsync = async () => new Promise((resolve) => setTimeout(resolve, 0));

describe('session-title-tracking', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });
    await Promise.resolve();
    await Promise.resolve();
    await teardownBot();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fetches session title via session.get() API at query start', async () => {
    vi.useFakeTimers();

    // Mock getSessionTitle to return a title
    mockWrapper.getSessionTitle.mockResolvedValue('My Session');

    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    const titleCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.sessionTitle === 'My Session');
    expect(titleCall).toBeDefined();

    // Restore
    mockWrapper.getSessionTitle.mockResolvedValue(null);
  });

  it('skips generic Slack titles from API', async () => {
    vi.useFakeTimers();

    // Mock getSessionTitle to return a Slack-generated title (should be filtered out)
    mockWrapper.getSessionTitle.mockResolvedValue('Slack C12345');

    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    // sessionTitle should be undefined since the Slack-generated title was filtered out
    const calls = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any);
    const titleCalls = calls.filter((args) => args?.sessionTitle === 'Slack C12345');
    expect(titleCalls.length).toBe(0);

    // Restore
    mockWrapper.getSessionTitle.mockResolvedValue(null);
  });

  it('captures session title from session.updated event during processing', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Emit session.updated with title
    eventSubscribers[0]?.({
      payload: {
        type: 'session.updated',
        properties: {
          info: { id: 'sess_mock', title: 'Updated Title' },
        },
      },
    });

    await Promise.resolve();

    // Verify saveSession was called with sessionTitle
    expect(saveSession).toHaveBeenCalledWith('C1', { sessionTitle: 'Updated Title' });
  });

  it('uses persisted title on subsequent queries', async () => {
    vi.useFakeTimers();

    // Mock getSession to return a session with persisted sessionTitle
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/tmp',
      previousSessionIds: [],
      sessionTitle: 'Persisted Title',
    } as any);

    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    const titleCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.sessionTitle === 'Persisted Title');
    expect(titleCall).toBeDefined();

    // getSessionTitle should NOT have been called since we had a non-Slack title
    expect(mockWrapper.getSessionTitle).not.toHaveBeenCalled();
  });
});
