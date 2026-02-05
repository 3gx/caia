/**
 * Model cache for OpenCode.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import type { ModelInfo } from '../../slack/src/types.js';

export type { ModelInfo };

let cachedModels: ModelInfo[] = [];
let cachedDefault: ModelInfo | undefined;
let lastRefresh = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function encodeModelId(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`;
}

export function decodeModelId(value: string): { providerID: string; modelID: string } | null {
  const [providerID, modelID] = value.split(':');
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

export async function refreshModelCache(client: OpencodeClient): Promise<ModelInfo[]> {
  try {
    const result = await client.config.providers();
    const providers = result.data?.providers ?? [];
    const models: ModelInfo[] = [];

    for (const provider of providers) {
      const providerName = provider.name || provider.id;
      const modelEntries = Object.values(provider.models || {});
      for (const model of modelEntries) {
        const modelId = model.id || model.name;
        if (!modelId) continue;
        const value = encodeModelId(provider.id, modelId);
        const displayName = `${providerName} / ${model.name || modelId}`;
        const description = model.name || modelId;
        models.push({ value, displayName, description });
      }
    }

    cachedModels = models;
    lastRefresh = Date.now();

    // Default model from config.providers default map
    const defaults = result.data?.default ?? {};
    const [defaultProvider, defaultModel] = Object.entries(defaults)[0] || [];
    if (defaultProvider && defaultModel) {
      const defaultValue = encodeModelId(defaultProvider, defaultModel as string);
      cachedDefault = cachedModels.find((m) => m.value === defaultValue);
    } else {
      cachedDefault = cachedModels[0];
    }

    return cachedModels;
  } catch (error) {
    console.error('[opencode:model-cache] Failed to refresh model cache:', error);
    // Keep existing cache if refresh fails
    if (cachedModels.length === 0) {
      cachedModels = [];
    }
    return cachedModels;
  }
}

export async function getAvailableModels(client: OpencodeClient): Promise<ModelInfo[]> {
  const now = Date.now();
  if (cachedModels.length > 0 && now - lastRefresh < CACHE_TTL_MS) {
    return cachedModels;
  }
  return refreshModelCache(client);
}

export async function isModelAvailable(client: OpencodeClient, modelId: string): Promise<boolean> {
  const models = await getAvailableModels(client);
  return models.some((m) => m.value === modelId);
}

export async function getModelInfo(client: OpencodeClient, modelId: string): Promise<ModelInfo | undefined> {
  const models = await getAvailableModels(client);
  return models.find((m) => m.value === modelId);
}

export async function getDefaultModel(client: OpencodeClient): Promise<ModelInfo | undefined> {
  if (cachedDefault) return cachedDefault;
  const models = await getAvailableModels(client);
  return cachedDefault ?? models[0];
}
