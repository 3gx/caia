import { describe, it, expect } from 'vitest';
import { isImageFile, isTextFile, isTextFileByExtension, isBinaryFile } from '../../../opencode/src/file-handler.js';

describe('file-handler', () => {
  it('detects image files', () => {
    expect(isImageFile('image/png')).toBe(true);
    expect(isImageFile('text/plain')).toBe(false);
  });

  it('detects text files by mimetype', () => {
    expect(isTextFile('text/markdown')).toBe(true);
    expect(isTextFile('application/json')).toBe(true);
    expect(isTextFile('image/png')).toBe(false);
  });

  it('detects text files by extension', () => {
    expect(isTextFileByExtension('README.md')).toBe(true);
    expect(isTextFileByExtension('image.png')).toBe(false);
  });

  it('detects binary files', () => {
    expect(isBinaryFile('application/pdf')).toBe(true);
    expect(isBinaryFile('text/plain')).toBe(false);
  });
});
