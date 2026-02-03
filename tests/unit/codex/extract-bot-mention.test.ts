import { describe, it, expect } from 'vitest';

// Helper function that mirrors the extraction logic in codex/src/slack-bot.ts
function extractBotMention(text: string, _botUserId: string): string {
  // Strip all mentions (matching claude behavior), not just this bot's
  return text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
}

describe('extractBotMention', () => {
  const botUserId = 'U123CODEX';

  describe('basic mention stripping', () => {
    it('strips the bot mention from start of message', () => {
      const result = extractBotMention('<@U123CODEX> hello', botUserId);
      expect(result).toBe('hello');
    });

    it('strips bot mention with extra whitespace', () => {
      const result = extractBotMention('<@U123CODEX>    hello world', botUserId);
      expect(result).toBe('hello world');
    });

    it('returns trimmed text when no mention', () => {
      const result = extractBotMention('  hello world  ', botUserId);
      expect(result).toBe('hello world');
    });

    it('returns empty string for mention-only message', () => {
      const result = extractBotMention('<@U123CODEX>', botUserId);
      expect(result).toBe('');
    });
  });

  describe('strips ALL mentions (claude parity)', () => {
    it('strips other bot mentions', () => {
      const result = extractBotMention('<@U123CODEX> <@U456OTHER> hello', botUserId);
      expect(result).toBe('hello');
    });

    it('strips user mentions', () => {
      const result = extractBotMention('<@U123CODEX> hey <@U789USER> check this', botUserId);
      expect(result).toBe('hey check this');
    });

    it('strips multiple bot mentions at start', () => {
      const result = extractBotMention('<@UBOT1> <@UBOT2> <@UBOT3> test message', botUserId);
      expect(result).toBe('test message');
    });

    it('strips mentions throughout the message', () => {
      const result = extractBotMention('<@U123CODEX> hello <@UOTHER> world <@UANOTHER> end', botUserId);
      expect(result).toBe('hello world end');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = extractBotMention('', botUserId);
      expect(result).toBe('');
    });

    it('handles whitespace only', () => {
      const result = extractBotMention('   ', botUserId);
      expect(result).toBe('');
    });

    it('handles multiple mentions with no text', () => {
      const result = extractBotMention('<@U123CODEX> <@UOTHER>', botUserId);
      expect(result).toBe('');
    });

    it('preserves text with angle brackets that are not mentions', () => {
      const result = extractBotMention('<@U123CODEX> use <tag> syntax', botUserId);
      expect(result).toBe('use <tag> syntax');
    });

    it('handles mention in middle of message', () => {
      const result = extractBotMention('hello <@U123CODEX> world', botUserId);
      expect(result).toBe('hello world');
    });
  });
});
