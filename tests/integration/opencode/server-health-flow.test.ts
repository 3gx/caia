import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

class MockWrapper {
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  restart = vi.fn().mockResolvedValue(undefined);
  healthCheck = vi.fn().mockResolvedValue(true);
  getServer() { return { url: 'http://localhost:60000', close: vi.fn() }; }
}

vi.mock('../../../opencode/src/opencode-client.js', () => ({
  OpencodeClientWrapper: MockWrapper,
}));

describe('server-health-flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts on failed health check', async () => {
    const { ServerPool } = await import('../../../opencode/src/server-pool.js');
    const pool = new ServerPool() as any;
    pool.healthIntervalMs = 50;
    pool.idleTimeoutMs = 10_000;

    const instance = await pool.getOrCreate('C1');
    const client = instance.client as MockWrapper;

    client.healthCheck.mockResolvedValueOnce(false).mockResolvedValue(true);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.restart).toHaveBeenCalled();

    await pool.shutdownAll();
  });

  it('shuts down idle instances', async () => {
    const { ServerPool } = await import('../../../opencode/src/server-pool.js');
    const pool = new ServerPool() as any;
    pool.healthIntervalMs = 50;
    pool.idleTimeoutMs = 100;

    const instance = await pool.getOrCreate('C1');
    const client = instance.client as MockWrapper;

    instance.lastUsedAt = Date.now() - 200;

    await vi.advanceTimersByTimeAsync(50);

    expect(client.stop).toHaveBeenCalled();

    await pool.shutdownAll();
  });
});
