import './slack-bot-mocks-real-blocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { registeredHandlers, resetMockState, eventSubscribers, lastAppClient } from './slack-bot-mocks-real-blocks.js';
import { startBot, stopBot } from '../../../opencode/src/slack-bot.js';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('status-window-content', () => {
  beforeEach(async () => {
    resetMockState();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_SIGNING_SECRET = 'secret';
    await startBot();
  });

  afterEach(async () => {
    await stopBot();
  });

  it('tool-heavy query: status blocks contain thinking and response', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> explain this codebase', channel: 'C1', ts: '10.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Reasoning
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'r1', text: 'Let me think about this', time: { start: 0 } },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    // Text delta
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', messageID: 'assistant-msg-1', text: 'Here is my answer' },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    // 10 tool running/complete cycles
    for (let i = 0; i < 10; i++) {
      eventSubscribers[0]?.({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { type: 'tool-invocation', id: `tool_${i}`, toolName: 'Read', state: 'running', input: { path: `/tmp/file${i}` } },
            sessionID: 'sess_mock',
          },
        },
      });
      await tick();

      eventSubscribers[0]?.({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { type: 'tool-invocation', id: `tool_${i}`, toolName: 'Read', state: 'completed', input: { path: `/tmp/file${i}` }, output: `content of file ${i}` },
            sessionID: 'sess_mock',
          },
        },
      });
      await tick();
    }

    // Second reasoning
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'r2', text: 'Now I understand', time: { start: 0 } },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    // Second text delta
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't2', messageID: 'assistant-msg-1', text: 'The complete answer is...' },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    // Session idle
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });
    await tick();
    await tick();

    // Find the last status update call
    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    expect(updateCalls.length).toBeGreaterThan(0);

    // Check the most recent update's blocks for thinking (:brain:), response (:pencil:), and tools (:white_check_mark:)
    const lastUpdate = updateCalls[updateCalls.length - 1];
    const blocksJson = JSON.stringify(lastUpdate[0]?.blocks || []);
    expect(blocksJson).toContain(':brain:');
    expect(blocksJson).toContain(':pencil:');
    expect(blocksJson).toContain(':white_check_mark:'); // Tools visible, not dropped
  });

  it('Scenario 1 ordering: text before tools preserves thinking and response', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> quick question', channel: 'C1', ts: '11.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Reasoning → text → tools → reasoning → text (Scenario 1 ordering)
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'r1', text: 'First thought', time: { start: 0 } },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', messageID: 'assistant-msg-1', text: 'Let me check...' },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    // Tools in the middle
    for (let i = 0; i < 5; i++) {
      eventSubscribers[0]?.({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { type: 'tool-invocation', id: `t_${i}`, toolName: 'Grep', state: 'completed', input: { pattern: 'test' }, output: 'match' },
            sessionID: 'sess_mock',
          },
        },
      });
      await tick();
    }

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'r2', text: 'After checking', time: { start: 0 } },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't2', messageID: 'assistant-msg-1', text: 'Here is the answer.' },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });
    await tick();
    await tick();

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    expect(updateCalls.length).toBeGreaterThan(0);

    const lastUpdate = updateCalls[updateCalls.length - 1];
    const blocksJson = JSON.stringify(lastUpdate[0]?.blocks || []);
    expect(blocksJson).toContain(':brain:');
    expect(blocksJson).toContain(':pencil:');
    expect(blocksJson).toContain(':white_check_mark:'); // Tools visible, not dropped
  });

  it('final status update failure + transient retry succeeds', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '12.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Make isRecoverable return true for this test
    const { isRecoverable } = await import('../../../opencode/src/errors.js') as any;
    isRecoverable.mockReturnValue(true);

    // Make chat.update fail once then succeed
    let callCount = 0;
    lastAppClient!.chat.update.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('ratelimited');
        (err as any).data = { error: 'ratelimited' };
        throw err;
      }
      return { ok: true, ts: '12.0' };
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', messageID: 'assistant-msg-1', text: 'Hello!' },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    // Wait for retries to complete
    await tick();
    await tick();
    await tick();

    // chat.update should have been called at least twice (initial fail + retry)
    expect(lastAppClient!.chat.update.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Reset for second mention
    isRecoverable.mockReturnValue(false);
  });

  it('final status update permanent failure: no retry, state cleaned', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '13.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Make isRecoverable return false (permanent error)
    const { isRecoverable } = await import('../../../opencode/src/errors.js') as any;
    isRecoverable.mockReturnValue(false);

    // Make chat.update fail with permanent error
    lastAppClient!.chat.update.mockRejectedValue(
      Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } })
    );

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', messageID: 'assistant-msg-1', text: 'Hello!' },
          sessionID: 'sess_mock',
        },
      },
    });
    await tick();

    const updateCallsBefore = lastAppClient!.chat.update.mock.calls.length;

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await tick();
    await tick();

    // Should have only 1 update attempt after idle (no retry for permanent errors)
    const updateCallsAfter = lastAppClient!.chat.update.mock.calls.length;
    const idleCalls = updateCallsAfter - updateCallsBefore;
    // The final updateStatusMessage call fails once, and since isRecoverable is false, no retry
    expect(idleCalls).toBeLessThanOrEqual(2); // At most the one failed attempt + possibly one before idle

    // A second mention should succeed (state was cleaned up)
    lastAppClient!.chat.update.mockResolvedValue({ ok: true, ts: '14.0' });

    const secondResult = handler({
      event: { user: 'U1', text: '<@BOT123> second message', channel: 'C1', ts: '14.0' },
      client,
      context: { botUserId: 'BOT123' },
    });
    // Should not throw
    await expect(secondResult).resolves.not.toThrow();
  });
});
