import type {
  AssistantMessage,
  GlobalEvent,
  Message,
  Part,
  Permission,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from '@opencode-ai/sdk';

/**
 * SDK Permission Mode type - matches OpenCode semantics.
 * - 'plan': Read-only mode, no tool execution
 * - 'default': Ask-based mode, prompts for approval on tool use
 * - 'bypassPermissions': Auto mode, runs tools without approval
 */
export type PermissionMode = 'plan' | 'default' | 'bypassPermissions';

export type AgentType = 'plan' | 'build';

export type MessagePartInput =
  | TextPartInput
  | FilePartInput
  | AgentPartInput
  | SubtaskPartInput;

export type OpencodeMessage = Message;
export type OpencodeMessagePart = Part;
export type OpencodeAssistantMessage = AssistantMessage;
export type OpencodePermission = Permission;
export type OpencodeGlobalEvent = GlobalEvent;

/**
 * Usage data from the last query (for /status and /context commands).
 */
export interface LastUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens?: number;
  cost: number;
  contextWindow: number;
  model: string;
  maxOutputTokens?: number;
}

export interface Session {
  sessionId: string | null;
  previousSessionIds?: string[];
  workingDir: string;
  mode: PermissionMode;
  model?: string;
  createdAt: number;
  lastActiveAt: number;
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy?: string | null;
  configuredAt?: number | null;
  lastUsage?: LastUsage;
  maxThinkingTokens?: number;
  updateRateSeconds?: number;
  threadCharLimit?: number;
  planFilePath?: string | null;
  syncedMessageUuids?: string[];
  slackOriginatedUserUuids?: string[];
  forkedFromChannelId?: string;
  forkedFromMessageTs?: string;
  forkedFromThreadTs?: string;
  forkedFromSdkMessageId?: string;
  forkedFromSessionId?: string;
  forkedFromConversationKey?: string;
}

export interface ThreadSession {
  sessionId: string | null;
  forkedFrom: string | null;
  resumeSessionAtMessageId?: string;
  workingDir: string;
  mode: PermissionMode;
  model?: string;
  createdAt: number;
  lastActiveAt: number;
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy?: string | null;
  configuredAt?: number | null;
  lastUsage?: LastUsage;
  maxThinkingTokens?: number;
  updateRateSeconds?: number;
  threadCharLimit?: number;
  planFilePath?: string | null;
  syncedMessageUuids?: string[];
  slackOriginatedUserUuids?: string[];
  previousSessionIds?: string[];
}

export interface ActivityEntry {
  timestamp: number;
  type:
    | 'starting'
    | 'thinking'
    | 'tool_start'
    | 'tool_complete'
    | 'error'
    | 'generating'
    | 'aborted'
    | 'mode_changed'
    | 'context_cleared'
    | 'session_changed';
  // Tool fields
  tool?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown> | string;
  toolOutput?: string;
  toolOutputPreview?: string;
  toolOutputTruncated?: boolean;
  toolIsError?: boolean;
  toolErrorMessage?: string;
  durationMs?: number;
  executionDurationMs?: number;
  toolCompleteTimestamp?: number;
  toolResultTimestamp?: number;
  // Thinking
  thinkingContent?: string;
  thinkingTruncated?: string;
  thinkingInProgress?: boolean;
  thinkingPartId?: string;
  // Generating
  generatingChunks?: number;
  generatingChars?: number;
  generatingInProgress?: boolean;
  generatingContent?: string;
  generatingTruncated?: string;
  // Text
  textContent?: string;
  charCount?: number;
  // Mode/session
  mode?: string;
  previousSessionId?: string;
  // Metrics
  lineCount?: number;
  matchCount?: number;
  linesAdded?: number;
  linesRemoved?: number;
  // Thread linking
  threadMessageTs?: string;
  threadMessageLink?: string;
  errorMessage?: string;
}

export interface SlackMessageMapping {
  sdkMessageId: string;
  sessionId: string;
  type: 'user' | 'assistant';
  parentSlackTs?: string;
  isContinuation?: boolean;
}

export interface SessionEventStreamOptions {
  /** Base delay for reconnect backoff */
  baseDelayMs?: number;
  /** Max delay for reconnect backoff */
  maxDelayMs?: number;
}
