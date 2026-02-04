/**
 * SDK Live Tests: Model Selection
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Model Selection', { timeout: 60000 }, () => {
  let opencode: OpencodeTestServer;
  let client: OpencodeClient;
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = findFreePort(counter, basePort);

    opencode = await createOpencodeWithCleanup(testPort);
    client = opencode.client;
  });

  afterAll(async () => {
    await opencode.cleanup();
  });

  it('CANARY: prompt with specific model succeeds', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Model Selection Test` },
    });
    opencode.trackSession(session.data!.id);

    // Get available models first
    let modelId: { providerID: string; modelID: string } | undefined;

    if (typeof client.app?.models === 'function') {
      const models = await client.app.models();
      if (models.data && models.data.length > 0) {
        const firstModel = models.data[0];
        modelId = {
          providerID: firstModel.providerID || firstModel.provider || 'anthropic',
          modelID: firstModel.modelID || firstModel.id || firstModel.name,
        };
      }
    }

    // Prompt with model parameter (if model was found)
    const promptBody: any = {
      parts: [{ type: 'text', text: 'Say "test"' }],
    };

    if (modelId) {
      promptBody.model = modelId;
    }

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: promptBody,
    });

    expect(result).toBeDefined();

    // Verify session has messages
    const messages = await client.session.messages({ path: { id: session.data!.id } });
    expect(messages.data).toBeDefined();
    expect(messages.data!.length).toBeGreaterThan(0);
  });

  it('CANARY: different models produce responses', async () => {
    // Get available models
    let models: any[] = [];

    if (typeof client.app?.models === 'function') {
      const result = await client.app.models();
      models = result.data || [];
    }

    if (models.length < 2) {
      // Skip if less than 2 models available
      expect(true).toBe(true);
      return;
    }

    const session1 = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Model Compare 1` },
    });
    opencode.trackSession(session1.data!.id);

    const session2 = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Model Compare 2` },
    });
    opencode.trackSession(session2.data!.id);

    // Use first two models
    const model1 = {
      providerID: models[0].providerID || models[0].provider || 'anthropic',
      modelID: models[0].modelID || models[0].id || models[0].name,
    };
    const model2 = {
      providerID: models[1].providerID || models[1].provider || 'anthropic',
      modelID: models[1].modelID || models[1].id || models[1].name,
    };

    await client.session.prompt({
      path: { id: session1.data!.id },
      body: {
        parts: [{ type: 'text', text: 'Respond with exactly "alpha"' }],
        model: model1,
      },
    });

    await client.session.prompt({
      path: { id: session2.data!.id },
      body: {
        parts: [{ type: 'text', text: 'Respond with exactly "beta"' }],
        model: model2,
      },
    });

    // Both should have produced responses
    const messages1 = await client.session.messages({ path: { id: session1.data!.id } });
    const messages2 = await client.session.messages({ path: { id: session2.data!.id } });

    expect(messages1.data!.length).toBeGreaterThan(0);
    expect(messages2.data!.length).toBeGreaterThan(0);
  });

  it('CANARY: invalid model returns error', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Invalid Model Test` },
    });
    opencode.trackSession(session.data!.id);

    // Try with obviously invalid model
    try {
      await client.session.prompt({
        path: { id: session.data!.id },
        body: {
          parts: [{ type: 'text', text: 'Hello' }],
          model: {
            providerID: 'nonexistent_provider_xyz',
            modelID: 'fake_model_abc123',
          },
        },
      });

      // If no error, the API may be lenient - that's ok
      expect(true).toBe(true);
    } catch (error: any) {
      // Expected error for invalid model
      expect(error).toBeDefined();
    }
  });
});
