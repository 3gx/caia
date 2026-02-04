import { describe, it, expect } from 'vitest';
import { buildContextDisplayBlocks } from '../../../opencode/src/blocks.js';

const usage = {
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cost: 0,
  contextWindow: 200000,
  model: 'test-model',
};

describe('streaming context usage', () => {
  it('renders context usage blocks', () => {
    const blocks = buildContextDisplayBlocks(usage);
    expect(blocks.length).toBeGreaterThan(0);
    const text = JSON.stringify(blocks);
    expect(text).toContain('Context');
  });
});
