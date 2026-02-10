export interface AgentCapabilities {
  supportsModes: boolean;
  modes: ModeDefinition[];
  supportsTerminalWatch: boolean;
  supportsThinkingTokens: boolean;
  supportsPlanFile: boolean;
  supportsSandbox: boolean;
  supportsReasoningEffort: boolean;
  supportsModelSelection: boolean;
}

export interface ModeDefinition {
  name: string;
  description: string;
  backendSettings: Record<string, unknown>;
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface IAgent {
  readonly name: 'claude' | 'codex' | 'opencode';
  readonly capabilities: AgentCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
}

export interface IModelProvider {
  getAvailableModels(): Promise<ModelInfo[]>;
  refreshModels(): Promise<ModelInfo[]>;
  isModelAvailable(modelId: string): Promise<boolean>;
  getModelInfo(modelId: string): Promise<ModelInfo | undefined>;
  getDefaultModel(): Promise<ModelInfo | undefined>;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  contextWindow?: number;     // From SDK config.providers() → model.limit.context
}
