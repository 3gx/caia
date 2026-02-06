import type { AgentCapabilities, IAgent } from '../../slack/dist/types.js';
import { startBot, stopBot } from './slack-bot.js';

const capabilities: AgentCapabilities = {
  supportsModes: true,
  modes: [
    { name: 'plan', description: 'Plan-only mode', backendSettings: { permissionMode: 'plan' } },
    { name: 'ask', description: 'Ask before tool use', backendSettings: { permissionMode: 'default' } },
    { name: 'bypass', description: 'Run tools without approval', backendSettings: { permissionMode: 'bypassPermissions' } },
  ],
  supportsTerminalWatch: true,
  supportsThinkingTokens: true,
  supportsPlanFile: true,
  supportsSandbox: false,
  supportsReasoningEffort: false,
  supportsModelSelection: true,
};

export class OpenCodeAgent implements IAgent {
  readonly name = 'opencode' as const;
  readonly capabilities = capabilities;

  async start(): Promise<void> {
    await startBot();
  }

  async stop(): Promise<void> {
    await stopBot();
  }

  isConnected(): boolean {
    return false;
  }
}
