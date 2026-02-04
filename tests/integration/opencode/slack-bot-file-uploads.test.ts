import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { processSlackFiles } from '../../../slack/src/file-handler.js';
import { buildMessageContent } from '../../../opencode/src/content-builder.js';

const sampleFile = {
  id: 'F1',
  name: 'readme.txt',
  mimetype: 'text/plain',
  size: 12,
  created: 123,
} as any;

describe('slack-bot-file-uploads', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('processes Slack files and passes them into content builder', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(processSlackFiles).mockResolvedValueOnce({
      files: [{ name: 'readme.txt', buffer: Buffer.from('hello') }],
      warnings: ['warn'],
    } as any);

    vi.mocked(buildMessageContent).mockReturnValueOnce([
      { type: 'text', text: 'content with file' },
    ] as any);

    await handler({
      event: {
        user: 'U1',
        text: '<@BOT123> summarize',
        channel: 'C1',
        ts: '1.0',
        files: [sampleFile],
      },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(processSlackFiles).toHaveBeenCalledWith([sampleFile], 'xoxb-test');
    expect(buildMessageContent).toHaveBeenCalledWith('summarize', expect.any(Array), ['warn']);
    expect(mockWrapper.promptAsync).toHaveBeenCalledWith(
      'sess_mock',
      [{ type: 'text', text: 'content with file' }],
      expect.objectContaining({ workingDir: '/tmp' })
    );
  });
});
