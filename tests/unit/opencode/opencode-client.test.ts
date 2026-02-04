import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpencodeClientWrapper } from '../../../opencode/src/opencode-client.js';
import { createOpencode } from '@opencode-ai/sdk';
import { execSync } from 'child_process';

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

function createMockClient() {
  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    global: {
      event: vi.fn().mockResolvedValue({ stream: (async function* () { })() }),
    },
  } as any;
}

describe('OpencodeClientWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts and stops a server instance', async () => {
    const client = createMockClient();
    const server = { url: 'http://localhost:60000', close: vi.fn() };

    vi.mocked(createOpencode).mockResolvedValue({ client, server } as any);

    const wrapper = new OpencodeClientWrapper();
    await wrapper.start(60000);

    expect(wrapper.isHealthy()).toBe(true);
    expect(createOpencode).toHaveBeenCalled();

    await wrapper.stop();
    expect(server.close).toHaveBeenCalled();
    expect(wrapper.isHealthy()).toBe(false);
  });

  it('healthCheck returns false when SDK throws', async () => {
    const client = createMockClient();
    client.session.list.mockRejectedValueOnce(new Error('boom'));
    const server = { url: 'http://localhost:60000', close: vi.fn() };

    vi.mocked(createOpencode).mockResolvedValue({ client, server } as any);

    const wrapper = new OpencodeClientWrapper();
    await wrapper.start(60001);
    const healthy = await wrapper.healthCheck();
    expect(healthy).toBe(false);
  });

  it('throws when port is busy', async () => {
    vi.mocked(execSync).mockReturnValueOnce('1234');
    const wrapper = new OpencodeClientWrapper();

    await expect(wrapper.start(60002)).rejects.toThrow('already in use');
  });

  it('restart cycles stop/start', async () => {
    const client = createMockClient();
    const server = { url: 'http://localhost:60000', close: vi.fn() };
    vi.mocked(createOpencode).mockResolvedValue({ client, server } as any);

    const wrapper = new OpencodeClientWrapper();
    await wrapper.start(60003);

    const stopSpy = vi.spyOn(wrapper, 'stop');
    const startSpy = vi.spyOn(wrapper, 'start');

    await wrapper.restart();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
  });
});
