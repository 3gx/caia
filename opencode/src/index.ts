import { startBot, stopBot } from './slack-bot.js';

async function shutdown(signal: string): Promise<void> {
  console.log(`[opencode] Received ${signal}, shutting down...`);
  try {
    await stopBot();
  } catch (error) {
    console.error('[opencode] Error during shutdown:', error);
  } finally {
    process.exit(0);
  }
}

startBot().catch((error) => {
  console.error('[opencode] Failed to start bot:', error);
  process.exit(1);
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
