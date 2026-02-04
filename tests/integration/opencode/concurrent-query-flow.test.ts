import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getOrCreateThreadSession } from '../../../opencode/src/session-manager.js';

describe('concurrent-query-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('routes thread reply through thread session', async () => {
    const handler = registeredHandlers['event_message'];
    const client = createMockWebClient();

    await handler({
      event: { channel: 'C1', thread_ts: '1.0', user: 'U1', text: 'thread message', ts: '2.0' },
      client,
    });

    expect(vi.mocked(getOrCreateThreadSession)).toHaveBeenCalled();
  });
});
