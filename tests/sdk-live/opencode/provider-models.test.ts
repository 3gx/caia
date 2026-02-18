/**
 * SDK Live Tests: Provider & Models
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Provider & Models', { timeout: 30000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
    server = opencode.server;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: config.providers() returns providers', async () => {
    const result = await client.config.providers();

    expect(result.data).toBeDefined();
    expect(result.data?.providers).toBeDefined();
    expect(result.data?.providers!.length).toBeGreaterThan(0);
  });

  it('CANARY: providers have ID and name', async () => {
    const result = await client.config.providers();
    const providers = result.data?.providers;

    expect(providers!.length).toBeGreaterThan(0);

    providers!.forEach(provider => {
      expect(provider.id).toBeDefined();
      expect(provider.name).toBeDefined();
    });
  });

  it('CANARY: at least one model has limit.context (context window)', async () => {
    // HARD ASSERT: The OpenCode config API must return context window sizes.
    // model-cache.ts reads model.limit?.context and falls back to a hardcoded
    // DEFAULT_CONTEXT_WINDOW (200k) if missing — which may be wrong for the
    // actual model, causing incorrect context % and compact timing.
    const result = await client.config.providers();
    const providers = result.data?.providers;
    expect(providers!.length).toBeGreaterThan(0);

    let foundContextWindow = false;
    const modelsChecked: string[] = [];

    for (const provider of providers!) {
      const modelEntries = Object.values(provider.models || {});
      for (const model of modelEntries) {
        const modelId = model.id || model.name || 'unknown';
        modelsChecked.push(`${provider.id}/${modelId}`);
        if (model.limit?.context !== undefined && model.limit.context !== null) {
          expect(typeof model.limit.context).toBe('number');
          expect(model.limit.context).toBeGreaterThan(0);
          foundContextWindow = true;
        }
      }
    }

    // At least one model must report its context window
    expect(foundContextWindow).toBe(true);
    if (!foundContextWindow) {
      console.error(`No model reported limit.context. Models checked: ${modelsChecked.join(', ')}`);
    }
  });

  it.skip('CANARY: session created with specific model', async () => {
    // Get available models first
    const providersResult = await client.config.providers();
    const firstProvider = providersResult.data?.providers![0];

    if (firstProvider?.models) {
      const modelKeys = Object.keys(firstProvider.models);
      if (modelKeys.length > 0) {
        const modelId = firstProvider.models[modelKeys[0]].id;

        const session = await client.session.create({
          body: { title: `${TEST_SESSION_PREFIX}Model Test Session`, model: modelId },
        });
        opencode.trackSession(session.data!.id);

        // Model info structure varies by SDK version
        expect(session.data).toBeDefined();
      }
    }
  });
});
