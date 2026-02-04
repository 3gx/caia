import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { createMockWebClient } from '../../__fixtures__/opencode/slack-mocks.js';
import { getSession } from '../../../opencode/src/session-manager.js';
import { uploadMarkdownAndPngWithResponse } from '../../../opencode/src/streaming.js';

const baseSession = {
  sessionId: 'sess_mock',
  workingDir: '/tmp',
  mode: 'default',
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  pathConfigured: false,
  configuredPath: null,
  previousSessionIds: [],
} as any;

describe('command-edge-cases', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('returns continue command blocks for /continue', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /continue', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    const call = client.chat.postMessage.mock.calls.at(-1)?.[0] as any;
    const blocks = call?.blocks || [];
    const blockText = blocks.map((block: any) => block.text?.text).join('\n');

    expect(blockText).toContain('opencode session resume sess_mock');
  });

  it('rejects /watch in threads', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /watch', channel: 'C1', ts: '1.0', thread_ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('only be used in the main channel'),
    }));
  });

  it('rejects /ff in threads', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /ff', channel: 'C1', ts: '1.0', thread_ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('only be used in the main channel'),
    }));
  });

  it('rejects invalid /message-size values', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /message-size nope', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Invalid number'),
    }));
  });

  it('rejects invalid /update-rate values', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /update-rate 0', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Minimum is'),
    }));
  });

  it('returns error when /show-plan has no plan path', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();

    await handler({
      event: { user: 'U1', text: '<@BOT123> /show-plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('No plan file recorded'),
    }));
  });

  it('uploads plan content for /show-plan when file exists', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValueOnce('PLAN CONTENT');

    vi.mocked(getSession).mockReturnValueOnce({
      ...baseSession,
      planFilePath: '/tmp/plan.md',
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> /show-plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(uploadMarkdownAndPngWithResponse).toHaveBeenCalledWith(
      client,
      'C1',
      'PLAN CONTENT',
      expect.stringContaining('Current Plan'),
      undefined,
      'U1',
      expect.any(Number)
    );

    readSpy.mockRestore();
  });

  it('reports missing plan file on /show-plan failure', async () => {
    const handler = registeredHandlers['event_app_mention'];
    const client = createMockWebClient();
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));

    vi.mocked(getSession).mockReturnValueOnce({
      ...baseSession,
      planFilePath: '/tmp/missing-plan.md',
    });

    await handler({
      event: { user: 'U1', text: '<@BOT123> /show-plan', channel: 'C1', ts: '1.0' },
      client,
      context: { botUserId: 'BOT123' },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Plan file not found'),
    }));

    readSpy.mockRestore();
  });
});
