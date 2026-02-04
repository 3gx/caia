import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession, getSession } from '../../../opencode/src/session-manager.js';

describe('path-navigation-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('responds to /path with current directory', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /path', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Current directory'),
    }));
  });

  it('sets path and locks it via /path .', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /path .', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(saveSession).toHaveBeenCalledWith('C1', expect.objectContaining({
      pathConfigured: true,
      configuredPath: '/tmp',
    }));
  });

  it('rejects changing locked path', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    (getSession as any).mockReturnValueOnce({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/tmp',
      previousSessionIds: [],
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> /path /var', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Path is locked'),
    }));
  });
});
