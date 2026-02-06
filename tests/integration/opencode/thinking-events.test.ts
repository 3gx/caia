import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, lastAppClient } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { uploadFilesToThread } from '../../../opencode/src/streaming.js';

describe('thinking-events', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('posts thinking placeholder on reasoning start', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            text: 'short',
            time: { start: 0 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const calls = lastAppClient?.chat.postMessage.mock.calls || [];
    const hasPlaceholder = calls.some((call) => call[0]?.text?.includes('Thinking...'));
    expect(hasPlaceholder).toBe(true);
  });

  it('updates thinking message on completion for short content', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            text: 'short',
            time: { start: 0, end: 1 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lastAppClient?.chat.update).toHaveBeenCalled();
  });

  it('uploads thinking attachment for long content', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const longText = 'x'.repeat(4000);
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            text: longText,
            time: { start: 0, end: 1 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(uploadFilesToThread).toHaveBeenCalled();
  });

  it('does not post duplicate thinking placeholders for repeated end events', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const payload = {
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            text: 'done',
            time: { start: 0, end: 1 },
          },
          sessionID: 'sess_mock',
        },
      },
    };

    eventSubscribers[0]?.(payload);
    eventSubscribers[0]?.(payload);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const calls = lastAppClient?.chat.postMessage.mock.calls || [];
    const thinkingPlaceholders = calls.filter((call) => call[0]?.text?.includes('Thinking...'));
    expect(thinkingPlaceholders).toHaveLength(1);
  });

  it('does not duplicate thinking on message.updated parts when part events already streamed', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            messageID: 'assistant_msg_1',
            sessionID: 'sess_mock',
            text: 'short',
            time: { start: 0, end: 1 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant_msg_1',
            sessionID: 'sess_mock',
            role: 'assistant',
            time: { created: 0, completed: 1 },
            parentID: 'user_msg_1',
            modelID: 'm',
            providerID: 'p',
            mode: 'build',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [{
            type: 'reasoning',
            id: 'r1',
            messageID: 'assistant_msg_1',
            sessionID: 'sess_mock',
            text: 'short',
            time: { start: 0, end: 1 },
          }],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const calls = lastAppClient?.chat.postMessage.mock.calls || [];
    const thinkingPlaceholders = calls.filter((call) => call[0]?.text?.includes('Thinking...'));
    expect(thinkingPlaceholders).toHaveLength(1);
  });
});
