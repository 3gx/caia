import { describe, it, expect, vi } from 'vitest';
import { reconcileSandboxAndMaybeResumeThread } from '../../../codex/src/slack-bot.js';

describe('sandbox/thread reconciliation', () => {
  it('restarts before resume when sandbox differs for existing thread', async () => {
    const calls: string[] = [];
    let sandbox: 'danger-full-access' | 'workspace-write' = 'danger-full-access';

    const codex = {
      getSandboxMode: vi.fn(() => sandbox),
      restartWithSandbox: vi.fn(async (mode: 'danger-full-access' | 'workspace-write') => {
        calls.push(`restart:${mode}`);
        sandbox = mode;
      }),
      resumeThread: vi.fn(async (threadId: string) => {
        calls.push(`resume:${threadId}`);
      }),
    };

    const effectiveSandbox = await reconcileSandboxAndMaybeResumeThread(
      codex,
      'workspace-write',
      'thread-123'
    );

    expect(calls).toEqual(['restart:workspace-write', 'resume:thread-123']);
    expect(effectiveSandbox).toBe('workspace-write');
  });

  it('resumes directly when sandbox already matches', async () => {
    const calls: string[] = [];
    const codex = {
      getSandboxMode: vi.fn(() => 'workspace-write' as const),
      restartWithSandbox: vi.fn(async (_mode: 'danger-full-access' | 'workspace-write') => {
        calls.push('restart');
      }),
      resumeThread: vi.fn(async (_threadId: string) => {
        calls.push('resume');
      }),
    };

    const effectiveSandbox = await reconcileSandboxAndMaybeResumeThread(
      codex,
      'workspace-write',
      'thread-123'
    );

    expect(calls).toEqual(['resume']);
    expect(effectiveSandbox).toBe('workspace-write');
  });

  it('can reconcile sandbox without resuming when no thread id is provided', async () => {
    const calls: string[] = [];
    let sandbox: 'danger-full-access' | 'workspace-write' = 'danger-full-access';

    const codex = {
      getSandboxMode: vi.fn(() => sandbox),
      restartWithSandbox: vi.fn(async (mode: 'danger-full-access' | 'workspace-write') => {
        calls.push(`restart:${mode}`);
        sandbox = mode;
      }),
      resumeThread: vi.fn(async (_threadId: string) => {
        calls.push('resume');
      }),
    };

    const effectiveSandbox = await reconcileSandboxAndMaybeResumeThread(
      codex,
      'workspace-write'
    );

    expect(calls).toEqual(['restart:workspace-write']);
    expect(effectiveSandbox).toBe('workspace-write');
  });
});
