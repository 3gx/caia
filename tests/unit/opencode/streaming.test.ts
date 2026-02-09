import { describe, it, expect, vi } from 'vitest';
import {
  makeConversationKey,
  startStreamingSession,
  truncateWithClosedFormatting,
  extractTailWithFormatting,
  uploadMarkdownAndPngWithResponse,
} from '../../../opencode/src/streaming.js';

vi.mock('../../../slack/dist/markdown-png.js', () => ({
  markdownToPng: vi.fn().mockResolvedValue(null),
}));

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

  it('posts thread text first then uploads files for long responses', async () => {
    const client = createMockClient();
    const longText = 'x'.repeat(2000);

    const result = await uploadMarkdownAndPngWithResponse(
      client,
      'C1',
      longText,
      longText,
      'T1'
    );

    expect(result?.ts).toBe('1.0');
    expect(result?.attachmentFailed).toBe(false);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', thread_ts: 'T1' })
    );
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: 'C1', thread_ts: 'T1' })
    );

    const postOrder = client.chat.postMessage.mock.invocationCallOrder[0];
    const uploadOrder = client.files.uploadV2.mock.invocationCallOrder[0];
    expect(postOrder).toBeLessThan(uploadOrder);
  });

  it('keeps posted response text when file upload fails in thread mode', async () => {
    const client = createMockClient();
    const longText = 'x'.repeat(2000);
    client.files.uploadV2.mockRejectedValueOnce(new Error('upload failed'));

    const result = await uploadMarkdownAndPngWithResponse(
      client,
      'C1',
      longText,
      longText,
      'T1'
    );

    expect(result?.ts).toBe('1.0');
    expect(result?.attachmentFailed).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', thread_ts: 'T1' })
    );
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        ts: '1.0',
        text: expect.stringContaining('not attached'),
      })
    );
  });
});
