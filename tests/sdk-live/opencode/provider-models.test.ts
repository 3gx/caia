/**
 * SDK Live Tests: Provider & Models
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer } from './test-helpers.js';

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
    testPort = basePort + Atomics.add(counter, 0, 1);

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

  it.skip('CANARY: session created with specific model', async () => {
    // Get available models first
    const providersResult = await client.config.providers();
    const firstProvider = providersResult.data?.providers![0];

    if (firstProvider?.models) {
      const modelKeys = Object.keys(firstProvider.models);
      if (modelKeys.length > 0) {
        const modelId = firstProvider.models[modelKeys[0]].id;

        const session = await client.session.create({
          body: { title: 'Model Test Session', model: modelId },
        });

        // Model info structure varies by SDK version
        expect(session.data).toBeDefined();
      }
    }
  });
});
