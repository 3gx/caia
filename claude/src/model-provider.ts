import type { IModelProvider, ModelInfo } from '../../slack/src/types.js';
import {
  getAvailableModels,
  refreshModelCache,
  isModelAvailable,
  getModelInfo,
  getDefaultModel,
} from './model-cache.js';

export class ClaudeModelProvider implements IModelProvider {
  async getAvailableModels(): Promise<ModelInfo[]> {
    return getAvailableModels();
  }

  async refreshModels(): Promise<ModelInfo[]> {
    return refreshModelCache();
  }

  async isModelAvailable(modelId: string): Promise<boolean> {
    return isModelAvailable(modelId);
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return getModelInfo(modelId);
  }

  async getDefaultModel(): Promise<ModelInfo | undefined> {
    return getDefaultModel();
  }
}
