import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, eventSubscribers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { buildCombinedStatusBlocks } from '../../../opencode/src/blocks.js';
import { getSession } from '../../../opencode/src/session-manager.js';

describe('status-update-flow', () => {
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
    await vi.advanceTimersByTimeAsync(3000);

    expect(vi.mocked(buildCombinedStatusBlocks).mock.calls.length).toBeGreaterThan(callCountBefore);
    const toolCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.status === 'tool' && args?.currentTool === 'WriteFile');
    expect(toolCall).toBeDefined();
    expect(toolCall?.toolsCompleted).toBe(0);
    expect(toolCall?.activityLog?.some((entry: any) => entry.type === 'tool_start')).toBe(true);
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
    await vi.advanceTimersByTimeAsync(3000);

    const completedCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.toolsCompleted === 1 && args?.status === 'thinking');
    expect(completedCall).toBeDefined();
    expect(completedCall?.currentTool).toBeUndefined();
    expect(completedCall?.activityLog?.some((entry: any) => entry.type === 'tool_complete')).toBe(true);
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
    await vi.advanceTimersByTimeAsync(3000);

    const compactCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.customStatus === 'Compacted');
    expect(compactCall).toBeDefined();
    expect(compactCall?.activityLog?.some((entry: any) => entry.tool === 'TodoWrite')).toBe(true);
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
    await vi.advanceTimersByTimeAsync(3000);

    const usageCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.contextPercent === 0.3);
    expect(usageCall).toBeDefined();
    expect(usageCall?.compactPercent).toBe(40);
    expect(usageCall?.tokensToCompact).toBe(400);
    expect(usageCall?.spinner).toBeDefined();
  });

  it('computes context stats with model-specific context window', async () => {
    vi.useFakeTimers();

    // Seed model cache: p:m has 60000 context window
    const { getCachedContextWindow } = await import('../../../opencode/src/model-cache.js');
    vi.mocked(getCachedContextWindow).mockReturnValue(60000);

    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> ctx test', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-ctx',
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
    await vi.advanceTimersByTimeAsync(3000);

    // 600 tokens used / 60000 context = 1.0%
    const usageCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.contextPercent === 1.0);
    expect(usageCall).toBeDefined();

    // Restore
    vi.mocked(getCachedContextWindow).mockReturnValue(null);
  });

  it('passes sessionTitle and contextWindow to status blocks', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> title test', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Emit session.updated with title
    eventSubscribers[0]?.({
      payload: {
        type: 'session.updated',
        properties: {
          info: { id: 'sess_mock', title: 'Test Session' },
        },
      },
    });

    // Emit message.updated to populate usage
    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-title',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 5 } },
            cost: 0.01,
          },
          parts: [],
        },
      },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    const titleCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.sessionTitle === 'Test Session');
    expect(titleCall).toBeDefined();
    expect(titleCall?.contextWindow).toBe(200000);  // DEFAULT_CONTEXT_WINDOW fallback
  });

  it('passes workingDir to status blocks', async () => {
    vi.useFakeTimers();
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> wdir test', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    // Session mock has workingDir: '/tmp' — verify it's passed through
    const wdirCall = vi.mocked(buildCombinedStatusBlocks).mock.calls
      .map((call) => call[0] as any)
      .find((args) => args?.workingDir === '/tmp');
    expect(wdirCall).toBeDefined();
  });

  it('respects updateRateSeconds for status update interval', async () => {
    vi.useFakeTimers();

    // Configure session with a 5-second update rate
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_mock',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: true,
      configuredPath: '/tmp',
      previousSessionIds: [],
      updateRateSeconds: 5,
    } as any);

    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> slow update', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const callsBefore = vi.mocked(buildCombinedStatusBlocks).mock.calls.length;

    // Advance 1 second — should NOT trigger a status update at the old 1s rate
    await vi.advanceTimersByTimeAsync(1000);
    const callsAt1s = vi.mocked(buildCombinedStatusBlocks).mock.calls.length;
    expect(callsAt1s).toBe(callsBefore);

    // Advance to 5 seconds total — should trigger first update
    await vi.advanceTimersByTimeAsync(4000);
    const callsAt5s = vi.mocked(buildCombinedStatusBlocks).mock.calls.length;
    expect(callsAt5s).toBeGreaterThan(callsBefore);
  });
});
