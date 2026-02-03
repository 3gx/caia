/**
 * SDK Live Tests: Session Updates
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Session Updates', { timeout: 30000 }, () => {
  let client: OpencodeClient;
  let server: { close(): void; url: string };
  let testPort: number;

  beforeAll(async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    testPort = basePort + Atomics.add(counter, 0, 1);

    const result = await createOpencode({ port: testPort });
    client = result.client;
    server = result.server;
  });

  afterAll(() => {
    server.close();
  });

  it('CANARY: session.update() changes properties', async () => {
    const created = await client.session.create({
      body: { title: 'Original Title' },
    });

    await client.session.update({
      path: { id: created.data!.id },
      body: { title: 'Updated Title' },
    });

    const updated = await client.session.get({ path: { id: created.data!.id } });
    expect(updated.data?.title).toBe('Updated Title');
  });
});
