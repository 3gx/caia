import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registeredHandlers, mockWrapper } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { processSlackFilesWithGuard } from '../../../slack/dist/file-guard.js';
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

    vi.mocked(processSlackFilesWithGuard).mockResolvedValueOnce({
      files: [{ name: 'readme.txt', buffer: Buffer.from('hello'), localPath: '/tmp/readme.txt' }],
      warnings: ['warn'],
      hasFailedFiles: false,
      failureWarnings: [],
      failedFiles: [],
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

    expect(processSlackFilesWithGuard).toHaveBeenCalledWith(
      [sampleFile],
      'xoxb-test',
      expect.objectContaining({ writeTempFile: expect.any(Function), inlineImages: 'always' }),
      expect.objectContaining({ allowInlineFallback: true })
    );
    expect(buildMessageContent).toHaveBeenCalledWith(
      'summarize',
      expect.arrayContaining([expect.objectContaining({ localPath: '/tmp/readme.txt' })]),
      ['warn']
    );
    expect(mockWrapper.promptAsync).toHaveBeenCalledWith(
      'sess_mock',
      [{ type: 'text', text: 'content with file' }],
      expect.objectContaining({ workingDir: '/tmp' })
    );
  });

  it('reports error and aborts when file processing fails', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    vi.mocked(processSlackFilesWithGuard).mockResolvedValueOnce({
      files: [{ name: 'readme.txt', buffer: Buffer.from(''), error: 'HTTP 403' }],
      warnings: ['File 1 (readme.txt) could not be downloaded: HTTP 403'],
      hasFailedFiles: true,
      failureWarnings: ['File 1 (readme.txt) could not be downloaded: HTTP 403'],
      failedFiles: [{ name: 'readme.txt', error: 'HTTP 403' }],
      failureMessage: 'Some attached files could not be processed and were not sent to the model.',
    } as any);

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

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '1.0',
        text: 'Some attached files could not be processed and were not sent to the model.',
      })
    );
    expect(buildMessageContent).not.toHaveBeenCalled();
    expect(mockWrapper.promptAsync).not.toHaveBeenCalled();
  });
});
