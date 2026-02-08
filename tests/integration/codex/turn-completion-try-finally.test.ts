/**
 * Integration test: Verify the try/finally fix in StreamingManager's turn:completed handler.
 *
 * Tests that the turnCompletedCallback ALWAYS fires when turn:completed is emitted,
 * even when:
 * - State is missing (null) for the found context
 * - An exception occurs during the handler body
 *
 * This prevents the "Another request is already running" bug where the busy flag
 * in conversationTracker is never cleared.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock all external dependencies before importing StreamingManager
vi.mock('../../../codex/src/emoji-reactions.js', () => ({
  markProcessingStart: vi.fn().mockResolvedValue(undefined),
  removeProcessingEmoji: vi.fn().mockResolvedValue(undefined),
  markError: vi.fn().mockResolvedValue(undefined),
  markAborted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../codex/src/abort-tracker.js', () => ({
  isAborted: vi.fn().mockReturnValue(false),
  clearAborted: vi.fn(),
}));

vi.mock('../../../codex/src/session-manager.js', () => ({
  saveSession: vi.fn().mockResolvedValue(undefined),
  saveThreadSession: vi.fn().mockResolvedValue(undefined),
  getThreadSession: vi.fn().mockReturnValue(null),
  getSession: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../codex/src/activity-thread.js', () => ({
  ActivityThreadManager: class {
    addEntry = vi.fn();
    getEntries = vi.fn().mockReturnValue([]);
    clearEntries = vi.fn();
  },
  getToolEmoji: vi.fn().mockReturnValue(''),
  buildActivityLogText: vi.fn().mockReturnValue(''),
  flushActivityBatchToThread: vi.fn().mockResolvedValue(undefined),
  updateThinkingEntryInThread: vi.fn().mockResolvedValue(undefined),
  syncResponseSegmentEntryInThread: vi.fn().mockResolvedValue(undefined),
  getThinkingEntryTs: vi.fn().mockReturnValue(undefined),
  getMessagePermalink: vi.fn().mockResolvedValue('https://slack.com/link'),
  uploadFilesToThread: vi.fn().mockResolvedValue({ success: true }),
  postThinkingToThread: vi.fn().mockResolvedValue(undefined),
  postResponseToThread: vi.fn().mockResolvedValue({ ts: 'resp_ts' }),
  postErrorToThread: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../codex/src/dm-notifications.js', () => ({
  sendDmNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../codex/src/blocks.js', () => ({
  buildActivityBlocks: vi.fn().mockReturnValue([]),
  DEFAULT_CONTEXT_WINDOW: 128000,
  computeAutoCompactThreshold: vi.fn().mockReturnValue(100000),
  buildActivityEntryBlocks: vi.fn().mockReturnValue([]),
  buildForkButton: vi.fn().mockReturnValue({}),
  buildAttachThinkingFileButton: vi.fn().mockReturnValue({}),
  buildAttachResponseFileButton: vi.fn().mockReturnValue({}),
  formatThreadActivityEntry: vi.fn().mockReturnValue(''),
  formatThreadResponseMessage: vi.fn().mockReturnValue(''),
  buildActivityEntryActionParams: vi.fn().mockReturnValue(undefined),
  markdownToSlack: vi.fn((s: string) => s),
  truncateWithClosedFormatting: vi.fn((s: string) => s),
}));

vi.mock('../../../slack/dist/retry.js', () => ({
  withSlackRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../../codex/src/commands.js', () => ({
  THINKING_MESSAGE_SIZE: 3000,
  MESSAGE_SIZE_DEFAULT: 500,
}));

import { StreamingManager, makeConversationKey } from '../../../codex/src/streaming.js';
import type { StreamingContext } from '../../../codex/src/streaming.js';
import type { TurnStatus, CodexClient } from '../../../codex/src/codex-client.js';

/** Minimal mock CodexClient: EventEmitter + stubs for methods used in the handler */
function createMockCodex(): CodexClient {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    startTurn: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    approveItem: vi.fn().mockResolvedValue(undefined),
    denyItem: vi.fn().mockResolvedValue(undefined),
    getThreadLatestAssistantMessage: vi.fn().mockResolvedValue(null),
    getThreadTurnCount: vi.fn().mockResolvedValue(1),
  }) as unknown as CodexClient;
}

function createMockSlack(): any {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'msg_ts' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function createContext(overrides?: Partial<StreamingContext>): StreamingContext {
  return {
    channelId: 'C_TEST',
    threadTs: 'thread_ts_1',
    messageTs: 'msg_ts_1',
    originalTs: 'orig_ts_1',
    userId: 'U_TEST',
    threadId: 'codex_thread_1',
    turnId: 'turn_1',
    approvalPolicy: 'never',
    mode: 'bypassPermissions',
    updateRateMs: 60000, // Long interval so timer doesn't fire during test
    startTime: Date.now(),
    ...overrides,
  };
}

describe('StreamingManager turn:completed try/finally guarantee', () => {
  let codex: CodexClient;
  let slack: any;
  let streaming: StreamingManager;

  beforeEach(() => {
    vi.clearAllMocks();
    codex = createMockCodex();
    slack = createMockSlack();
    streaming = new StreamingManager(slack, codex);
  });

  it('callback fires on normal turn completion', async () => {
    const callbackSpy = vi.fn();
    streaming.onTurnCompleted(callbackSpy);

    const ctx = createContext();
    streaming.startStreaming(ctx);

    // Emit turn:completed
    (codex as unknown as EventEmitter).emit('turn:completed', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      status: 'completed' as TurnStatus,
    });

    // Allow async handler to complete
    await vi.waitFor(() => expect(callbackSpy).toHaveBeenCalled());
    expect(callbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ctx.threadId }),
      'completed'
    );
  });

  it('callback fires when state is missing (the null-state gap)', async () => {
    const callbackSpy = vi.fn();
    streaming.onTurnCompleted(callbackSpy);

    const ctx = createContext();
    streaming.startStreaming(ctx);

    // Manually delete the state to simulate the null-state scenario.
    // The context remains so findContextByTurnId finds it, but state is gone.
    const key = makeConversationKey(ctx.channelId, ctx.threadTs);
    // Access internal states map via the streaming manager
    // We use Object.keys trick since states is private
    (streaming as any).states.delete(key);

    (codex as unknown as EventEmitter).emit('turn:completed', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      status: 'completed' as TurnStatus,
    });

    // The callback MUST still fire (this is the fix)
    await vi.waitFor(() => expect(callbackSpy).toHaveBeenCalled());
    expect(callbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ctx.threadId }),
      'completed'
    );
  });

  it('callback fires when an exception occurs mid-handler', async () => {
    const callbackSpy = vi.fn();
    streaming.onTurnCompleted(callbackSpy);

    const ctx = createContext();
    streaming.startStreaming(ctx);

    // Make a Slack API call throw to simulate an uncaught exception
    // removeProcessingEmoji is called during the handler and we un-mock it to throw
    const { removeProcessingEmoji } = await import('../../../codex/src/emoji-reactions.js');
    (removeProcessingEmoji as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Slack API failure')
    );

    (codex as unknown as EventEmitter).emit('turn:completed', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      status: 'completed' as TurnStatus,
    });

    // The callback MUST still fire despite the error
    await vi.waitFor(() => expect(callbackSpy).toHaveBeenCalled());
    expect(callbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ctx.threadId }),
      'completed'
    );
  });

  it('context and state are cleaned up from maps after completion', async () => {
    const callbackSpy = vi.fn();
    streaming.onTurnCompleted(callbackSpy);

    const ctx = createContext();
    streaming.startStreaming(ctx);

    const key = makeConversationKey(ctx.channelId, ctx.threadTs);
    expect((streaming as any).contexts.has(key)).toBe(true);
    expect((streaming as any).states.has(key)).toBe(true);

    (codex as unknown as EventEmitter).emit('turn:completed', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      status: 'completed' as TurnStatus,
    });

    await vi.waitFor(() => expect(callbackSpy).toHaveBeenCalled());

    // Maps should be cleaned up
    expect((streaming as any).contexts.has(key)).toBe(false);
    expect((streaming as any).states.has(key)).toBe(false);
  });

  it('callback fires on failed status', async () => {
    const callbackSpy = vi.fn();
    streaming.onTurnCompleted(callbackSpy);

    const ctx = createContext();
    streaming.startStreaming(ctx);

    (codex as unknown as EventEmitter).emit('turn:completed', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      status: 'failed' as TurnStatus,
    });

    await vi.waitFor(() => expect(callbackSpy).toHaveBeenCalled());
    expect(callbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ctx.threadId }),
      'failed'
    );
  });

  it('callback fires on interrupted status', async () => {
    const callbackSpy = vi.fn();
    streaming.onTurnCompleted(callbackSpy);

    const ctx = createContext();
    streaming.startStreaming(ctx);

    (codex as unknown as EventEmitter).emit('turn:completed', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      status: 'interrupted' as TurnStatus,
    });

    await vi.waitFor(() => expect(callbackSpy).toHaveBeenCalled());
    expect(callbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ctx.threadId }),
      'interrupted'
    );
  });
});
