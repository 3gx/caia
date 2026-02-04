import { describe, it, expect, vi } from 'vitest';
import { OpencodeClientWrapper } from '../../../opencode/src/opencode-client.js';
import { createOpencode } from '@opencode-ai/sdk';
import { execSync } from 'child_process';

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '1234'),
}));

describe('port collision', () => {
  it('throws when port is already in use', async () => {
    const wrapper = new OpencodeClientWrapper();
    await expect(wrapper.start(62000)).rejects.toThrow('already in use');
    expect(execSync).toHaveBeenCalled();
    expect(createOpencode).not.toHaveBeenCalled();
  });
});
