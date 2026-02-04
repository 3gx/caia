import type { Session, ThreadSession, LastUsage, ActivityEntry, SlackMessageMapping } from '../../../opencode/src/session-manager.js';

export const mockChannelSession: Session = {
  sessionId: 'sess_test',
  workingDir: '/tmp',
  mode: 'default',
  createdAt: 1,
  lastActiveAt: 2,
  pathConfigured: true,
  configuredPath: '/tmp',
  configuredBy: 'U123',
  configuredAt: 3,
  previousSessionIds: [],
};

export const mockThreadSession: ThreadSession = {
  sessionId: 'thread_sess',
  forkedFrom: 'sess_test',
  workingDir: '/tmp',
  mode: 'default',
  createdAt: 1,
  lastActiveAt: 2,
  pathConfigured: true,
  configuredPath: '/tmp',
  configuredBy: 'U123',
  configuredAt: 3,
};

export const mockLastUsage: LastUsage = {
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cost: 0,
  contextWindow: 200000,
  model: 'test-model',
};

export const mockActivityEntries: ActivityEntry[] = [
  { timestamp: 1, type: 'starting' },
  { timestamp: 2, type: 'generating', generatingChars: 5 },
];

export const mockMessageMapping: SlackMessageMapping[] = [
  { sdkMessageId: 'msg_1', sessionId: 'sess_test', type: 'assistant' },
];
