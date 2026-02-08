import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../codex/src/codex-client.js', () => {
  return {
    CodexClient: class MockCodexClient extends EventEmitter {
      start = vi.fn(async () => {});
      stop = vi.fn(async () => {});
      respondToApproval = vi.fn(async (_requestId: number, _decision: 'accept' | 'decline') => {});
    },
  };
});

vi.mock('../../../codex/src/streaming.js', () => {
  return {
    StreamingManager: class MockStreamingManager {
      stopAllStreaming = vi.fn(() => {});
      private approvalCallback?: (request: unknown, context: unknown) => Promise<void> | void;

      onApprovalRequest(callback: (request: unknown, context: unknown) => Promise<void> | void): void {
        this.approvalCallback = callback;
      }

      onTurnCompleted(_callback: (context: unknown, status: unknown) => void): void {
        // no-op for this test
      }

      async triggerApproval(request: unknown, context: unknown): Promise<void> {
        if (this.approvalCallback) {
          await this.approvalCallback(request, context);
        }
      }
    },
  };
});

vi.mock('../../../codex/src/approval-handler.js', () => {
  return {
    ApprovalHandler: class MockApprovalHandler {
      handleApprovalRequest = vi.fn(async () => {});
      hasPendingApproval = vi.fn(() => false);
    },
  };
});

import { CodexPool } from '../../../codex/src/codex-pool.js';

describe('CodexPool auto-approve routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-approves request when enabled in non-danger sandbox', async () => {
    const pool = new CodexPool({} as any);
    const runtime = await pool.getRuntime('C123_111.222');

    await (runtime.streaming as any).triggerApproval(
      {
        method: 'item/commandExecution/requestApproval',
        rpcId: 42,
        params: { threadId: 'thread-1' },
      },
      {
        channelId: 'C123',
        threadTs: '111.222',
        userId: 'U123',
        threadId: 'thread-1',
        turnId: 'turn-1',
        approvalPolicy: 'on-request',
        mode: 'ask',
        sandboxMode: 'workspace-write',
        autoApprove: true,
        updateRateMs: 1000,
        model: 'gpt-5.2-codex',
        startTime: Date.now(),
      }
    );

    expect((runtime.codex as any).respondToApproval).toHaveBeenCalledWith(42, 'accept');
    expect((runtime.approval as any).handleApprovalRequest).not.toHaveBeenCalled();
  });

  it('falls back to manual approval when sandbox is danger-full-access', async () => {
    const pool = new CodexPool({} as any);
    const runtime = await pool.getRuntime('C123_333.444');

    await (runtime.streaming as any).triggerApproval(
      {
        method: 'item/fileChange/requestApproval',
        rpcId: 55,
        params: { threadId: 'thread-2' },
      },
      {
        channelId: 'C123',
        threadTs: '333.444',
        userId: 'U123',
        threadId: 'thread-2',
        turnId: 'turn-2',
        approvalPolicy: 'on-request',
        mode: 'ask',
        sandboxMode: 'danger-full-access',
        autoApprove: true,
        updateRateMs: 1000,
        model: 'gpt-5.2-codex',
        startTime: Date.now(),
      }
    );

    expect((runtime.codex as any).respondToApproval).not.toHaveBeenCalled();
    expect((runtime.approval as any).handleApprovalRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to manual approval when rpcId is missing', async () => {
    const pool = new CodexPool({} as any);
    const runtime = await pool.getRuntime('C123_555.666');

    await (runtime.streaming as any).triggerApproval(
      {
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-3' },
      },
      {
        channelId: 'C123',
        threadTs: '555.666',
        userId: 'U123',
        threadId: 'thread-3',
        turnId: 'turn-3',
        approvalPolicy: 'on-request',
        mode: 'ask',
        sandboxMode: 'workspace-write',
        autoApprove: true,
        updateRateMs: 1000,
        model: 'gpt-5.2-codex',
        startTime: Date.now(),
      }
    );

    expect((runtime.codex as any).respondToApproval).not.toHaveBeenCalled();
    expect((runtime.approval as any).handleApprovalRequest).toHaveBeenCalledTimes(1);
  });
});
