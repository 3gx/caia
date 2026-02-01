import type { AgentCapabilities, IAgent } from '../../slack/src/types.js';

const capabilities: AgentCapabilities = {
  supportsModes: true,
  modes: [
    { name: 'ask', description: 'Ask before tool use', backendSettings: { approvalPolicy: 'on-request' } },
    { name: 'auto', description: 'Auto-run tools in sandbox', backendSettings: { approvalPolicy: 'never', sandbox: 'workspace-write' } },
    { name: 'bypass', description: 'Run tools without approval', backendSettings: { approvalPolicy: 'never', sandbox: 'danger-full-access' } },
  ],
  supportsTerminalWatch: false,
  supportsThinkingTokens: false,
  supportsPlanFile: false,
  supportsSandbox: true,
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
