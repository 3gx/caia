/**
 * SDK Live Test: Build agent DOES create file (control test)
 *
 * Uses promptAsync + event listening to auto-approve permissions
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';
import * as fs from 'fs';
import * as path from 'path';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const TEST_FILE_DIR = '/tmp';
const TEST_FILE_NAME = `opencode-build-creates-${process.pid}.txt`;
const TEST_FILE_PATH = path.join(TEST_FILE_DIR, TEST_FILE_NAME);

describe.skipIf(SKIP_LIVE)('Build Mode Creates File', { timeout: 60000 }, () => {
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

  it('build agent DOES create file (control test)', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Build Mode Control` },
    });
    opencode.trackSession(session.data!.id);

    // Start event stream to listen for permission requests and auto-approve
    const controller = new AbortController();
    const eventStream = await client.global.event({ signal: controller.signal });

    // Use promptAsync (non-blocking)
    await client.session.promptAsync({
      path: { id: session.data!.id },
      body: {
        parts: [{ type: 'text', text: `Create a file at ${TEST_FILE_PATH} with the content "hello from build"` }],
        agent: 'build',
      },
    });

    // Process events: auto-approve permissions, wait for session.idle
    const startTime = Date.now();
    const timeoutMs = 30000;
    let completed = false;
    let hasToolParts = false;

    try {
      for await (const event of eventStream.stream) {
        const payload = event.payload;

        // Auto-approve any permission request
        if (payload?.type === 'permission.asked' && payload?.properties?.id) {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: session.data!.id, permissionID: payload.properties.id },
            body: { response: 'always' },
          });
        }

        // Track if we see tool parts
        if (payload?.type === 'message.part.updated' && payload?.properties?.part?.type === 'tool') {
          hasToolParts = true;
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

    // Build mode should have used tools OR created the file
    const fileCreated = fs.existsSync(TEST_FILE_PATH);
    expect(hasToolParts || fileCreated).toBe(true);
  });
});
