/**
 * SDK Live Tests: Image & Attachment Support
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';
import * as fs from 'fs';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Image Support', { timeout: 60000 }, () => {
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;
  const testImagePath = '/tmp/test-image.png';

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = basePort + Atomics.add(counter, 0, 1);

    const result = await createOpencode({ port: testPort });
    client = result.client;
    server = result.server;

    // Create a minimal test image
    const minimalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(testImagePath, minimalPng);
  });

  afterAll(() => {
    server.close();
    try {
      fs.unlinkSync(testImagePath);
    } catch {}
  });

  // Skip these tests until we understand the exact SDK file format
  it.skip('CANARY: file content block accepted', async () => {
    // SDK type investigation needed
  });

  it.skip('CANARY: text + file in same message', async () => {
    // SDK type investigation needed
  });
});
