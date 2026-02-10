import { vi } from 'vitest';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

const { conversationBusy } = vi.hoisted(() => ({
  conversationBusy: new Set<string>(),
}));

export let registeredHandlers: Record<string, any> = {};
export let lastAppClient: ReturnType<typeof createMockWebClient> | null = null;
export const eventSubscribers: Array<(event: any) => void> = [];
export const eventUnsubscribers: Array<ReturnType<typeof vi.fn>> = [];
export let lastStreamingSession: { appendText: any; finish: any; error: any; messageTs: string | null } | null = null;

export const resetHandlers = () => { registeredHandlers = {}; };
export const resetMockState = () => {
  vi.clearAllMocks();
  resetHandlers();
  eventSubscribers.length = 0;
  eventUnsubscribers.length = 0;
  lastAppClient = null;
  lastStreamingSession = null;
  conversationBusy.clear();
};

class MockApp {
  client = createMockWebClient();
  constructor() {
    lastAppClient = this.client;
  }
  event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
  message(handler: any) { registeredHandlers['message'] = handler; }
  action(pattern: string | RegExp, handler: any) {
    const key = typeof pattern === 'string' ? pattern : pattern.source;
    registeredHandlers[`action_${key}`] = handler;
  }
  view(pattern: string, handler: any) { registeredHandlers[`view_${pattern}`] = handler; }
  async start() { return Promise.resolve(); }
  async stop() { return Promise.resolve(); }
}

vi.mock('@slack/bolt', () => ({
  App: MockApp,
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

class MockWrapper {
  private client = {
    session: {
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  } as any;
  getClient() { return this.client; }
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  restart = vi.fn().mockResolvedValue(undefined);
  healthCheck = vi.fn().mockResolvedValue(true);
  createSession = vi.fn().mockResolvedValue('sess_mock');
  forkSession = vi.fn().mockResolvedValue('fork_sess');
  promptAsync = vi.fn().mockResolvedValue(undefined);
  respondToPermission = vi.fn().mockResolvedValue(undefined);
  abort = vi.fn().mockResolvedValue(undefined);
  subscribeToEvents = vi.fn((cb: (event: any) => void) => {
    eventSubscribers.push(cb);
    const unsubscribe = vi.fn();
    eventUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  getServer() { return { url: 'http://localhost:60000', close: vi.fn() }; }
}

export const mockWrapper = new MockWrapper();
export let lastServerPool: any = null;

vi.mock('../../../opencode/src/server-pool.js', () => {
  class ServerPool {
    constructor() {
      lastServerPool = this;
    }
    getOrCreate = vi.fn().mockResolvedValue({
      client: mockWrapper,
      server: { url: 'http://localhost:60000', close: vi.fn() },
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      channelId: 'C1',
      restartAttempts: 0,
      refCount: 1,
      channelIds: new Set(['C1']),
    });
    attachChannel = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
    shutdownAll = vi.fn().mockResolvedValue(undefined);
  }
  return { ServerPool };
});

vi.mock('../../../slack/dist/session/conversation-tracker.js', () => ({
  ConversationTracker: class {
    startProcessing(id: string) { if (conversationBusy.has(id)) return false; conversationBusy.add(id); return true; }
    stopProcessing(id: string) { conversationBusy.delete(id); }
    isBusy(id: string) { return conversationBusy.has(id); }
  },
}));

vi.mock('../../../opencode/src/session-manager.js', () => ({
  getSession: vi.fn().mockReturnValue({
    sessionId: 'sess_mock',
    workingDir: '/tmp',
    mode: 'default',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: true,
    configuredPath: '/tmp',
    previousSessionIds: [],
  }),
  saveSession: vi.fn(),
  getThreadSession: vi.fn(),
  saveThreadSession: vi.fn(),
  getOrCreateThreadSession: vi.fn().mockResolvedValue({
    session: { sessionId: 'sess_thread', forkedFrom: 'sess_mock', workingDir: '/tmp', mode: 'default', createdAt: Date.now(), lastActiveAt: Date.now(), pathConfigured: true, configuredPath: '/tmp' },
    isNewFork: false,
  }),
  saveMessageMapping: vi.fn(),
  findForkPointMessageId: vi.fn().mockReturnValue(null),
  addSlackOriginatedUserUuid: vi.fn(),
  clearSyncedMessageUuids: vi.fn(),
  clearSlackOriginatedUserUuids: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('../../../opencode/src/blocks.js', () => ({
  buildCombinedStatusBlocks: vi.fn().mockReturnValue([]),
  buildStatusDisplayBlocks: vi.fn().mockReturnValue([]),
  buildContextDisplayBlocks: vi.fn().mockReturnValue([]),
  buildToolApprovalBlocks: vi.fn().mockReturnValue([]),
  buildForkToChannelModalView: vi.fn().mockImplementation((params: any) => ({
    type: 'modal',
    private_metadata: JSON.stringify(params),
    blocks: [],
  })),
  buildModelSelectionBlocks: vi.fn().mockImplementation((models: any[], currentModel?: string, recentModels?: string[]) => {
    // Group models by provider for option_groups (same logic as real implementation)
    const groups = new Map<string, any[]>();
    for (const model of models) {
      const provider = model.displayName?.split(' / ')[0] || 'Other';
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider)!.push(model);
    }
    const providerOptionGroups = Array.from(groups.entries()).map(([provider, models]) => ({
      label: { type: 'plain_text', text: provider },
      options: models.map((m: any) => ({
        text: { type: 'plain_text', text: m.displayName?.split(' / ')[1] || m.displayName },
        value: m.value,
      })),
    }));

    // Build Recent group (only if has items - Slack requires ≥1 option per group)
    const validRecent = (recentModels || [])
      .map(value => models.find((m: any) => m.value === value))
      .filter((m: any) => m !== undefined);

    const recentGroup = validRecent.length > 0 ? {
      label: { type: 'plain_text', text: 'Recent' },
      options: validRecent.map((m: any) => ({
        text: { type: 'plain_text', text: m.displayName?.split(' / ')[1] || m.displayName },
        value: m.value,
      })),
    } : null;

    const optionGroups = recentGroup
      ? [recentGroup, ...providerOptionGroups]
      : providerOptionGroups;

    const currentModelDisplay = currentModel
      ? models.find((m: any) => m.value === currentModel)?.displayName || currentModel
      : 'not set';

    // Recent status text for context block (always shown)
    const recentStatusText = recentGroup
      ? `Recent: ${recentGroup.options.map((o: any) => o.text.text).join(', ')}`
      : 'Recent: _(none yet)_';

    return [
      {
        type: 'context',
        block_id: 'model_recent_status',
        elements: [{ type: 'mrkdwn', text: recentStatusText }],
      },
      {
        type: 'section',
        block_id: 'model_selection',
        text: { type: 'mrkdwn', text: `*Select Model*\nCurrent: \`${currentModelDisplay}\`` },
        accessory: {
          type: 'static_select',
          action_id: 'model_select',
          placeholder: { type: 'plain_text', text: 'Choose a model...' },
          option_groups: optionGroups,
        },
      },
      {
        type: 'actions',
        block_id: 'model_actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel', emoji: true },
          action_id: 'model_cancel',
        }],
      },
    ];
  }),
  buildModelDeprecatedBlocks: vi.fn().mockReturnValue([]),
  buildAbortConfirmationModalView: vi.fn().mockReturnValue({}),
  buildModeSelectionBlocks: vi.fn().mockImplementation((currentMode: string) => [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Select Permission Mode*\nCurrent: \`${currentMode}\`` },
    },
    {
      type: 'actions',
      block_id: 'mode_selection',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: ':clipboard: plan' }, action_id: 'mode_plan', value: 'plan', ...(currentMode === 'plan' ? { style: 'primary' } : {}) },
        { type: 'button', text: { type: 'plain_text', text: ':question: ask' }, action_id: 'mode_default', value: 'default', ...(currentMode === 'default' ? { style: 'primary' } : {}) },
        { type: 'button', text: { type: 'plain_text', text: ':rocket: bypass' }, action_id: 'mode_bypassPermissions', value: 'bypassPermissions', ...(currentMode === 'bypassPermissions' ? { style: 'primary' } : {}) },
      ],
    },
  ]),
  buildAttachThinkingFileButton: vi.fn().mockReturnValue({ type: 'actions', elements: [] }),
  formatThreadThinkingMessage: vi.fn().mockReturnValue(':bulb: *Thinking*'),
  buildWatchingStatusSection: vi.fn().mockReturnValue({ type: 'context', elements: [] }),
  DEFAULT_CONTEXT_WINDOW: 200000,
  computeAutoCompactThreshold: vi.fn().mockReturnValue(1000),
}));

vi.mock('../../../opencode/src/streaming.js', () => ({
  createNoopStreamingSession: vi.fn().mockImplementation(() => {
    lastStreamingSession = {
      appendText: vi.fn(),
      finish: vi.fn(),
      error: vi.fn(),
      messageTs: null,
    };
    return lastStreamingSession;
  }),
  startStreamingSession: vi.fn().mockImplementation(async () => {
    lastStreamingSession = {
      appendText: vi.fn(),
      finish: vi.fn(),
      error: vi.fn(),
      messageTs: '1.0',
    };
    return lastStreamingSession;
  }),
  makeConversationKey: vi.fn().mockReturnValue('C1'),
  uploadMarkdownAndPngWithResponse: vi.fn().mockResolvedValue({ ts: '1.0' }),
  uploadFilesToThread: vi.fn().mockResolvedValue({ success: true, fileMessageTs: '2.0' }),
  extractTailWithFormatting: vi.fn((text: string, maxChars: number) => text.slice(-maxChars)),
}));

vi.mock('../../../opencode/src/errors.js', () => ({
  toUserMessage: vi.fn().mockReturnValue('Error'),
  isRecoverable: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../opencode/src/emoji-reactions.js', () => ({
  markProcessingStart: vi.fn().mockResolvedValue(undefined),
  markApprovalWait: vi.fn().mockResolvedValue(undefined),
  markApprovalDone: vi.fn().mockResolvedValue(undefined),
  markError: vi.fn().mockResolvedValue(undefined),
  markAborted: vi.fn().mockResolvedValue(undefined),
  removeProcessingEmoji: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../opencode/src/dm-notifications.js', () => ({
  sendDmNotification: vi.fn().mockResolvedValue(undefined),
  clearDmDebounce: vi.fn(),
}));

vi.mock('../../../slack/dist/file-handler.js', () => ({
  processSlackFiles: vi.fn().mockResolvedValue({ files: [], warnings: [] }),
  writeTempFile: vi.fn(),
}));

vi.mock('../../../slack/dist/file-guard.js', () => ({
  processSlackFilesWithGuard: vi.fn().mockResolvedValue({
    files: [],
    warnings: [],
    hasFailedFiles: false,
    failureWarnings: [],
    failedFiles: [],
  }),
}));

vi.mock('../../../opencode/src/content-builder.js', () => ({
  buildMessageContent: vi.fn().mockReturnValue([{ type: 'text', text: 'hello' }]),
}));

vi.mock('../../../slack/dist/retry.js', () => ({
  withSlackRetry: (fn: any) => fn(),
  sleep: (ms: number) => Promise.resolve(ms),
}));

vi.mock('../../../opencode/src/terminal-watcher.js', () => ({
  startWatching: vi.fn().mockReturnValue({ success: true }),
  isWatching: vi.fn().mockReturnValue(false),
  updateWatchRate: vi.fn().mockReturnValue(true),
  stopAllWatchers: vi.fn(),
  onSessionCleared: vi.fn(),
}));

vi.mock('../../../opencode/src/message-sync.js', () => ({
  syncMessagesFromSession: vi.fn().mockResolvedValue({ syncedCount: 0, totalToSync: 0, wasAborted: false, allSucceeded: true }),
}));

vi.mock('../../../opencode/src/model-cache.js', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([
    { value: 'anthropic:claude-4', displayName: 'Anthropic / Claude 4', description: 'Latest model' },
    { value: 'anthropic:claude-3-5-sonnet', displayName: 'Anthropic / Claude 3.5 Sonnet', description: 'Fast model' },
    { value: 'openai:gpt-4o', displayName: 'OpenAI / GPT-4o', description: 'OpenAI model' },
  ]),
  getModelInfo: vi.fn().mockImplementation((_client: any, modelValue: string) => {
    const models: Record<string, any> = {
      'anthropic:claude-4': { value: 'anthropic:claude-4', displayName: 'Anthropic / Claude 4', description: 'Latest model' },
      'anthropic:claude-3-5-sonnet': { value: 'anthropic:claude-3-5-sonnet', displayName: 'Anthropic / Claude 3.5 Sonnet', description: 'Fast model' },
      'openai:gpt-4o': { value: 'openai:gpt-4o', displayName: 'OpenAI / GPT-4o', description: 'OpenAI model' },
    };
    return Promise.resolve(models[modelValue]);
  }),
  encodeModelId: vi.fn().mockReturnValue('p:m'),
  decodeModelId: vi.fn().mockReturnValue({ providerID: 'p', modelID: 'm' }),
  isModelAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../opencode/src/activity-thread.js', () => ({
  flushActivityBatch: vi.fn().mockResolvedValue(undefined),
  postThinkingToThread: vi.fn().mockResolvedValue(undefined),
  postStartingToThread: vi.fn().mockResolvedValue(undefined),
  postErrorToThread: vi.fn().mockResolvedValue(undefined),
  postResponseToThread: vi.fn().mockResolvedValue({ ts: '2.0', permalink: 'https://example.slack.com/archives/C123/p2' }),
  updatePostedBatch: vi.fn().mockResolvedValue(undefined),
  getMessagePermalink: vi.fn().mockResolvedValue('https://example.slack.com/archives/C123/p1'),
}));
