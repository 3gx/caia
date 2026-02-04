import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';

let setupBot: () => Promise<void>;
let teardownBot: () => Promise<void>;
let registeredHandlers: Record<string, any>;

describe('status-block-content', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENCODE_TEST_REAL_BLOCKS = '1';

    ({ registeredHandlers } = await import('./slack-bot-mocks.js'));
    ({ setupBot, teardownBot } = await import('./slack-bot-test-utils.js'));

    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
    delete process.env.OPENCODE_TEST_REAL_BLOCKS;
    vi.resetModules();
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
});
