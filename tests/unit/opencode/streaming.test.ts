import { describe, it, expect, vi } from 'vitest';
import { makeConversationKey, startStreamingSession, truncateWithClosedFormatting, extractTailWithFormatting } from '../../../opencode/src/streaming.js';

function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      startStream: vi.fn().mockRejectedValue(new Error('no stream')),
      appendStream: vi.fn().mockResolvedValue({ ok: true }),
      stopStream: vi.fn().mockResolvedValue({ ok: true }),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ id: 'F1' }] }),
      info: vi.fn().mockResolvedValue({ ok: true, file: { shares: { public: { C1: [{ ts: '1.0' }] } } } }),
    },
  } as any;
}

describe('streaming', () => {
  it('builds conversation key', () => {
    expect(makeConversationKey('C1')).toBe('C1');
    expect(makeConversationKey('C1', 'T1')).toBe('C1_T1');
  });

  it('truncates with closed formatting', () => {
    const text = '*bold* _italic_ `code`';
    const truncated = truncateWithClosedFormatting(text, 10);
    expect(truncated).toContain('_...truncated. Full response attached._');
    expect(truncated.length).toBeGreaterThan(10);
  });

  it('extractTailWithFormatting returns a tail', () => {
    const text = 'Hello world **bold** and `code`';
    const tail = extractTailWithFormatting(text, 10);
    expect(tail.startsWith('...')).toBe(true);
    expect(tail).toContain('code');
  });

  it('fallback streaming appends text', async () => {
    const client = createMockClient();
    const session = await startStreamingSession(client, {
      channel: 'C1',
      userId: 'U1',
      forceFallback: true,
    });

    await session.appendText('hello');
    await session.finish();

    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalled();
  });
});
