import { OpencodeClient } from '@opencode-ai/sdk';

export const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

export const MINIMAL_PNG_DATA_URL = `data:image/png;base64,${MINIMAL_PNG_BASE64}`;
export const DEFAULT_IMAGE_MODEL = 'moonshotai:kimi-k2.5';
export const IMAGE_MODEL_OVERRIDE_ENV = 'VITEST_OPENCODE_IMAGE_MODEL';

export interface ModelRef {
  providerID: string;
  modelID: string;
}

function parseModelRef(value: string): ModelRef | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

function modelExists(providers: any[], modelRef: ModelRef): boolean {
  const provider = providers.find((entry: any) => entry?.id === modelRef.providerID);
  if (!provider) return false;
  const models = provider?.models ?? {};
  for (const [modelKey, model] of Object.entries(models)) {
    const modelID = (model as any)?.id || modelKey;
    if (modelID === modelRef.modelID) return true;
  }
  return false;
}

function modelSupportsImageInput(model: any): boolean {
  if (model?.capabilities?.input?.image === true) return true;
  const modalities = model?.modalities?.input;
  if (Array.isArray(modalities) && modalities.includes('image')) return true;
  if (model?.attachment === true) return true;
  return model?.capabilities?.attachment === true;
}

export async function findImageCapableModel(client: OpencodeClient): Promise<ModelRef | null> {
  const providersResult = await client.config.providers();
  const providers = providersResult.data?.providers ?? [];

  const overrideRaw = process.env[IMAGE_MODEL_OVERRIDE_ENV];
  if (overrideRaw) {
    const override = parseModelRef(overrideRaw);
    if (!override) {
      console.warn(
        `[OpenCode SDK Live] Ignoring invalid ${IMAGE_MODEL_OVERRIDE_ENV}="${overrideRaw}". Expected "providerID:modelID".`
      );
    } else {
      return override;
    }
  }

  const defaultModel = parseModelRef(DEFAULT_IMAGE_MODEL);
  if (defaultModel && modelExists(providers, defaultModel)) {
    return defaultModel;
  }

  for (const provider of providers) {
    const providerID = provider?.id;
    const models = provider?.models ?? {};
    for (const [modelKey, model] of Object.entries(models)) {
      const modelID = (model as any)?.id || modelKey;
      if (!providerID || !modelID) continue;
      if (modelSupportsImageInput(model)) {
        return { providerID, modelID };
      }
    }
  }

  return null;
}

export async function promptAsyncAndWaitForIdle(
  client: OpencodeClient,
  sessionId: string,
  body: any,
  timeoutMs = 30000
): Promise<void> {
  const controller = new AbortController();
  const events = await client.global.event({ signal: controller.signal });
  const startTime = Date.now();

  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      body,
    });

    for await (const event of events.stream) {
      const payload = event.payload;
      if (payload?.type === 'session.idle' && payload?.properties?.sessionID === sessionId) {
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for session.idle (${sessionId})`);
      }
    }
  } finally {
    controller.abort();
  }

  throw new Error(`Event stream ended before session.idle (${sessionId})`);
}
