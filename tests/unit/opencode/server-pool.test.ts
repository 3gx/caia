import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.OPENCODE_PORT_BASE = '61000';

vi.mock('../../../opencode/src/opencode-client.js', () => {
  class MockWrapper {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    restart = vi.fn().mockResolvedValue(undefined);
    healthCheck = vi.fn().mockResolvedValue(true);
    getServer() { return { url: 'http://localhost:61000', close: vi.fn() }; }
  }
  return { OpencodeClientWrapper: MockWrapper };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { ServerPool } from '../../../opencode/src/server-pool.js';

// Helper to wait for microtasks
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ServerPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and reuses instances per channel', async () => {
    const pool = new ServerPool();

    const a = await pool.getOrCreate('C1');
    const b = await pool.getOrCreate('C1');

    expect(a).toBe(b);
  });

  it('attaches additional channels without shutdown', async () => {
    const pool = new ServerPool();

    const a = await pool.getOrCreate('C1');
    pool.attachChannel('C2', a);

    await pool.shutdown('C1');
    // Instance should still be active for C2
    expect(a.refCount).toBe(1);

    await pool.shutdown('C2');
    expect(a.refCount).toBe(0);
  });

  it('shuts down all instances', async () => {
    const pool = new ServerPool();

    await pool.getOrCreate('C1');
    await pool.getOrCreate('C2');

    await pool.shutdownAll();
    await tick();
  });
});
