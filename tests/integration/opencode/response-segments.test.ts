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

  it('posts response segment to activity thread when tool starts', async () => {
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
    const postedSegment = calls.some((call: any[]) => call[3] === 'Hello');
    expect(postedSegment).toBe(true);
  });

  it('posts thinking placeholder before response segment when reasoning starts', async () => {
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
            type: 'reasoning',
            id: 'r1',
            text: 'The',
            time: { start: 0 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const postMessageCalls = lastAppClient?.chat.postMessage.mock.calls || [];
    const thinkingCallIndex = postMessageCalls.findIndex((call) => call[0]?.text?.includes('Thinking...'));
    expect(thinkingCallIndex).toBeGreaterThanOrEqual(0);

    const thinkingOrder = lastAppClient!.chat.postMessage.mock.invocationCallOrder[thinkingCallIndex];
    const responseOrder = (postResponseToThread as any).mock.invocationCallOrder[0];
    expect(thinkingOrder).toBeLessThan(responseOrder);
  });
});
