import { describe, it, expect, vi } from 'vitest';
import { addReaction, removeReaction, markProcessingStart, markApprovalWait, markApprovalDone, markError, markAborted, cleanupMutex } from '../../../opencode/src/emoji-reactions.js';

describe('emoji-reactions', () => {
  it('adds and removes reactions', async () => {
    const client = { reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) } } as any;
    await addReaction(client, 'C1', '1.0', 'eyes');
    await removeReaction(client, 'C1', '1.0', 'eyes');

    expect(client.reactions.add).toHaveBeenCalled();
    expect(client.reactions.remove).toHaveBeenCalled();
  });

  it('transitions approval and error states', async () => {
    const client = { reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) } } as any;

    await markProcessingStart(client, 'C1', '1.0');
    await markApprovalWait(client, 'C1', '1.0');
    await markApprovalDone(client, 'C1', '1.0');
    await markError(client, 'C1', '1.0');
    await markAborted(client, 'C1', '1.0');

    cleanupMutex('C1', '1.0');

    expect(client.reactions.add).toHaveBeenCalled();
  });
});
