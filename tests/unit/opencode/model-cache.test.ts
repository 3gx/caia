import { describe, it, expect, vi } from 'vitest';
import { encodeModelId, decodeModelId, refreshModelCache, getAvailableModels, isModelAvailable, getCachedContextWindow } from '../../../opencode/src/model-cache.js';

describe('model-cache', () => {
  it('encodes and decodes model ids', () => {
    const value = encodeModelId('provider', 'model');
    expect(value).toBe('provider:model');
    expect(decodeModelId(value)).toEqual({ providerID: 'provider', modelID: 'model' });
  });

  it('refreshes model cache from providers', async () => {
    const client = {
      config: {
        providers: vi.fn().mockResolvedValue({
          data: {
            providers: [
              { id: 'p1', name: 'Provider1', models: { m1: { id: 'm1', name: 'Model1', limit: { context: 128000, output: 8192 } } } },
            ],
            default: { p1: 'm1' },
          },
        }),
      },
    } as any;

    const models = await refreshModelCache(client);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].contextWindow).toBe(128000);
  });

  it('checks model availability', async () => {
    const client = {
      config: {
        providers: vi.fn().mockResolvedValue({ data: { providers: [], default: {} } }),
      },
    } as any;

    const models = await getAvailableModels(client);
    expect(Array.isArray(models)).toBe(true);
    const available = await isModelAvailable(client, 'p1:m1');
    expect(typeof available).toBe('boolean');
  });

  it('getCachedContextWindow returns cached context window', async () => {
    const client = {
      config: {
        providers: vi.fn().mockResolvedValue({
          data: {
            providers: [
              { id: 'p1', name: 'Provider1', models: { m1: { id: 'm1', name: 'Model1', limit: { context: 128000 } } } },
            ],
            default: { p1: 'm1' },
          },
        }),
      },
    } as any;

    await refreshModelCache(client);
    expect(getCachedContextWindow('p1:m1')).toBe(128000);
  });

  it('getCachedContextWindow returns null for unknown model', async () => {
    expect(getCachedContextWindow('unknown:model')).toBe(null);
  });

  it('getCachedContextWindow returns null when model has no limit', async () => {
    const client = {
      config: {
        providers: vi.fn().mockResolvedValue({
          data: {
            providers: [
              { id: 'p2', name: 'Provider2', models: { m2: { id: 'm2', name: 'Model2' } } },
            ],
            default: { p2: 'm2' },
          },
        }),
      },
    } as any;

    await refreshModelCache(client);
    expect(getCachedContextWindow('p2:m2')).toBe(null);
  });
});
