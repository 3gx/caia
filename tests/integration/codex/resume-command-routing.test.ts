/**
 * Integration-ish test covering command routing for /resume.
 * Ensures the router dispatches to handleResumeCommand and persists session updates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodexClient } from '../../../codex/src/codex-client.js';
import { handleCommand, type CommandContext } from '../../../codex/src/commands.js';

vi.mock('../../../codex/src/session-manager.js', () => {
  const saveSession = vi.fn();
  const saveThreadSession = vi.fn();

  return {
    getSession: vi.fn(() => null),
    getThreadSession: vi.fn(() => null),
    saveSession,
    saveThreadSession,
    saveThreadCharLimit: vi.fn(),
    saveSandboxMode: vi.fn(),
    clearSession: vi.fn(),
    getEffectiveMode: vi.fn(() => 'ask'),
    getEffectiveWorkingDir: vi.fn(() => '/tmp'),
    getEffectiveSandboxMode: vi.fn(() => 'danger-full-access'),
  };
});

describe('/resume command routing', () => {
  const baseContext: CommandContext = {
    channelId: 'C123',
    threadTs: '123.456',
    userId: 'U123',
    text: '',
  };

  let codex: CodexClient;

  beforeEach(() => {
    vi.clearAllMocks();
    codex = {
      resumeThread: vi.fn().mockResolvedValue({
        id: 'thread-xyz',
        workingDirectory: '/project',
        createdAt: new Date().toISOString(),
      }),
    } as unknown as CodexClient;
  });

  it('dispatches /resume to resumeThread and saves session', async () => {
    const result = await handleCommand(
      { ...baseContext, text: '/resume thread-xyz' },
      codex
    );

    expect(result).not.toBeNull();
    expect(codex.resumeThread).toHaveBeenCalledWith('thread-xyz');

    const { saveSession, saveThreadSession } = await import('../../../codex/src/session-manager.js');
    expect(saveSession as unknown as any).toHaveBeenCalled();
    expect(saveThreadSession as unknown as any).toHaveBeenCalled();

    const channelArgs = (saveSession as unknown as any).mock.calls[0][1];
    expect(channelArgs.threadId).toBe('thread-xyz');
    expect(channelArgs.configuredPath).toBe('/project');
  });
});
