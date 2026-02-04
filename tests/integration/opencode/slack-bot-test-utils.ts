import { startBot, stopBot } from '../../../opencode/src/slack-bot.js';
import { resetMockState } from './slack-bot-mocks.js';

export async function setupBot(): Promise<void> {
  resetMockState();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_APP_TOKEN = 'xapp-test';
  process.env.SLACK_SIGNING_SECRET = 'secret';
  await startBot();
}

export async function teardownBot(): Promise<void> {
  await stopBot();
}
