import { vi } from 'vitest';
import type { GlobalEvent } from '@opencode-ai/sdk';
import type { Session, ThreadSession, ActivityEntry, SlackMessageMapping } from '../../../opencode/src/session-manager.js';

export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess_test',
    workingDir: '/tmp',
    mode: 'default',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: false,
    configuredPath: null,
    ...overrides,
  };
}

export function createMockThreadSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    sessionId: 'thread_sess',
    forkedFrom: 'sess_test',
    workingDir: '/tmp',
    mode: 'default',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pathConfigured: false,
    configuredPath: null,
    ...overrides,
  };
}

export function createMockMessage(overrides: Record<string, any> = {}) {
  return {
    info: {
      id: 'msg_1',
      role: 'assistant',
      sessionID: 'sess_test',
      time: { created: Date.now() },
      ...overrides.info,
    },
    parts: [{ type: 'text', text: 'hello' }],
    ...overrides,
  };
}

export function createMockEvent(type: string, payload: Record<string, any> = {}): GlobalEvent {
  return {
    type,
    payload: { type, ...payload },
  } as GlobalEvent;
}

export async function* mockEventStream(events: GlobalEvent[] = [createMockEvent('session.idle')]) {
  for (const event of events) {
    yield event;
  }
}

export function createMockActivityEntries(): ActivityEntry[] {
  return [
    { timestamp: Date.now(), type: 'starting' },
    { timestamp: Date.now(), type: 'generating', generatingChars: 5 },
  ];
}

export function createMockMessageMapping(): SlackMessageMapping {
  return {
    sdkMessageId: 'msg_1',
    sessionId: 'sess_test',
    type: 'assistant',
  };
}

export function createMockServerInstance() {
  return {
    client: {
      session: { list: vi.fn().mockResolvedValue({ data: [] }) },
      global: { event: vi.fn() },
    },
    server: { url: 'http://localhost:60000', close: vi.fn() },
    port: 60000,
    trackedPids: [],
  };
}
