import { describe, it, expect, vi } from 'vitest';
import { OpencodeClientWrapper } from '../../../opencode/src/opencode-client.js';
import { createOpencode } from '@opencode-ai/sdk';

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

describe('approval handling', () => {
  it('responds to permission via SDK', async () => {
    const client = {
      session: { list: vi.fn().mockResolvedValue({ data: [] }) },
      global: { event: vi.fn().mockResolvedValue({ stream: (async function* () {})() }) },
      postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({}),
    } as any;
    const server = { url: 'http://localhost:60000', close: vi.fn() };

    vi.mocked(createOpencode).mockResolvedValue({ client, server } as any);

    const wrapper = new OpencodeClientWrapper();
    await wrapper.start(60010);
    await wrapper.respondToPermission('sess', 'perm1', 'always', '/tmp');

    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: 'sess', permissionID: 'perm1' },
      body: { response: 'always' },
      query: { directory: '/tmp' },
    });
  });
});
