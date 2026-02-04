import { describe, it, expect } from 'vitest';
import {
  buildStatusBlocks,
  buildModeSelectionBlocks,
  buildToolApprovalBlocks,
  buildPlanApprovalBlocks,
  buildForkToChannelModalView,
  buildAbortConfirmationModalView,
  buildModelSelectionBlocks,
  buildModelDeprecatedBlocks,
} from '../../../opencode/src/blocks.js';

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  reasoningTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cost: 0,
  contextWindow: 200000,
  model: 'test',
};

describe('blocks', () => {
  it('builds status blocks', () => {
    const blocks = buildStatusBlocks('processing', { statusMsgTs: '1.0', usage });
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('builds mode selection blocks', () => {
    const blocks = buildModeSelectionBlocks('default');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('builds tool approval blocks', () => {
    const blocks = buildToolApprovalBlocks({
      approvalId: 'ap1',
      toolName: 'Read',
      toolInput: { path: '/tmp' },
      userId: 'U1',
      channelId: 'C1',
    });
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('builds plan approval blocks', () => {
    const blocks = buildPlanApprovalBlocks({ conversationKey: 'C1', planFilePath: '/tmp/plan.md', userId: 'U1', channelId: 'C1' });
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('builds fork/channel modals', () => {
    const fork = buildForkToChannelModalView({ channelId: 'C1', threadTs: '1.0' });
    const abort = buildAbortConfirmationModalView({ conversationKey: 'C1', channelId: 'C1', threadTs: '1.0' });
    expect(fork).toBeDefined();
    expect(abort).toBeDefined();
  });

  it('builds model selection blocks', () => {
    const models = [
      { value: 'm1', displayName: 'Model 1', description: 'Fast' },
      { value: 'm2', displayName: 'Model 2', description: 'Smart' },
    ];
    const blocks = buildModelSelectionBlocks(models, 'm1');
    expect(blocks.length).toBeGreaterThan(0);
    const deprecated = buildModelDeprecatedBlocks(models, 'm2');
    expect(deprecated.length).toBeGreaterThan(0);
  });
});
