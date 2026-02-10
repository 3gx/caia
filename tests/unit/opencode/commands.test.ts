import { describe, it, expect } from 'vitest';
import { parseCommand, extractInlineMode, extractMentionMode, extractMentionModel } from '../../../opencode/src/commands.js';
import type { Session } from '../../../opencode/src/session-manager.js';

const baseSession: Session = {
  sessionId: 'sess',
  workingDir: '/tmp',
  mode: 'default',
  createdAt: 1,
  lastActiveAt: 1,
  pathConfigured: false,
  configuredPath: null,
  configuredBy: null,
  configuredAt: null,
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
      expect(result.showModelSelection).toBe(true);
      expect(result.deferredQuery).toBeUndefined();
    });
  });

  describe('extractMentionMode', () => {
    const BOT_ID = 'U123456';

    describe('valid patterns (immediate following)', () => {
      it('extracts mode when immediately after mention', () => {
        const res = extractMentionMode('<@U123456> /mode plan refactor code', BOT_ID);
        expect(res.mode).toBe('plan');
        expect(res.remainingText).toBe('refactor code');
      });

      it('extracts mode with whitespace between mention and command', () => {
        const res = extractMentionMode('<@U123456>    /mode   plan   fix bugs', BOT_ID);
        expect(res.mode).toBe('plan');
        expect(res.remainingText).toBe('fix bugs');
      });

      it('extracts ask mode', () => {
        const res = extractMentionMode('<@U123456> /mode ask review this', BOT_ID);
        expect(res.mode).toBe('default');
        expect(res.remainingText).toBe('review this');
      });

      it('extracts bypass mode', () => {
        const res = extractMentionMode('<@U123456> /mode bypass deploy now', BOT_ID);
        expect(res.mode).toBe('bypassPermissions');
        expect(res.remainingText).toBe('deploy now');
      });

      it('handles empty message after mode command', () => {
        const res = extractMentionMode('<@U123456> /mode plan', BOT_ID);
        expect(res.mode).toBe('plan');
        expect(res.remainingText).toBe('');
      });
    });

    describe('invalid patterns (not immediate following)', () => {
      it('does not extract mode when text between mention and command', () => {
        const res = extractMentionMode('blah <@U123456> glah /mode plan test', BOT_ID);
        expect(res.mode).toBeUndefined();
        expect(res.remainingText).toBe('blah glah /mode plan test');
      });

      it('does not extract mode when mention in middle of text', () => {
        const res = extractMentionMode('hello <@U123456> please /mode bypass do it', BOT_ID);
        expect(res.mode).toBeUndefined();
        expect(res.remainingText).toBe('hello please /mode bypass do it');
      });

      it('bot receives text with /mode as regular message', () => {
        const res = extractMentionMode('<@U123456> message /mode plan test', BOT_ID);
        expect(res.mode).toBeUndefined();
        expect(res.remainingText).toBe('message /mode plan test');
      });
    });

    describe('error handling', () => {
      it('returns error for unknown mode', () => {
        const res = extractMentionMode('<@U123456> /mode invalidmode text', BOT_ID);
        expect(res.mode).toBeUndefined();
        expect(res.error).toBe('Unknown mode `invalidmode`. Valid modes: plan, ask, bypass');
        expect(res.remainingText).toBe('text');
      });

      it('returns error for missing mode argument', () => {
        const res = extractMentionMode('<@U123456> /mode', BOT_ID);
        expect(res.mode).toBeUndefined();
        expect(res.error).toBeUndefined();
      });
    });
  });

  describe('extractMentionModel', () => {
    const BOT_ID = 'U123456';

    describe('valid patterns (immediate following)', () => {
      it('detects model command when immediately after mention', () => {
        const res = extractMentionModel('<@U123456> /model explain this', BOT_ID);
        expect(res.hasModelCommand).toBe(true);
        expect(res.deferredQuery).toBe('explain this');
        expect(res.remainingText).toBe('explain this');
      });

      it('detects model command with whitespace', () => {
        const res = extractMentionModel('<@U123456>   /model   check file', BOT_ID);
        expect(res.hasModelCommand).toBe(true);
        expect(res.deferredQuery).toBe('check file');
      });

      it('handles empty query after model command', () => {
        const res = extractMentionModel('<@U123456> /model', BOT_ID);
        expect(res.hasModelCommand).toBe(true);
        expect(res.deferredQuery).toBeUndefined();
      });

      it('handles query with special characters', () => {
        const res = extractMentionModel('<@U123456> /model check /path/to/file.txt', BOT_ID);
        expect(res.hasModelCommand).toBe(true);
        expect(res.deferredQuery).toBe('check /path/to/file.txt');
      });
    });

    describe('invalid patterns (not immediate following)', () => {
      it('does not detect model command when text between mention and command', () => {
        const res = extractMentionModel('hello <@U123456> world /model query', BOT_ID);
        expect(res.hasModelCommand).toBe(false);
        expect(res.deferredQuery).toBeUndefined();
        expect(res.remainingText).toBe('hello world /model query');
      });

      it('does not detect model command when message before command', () => {
        const res = extractMentionModel('<@U123456> please /model help me', BOT_ID);
        expect(res.hasModelCommand).toBe(false);
        expect(res.deferredQuery).toBeUndefined();
        expect(res.remainingText).toBe('please /model help me');
      });
    });
  });
});
