import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
  },
}));

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { default: actual };
});

import fs from 'fs';
import {
  loadSessions,
  saveSession,
  getSession,
  getOrCreateThreadSession,
  saveThreadSession,
  getThreadSession,
  saveMessageMapping,
  getMessageMapping,
} from '../../../opencode/src/session-manager.js';

const mockedFs = vi.mocked(fs);

describe('session-manager (opencode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty store when session file is missing', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const store = loadSessions();

    expect(store).toEqual({ channels: {} });
    expect(mockedFs.readFileSync).not.toHaveBeenCalled();
  });

  it('saveSession writes and getSession reads back', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    await saveSession('C123', {
      sessionId: 'sess-1',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: 1,
      lastActiveAt: 2,
      pathConfigured: false,
      configuredPath: null,
    });

    const session = getSession('C123');
    expect(session?.sessionId).toBe('sess-1');
    expect(session?.workingDir).toBe('/tmp');
  });

  it('creates thread session when missing', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    const result = await getOrCreateThreadSession('C1', '123.456');
    expect(result.isNewFork).toBe(true);
    expect(result.session.forkedFrom).toBe(null);
  });

  it('stores and retrieves message mappings', async () => {
    let fileContents = JSON.stringify({ channels: { C1: { sessionId: 'sess', workingDir: '/tmp', mode: 'default', createdAt: 1, lastActiveAt: 1, pathConfigured: false, configuredPath: null, previousSessionIds: [] } } });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    await saveMessageMapping('C1', '111.222', {
      sdkMessageId: 'msg_1',
      sessionId: 'sess',
      type: 'assistant',
    });

    const mapping = getMessageMapping('C1', '111.222');
    expect(mapping?.sdkMessageId).toBe('msg_1');
  });

  it('preserves recentModels across saveSession calls', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    // First save: set model and recentModels
    await saveSession('C123', {
      sessionId: 'sess-1',
      workingDir: '/tmp',
      mode: 'default',
      model: 'anthropic:claude-4',
      recentModels: ['anthropic:claude-4', 'openai:gpt-4o'],
      createdAt: 1,
      lastActiveAt: 2,
      pathConfigured: false,
      configuredPath: null,
    });

    // Verify recentModels was saved
    let session = getSession('C123');
    expect(session?.recentModels).toEqual(['anthropic:claude-4', 'openai:gpt-4o']);

    // Second save: update only lastUsage (simulates turn completion)
    // This should NOT wipe out recentModels
    await saveSession('C123', {
      lastUsage: {
        model: 'claude-4',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    });

    // Verify recentModels is still preserved
    session = getSession('C123');
    expect(session?.recentModels).toEqual(['anthropic:claude-4', 'openai:gpt-4o']);
    expect(session?.model).toBe('anthropic:claude-4');
    expect(session?.lastUsage?.inputTokens).toBe(100);
  });

  it('preserves recentModels when updating mode', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    // Set up session with recentModels
    await saveSession('C123', {
      sessionId: 'sess-1',
      recentModels: ['anthropic:claude-4'],
    });

    // Update mode only
    await saveSession('C123', { mode: 'plan' });

    // Verify recentModels preserved
    const session = getSession('C123');
    expect(session?.recentModels).toEqual(['anthropic:claude-4']);
    expect(session?.mode).toBe('plan');
  });

  it('thread model selection does not affect channel recentModels', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    // Set up channel session with recentModels
    await saveSession('C123', {
      sessionId: 'sess-1',
      model: 'anthropic:claude-4',
      recentModels: ['anthropic:claude-4', 'openai:gpt-4o'],
    });

    // Create thread session and update its model
    await getOrCreateThreadSession('C123', '111.222');
    await saveThreadSession('C123', '111.222', { model: 'google:gemini-2' });

    // Verify channel recentModels is unchanged
    const channelSession = getSession('C123');
    expect(channelSession?.recentModels).toEqual(['anthropic:claude-4', 'openai:gpt-4o']);
    expect(channelSession?.model).toBe('anthropic:claude-4');
  });

  it('can update channel recentModels while thread has different model', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    // Set up channel session
    await saveSession('C123', {
      sessionId: 'sess-1',
      model: 'anthropic:claude-4',
      recentModels: ['anthropic:claude-4'],
    });

    // Create thread with different model
    await getOrCreateThreadSession('C123', '111.222');
    await saveThreadSession('C123', '111.222', { model: 'google:gemini-2' });

    // Simulate the fix: update channel recentModels when model selected from thread
    // This is what slack-bot.ts now does after the fix
    await saveSession('C123', { recentModels: ['google:gemini-2', 'anthropic:claude-4'] });

    // Verify channel recentModels is updated
    const channelSession = getSession('C123');
    expect(channelSession?.recentModels).toEqual(['google:gemini-2', 'anthropic:claude-4']);

    // Verify thread model is still correct
    const threadSession = getThreadSession('C123', '111.222');
    expect(threadSession?.model).toBe('google:gemini-2');
  });

  it('preserves sessionTitle across saveSession calls', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    // First save: set sessionTitle
    await saveSession('C123', {
      sessionId: 'sess-1',
      sessionTitle: 'Test Title',
    });

    // Verify sessionTitle was saved
    let session = getSession('C123');
    expect(session?.sessionTitle).toBe('Test Title');

    // Second save: update only lastActiveAt (simulates subsequent save)
    await saveSession('C123', {
      lastActiveAt: Date.now(),
    } as any);

    // Verify sessionTitle is still preserved
    session = getSession('C123');
    expect(session?.sessionTitle).toBe('Test Title');
  });

  it('preserves sessionTitle in thread sessions', async () => {
    let fileContents = JSON.stringify({ channels: {} });
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('opencode-sessions.json'));
    mockedFs.readFileSync.mockImplementation(() => fileContents);
    mockedFs.writeFileSync.mockImplementation((_path, data) => {
      fileContents = data.toString();
    });

    // Create channel session first
    await saveSession('C123', { sessionId: 'sess-1' });

    // Create thread with sessionTitle
    await saveThreadSession('C123', '111.222', {
      sessionId: 'thread-1',
      sessionTitle: 'Thread Title',
    });

    // Verify thread sessionTitle
    let thread = getThreadSession('C123', '111.222');
    expect(thread?.sessionTitle).toBe('Thread Title');

    // Update thread with other fields
    await saveThreadSession('C123', '111.222', {
      lastActiveAt: Date.now(),
    } as any);

    // Verify sessionTitle is still preserved
    thread = getThreadSession('C123', '111.222');
    expect(thread?.sessionTitle).toBe('Thread Title');
  });
});
