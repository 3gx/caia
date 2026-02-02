import type { AgentCapabilities, IAgent } from '../../slack/src/types.js';

const capabilities: AgentCapabilities = {
  supportsModes: true,
  modes: [
    { name: 'ask', description: 'Ask before tool use', backendSettings: { mode: 'ask' } },
    { name: 'bypass', description: 'Run tools without approval', backendSettings: { mode: 'bypass' } },
  ],
  supportsTerminalWatch: false,
  supportsThinkingTokens: false,
  supportsPlanFile: false,
  supportsSandbox: false,
  supportsReasoningEffort: true,
  supportsModelSelection: true,
};

export class CodexAgent implements IAgent {
  readonly name = 'codex' as const;
  readonly capabilities = capabilities;

  async start(): Promise<void> {
    // Actual startup handled by codex/slack-bot.ts
  }

  async stop(): Promise<void> {
    // Actual shutdown handled by codex/slack-bot.ts
  }

  isConnected(): boolean {
    return false;
  }
}
