/**
 * Unit tests for command handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodexClient } from '../../../codex/src/codex-client.js';
import {
  handleModeCommand,
  handleModelCommand,
  handleResumeCommand,
  handleMessageSizeCommand,
  MESSAGE_SIZE_DEFAULT,
  type CommandContext,
} from '../../../codex/src/commands.js';

vi.mock('../../../codex/src/session-manager.js', () => ({
  getEffectiveMode: vi.fn(() => 'ask'),
  getSession: vi.fn(() => ({ model: 'model-a', reasoningEffort: 'high', workingDir: '/tmp' })),
  getThreadSession: vi.fn(() => null),
  saveSession: vi.fn(),
  saveThreadSession: vi.fn(),
  saveMode: vi.fn(),
  saveThreadCharLimit: vi.fn(),
  clearSession: vi.fn(),
  getEffectiveWorkingDir: vi.fn(() => '/tmp'),
}));

describe('Command Handlers', () => {
  const baseContext: CommandContext = {
    channelId: 'C123',
    threadTs: '123.456',
    userId: 'U123',
    text: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows mode selection prompt when no args', async () => {
    const result = await handleModeCommand({ ...baseContext, text: '' });

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].text?.text).toContain('Select Mode');
    expect(result.showModeSelection).toBe(true);
  });

  it('returns error for invalid mode', async () => {
    const result = await handleModeCommand({ ...baseContext, text: 'invalid' });

    expect(result.text).toContain('Invalid mode');
  });

  it('shows model selection prompt (no args)', async () => {
    const result = await handleModelCommand({ ...baseContext, text: '' }, {} as CodexClient);

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].text?.text).toContain('Select Model');
  });

  it('shows model selection prompt even with args', async () => {
    const result = await handleModelCommand({ ...baseContext, text: 'model-b' }, {} as CodexClient);

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].text?.text).toContain('Select Model');
  });

  it('includes bundled models in selection', async () => {
    const result = await handleModelCommand({ ...baseContext, text: '' }, {} as CodexClient);

    expect(JSON.stringify(result.blocks)).toContain('gpt-5.2-codex');
  });

  describe('handleResumeCommand', () => {
    const codex = {
      resumeThread: vi.fn(),
    } as unknown as CodexClient;

    it('returns usage error when no thread id provided', async () => {
      const result = await handleResumeCommand({ ...baseContext, text: '' }, codex);
      expect(result.text).toContain('Usage: /resume');
    });

    it('resumes thread, updates sessions, and includes previous hint', async () => {
      const mockResumeId = 'thread-123';
      (codex.resumeThread as any).mockResolvedValue({ id: mockResumeId, workingDirectory: '/proj' });

      const { getSession, getThreadSession, saveSession, saveThreadSession } = await import('../../../codex/src/session-manager.js');

      (getSession as any).mockReturnValue({
        threadId: 'old-channel-thread',
        previousThreadIds: ['c-prev'],
        workingDir: '/old',
        mode: 'ask',
        pathConfigured: true,
        configuredPath: '/old',
        configuredBy: 'U0',
        configuredAt: 1,
      });

      (getThreadSession as any).mockReturnValue({
        threadId: 'old-thread-thread',
        previousThreadIds: ['t-prev'],
        workingDir: '/t-old',
        mode: 'ask',
        pathConfigured: true,
        configuredPath: '/t-old',
        configuredBy: 'U9',
        configuredAt: 2,
      });

      const result = await handleResumeCommand(
        { ...baseContext, text: mockResumeId },
        codex
      );

      expect(codex.resumeThread).toHaveBeenCalledWith(mockResumeId);

      expect(saveSession).toHaveBeenCalled();
      const channelArgs = (saveSession as any).mock.calls[0][1];
      expect(channelArgs.threadId).toBe(mockResumeId);
      expect(channelArgs.previousThreadIds).toContain('old-channel-thread');
      expect(channelArgs.configuredPath).toBe('/proj');

      expect(saveThreadSession).toHaveBeenCalled();
      const threadArgs = (saveThreadSession as any).mock.calls[0][2];
      expect(threadArgs.threadId).toBe(mockResumeId);
      expect(threadArgs.previousThreadIds).toContain('old-thread-thread');
      expect(threadArgs.configuredPath).toBe('/proj');

      expect(result.text).toContain('Resuming session');
      expect(result.text).toContain(mockResumeId);
      expect(result.text).toContain('/proj');
      const blocksJson = JSON.stringify(result.blocks);
      expect(blocksJson).toContain('Previous session');
    });

    it('surfaces errors from Codex resumeThread', async () => {
      (codex.resumeThread as any).mockRejectedValue(new Error('not found'));

      const result = await handleResumeCommand(
        { ...baseContext, text: 'bad-id' },
        codex
      );

      expect(result.text).toContain('Failed to resume session');
      expect(result.text).toContain('not found');
    });

    it('fails when Codex resumeThread does not return a working directory', async () => {
      (codex.resumeThread as any).mockResolvedValue({ id: 'thread-xyz', workingDirectory: '' });

      const result = await handleResumeCommand(
        { ...baseContext, text: 'thread-xyz' },
        codex
      );

      expect(result.text).toContain('Failed to resume session');
      expect(result.text).toContain('working directory');
    });
  });

  describe('handleMessageSizeCommand', () => {
    it('shows default message size when unset', async () => {
      const result = await handleMessageSizeCommand({ ...baseContext, text: '' });

      expect(result.text).toContain(`${MESSAGE_SIZE_DEFAULT}`);
      expect(result.text).toContain('default');
    });

    it('sets message size when valid', async () => {
      const { saveThreadCharLimit } = await import('../../../codex/src/session-manager.js');

      const result = await handleMessageSizeCommand({ ...baseContext, text: '1000' });

      expect(saveThreadCharLimit).toHaveBeenCalledWith(baseContext.channelId, baseContext.threadTs, 1000);
      expect(result.text).toContain('1000');
    });

    it('rejects invalid message size', async () => {
      const result = await handleMessageSizeCommand({ ...baseContext, text: 'abc' });

      expect(result.text).toContain('Invalid');
    });
  });

  // Note: /ls, /cd, /set-current-path commands are tested in
  // src/__tests__/integration/path-navigation-flow.test.ts
  // which provides comprehensive coverage with proper fs mocking.
});
