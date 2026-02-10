import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { postResponseToThread } from '../../../opencode/src/activity-thread.js';
import { saveMessageMapping, saveSession } from '../../../opencode/src/session-manager.js';
import { buildCombinedStatusBlocks } from '../../../opencode/src/blocks.js';

describe('session-idle-cleanup', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  async function triggerMention(ts: string, text = 'hello') {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    await handler({
      event: { user: 'U1', text: `<@BOT123> ${text}`, channel: 'C1', ts },
      client,
      context: { botUserId: 'BOT123' },
    });
    return client;
  }

  function emitTextPart(text: string, messageId = 'msg_1') {
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', text, messageID: messageId },
          sessionID: 'sess_mock',
        },
      },
    });
  }

  function emitToolRunning(tool = 'bash', callId = 'call_1') {
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            id: callId,
            callID: callId,
            tool,
            state: { status: 'running', input: {} },
          },
          sessionID: 'sess_mock',
        },
      },
    });
  }

  function emitToolCompleted(tool = 'bash', callId = 'call_1') {
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            id: callId,
            callID: callId,
            tool,
            state: { status: 'completed', input: {}, output: 'done' },
          },
          sessionID: 'sess_mock',
        },
      },
    });
  }

  function emitSessionIdle() {
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });
  }

  async function tick(ms = 50) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('happy path: tools + text + session.idle → response posted, state cleaned', async () => {
    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    emitToolRunning();
    await tick(0);
    emitToolCompleted();
    await tick(0);
    emitTextPart('Final answer');
    await tick(0);
    emitSessionIdle();
    await tick();

    expect(postResponseToThread).toHaveBeenCalled();
    const lastCall = (postResponseToThread as any).mock.calls[(postResponseToThread as any).mock.calls.length - 1];
    expect(lastCall[3]).toBe('Final answer');

    // Second mention should succeed (state cleaned)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('saveMessageMapping inside finalizeResponseSegment throws → response still posted, state cleaned', async () => {
    // Make saveMessageMapping reject on every call
    (saveMessageMapping as any).mockRejectedValue(new Error('DB write failed'));

    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    emitTextPart('Final answer');
    await tick(0);
    emitSessionIdle();
    await tick();

    // Response should still be posted (post happens before saveMessageMapping)
    expect(postResponseToThread).toHaveBeenCalled();

    // Second mention should succeed (state cleaned despite saveMessageMapping failure)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('updateStatusMessage throws → state still cleaned', async () => {
    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    // Get the client used for chat.update and make it throw
    const client = createMockWebClient();
    client.chat.update.mockRejectedValueOnce(new Error('Slack API error'));

    emitTextPart('Final answer');
    await tick(0);
    emitSessionIdle();
    await tick();

    // Second mention should succeed (state cleaned despite chat.update failure)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('no text anywhere → "Final response text missing" error, state cleaned', async () => {
    // Mock session API to return no text parts
    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 } },
          parts: [],
        },
      ],
    });

    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    // No text events emitted, just idle
    emitSessionIdle();
    await tick();

    // buildCombinedStatusBlocks should be called with error status
    const statusCalls = (buildCombinedStatusBlocks as any).mock.calls;
    const lastStatusCall = statusCalls[statusCalls.length - 1];
    expect(lastStatusCall[0].status).toBe('error');

    // Second mention should succeed (state cleaned)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('saveSession throws → finalization still proceeds, state cleaned', async () => {
    (saveSession as any).mockRejectedValueOnce(new Error('DB session save failed'));

    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    emitTextPart('Final answer');
    await tick(0);
    emitSessionIdle();
    await tick();

    // Response should still be posted despite saveSession failure
    expect(postResponseToThread).toHaveBeenCalled();

    // Second mention should succeed (state cleaned)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('stacked failures → cleanup guaranteed', async () => {
    // Make multiple things fail simultaneously
    (saveSession as any).mockRejectedValue(new Error('DB session save failed'));
    (saveMessageMapping as any).mockRejectedValue(new Error('DB mapping save failed'));

    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    emitTextPart('Final answer');
    await tick(0);
    emitSessionIdle();
    await tick();

    // Second mention should succeed (state cleaned despite multiple failures)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('tools shown, text from session API, response posted (production scenario)', async () => {
    // Mock session API with both tool and text parts
    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 } },
          parts: [
            {
              type: 'tool',
              id: 'call_1',
              callID: 'call_1',
              tool: 'bash',
              state: { status: 'completed', input: {}, output: 'done' },
            },
            { type: 'text', id: 't1', text: 'API text answer' },
          ],
        },
      ],
    });

    await triggerMention('1.0');
    const callsBefore = mockWrapper.promptAsync.mock.calls.length;

    // Only emit tool events via SSE — no text SSE events
    emitToolRunning();
    await tick(0);
    emitToolCompleted();
    await tick(0);

    // Session idle triggers API recovery which provides the text
    emitSessionIdle();
    await tick();

    // Response should be posted with API text
    expect(postResponseToThread).toHaveBeenCalled();
    const lastCall = (postResponseToThread as any).mock.calls[(postResponseToThread as any).mock.calls.length - 1];
    expect(lastCall[3]).toBe('API text answer');

    // Second mention should succeed (state cleaned)
    await triggerMention('2.0', 'second');
    expect(mockWrapper.promptAsync.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
