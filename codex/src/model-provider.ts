import type { IModelProvider, ModelInfo } from '../../slack/dist/types.js';
import type { CodexClient } from './codex-client.js';
import {
  FALLBACK_MODELS,
  getAvailableModels as getAvailableCodexModels,
  getModelInfo as findModelInfo,
  resolveDefaultModel,
} from './model-cache.js';

export class CodexModelProvider implements IModelProvider {
  constructor(private readonly client?: CodexClient) {}

  async getAvailableModels(): Promise<ModelInfo[]> {
    if (!this.client) return FALLBACK_MODELS;
    return getAvailableCodexModels(this.client);
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
    return findModelInfo(models, modelId);
  }

  async getDefaultModel(): Promise<ModelInfo | undefined> {
    if (!this.client) return FALLBACK_MODELS[0];
    const defaultModelId = await resolveDefaultModel(this.client);
    const models = await this.getAvailableModels();
    return findModelInfo(models, defaultModelId) ?? models[0];
  }
}
