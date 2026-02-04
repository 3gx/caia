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
});
