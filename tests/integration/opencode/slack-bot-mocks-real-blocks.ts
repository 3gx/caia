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
  action(pattern: RegExp, handler: any) { registeredHandlers[`action_${pattern.source}`] = handler; }
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
  sleep: () => Promise.resolve(),
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
  getAvailableModels: vi.fn().mockResolvedValue([]),
  getModelInfo: vi.fn().mockResolvedValue(undefined),
  encodeModelId: vi.fn().mockReturnValue('p:m'),
  decodeModelId: vi.fn().mockReturnValue({ providerID: 'p', modelID: 'm' }),
  isModelAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../opencode/src/activity-thread.js', () => ({
  flushActivityBatch: vi.fn().mockResolvedValue(undefined),
  postStartingToThread: vi.fn().mockResolvedValue(undefined),
  postThinkingToThread: vi.fn().mockResolvedValue(undefined),
  postErrorToThread: vi.fn().mockResolvedValue(undefined),
  postResponseToThread: vi.fn().mockResolvedValue({ ts: '2.0', permalink: 'https://example.slack.com/archives/C123/p2' }),
  updatePostedBatch: vi.fn().mockResolvedValue(undefined),
  getMessagePermalink: vi.fn().mockResolvedValue('https://example.slack.com/archives/C123/p1'),
}));
