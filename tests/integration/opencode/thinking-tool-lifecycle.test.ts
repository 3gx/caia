import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, lastAppClient, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { flushActivityBatch } from '../../../opencode/src/activity-thread.js';

describe('thinking-tool-lifecycle', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  async function triggerMention() {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });
  }

  function emitEvent(event: any) {
    eventSubscribers[0]?.(event);
  }

  function makeReasoningEvent(id: string, text: string, opts?: { start?: number; end?: number }) {
    return {
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id,
            text,
            time: { start: opts?.start ?? 0, ...(opts?.end !== undefined ? { end: opts.end } : {}) },
          },
          sessionID: 'sess_mock',
        },
      },
    };
  }

  function makeToolEvent(id: string, tool: string, status: string, opts?: { input?: any; output?: string }) {
    return {
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            id,
            callID: id,
            tool,
            state: {
              status,
              input: opts?.input ?? {},
              ...(status === 'completed' ? { output: opts?.output ?? 'ok' } : {}),
              ...(status === 'error' ? { error: 'failed' } : {}),
            },
          },
          sessionID: 'sess_mock',
        },
      },
    };
  }

  function makeSessionIdle() {
    return {
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    };
  }

  it('finalizes all thinking entries across multiple reasoning-tool-reasoning cycles', async () => {
    await triggerMention();

    // Reasoning 1: start
    emitEvent(makeReasoningEvent('r1', 'thinking about step 1'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reasoning 1: complete
    emitEvent(makeReasoningEvent('r1', 'thinking about step 1', { end: 100 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Tool call
    emitEvent(makeToolEvent('tool1', 'Read', 'running'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitEvent(makeToolEvent('tool1', 'Read', 'completed', { output: 'file contents' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reasoning 2: start
    emitEvent(makeReasoningEvent('r2', 'analyzing results'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reasoning 2: complete
    emitEvent(makeReasoningEvent('r2', 'analyzing results', { end: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // session.idle
    emitEvent(makeSessionIdle());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: TWO thinking placeholders posted
    const calls = lastAppClient?.chat.postMessage.mock.calls || [];
    const thinkingPlaceholders = calls.filter((call: any) => call[0]?.text?.includes('Thinking...'));
    expect(thinkingPlaceholders.length).toBe(2);

    // Assert: BOTH thinking entries finalized (chat.update called for finalization)
    const updateCalls = lastAppClient?.chat.update.mock.calls || [];
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('captures tool entries from message.part.updated events', async () => {
    await triggerMention();

    // Tool: running → completed
    emitEvent(makeToolEvent('tool1', 'Bash', 'running'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitEvent(makeToolEvent('tool1', 'Bash', 'completed', { output: 'done' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // session.idle
    emitEvent(makeSessionIdle());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: flushActivityBatch was called with batch containing tool entries
    expect(flushActivityBatch).toHaveBeenCalled();
  });

  it('recovers tool entries from session API when events were missed', async () => {
    await triggerMention();

    // Configure mock to return authoritative response with tool parts
    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 } },
          parts: [
            {
              type: 'tool',
              id: 'tool_missed',
              callID: 'tool_missed',
              tool: 'Read',
              state: {
                status: 'completed',
                input: { path: '/tmp/test' },
                output: 'file contents',
              },
            },
            { type: 'text', id: 't1', text: 'Here are the results' },
          ],
        },
      ],
    });

    // Emit tool as 'running' only (completion event missed via SSE)
    // This creates a non-terminal entry in toolStates, triggering recovery
    emitEvent(makeToolEvent('tool_missed', 'Read', 'running'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Emit text and message.updated
    emitEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', text: 'Here are the results', messageID: 'msg_1' },
          sessionID: 'sess_mock',
        },
      },
    });
    emitEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            role: 'assistant',
            time: { completed: 1 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            modelID: 'm',
            providerID: 'p',
          },
          parts: [],
        },
      },
    });

    // session.idle
    emitEvent(makeSessionIdle());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: session.messages was called for recovery
    expect(mockMessages).toHaveBeenCalled();
  });

  it('happy path regression: reasoning then text then idle', async () => {
    await triggerMention();

    // Reasoning: start → complete
    emitEvent(makeReasoningEvent('r1', 'let me think'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitEvent(makeReasoningEvent('r1', 'let me think', { end: 100 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Text response
    emitEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', text: 'The answer is 42', messageID: 'msg_1' },
          sessionID: 'sess_mock',
        },
      },
    });
    emitEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            role: 'assistant',
            time: { completed: 1 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            modelID: 'm',
            providerID: 'p',
          },
          parts: [],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // session.idle
    emitEvent(makeSessionIdle());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: ONE thinking placeholder
    const calls = lastAppClient?.chat.postMessage.mock.calls || [];
    const thinkingPlaceholders = calls.filter((call: any) => call[0]?.text?.includes('Thinking...'));
    expect(thinkingPlaceholders.length).toBe(1);

    // Assert: no errors (test completes without throwing)
  });
});
