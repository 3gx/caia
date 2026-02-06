import type { IModelProvider, ModelInfo } from '../../slack/dist/types.js';
import type { CodexClient } from './codex-client.js';
import { FALLBACK_MODELS } from './commands.js';

function normalizeModels(models: string[]): ModelInfo[] {
  return models.map((value) => ({
    value,
    displayName: value,
    description: 'Available model',
  }));
}

export class CodexModelProvider implements IModelProvider {
  constructor(private readonly client?: CodexClient) {}

  async getAvailableModels(): Promise<ModelInfo[]> {
    if (!this.client) return FALLBACK_MODELS;
    const models = await this.client.listModels();
    if (!models.length) return FALLBACK_MODELS;
    return normalizeModels(models);
  }

  async refreshModels(): Promise<ModelInfo[]> {
    return this.getAvailableModels();
  }

  async isModelAvailable(modelId: string): Promise<boolean> {
    const models = await this.getAvailableModels();
    return models.some((model) => model.value === modelId);
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    const models = await this.getAvailableModels();
    return models.find((model) => model.value === modelId);
  }

  async getDefaultModel(): Promise<ModelInfo | undefined> {
    const models = await this.getAvailableModels();
    return models[0];
  }
}
