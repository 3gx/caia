import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../opencode/src/opencode-client.js', () => {
  class MockWrapper {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    restart = vi.fn().mockResolvedValue(undefined);
    healthCheck = vi.fn().mockResolvedValue(false);
    getServer() { return { url: 'http://localhost:61000', close: vi.fn() }; }
  }
  return { OpencodeClientWrapper: MockWrapper };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { ServerPool } from '../../../opencode/src/server-pool.js';

describe('server crash recovery', () => {
  it('restarts server when health check fails', async () => {
    vi.useFakeTimers();
    const pool = new ServerPool();
    const instance = await pool.getOrCreate('C1');

    // Fast-forward health interval (30s default)
    await vi.advanceTimersByTimeAsync(30000);

    expect(instance.client.restart).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
