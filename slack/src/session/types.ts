export type UnifiedMode = 'plan' | 'ask' | 'bypass';

export interface BaseSession {
  workingDir: string;
  createdAt: number;
  lastActiveAt: number;
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
  mode: UnifiedMode;
  updateRateSeconds?: number;
  threadCharLimit?: number;
}

export interface BaseThreadSession extends BaseSession {
  forkedFrom: string | null;
  forkPointId?: string;
}

export interface MessageMapping {
  pointId?: string;
  sdkMessageId?: string;
  sessionId: string;
  type: 'user' | 'assistant';
  parentSlackTs?: string;
  isContinuation?: boolean;
}

export interface ForkPoint {
  pointId: string;
  sessionId: string;
}

export interface SessionStore<S, T> {
  channels: {
    [channelId: string]: S & {
      threads?: {
        [threadTs: string]: T;
      };
      messageMap?: Record<string, MessageMapping>;
    };
  };
}
