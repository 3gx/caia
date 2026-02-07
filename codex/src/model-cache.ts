/**
 * Model cache for Codex App-Server model discovery.
 */

import type { ModelInfo } from './blocks.js';
import type { CodexClient, CodexModelInfo } from './codex-client.js';

// Preferred default when available in model/list.
export const PREFERRED_DEFAULT_MODEL = 'gpt-5.3-codex';
// Safe fallback when preferred model is unavailable.
export const LEGACY_DEFAULT_MODEL = 'gpt-5.2-codex';

/**
 * Fallback model list when model/list is unavailable.
 * Keep this conservative so default behavior remains safe.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', description: 'Latest frontier agentic coding model.' },
  { value: 'gpt-5.2', displayName: 'GPT-5.2', description: 'Latest frontier model with improvements across knowledge, reasoning and coding.' },
  { value: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', description: 'Codex-optimized flagship for deep and fast reasoning.' },
  { value: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', description: 'Optimized for codex. Cheaper, faster, but less capable.' },
];

let cachedModels: ModelInfo[] = [];
let lastRefresh = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function normalizeModels(models: CodexModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const normalized: ModelInfo[] = [];

  for (const model of models) {
    const value = model.id || model.model;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push({
      value,
      displayName: model.displayName || value,
      description: model.description || 'Available model',
    });
  }

  return normalized;
}

export function getModelInfo(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  return models.find((model) => model.value === modelId);
}

export function selectDefaultModelFromIds(modelIds: string[]): string {
  if (modelIds.includes(PREFERRED_DEFAULT_MODEL)) return PREFERRED_DEFAULT_MODEL;
  if (modelIds.includes(LEGACY_DEFAULT_MODEL)) return LEGACY_DEFAULT_MODEL;
  return modelIds[0] ?? LEGACY_DEFAULT_MODEL;
}

export async function refreshModelCache(client: CodexClient): Promise<ModelInfo[]> {
  try {
    const modelInfos = typeof client.listModelInfos === 'function'
      ? await client.listModelInfos()
      : [];
    const normalized = normalizeModels(modelInfos);
    if (normalized.length > 0) {
      cachedModels = normalized;
      lastRefresh = Date.now();
      return cachedModels;
    }
  } catch (error) {
    console.error('[codex:model-cache] Failed to refresh model cache:', error);
  }

  if (cachedModels.length === 0) {
    cachedModels = FALLBACK_MODELS;
  }
  return cachedModels;
}

export async function getAvailableModels(client: CodexClient): Promise<ModelInfo[]> {
  const now = Date.now();
  if (cachedModels.length > 0 && now - lastRefresh < CACHE_TTL_MS) {
    return cachedModels;
  }
  return refreshModelCache(client);
}

/**
 * Resolve the runtime default model:
 * 1) Prefer gpt-5.3-codex when available
 * 2) Otherwise use gpt-5.2-codex
 * 3) Otherwise use first available model
 */
export async function resolveDefaultModel(client: CodexClient): Promise<string> {
  try {
    const modelIds = typeof client.listModels === 'function'
      ? await client.listModels()
      : [];
    if (modelIds.length > 0) {
      return selectDefaultModelFromIds(modelIds);
    }
  } catch (error) {
    console.error('[codex:model-cache] Failed to resolve default model:', error);
  }
  return LEGACY_DEFAULT_MODEL;
}

// Test helper: clear in-memory cache between test cases.
export function resetModelCacheForTests(): void {
  cachedModels = [];
  lastRefresh = 0;
}
