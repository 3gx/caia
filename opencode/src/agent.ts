import type { AgentCapabilities, IAgent } from '../../slack/src/types.js';

const capabilities: AgentCapabilities = {
  supportsModes: true,
  modes: [],
  supportsTerminalWatch: false,
  supportsThinkingTokens: false,
  supportsPlanFile: false,
  supportsSandbox: false,
  supportsReasoningEffort: false,
  supportsModelSelection: true,
};

export class OpenCodeAgent implements IAgent {
  readonly name = 'opencode' as const;
  readonly capabilities = capabilities;

  async start(): Promise<void> {
    // Stub
  }

  async stop(): Promise<void> {
    // Stub
  }

  isConnected(): boolean {
    return false;
  }
}
