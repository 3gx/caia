import { describe, it, expect } from 'vitest';
import { evaluateFileProcessing } from '../../../slack/src/file-guard.js';

const inlineWarning = 'File 1 (image.png) image too large for inline data URL (4.0MB, max 3.75MB)';
const downloadWarning = 'File 1 (image.png) could not be downloaded: HTTP 403';

describe('file-guard', () => {
  it('ignores inline warnings when inline fallback is allowed', () => {
    const result = evaluateFileProcessing(
      { files: [{ name: 'image.png' }], warnings: [inlineWarning] },
      { allowInlineFallback: true }
    );
    expect(result.hasFailedFiles).toBe(false);
  });

  it('flags inline warnings when inline fallback is not allowed', () => {
    const result = evaluateFileProcessing(
      { files: [{ name: 'image.png' }], warnings: [inlineWarning] },
      { allowInlineFallback: false }
    );
    expect(result.hasFailedFiles).toBe(true);
    expect(result.failureWarnings).toEqual([inlineWarning]);
  });

  it('flags failed files and download warnings', () => {
    const result = evaluateFileProcessing({
      files: [{ name: 'image.png', error: 'HTTP 403' }],
      warnings: [downloadWarning],
    });
    expect(result.hasFailedFiles).toBe(true);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failureWarnings).toEqual([downloadWarning]);
    expect(result.failureMessage).toContain('could not be processed');
  });
});
