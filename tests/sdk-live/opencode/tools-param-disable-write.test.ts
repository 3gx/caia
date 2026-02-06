/**
 * SDK Live Test: Explicit tools parameter can disable Write tool
 *
 * Uses promptAsync + event listening to handle completion
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';
import * as fs from 'fs';
import * as path from 'path';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const TEST_FILE_DIR = '/tmp';
const TEST_FILE_NAME = `opencode-tools-disable-${process.pid}.txt`;
const TEST_FILE_PATH = path.join(TEST_FILE_DIR, TEST_FILE_NAME);

describe.skipIf(SKIP_LIVE)('Tools Param Disable Write', { timeout: 60000 }, () => {
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

  it('explicit tools parameter can disable Write tool', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Tools Param Disable Write` },
    });
    opencode.trackSession(session.data!.id);

    // Start event stream
    const controller = new AbortController();
    const eventStream = await client.global.event({ signal: controller.signal });

    // Use promptAsync with Write tool disabled
    await client.session.promptAsync({
      path: { id: session.data!.id },
      body: {
        parts: [{ type: 'text', text: `Create a file at ${TEST_FILE_PATH} with content "should not write"` }],
        agent: 'build',
        tools: {
          Write: false,
        },
      },
    });

    // Wait for session.idle (should complete quickly since Write is disabled)
    const startTime = Date.now();
    const timeoutMs = 30000;
    let completed = false;

    try {
      for await (const event of eventStream.stream) {
        const payload = event.payload;

        // Reject any permission request (Write should be disabled, but handle edge cases)
        if (payload?.type === 'permission.asked' && payload?.properties?.id) {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: session.data!.id, permissionID: payload.properties.id },
            body: { response: 'reject' },
          });
        }

        // Done when session goes idle
        if (payload?.type === 'session.idle' && payload?.properties?.sessionID === session.data!.id) {
          completed = true;
          break;
        }

        if (Date.now() - startTime > timeoutMs) {
          throw new Error('Timeout waiting for session.idle');
        }
      }
    } finally {
      controller.abort();
    }

    expect(completed).toBe(true);

    // File should NOT be created when Write tool is disabled
    expect(fs.existsSync(TEST_FILE_PATH)).toBe(false);
  });
});
