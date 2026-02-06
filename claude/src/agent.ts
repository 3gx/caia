import type { AgentCapabilities, IAgent } from '../../slack/dist/types.js';

const capabilities: AgentCapabilities = {
  supportsModes: true,
  modes: [
    { name: 'plan', description: 'Plan-only mode', backendSettings: { permissionMode: 'plan' } },
    { name: 'ask', description: 'Ask before tool use', backendSettings: { permissionMode: 'default' } },
    { name: 'acceptEdits', description: 'Accept edits without prompting', backendSettings: { permissionMode: 'acceptEdits' } },
    { name: 'bypass', description: 'Run tools without approval', backendSettings: { permissionMode: 'bypassPermissions' } },
  ],
  supportsTerminalWatch: true,
  supportsThinkingTokens: true,
  supportsPlanFile: true,
  supportsSandbox: false,
  supportsReasoningEffort: false,
  supportsModelSelection: true,
};

export class ClaudeAgent implements IAgent {
  readonly name = 'claude' as const;
  readonly capabilities = capabilities;

  async start(): Promise<void> {
    // Actual startup handled by claude/slack-bot.ts
  }

  async stop(): Promise<void> {
    // Actual shutdown handled by claude/slack-bot.ts
  }

  isConnected(): boolean {
    return false;
  }
}
