import { describe, it, expect } from 'vitest';
import { markdownToSlack, normalizeTable } from '../../../opencode/src/utils.js';

describe('utils', () => {
  it('converts markdown to Slack format', () => {
    const text = '**bold** _italic_ [link](https://example.com)';
    const result = markdownToSlack(text);
    expect(result).toContain('*bold*');
    expect(result).toContain('_italic_');
    expect(result).toContain('<https://example.com|link>');
  });

  it('normalizes table without crashing', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    const result = normalizeTable(table);
    expect(result).toContain('|');
  });
});
