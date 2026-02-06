import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, lastAppClient } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';

describe('fork-ui-update', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('updates source message with fork context + refresh button after fork', async () => {
    const handler = registeredHandlers['view_fork_to_channel_modal'];
    const ack = vi.fn();
    const client = lastAppClient!;

    client.conversations.create.mockResolvedValueOnce({ ok: true, channel: { id: 'CFORK' } });
    client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [{
        ts: '123.456',
        text: 'status',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'status' } },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              action_id: 'fork_here_C1',
              text: { type: 'plain_text', text: 'Fork here' },
              value: JSON.stringify({ threadTs: undefined, sdkMessageId: 'm1', sessionId: 's1' }),
            }],
          },
        ],
      }],
    });

    await handler({
      ack,
      view: {
        state: { values: { channel_name_block: { channel_name_input: { value: 'forked-channel' } } } },
        private_metadata: JSON.stringify({
          sourceChannelId: 'C1',
          sourceMessageTs: '123.456',
          conversationKey: 'C1',
          threadTs: '123.456',
          sdkMessageId: 'm1',
          sessionId: 's1',
        }),
      },
      client,
      body: { user: { id: 'U1' } },
    });

    const updateCall = client.chat.update.mock.calls.find((call: any[]) => call[0]?.ts === '123.456');
    expect(updateCall).toBeDefined();
    const updateBlocks = updateCall![0].blocks as any[];
    const contextBlock = updateBlocks.find(b => b.type === 'context' && b.elements?.[0]?.text?.includes('Forked to'));
    expect(contextBlock).toBeDefined();
    const actionsBlock = updateBlocks.find(b => b.type === 'actions');
    const actionIds = (actionsBlock?.elements || []).map((el: any) => el.action_id);
    expect(actionIds.some((id: string) => id?.startsWith('fork_here_'))).toBe(false);
    expect(actionIds.some((id: string) => id?.startsWith('refresh_fork_'))).toBe(true);

    const postMessageCall = client.chat.postMessage.mock.calls.find((call: any[]) => call[0]?.channel === 'CFORK');
    expect(postMessageCall?.[0]?.text).toContain('p123456');
  });

  it('restores Fork here when refresh detects missing channel', async () => {
    const handler = registeredHandlers['action_^refresh_fork_(.+)$'];
    const ack = vi.fn();
    const client = lastAppClient!;

    client.conversations.info.mockRejectedValueOnce(new Error('not_found'));
    client.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [{
        ts: '123.456',
        text: 'status',
        blocks: [
          { type: 'context', elements: [{ type: 'mrkdwn', text: ':twisted_rightwards_arrows: Forked to <#CFORK>' }] },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              action_id: 'refresh_fork_C1',
              text: { type: 'plain_text', text: 'Refresh fork' },
              value: JSON.stringify({
                forkChannelId: 'CFORK',
                sourceChannelId: 'C1',
                sourceMessageTs: '123.456',
                conversationKey: 'C1',
                sdkMessageId: 'm1',
                sessionId: 's1',
              }),
            }],
          },
        ],
      }],
    });

    await handler({
      ack,
      action: {
        action_id: 'refresh_fork_C1',
        value: JSON.stringify({
          forkChannelId: 'CFORK',
          sourceChannelId: 'C1',
          sourceMessageTs: '123.456',
          conversationKey: 'C1',
          sdkMessageId: 'm1',
          sessionId: 's1',
        }),
      },
      client,
    });

    const updateCall = client.chat.update.mock.calls.find((call: any[]) => call[0]?.ts === '123.456');
    expect(updateCall).toBeDefined();
    const updateBlocks = updateCall![0].blocks as any[];
    const contextBlock = updateBlocks.find(b => b.type === 'context' && b.elements?.[0]?.text?.includes('Forked to'));
    expect(contextBlock).toBeUndefined();
    const actionsBlock = updateBlocks.find(b => b.type === 'actions');
    const actionIds = (actionsBlock?.elements || []).map((el: any) => el.action_id);
    expect(actionIds.some((id: string) => id?.startsWith('fork_here_'))).toBe(true);
  });
});
