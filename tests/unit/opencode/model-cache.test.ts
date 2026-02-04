import { describe, it, expect, vi } from 'vitest';
import { encodeModelId, decodeModelId, refreshModelCache, getAvailableModels, isModelAvailable } from '../../../opencode/src/model-cache.js';

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
              { id: 'p1', name: 'Provider1', models: { m1: { id: 'm1', name: 'Model1' } } },
            ],
            default: { p1: 'm1' },
          },
        }),
      },
    } as any;

    const models = await refreshModelCache(client);
    expect(models.length).toBeGreaterThan(0);
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
});
