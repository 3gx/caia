import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';

describe('slack-bot-commands', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers app_mention and message handlers', () => {
    expect(registeredHandlers['event_app_mention']).toBeDefined();
    expect(registeredHandlers['event_message']).toBeDefined();
  });
});
