import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWatching, stopWatching, isWatching, updateWatchRate, stopAllWatchers } from '../../../opencode/src/terminal-watcher.js';

vi.mock('../../../opencode/src/message-sync.js', () => ({
  syncMessagesFromSession: vi.fn().mockResolvedValue({ syncedCount: 0, totalToSync: 0, wasAborted: false, allSucceeded: true }),
}));

describe('terminal-watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopAllWatchers();
    vi.useRealTimers();
  });

  it('starts and stops watching', () => {
    const session = {
      sessionId: 'sess',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: 1,
      lastActiveAt: 1,
      pathConfigured: false,
      configuredPath: null,
    } as any;

    const result = startWatching('C1', undefined, session, {} as any, {} as any, '1.0');
    expect(result.success).toBe(true);
    expect(isWatching('C1')).toBe(true);

    const stopped = stopWatching('C1');
    expect(stopped).toBe(true);
    expect(isWatching('C1')).toBe(false);
  });

  it('updates watch rate', () => {
    const session = {
      sessionId: 'sess',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: 1,
      lastActiveAt: 1,
      pathConfigured: false,
      configuredPath: null,
    } as any;

    startWatching('C1', undefined, session, {} as any, {} as any, '1.0');
    const updated = updateWatchRate('C1', undefined, 2);
    expect(updated).toBe(true);
  });
});
