/**
 * SDK Live Test: Plan agent response should contain step parts, not tool execution parts
 *
 * SKIPPED: Redundant with agents-basic.test.ts (checks step-start/step-finish) and
 * plan-mode-no-write.test.ts (verifies plan mode doesn't execute mutations).
 * Times out intermittently in full suite despite passing when run alone.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeWithCleanup, OpencodeTestServer, findFreePort, TEST_SESSION_PREFIX } from './test-helpers.js';
import * as path from 'path';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

const TEST_FILE_PATH = path.join('/tmp', `opencode-plan-step-parts-${process.pid}.txt`);

describe.skip('Plan Mode Step Parts', { timeout: 60000 }, () => {
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

  it('plan agent response should contain step parts, not tool execution parts', async () => {
    const session = await client.session.create({
      body: { title: `${TEST_SESSION_PREFIX}Plan Mode Step Parts` },
    });
    opencode.trackSession(session.data!.id);

    const result = await client.session.prompt({
      path: { id: session.data!.id },
      body: {
        parts: [{ type: 'text', text: `Create a file at ${TEST_FILE_PATH} with content "test"` }],
        agent: 'plan',
      },
    });

    expect(result.data).toBeDefined();

    const parts = result.data!.parts || [];
    const partTypes = parts.map((p: any) => p.type);

    expect(partTypes).toContain('step-start');
    expect(partTypes).toContain('step-finish');

    const toolParts = parts.filter((p: any) => p.type === 'tool' && p.state === 'completed');
    const writeToolParts = toolParts.filter((p: any) =>
      p.tool === 'Write' || p.tool === 'Edit' || p.tool === 'Bash'
    );
    expect(writeToolParts.length).toBe(0);
  });
});
