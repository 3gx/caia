import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registeredHandlers,
  eventSubscribers,
  mockWrapper,
  lastAppClient,
} from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getSession } from '../../../opencode/src/session-manager.js';
import {
  flushActivityBatch,
  postResponseToThread,
} from '../../../opencode/src/activity-thread.js';

describe('watchdog-finalize-canary', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/tmp',
      previousSessionIds: [],
      updateRateSeconds: 1,
    } as any);
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
    vi.useRealTimers();
  });

  async function triggerMention(): Promise<void> {
    const handler = registeredHandlers.event_app_mention;
    const client = createMockWebClient();
    await handler({
      event: { user: 'U1', text: '<@BOT123> show tests', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });
  }

  it('finalizes from watchdog when idle event is missing and preserves thinking -> tool -> response capture', async () => {
    await triggerMention();

    // Stream reasoning + tool activity, but do not emit idle.
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'r1', text: 'Live thinking chunk', time: { start: 10 } },
          sessionID: 'sess_mock',
        },
      },
    });
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', id: 'tool1', tool: 'Glob', state: { status: 'running', input: { pattern: 'tests/**/*' } } },
          sessionID: 'sess_mock',
        },
      },
    });
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', id: 'tool1', tool: 'Glob', state: { status: 'completed', input: { pattern: 'tests/**/*' }, output: 'matches' } },
          sessionID: 'sess_mock',
        },
      },
    });

    // Provide authoritative data that includes reasoning, terminal tool state, and final text.
    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValue({
      data: [
        {
          info: { id: 'msg_final', role: 'assistant', time: { completed: 2 } },
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Recovered watchdog thinking', time: { start: 100, end: 500 } },
            {
              type: 'tool',
              id: 'tool1',
              tool: 'Glob',
              state: { status: 'completed', input: { pattern: 'tests/**/*' }, output: 'matches' },
            },
            { type: 'text', id: 't1', text: 'Recovered watchdog final response' },
          ],
        },
      ],
    });

    // Do not emit session.idle; watchdog should finalize after inactivity timeout.
    await vi.advanceTimersByTimeAsync(20000);

    const postCalls = (lastAppClient?.chat.postMessage as any).mock.calls;
    expect(postCalls.some((call: any[]) => String(call[0]?.text || '').includes('Thinking...'))).toBe(true);
    expect(flushActivityBatch).toHaveBeenCalled();
    expect(postResponseToThread).toHaveBeenCalled();
    const lastResponseCall = (postResponseToThread as any).mock.calls[(postResponseToThread as any).mock.calls.length - 1];
    expect(lastResponseCall[3]).toBe('Recovered watchdog final response');

    const statusUpdates = (lastAppClient?.chat.update as any).mock.calls;
    expect(statusUpdates.some((call: any[]) => call[0]?.text === 'Complete')).toBe(true);
  });
});
