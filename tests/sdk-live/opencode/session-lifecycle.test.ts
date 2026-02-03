/**
 * SDK Live Tests: Session Lifecycle
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { createOpencode, OpencodeClient } from '@opencode-ai/sdk';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Session Lifecycle', { timeout: 60000 }, () => {
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

  it('CANARY: session.list() returns all sessions', async () => {
    await client.session.create({ body: { title: 'Test 1' } });
    await client.session.create({ body: { title: 'Test 2' } });

    const list = await client.session.list();
    expect(list.data?.length).toBeGreaterThanOrEqual(2);
  });

  it('CANARY: session.get() retrieves session details', async () => {
    const created = await client.session.create({ body: { title: 'Test' } });

    const retrieved = await client.session.get({
      path: { id: created.data!.id }
    });
    expect(retrieved.data?.id).toBe(created.data!.id);
  });

  it('CANARY: session.delete() removes session', async () => {
    const created = await client.session.create({ body: { title: 'Test Delete' } });

    await client.session.delete({ path: { id: created.data!.id } });

    const result = await client.session.get({ path: { id: created.data!.id } });
    expect(result.error).toBeDefined();
  });

  it('CANARY: session.status() shows status map', async () => {
    const created = await client.session.create({ body: { title: 'Test' } });

    const status = await client.session.status();
    expect(status.data).toBeDefined();
    // Status returns a map of sessionID -> status
    expect(typeof status.data).toBe('object');
  });
});
