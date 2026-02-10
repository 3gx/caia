import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession } from '../../../opencode/src/session-manager.js';
import { mockWrapper } from './slack-bot-mocks.js';

describe('slack-bot-mention', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('applies inline mode from mention', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /mode plan make a plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { mode: 'plan' });
  });

  it('dedupes app_mention events with the same message ts', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '9.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '9.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('ignores edited app_mention events', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: {
        user: 'U1',
        text: '<@BOT123> hello',
        channel: 'C1',
        ts: '10.0',
        edited: { user: 'U1', ts: '10.1' },
      },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(mockWrapper.promptAsync).not.toHaveBeenCalled();
  });

  describe('/mode command immediate-following constraint', () => {
    it('does NOT extract mode when text exists between mention and command', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const client = createMockWebClient();

      // This should NOT set mode to 'plan' because there's text between <@BOT123> and /mode
      await handler({
        event: {
          user: 'U1',
          text: 'blah blah <@BOT123> glah /mode plan test',
          channel: 'C2',
          ts: '11.0',
        },
        client,
        context: { botUserId: 'BOT123' },
      });

      // saveSession should NOT be called with mode: 'plan'
      const modeCalls = vi.mocked(saveSession).mock.calls.filter(
        (call: any) => call[1]?.mode === 'plan'
      );
      expect(modeCalls).toHaveLength(0);

      // Should still process the message (promptAsync called)
      expect(mockWrapper.promptAsync).toHaveBeenCalled();
    });

    it('does NOT extract mode when message comes before command', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const client = createMockWebClient();

      await handler({
        event: {
          user: 'U1',
          text: '<@BOT123> message /mode plan test',
          channel: 'C3',
          ts: '12.0',
        },
        client,
        context: { botUserId: 'BOT123' },
      });

      // Mode should remain default
      const modeCalls = vi.mocked(saveSession).mock.calls.filter(
        (call: any) => call[1]?.mode === 'plan'
      );
      expect(modeCalls).toHaveLength(0);
    });

    it('extracts mode with extra whitespace between mention and command', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const client = createMockWebClient();

      await handler({
        event: {
          user: 'U1',
          text: '<@BOT123>    /mode   bypass   deploy now',
          channel: 'C4',
          ts: '13.0',
        },
        client,
        context: { botUserId: 'BOT123' },
      });

      expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C4', { mode: 'bypassPermissions' });
    });
  });

  describe('/model command immediate-following constraint', () => {
    it('shows model selection when immediately after mention', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const client = createMockWebClient();

      await handler({
        event: {
          user: 'U1',
          text: '<@BOT123> /model explain this code',
          channel: 'C5',
          ts: '14.0',
        },
        client,
        context: { botUserId: 'BOT123' },
      });

      // Should have posted model selection UI
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Select model',
        })
      );
    });

    it('does NOT show model selection when text between mention and command', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const client = createMockWebClient();

      await handler({
        event: {
          user: 'U1',
          text: 'hello <@BOT123> world /model query',
          channel: 'C6',
          ts: '15.0',
        },
        client,
        context: { botUserId: 'BOT123' },
      });

      // Should NOT have posted model selection UI
      const modelSelectionCalls = (client.chat.postMessage as any).mock.calls.filter(
        (call: any) => call[0]?.text === 'Select model'
      );
      expect(modelSelectionCalls).toHaveLength(0);

      // Should process as regular message instead
      expect(mockWrapper.promptAsync).toHaveBeenCalled();
    });

    it('shows model selection even with empty query', async () => {
      const handler = registeredHandlers['event_app_mention'];
      const client = createMockWebClient();

      await handler({
        event: {
          user: 'U1',
          text: '<@BOT123> /model',
          channel: 'C7',
          ts: '16.0',
        },
        client,
        context: { botUserId: 'BOT123' },
      });

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Select model',
        })
      );
    });
  });
});
