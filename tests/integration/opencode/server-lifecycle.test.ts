import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers, lastServerPool } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';
import { stopAllWatchers } from '../../../opencode/src/terminal-watcher.js';

describe('server-lifecycle', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention handler', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
  });

  it('shuts down server pool on stop', async () => {
    await teardownBot();
    expect(lastServerPool?.shutdownAll).toHaveBeenCalled();
    expect(stopAllWatchers).toHaveBeenCalled();
  });
});
