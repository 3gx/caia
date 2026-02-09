import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, eventSubscribers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { postResponseToThread, postThinkingToThread } from '../../../opencode/src/activity-thread.js';

describe('pending-parts-flush', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  async function triggerMention() {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    await handler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });
  }

  it('flushes buffered text parts on session.idle when message.updated has not arrived', async () => {
    await triggerMention();

    // Emit text part WITH messageID → gets buffered in pendingMessageParts
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', text: 'Final answer', messageID: 'msg_2' },
          sessionID: 'sess_mock',
        },
      },
    });

    // session.idle fires BEFORE message.updated → triggers handleSessionIdle
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postResponseToThread).toHaveBeenCalledTimes(1);
    expect((postResponseToThread as any).mock.calls[0][3]).toBe('Final answer');
  });

  it('posts response after tool calls when final text has messageID and session.idle fires first', async () => {
    await triggerMention();

    // 1. Tool call part (sets messageID msg_1 → role=assistant via non-text heuristic)
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', id: 'tool1', tool: 'Read', state: { status: 'complete', input: {}, output: '...' }, messageID: 'msg_1' },
          sessionID: 'sess_mock',
        },
      },
    });

    // 2. Final text response in a NEW message (msg_2) → buffered
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't2', text: 'Project description here', messageID: 'msg_2' },
          sessionID: 'sess_mock',
        },
      },
    });

    // 3. session.idle before message.updated for msg_2
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postResponseToThread).toHaveBeenCalled();
    expect((postResponseToThread as any).mock.calls[0][3]).toBe('Project description here');
  });

  it('falls back to authoritative session API when no text parts received at all', async () => {
    await triggerMention();

    // Configure mock to return authoritative response
    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 } },
          parts: [{ type: 'text', id: 't1', text: 'Authoritative answer' }],
        },
      ],
    });

    // Only session.idle, no text parts at all
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockMessages).toHaveBeenCalled();
    expect(postResponseToThread).toHaveBeenCalled();
    expect((postResponseToThread as any).mock.calls[0][3]).toBe('Authoritative answer');
  });

  it('message.updated before session.idle still works (happy path regression)', async () => {
    await triggerMention();

    // Text part with messageID → buffered
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', text: 'Normal response', messageID: 'msg_1' },
          sessionID: 'sess_mock',
        },
      },
    });

    // message.updated arrives → flushes pending parts
    eventSubscribers[0]?.({
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, modelID: 'm', providerID: 'p' },
          parts: [],
        },
      },
    });

    // session.idle → finalizes
    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postResponseToThread).toHaveBeenCalledTimes(1);
    expect((postResponseToThread as any).mock.calls[0][3]).toBe('Normal response');
  });

  it('prefers authoritative final response on idle even when partial stream text exists', async () => {
    await triggerMention();

    // Streamed partial text arrives first.
    eventSubscribers[0]?.({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 't1', text: 'Partial streamed response' },
          sessionID: 'sess_mock',
        },
      },
    });

    // Authoritative session API contains the final full response.
    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 } },
          parts: [{ type: 'text', id: 't2', text: 'Authoritative final response' }],
        },
      ],
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postResponseToThread).toHaveBeenCalled();
    const lastResponseCall = (postResponseToThread as any).mock.calls[(postResponseToThread as any).mock.calls.length - 1];
    expect(lastResponseCall[3]).toBe('Authoritative final response');
  });

  it('recovers missing thinking activity from authoritative reasoning parts on idle', async () => {
    await triggerMention();

    const mockMessages = mockWrapper.getClient().session.messages;
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: 'msg_1', role: 'assistant', time: { completed: 1 } },
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Recovered thinking content', time: { start: 1000, end: 2500 } },
            { type: 'text', id: 't1', text: 'Recovered response content' },
          ],
        },
      ],
    });

    eventSubscribers[0]?.({
      payload: { type: 'session.idle', properties: { sessionID: 'sess_mock' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postThinkingToThread).toHaveBeenCalled();
    const lastThinkingCall = (postThinkingToThread as any).mock.calls[(postThinkingToThread as any).mock.calls.length - 1];
    expect(lastThinkingCall[3].thinkingContent).toBe('Recovered thinking content');
    expect(postResponseToThread).toHaveBeenCalled();
    const lastResponseCall = (postResponseToThread as any).mock.calls[(postResponseToThread as any).mock.calls.length - 1];
    expect(lastResponseCall[3]).toBe('Recovered response content');
  });
});
