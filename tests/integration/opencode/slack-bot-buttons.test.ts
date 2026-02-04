import './slack-bot-mocks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registeredHandlers } from './slack-bot-mocks.js';
import { setupBot, teardownBot } from './slack-bot-test-utils.js';

describe('slack-bot-buttons', () => {
  beforeEach(async () => {
    await setupBot();
  });

  afterEach(async () => {
    await teardownBot();
  });

  it('registers button handlers', () => {
    expect(registeredHandlers['action_^mode_(plan|default|bypassPermissions)$']).toBeDefined();
    expect(registeredHandlers['action_^model_select_(.+)$']).toBeDefined();
    expect(registeredHandlers['action_^abort_query_(.+)$']).toBeDefined();
  });
});
