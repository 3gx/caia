/**
 * Integration tests for mode selection persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { saveMode } from '../../session-manager.js';

vi.mock('fs');

describe('Mode Selection Flow', () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists mode to both channel and thread sessions', async () => {
    const channelId = 'C_POLICY';
    const threadTs = '1234567890.000001';

    let sessionStore = {
      channels: {
        [channelId]: {
          threadId: null,
          workingDir: '/test',
          mode: 'ask',
          createdAt: 1000,
          lastActiveAt: 2000,
          pathConfigured: false,
          configuredPath: null,
          configuredBy: null,
          configuredAt: null,
          threads: {},
        },
      },
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => JSON.stringify(sessionStore));
    mockFs.writeFileSync.mockImplementation((_, data) => {
      sessionStore = JSON.parse(data as string);
    });

    await saveMode(channelId, threadTs, 'bypass');

    expect(sessionStore.channels[channelId].mode).toBe('bypass');
    expect(sessionStore.channels[channelId].threads[threadTs].mode).toBe('bypass');
  });
});
