import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';

describe('fork-to-channel', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers fork-to-channel view handler', () => {
    expect(registeredHandlers['view_fork_to_channel_modal']).toBeDefined();
  });

  it('returns validation error when channel name missing', async () => {
    const handler = registeredHandlers['view_fork_to_channel_modal'];
    const ack = vi.fn();

    await handler({
      ack,
      view: { state: { values: {} }, private_metadata: '{}' },
      client: {} as any,
      body: { user: { id: 'U1' } },
    });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { channel_name_block: 'Channel name required' },
    });
  });
});
