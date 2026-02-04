import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../opencode/src/opencode-client.js', () => {
  class MockWrapper {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    restart = vi.fn().mockResolvedValue(undefined);
    healthCheck = vi.fn().mockResolvedValue(true);
    getServer() { return { url: 'http://localhost:63000', close: vi.fn() }; }
  }
  return { OpencodeClientWrapper: MockWrapper };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { ServerPool } from '../../../opencode/src/server-pool.js';

describe('concurrent startup', () => {
  it('creates separate instances for different channels', async () => {
    const pool = new ServerPool();
    const [a, b] = await Promise.all([
      pool.getOrCreate('C1'),
      pool.getOrCreate('C2'),
    ]);

    expect(a).not.toBe(b);
  });
});
