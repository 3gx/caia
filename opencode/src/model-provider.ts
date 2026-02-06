import type { IModelProvider, ModelInfo } from '../../slack/dist/types.js';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
  getAvailableModels,
  refreshModelCache,
  isModelAvailable,
  getModelInfo,
  getDefaultModel,
} from './model-cache.js';

export class OpencodeModelProvider implements IModelProvider {
  private clientProvider: () => OpencodeClient;

  constructor(clientProvider: () => OpencodeClient) {
    this.clientProvider = clientProvider;
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return getAvailableModels(this.clientProvider());
  }

  async refreshModels(): Promise<ModelInfo[]> {
    return refreshModelCache(this.clientProvider());
  }

  async isModelAvailable(modelId: string): Promise<boolean> {
    return isModelAvailable(this.clientProvider(), modelId);
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return getModelInfo(this.clientProvider(), modelId);
  }

  async getDefaultModel(): Promise<ModelInfo | undefined> {
    return getDefaultModel(this.clientProvider());
  }
}
