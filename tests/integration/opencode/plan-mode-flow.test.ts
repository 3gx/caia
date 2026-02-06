import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { saveSession, getSession, saveThreadSession } from '../../../opencode/src/session-manager.js';

describe('plan-mode-flow', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers mode selection handler', () => {
    expect(registeredHandlers['action_^mode_(plan|default|bypassPermissions)$']).toBeDefined();
  });

  it('updates mode via /mode plan command', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /mode plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { mode: 'plan' });
    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it('shows mode selection UI via /mode command (no argument)', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    // Mock session with current mode
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_test',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /mode', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Select mode',
      blocks: expect.arrayContaining([
        expect.objectContaining({
          type: 'section',
          text: expect.objectContaining({ text: expect.stringContaining('Current: `default`') }),
        }),
      ]),
    }));
  });

  it('shows current mode in selection UI', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    // Mock session with plan mode
    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_test',
      workingDir: '/tmp',
      mode: 'plan',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    await handler({
      event: { user: 'U1', text: '<@BOT123> /mode', channel: 'C1', ts: '2.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const call = (client.chat.postMessage as any).mock.calls[0][0];
    expect(call.blocks[0].text.text).toContain('Current: `plan`');
  });

  it('saves mode to channel session when button clicked', async () => {
    const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions)$'];
    const client = createMockWebClient();
    const ack = vi.fn();

    await handler({
      action: { action_id: 'mode_plan' },
      body: { channel: { id: 'C1' }, message: { ts: '1.0' } },
      client,
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(vi.mocked(saveSession)).toHaveBeenCalledWith('C1', { mode: 'plan' });
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Mode set to `plan`',
    }));
  });

  it('saves mode to thread session when sessionThreadTs is set', async () => {
    // First, trigger /mode in a thread to set up pendingModeSelections
    const mentionHandler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(getSession).mockReturnValue({
      sessionId: 'sess_test',
      workingDir: '/tmp',
      mode: 'default',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: false,
      configuredPath: null,
    } as any);

    // Send /mode command in a thread (thread_ts is set)
    await mentionHandler({
      event: { user: 'U1', text: '<@BOT123> /mode', channel: 'C1', ts: '1.5', thread_ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    // Get the ts of the mode selection message that was posted
    const postCall = (client.chat.postMessage as any).mock.calls[0][0];
    expect(postCall.text).toBe('Select mode');

    // Now simulate button click - the handler should use sessionThreadTs from pending
    const actionHandler = registeredHandlers['action_^mode_(plan|default|bypassPermissions)$'];
    const ack = vi.fn();

    // Note: The pendingModeSelections map was populated when /mode was sent
    // We simulate clicking on a message that was posted in the thread
    await actionHandler({
      action: { action_id: 'mode_bypassPermissions' },
      body: { channel: { id: 'C1' }, message: { ts: postCall.thread_ts || '1.0', thread_ts: '1.0' } },
      client,
      ack,
    });

    expect(ack).toHaveBeenCalled();
    // Should save to thread session, not channel session
    expect(vi.mocked(saveThreadSession)).toHaveBeenCalled();
  });

  it('updates message to show selected mode', async () => {
    const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions)$'];
    const client = createMockWebClient();
    const ack = vi.fn();

    await handler({
      action: { action_id: 'mode_default' },
      body: { channel: { id: 'C1' }, message: { ts: '2.0' } },
      client,
      ack,
    });

    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C1',
      ts: '2.0',
      text: 'Mode set to `default`',
    }));
  });

  it('handles all three mode buttons', async () => {
    const handler = registeredHandlers['action_^mode_(plan|default|bypassPermissions)$'];
    const client = createMockWebClient();
    const ack = vi.fn();

    // Test plan mode
    await handler({
      action: { action_id: 'mode_plan' },
      body: { channel: { id: 'C1' }, message: { ts: '3.0' } },
      client,
      ack,
    });
    expect(vi.mocked(saveSession)).toHaveBeenLastCalledWith('C1', { mode: 'plan' });

    // Test default mode
    await handler({
      action: { action_id: 'mode_default' },
      body: { channel: { id: 'C2' }, message: { ts: '4.0' } },
      client,
      ack,
    });
    expect(vi.mocked(saveSession)).toHaveBeenLastCalledWith('C2', { mode: 'default' });

    // Test bypassPermissions mode
    await handler({
      action: { action_id: 'mode_bypassPermissions' },
      body: { channel: { id: 'C3' }, message: { ts: '5.0' } },
      client,
      ack,
    });
    expect(vi.mocked(saveSession)).toHaveBeenLastCalledWith('C3', { mode: 'bypassPermissions' });
  });
});
