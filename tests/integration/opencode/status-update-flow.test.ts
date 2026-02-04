import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, eventSubscribers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { buildCombinedStatusBlocks } from '../../../opencode/src/blocks.js';

describe('status-update-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('includes running tool info in status updates', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> run tool', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const callCountBefore = vi.mocked(buildCombinedStatusBlocks).mock.calls.length;

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess_mock',
          part: {
            type: 'tool',
            id: 'tool-1',
            callID: 'call-1',
            tool: 'WriteFile',
            state: { status: 'running', input: { path: '/tmp/test.txt' } },
          },
        },
      },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    const lastCall = vi.mocked(buildCombinedStatusBlocks).mock.calls.at(-1)?.[0] as any;
    expect(vi.mocked(buildCombinedStatusBlocks).mock.calls.length).toBeGreaterThan(callCountBefore);
    expect(lastCall?.status).toBe('tool');
    expect(lastCall?.currentTool).toBe('WriteFile');
    expect(lastCall?.toolsCompleted).toBe(0);
    expect(lastCall?.activityLog?.some((entry: any) => entry.type === 'tool_start')).toBe(true);
  });

  it('tracks tool completions and updates activity log', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> complete tool', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess_mock',
          part: {
            type: 'tool',
            id: 'tool-2',
            callID: 'call-2',
            tool: 'Search',
            state: { status: 'running', input: { query: 'test' } },
          },
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess_mock',
          part: {
            type: 'tool',
            id: 'tool-2',
            callID: 'call-2',
            tool: 'Search',
            state: { status: 'completed', input: { query: 'test' }, output: 'done' },
          },
        },
      },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    const lastCall = vi.mocked(buildCombinedStatusBlocks).mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.status).toBe('thinking');
    expect(lastCall?.currentTool).toBeUndefined();
    expect(lastCall?.toolsCompleted).toBe(1);
    expect(lastCall?.activityLog?.some((entry: any) => entry.type === 'tool_complete')).toBe(true);
  });

  it('captures todo updates and compaction status', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> todos', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'todo.updated',
        properties: {
          sessionID: 'sess_mock',
          todos: [{ id: 't1', text: 'Do the thing', done: false }],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'session.compacted',
        properties: { sessionID: 'sess_mock' },
      },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    const lastCall = vi.mocked(buildCombinedStatusBlocks).mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.customStatus).toBe('Compacted');
    expect(lastCall?.activityLog?.some((entry: any) => entry.tool === 'TodoWrite')).toBe(true);
  });

  it('computes context stats for status updates', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> usage', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-2',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: {
              input: 400,
              output: 50,
              reasoning: 0,
              cache: { read: 100, write: 100 },
            },
            cost: 0.02,
          },
          parts: [],
        },
      },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    const lastCall = vi.mocked(buildCombinedStatusBlocks).mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.contextPercent).toBe(0.3);
    expect(lastCall?.compactPercent).toBe(40);
    expect(lastCall?.tokensToCompact).toBe(400);
    expect(lastCall?.spinner).toBeDefined();
  });
});
