import { describe, it, expect } from 'vitest';
import { buildMessageContent } from '../../../opencode/src/content-builder.js';

describe('content-builder', () => {
  it('builds content with file header and text body', () => {
    const files = [
      {
        index: 1,
        name: 'test.txt',
        mimetype: 'text/plain',
        size: 4,
        isText: true,
        isImage: false,
        error: null,
        buffer: Buffer.from('hello'),
      },
    ];

    const parts = buildMessageContent('hi', files, []);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0].type).toBe('text');
    expect((parts[0] as any).text).toContain('User message');
  });

  it('includes image data URLs when base64 available', () => {
    const files = [
      {
        index: 1,
        name: 'img.png',
        mimetype: 'image/png',
        size: 4,
        isText: false,
        isImage: true,
        error: null,
        base64: 'AA==',
      },
    ];

    const parts = buildMessageContent('hi', files, []);
    expect(parts.some((p: any) => p.type === 'file')).toBe(true);
  });

  it('falls back to local path text when base64 is unavailable', () => {
    const files = [
      {
        index: 1,
        name: 'img.png',
        mimetype: 'image/png',
        size: 1024,
        isText: false,
        isImage: true,
        error: null,
        localPath: '/tmp/img.png',
      },
    ];

    const parts = buildMessageContent('hi', files, []);
    const combinedText = parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    expect(combinedText).toContain('/tmp/img.png');
  });

  it('warns when image has neither base64 nor local path', () => {
    const files = [
      {
        index: 2,
        name: 'img.png',
        mimetype: 'image/png',
        size: 1024,
        isText: false,
        isImage: true,
        error: null,
      },
    ];

    const parts = buildMessageContent('hi', files, []);
    const combinedText = parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    expect(combinedText).toContain('could not be inlined or stored');
  });
});
