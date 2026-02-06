import { describe, it, expect } from 'vitest';
import { parseCommand, extractInlineMode, extractMentionMode } from '../../../opencode/src/commands.js';
import type { Session } from '../../../opencode/src/session-manager.js';

const baseSession: Session = {
  sessionId: 'sess',
  workingDir: '/tmp',
  mode: 'default',
  createdAt: 1,
  lastActiveAt: 1,
  pathConfigured: false,
  configuredPath: null,
};

describe('commands', () => {
  it('parses /mode', () => {
    const result = parseCommand('/mode plan', baseSession);
    expect(result.handled).toBe(true);
    expect(result.sessionUpdate?.mode).toBe('plan');
  });

  it('parses /model', () => {
    const result = parseCommand('/model provider/model', baseSession);
    expect(result.handled).toBe(true);
    expect(result.showModelSelection).toBe(true);
  });

  it('extracts inline mode', () => {
    const res = extractInlineMode('/mode plan please');
    expect(res.mode).toBe('plan');
  });

  it('extracts mention mode', () => {
    const res = extractMentionMode('<@BOT> /mode ask hello', 'BOT');
    expect(res.mode).toBe('default');
  });

  describe('handleModel with query', () => {
    it('returns deferredQuery when query provided', () => {
      const result = parseCommand('/model what is the weather', baseSession);
      expect(result.showModelSelection).toBe(true);
      expect(result.deferredQuery).toBe('what is the weather');
    });

    it('returns no deferredQuery when no query', () => {
      const result = parseCommand('/model', baseSession);
      expect(result.showModelSelection).toBe(true);
      expect(result.deferredQuery).toBeUndefined();
    });

    it('trims whitespace from query', () => {
      const result = parseCommand('/model   hello world  ', baseSession);
      expect(result.deferredQuery).toBe('hello world');
    });

    it('treats whitespace-only as no query', () => {
      const result = parseCommand('/model    ', baseSession);
      expect(result.deferredQuery).toBeUndefined();
    });
  });
});
