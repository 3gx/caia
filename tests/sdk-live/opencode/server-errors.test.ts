/**
 * SDK Live Tests: Server Error Scenarios
 *
 * Uses in-memory atomic port allocator via Vitest's globalSetup provide/inject
 */
import { describe, it, expect, inject } from 'vitest';
import { createOpencodeWithCleanup, findFreePort } from './test-helpers.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

describe.skipIf(SKIP_LIVE)('Server Errors', { timeout: 30000 }, () => {
  it('CANARY: server creation validates port', async () => {
    const buffer = inject('portCounter') as SharedArrayBuffer;
    const basePort = inject('basePort') as number;
    const counter = new Int32Array(buffer);
    const testPort = findFreePort(counter, basePort);

    const opencode = await createOpencodeWithCleanup(testPort);
    expect(opencode.server.url).toMatch(new RegExp(`:${testPort}`));

    await opencode.cleanup();
  });
});
