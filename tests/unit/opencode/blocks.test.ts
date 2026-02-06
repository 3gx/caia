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
  buildAttachThinkingFileButton,
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

  it('includes workingDir in attach thinking button payload', () => {
    const block = buildAttachThinkingFileButton('1.0', '2.0', 'C1', 'sess1', '/tmp', 123, 456, 'r1') as any;
    const value = JSON.parse(block.elements[0].value);
    expect(value.workingDir).toBe('/tmp');
    expect(value.reasoningPartId).toBe('r1');
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
  // Block structure: [0] = context (Recent status), [1] = section (dropdown), [2] = actions (Cancel)

  it('returns context, section with static_select, and actions blocks', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('context');  // Recent status
    expect(blocks[1].type).toBe('section');  // Dropdown
    expect((blocks[1] as any).accessory.type).toBe('static_select');
    expect(blocks[2].type).toBe('actions');  // Cancel button
  });

  it('uses option_groups for provider categorization', () => {
    const models = [
      { value: 'p1:m1', displayName: 'ProviderA / Model1', description: 'd1' },
      { value: 'p2:m1', displayName: 'ProviderB / Model2', description: 'd2' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    const select = (blocks[1] as any).accessory;
    // Only provider groups when no recent (Slack requires ≥1 option per group)
    expect(select.option_groups).toHaveLength(2);
    expect(select.option_groups[0].label.text).toBe('ProviderA');
    expect(select.option_groups[1].label.text).toBe('ProviderB');
  });

  it('sets initial_option when currentModel provided', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, 'p:m');
    expect((blocks[1] as any).accessory.initial_option).toBeDefined();
    expect((blocks[1] as any).accessory.initial_option.value).toBe('p:m');
  });

  it('shows "not set" text when no currentModel', () => {
    const blocks = buildModelSelectionBlocks([], undefined);
    expect((blocks[1] as any).text.text).toContain('not set');
  });

  it('uses action_id model_select for static_select', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    expect((blocks[1] as any).accessory.action_id).toBe('model_select');
  });

  it('includes Cancel button with model_cancel action_id', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined);
    const actions = blocks[2] as any;
    expect(actions.type).toBe('actions');
    expect(actions.elements[0].type).toBe('button');
    expect(actions.elements[0].action_id).toBe('model_cancel');
    expect(actions.elements[0].text.text).toBe('Cancel');
  });

  it('shows Recent group in dropdown when recentModels populated', () => {
    const models = [
      { value: 'p1:m1', displayName: 'ProviderA / Model1', description: 'd1' },
      { value: 'p2:m1', displayName: 'ProviderB / Model2', description: 'd2' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined, ['p1:m1']);
    const select = (blocks[1] as any).accessory;
    expect(select.option_groups[0].label.text).toBe('Recent');
    expect(select.option_groups[0].options).toHaveLength(1);
    expect(select.option_groups[0].options[0].value).toBe('p1:m1');
  });

  it('filters out invalid recent models', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined, ['invalid:model', 'p:m']);
    const select = (blocks[1] as any).accessory;
    expect(select.option_groups[0].label.text).toBe('Recent');
    expect(select.option_groups[0].options).toHaveLength(1);
    expect(select.option_groups[0].options[0].value).toBe('p:m');
  });

  it('shows Recent status in context block even when empty', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined, []);
    // Context block shows "Recent: _(none yet)_"
    expect(blocks[0].type).toBe('context');
    expect((blocks[0] as any).elements[0].text).toContain('Recent:');
    expect((blocks[0] as any).elements[0].text).toContain('(none yet)');
    // Dropdown does NOT have Recent group when empty (Slack requires ≥1 option)
    const select = (blocks[1] as any).accessory;
    expect(select.option_groups[0].label.text).toBe('Provider');
  });

  it('shows Recent status with model names when populated', () => {
    const models = [
      { value: 'p1:m1', displayName: 'ProviderA / Model1', description: 'd1' },
      { value: 'p2:m1', displayName: 'ProviderB / Model2', description: 'd2' },
    ];
    const blocks = buildModelSelectionBlocks(models, undefined, ['p1:m1', 'p2:m1']);
    // Context block shows "Recent: Model1, Model2"
    expect(blocks[0].type).toBe('context');
    expect((blocks[0] as any).elements[0].text).toContain('Recent:');
    expect((blocks[0] as any).elements[0].text).toContain('Model1');
    expect((blocks[0] as any).elements[0].text).toContain('Model2');
  });

  it('shows full displayName for current model', () => {
    const models = [
      { value: 'p:m', displayName: 'Provider / Model', description: 'desc' },
    ];
    const blocks = buildModelSelectionBlocks(models, 'p:m');
    expect((blocks[1] as any).text.text).toContain('Provider / Model');
  });
});
