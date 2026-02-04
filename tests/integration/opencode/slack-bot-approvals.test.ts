import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';

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
});
