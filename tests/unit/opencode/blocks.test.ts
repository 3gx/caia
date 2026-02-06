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
  groupModelsByProvider,
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
    const blocks = buildStatusBlocks({ status: 'processing', messageTs: '1.0' });
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
    const deprecated = buildModelDeprecatedBlocks('m2', models);
    expect(deprecated.length).toBeGreaterThan(0);
  });
});

describe('groupModelsByProvider', () => {
  it('groups models by provider name', () => {
    const models = [
      { value: 'p1:m1', displayName: 'Provider1 / Model1', description: 'desc1' },
      { value: 'p1:m2', displayName: 'Provider1 / Model2', description: 'desc2' },
      { value: 'p2:m1', displayName: 'Provider2 / ModelA', description: 'descA' },
    ];
    const groups = groupModelsByProvider(models);
    expect(groups).toHaveLength(2);
    expect(groups[0].provider).toBe('Provider1');
    expect(groups[0].models).toHaveLength(2);
    expect(groups[1].provider).toBe('Provider2');
    expect(groups[1].models).toHaveLength(1);
  });

  it('handles models without provider separator', () => {
    const models = [
      { value: 'x', displayName: 'StandaloneModel', description: 'desc' },
    ];
    const groups = groupModelsByProvider(models);
    // When there's no " / " separator, the whole displayName becomes the provider
    expect(groups[0].provider).toBe('StandaloneModel');
  });

  it('handles empty model list', () => {
    const groups = groupModelsByProvider([]);
    expect(groups).toHaveLength(0);
  });
});

describe('buildModelSelectionBlocks (static_select)', () => {
  it('returns section with static_select accessory', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    expect(blocks[0].type).toBe('section');
    expect((blocks[0] as any).accessory.type).toBe('static_select');
  });

  it('uses option_groups for provider categorization', () => {
    const models = [
      { value: 'p1:m1', displayName: 'ProviderA / Model1', description: 'd1' },
      { value: 'p2:m1', displayName: 'ProviderB / Model2', description: 'd2' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    const select = (blocks[0] as any).accessory;
    expect(select.option_groups).toHaveLength(2);
    expect(select.option_groups[0].label.text).toBe('ProviderA');
  });

  it('sets initial_option when currentModel provided', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, 'p:m');
    expect((blocks[0] as any).accessory.initial_option).toBeDefined();
    expect((blocks[0] as any).accessory.initial_option.value).toBe('p:m');
  });

  it('shows default text when no currentModel', () => {
    const blocks = buildModelSelectionBlocks([], undefined);
    expect((blocks[0] as any).text.text).toContain('default (SDK chooses)');
  });

  it('uses action_id model_select for static_select', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    expect((blocks[0] as any).accessory.action_id).toBe('model_select');
  });
});
