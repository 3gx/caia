import { describe, it, expect } from 'vitest';
import { extractFirstMentionId } from '../../../opencode/src/commands.js';

describe('command extraction', () => {
  it('extracts first mention id', () => {
    const id = extractFirstMentionId('<@U123> hello <@U456>');
    expect(id).toBe('U123');
  });
});
