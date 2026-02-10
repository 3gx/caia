import './slack-bot-mocks-real-blocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { registeredHandlers, resetMockState, eventSubscribers, lastAppClient } from './slack-bot-mocks-real-blocks.js';
import { startBot, stopBot } from '../../../opencode/src/slack-bot.js';

describe('status-block-content', () => {
  beforeEach(async () => {
    resetMockState();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_SIGNING_SECRET = 'secret';
    await startBot();
  });

  afterEach(async () => {
    await stopBot();
  });

  it('renders combined status blocks with activity, spinner, status line, and abort', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const statusCall = client.chat.postMessage.mock.calls.find((call: any) => call[0]?.text === 'Processing...');
    expect(statusCall).toBeDefined();

    const blocks = statusCall[0].blocks as Array<any>;
    expect(blocks.length).toBeGreaterThanOrEqual(4);

    // Activity log block
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text?.text).toContain('Analyzing request');

    // Spinner block
    expect(blocks[1].type).toBe('context');
    expect(blocks[1].elements?.[0]?.text).toMatch(/\[\d+\.\d+s\]/);

    // Unified status line block
    expect(blocks[2].type).toBe('context');
    expect(blocks[2].elements?.[0]?.text).toContain('ask');
    expect(blocks[2].elements?.[0]?.text).toContain('sess_mock');

    // Abort button block
    expect(blocks[3].type).toBe('actions');
    expect(blocks[3].elements?.[0]?.action_id).toMatch(/^abort_query_/);
  });

  it('renders completion blocks with user mention, stats, and fork button', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-1',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
          parts: [],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            id: 't_complete_1',
            messageID: 'assistant-msg-1',
            text: 'Final response text',
          },
          sessionID: 'sess_mock',
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    const completionCall = updateCalls.find((call: any) =>
      call[0]?.text === 'Complete' || JSON.stringify(call[0]?.blocks || []).includes('Complete')
    );

    expect(completionCall).toBeDefined();

    const blocks = completionCall[0].blocks as Array<any>;
    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('<@U1>');
    expect(blocksJson).toContain('ask');
    expect(blocksJson).toContain('p:m');
    expect(blocksJson).toContain('sess_mock');

    const actionsBlock = blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements?.some((el: any) => el.action_id?.startsWith('fork_here_'))).toBe(true);
  });

  it('renders completion blocks on session.status idle (no abort)', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '3.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-2',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
          parts: [],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            id: 't_complete_2',
            messageID: 'assistant-msg-2',
            text: 'Final response text',
          },
          sessionID: 'sess_mock',
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.status', properties: { sessionID: 'sess_mock', status: { type: 'idle' } } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    const completionCall = updateCalls.find((call: any) =>
      call[0]?.text === 'Complete' || JSON.stringify(call[0]?.blocks || []).includes('Complete')
    );

    expect(completionCall).toBeDefined();
    const blocks = completionCall[0].blocks as Array<any>;
    const actionsBlock = blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements?.some((el: any) => el.action_id?.startsWith('fork_here_'))).toBe(true);
    expect(actionsBlock.elements?.some((el: any) => el.action_id?.startsWith('abort_query_'))).toBe(false);
  });

  it('renders full thinking content from message.updated parts', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '4.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Initial partial reasoning delta
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'reasoning',
            id: 'r1',
            text: 'The',
            time: { start: 0 },
          },
          sessionID: 'sess_mock',
        },
      },
    });

    // Final message.updated with full reasoning
    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-3',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            time: { completed: 1 },
          },
          parts: [{
            type: 'reasoning',
            id: 'r1',
            messageID: 'assistant-msg-3',
            text: 'The user wants me to assume xyz has value 1234.',
            time: { start: 0, end: 1 },
          }, {
            type: 'text',
            id: 't_complete_3',
            messageID: 'assistant-msg-3',
            text: 'Final response text',
          }],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    const completionCall = updateCalls.find((call: any) =>
      call[0]?.text === 'Complete' || JSON.stringify(call[0]?.blocks || []).includes('Complete')
    );

    expect(completionCall).toBeDefined();
    const blocks = completionCall[0].blocks as Array<any>;
    expect(blocks[0]?.text?.text).toContain('The user wants me to assume xyz has value 1234.');
  });

  it('status line includes reasoning indicator when reasoning tokens present', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '5.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-reasoning',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 10, output: 5, reasoning: 500, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
          parts: [{
            type: 'text',
            id: 't_reasoning',
            messageID: 'assistant-msg-reasoning',
            text: 'Response text',
          }],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    const completionCall = updateCalls.find((call: any) =>
      call[0]?.text === 'Complete' || JSON.stringify(call[0]?.blocks || []).includes('Complete')
    );
    expect(completionCall).toBeDefined();
    const blocksJson = JSON.stringify(completionCall[0].blocks);
    expect(blocksJson).toContain('[reasoning]');
  });

  it('status line includes session title', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '6.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Emit session.updated with title
    eventSubscribers[0]?.({
      payload: {
        type: 'session.updated',
        properties: {
          info: { id: 'sess_mock', title: 'My Project' },
        },
      },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-title',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
          parts: [{
            type: 'text',
            id: 't_title',
            messageID: 'assistant-msg-title',
            text: 'Response',
          }],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    const completionCall = updateCalls.find((call: any) =>
      call[0]?.text === 'Complete' || JSON.stringify(call[0]?.blocks || []).includes('Complete')
    );
    expect(completionCall).toBeDefined();
    const blocksJson = JSON.stringify(completionCall[0].blocks);
    expect(blocksJson).toContain('My Project');
  });

  it('status line shows used/total context format', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '7.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'assistant-msg-ctx',
            role: 'assistant',
            sessionID: 'sess_mock',
            modelID: 'm',
            providerID: 'p',
            tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 500, write: 100 } },
            cost: 0.02,
          },
          parts: [{
            type: 'text',
            id: 't_ctx',
            messageID: 'assistant-msg-ctx',
            text: 'Response',
          }],
        },
      },
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updateCalls = lastAppClient?.chat.update.mock.calls ?? [];
    const completionCall = updateCalls.find((call: any) =>
      call[0]?.text === 'Complete' || JSON.stringify(call[0]?.blocks || []).includes('Complete')
    );
    expect(completionCall).toBeDefined();
    const blocksJson = JSON.stringify(completionCall[0].blocks);
    // Should contain "% used" and a "/" separator (used/total format)
    expect(blocksJson).toContain('% used');
    expect(blocksJson).toContain('/');
  });
});
