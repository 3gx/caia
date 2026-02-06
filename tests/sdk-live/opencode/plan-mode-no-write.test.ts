/**
 * SDK Live Test: Plan agent should NOT create file when asked to write
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';
import * as fs from 'fs';
import * as path from 'path';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const TEST_FILE_DIR = '/tmp';
const TEST_FILE_NAME = `opencode-plan-no-write-${process.pid}.txt`;
const TEST_FILE_PATH = path.join(TEST_FILE_DIR, TEST_FILE_NAME);

describe.skipIf(SKIP_LIVE)('Plan Mode No Write', { timeout: 60000 }, () => {
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

  beforeEach(() => {
    try { if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH); } catch {}
  });

  afterEach(() => {
    try { if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH); } catch {}
  });

  it('plan agent should NOT create file when asked to write', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Plan Mode No Write` },
    });
    opencode.trackSession(session.data!.id);

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: {
        parts: [{ type: 'text', text: `write "test" to ${TEST_FILE_PATH}` }],
        agent: 'plan',
      },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data!.info.mode).toBe('plan');
    expect(fs.existsSync(TEST_FILE_PATH)).toBe(false);
  });
});
