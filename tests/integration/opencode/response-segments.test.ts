import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, lastAppClient } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { postResponseToThread } from '../../../opencode/src/activity-thread.js';

describe('response-segments', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('does not post response before completion (tool start)', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            id: 't1',
            text: 'Hello',
          },
          sessionID: 'sess_mock',
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            id: 'tool1',
            tool: 'Read',
            state: { status: 'pending', input: { path: '/tmp' } },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const calls = (postResponseToThread as any).mock.calls;
    expect(calls).toHaveLength(0);
  });

  it('posts response once on completion', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            id: 't1',
            text: 'Hello',
          },
          sessionID: 'sess_mock',
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'sess_mock' },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const calls = (postResponseToThread as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toBe('Hello');
  });
});
