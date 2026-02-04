import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, eventSubscribers, lastAppClient, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { markApprovalDone } from '../../../opencode/src/emoji-reactions.js';

describe('slack-bot-approvals', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers tool approval handlers', () => {
    expect(registeredHandlers['action_^tool_(approve|deny)_(.+)$']).toBeDefined();
  });

  it('posts approval blocks on permission.updated event', async () => {
    const mentionHandler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Simulate permission.updated event from SSE
    eventSubscribers[0]?.({
      payload: {
        type: 'permission.updated',
        properties: { id: 'perm1', sessionID: 'sess_mock', title: 'Write', metadata: { path: '/tmp' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lastAppClient?.chat.postMessage).toHaveBeenCalled();
  });

  it('approves permissions via action handler', async () => {
    const mentionHandler = registeredHandlers['event_app_mention'];
    const approveHandler = registeredHandlers['action_^tool_(approve|deny)_(.+)$'];
    const client = createMockWebClient();

    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'permission.updated',
        properties: { id: 'perm1', sessionID: 'sess_mock', title: 'Write', metadata: { path: '/tmp' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await approveHandler({
      action: { action_id: 'tool_approve_perm1' },
      ack: async () => undefined,
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
    });

    expect(mockWrapper.respondToPermission).toHaveBeenCalledWith('sess_mock', 'perm1', 'once');
    expect(client.chat.update).toHaveBeenCalled();
    expect(vi.mocked(markApprovalDone)).toHaveBeenCalled();
  });

  it('denies permissions via action handler', async () => {
    const mentionHandler = registeredHandlers['event_app_mention'];
    const denyHandler = registeredHandlers['action_^tool_(approve|deny)_(.+)$'];
    const client = createMockWebClient();

    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> hello', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    eventSubscribers[0]?.({
      payload: {
        type: 'permission.updated',
        properties: { id: 'perm2', sessionID: 'sess_mock', title: 'Write', metadata: { path: '/tmp' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await denyHandler({
      action: { action_id: 'tool_deny_perm2' },
      ack: async () => undefined,
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
    });

    expect(mockWrapper.respondToPermission).toHaveBeenCalledWith('sess_mock', 'perm2', 'reject');
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: 'Denied.' }));
  });
});
