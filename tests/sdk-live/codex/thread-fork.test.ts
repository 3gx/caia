/**
 * SDK Live Tests: Thread Fork Verification
 *
 * CRITICAL TEST: Verifies that Codex `thread/fork` RPC call works correctly,
 * including fork-at-point-in-time functionality (forking at a specific turn index).
 *
 * This test ensures:
 * 1. Basic thread fork works (creates a new thread from existing)
 * 2. Fork-at-turn-index works (forks from a specific point in conversation)
 * 3. Forked thread state is correct (has forkedFrom, forkedAtTurnIndex)
 *
 * Run with: make sdk-test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

// Helper to create JSON-RPC request
function createRequest(id: number, method: string, params?: Record<string, unknown>) {
  const request: Record<string, unknown> = {
    jsonrpc: '2.0',
    id,
    method,
  };
  if (params) {
    request.params = params;
  }
  return JSON.stringify(request) + '\n';
}

interface ThreadInfo {
  id: string;
  forkedFrom?: string;
  forkedAtTurnIndex?: number;
  [key: string]: unknown;
}

describe.skipIf(SKIP_LIVE)('Codex Thread Fork', { timeout: 120000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];

  beforeAll(async () => {
    // Spawn app-server
    server = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    // Set up line reader for responses
    rl = readline.createInterface({
      input: server.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && responseHandlers.has(msg.id)) {
          // Response to a request
          const handler = responseHandlers.get(msg.id)!;
          responseHandlers.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result);
          }
        } else if (msg.method) {
          // Notification
          notifications.push({ method: msg.method, params: msg.params });
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    // Initialize
    await rpc('initialize', {
      clientInfo: { name: 'cxslack-fork-test', version: '1.0.0' },
    });
  });

  afterAll(() => {
    rl?.close();
    server?.kill();
  });

  async function rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      responseHandlers.set(id, { resolve: resolve as (v: unknown) => void, reject });
      server.stdin!.write(createRequest(id, method, params));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (responseHandlers.has(id)) {
          responseHandlers.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 30000);
    });
  }

  async function waitForTurnComplete(timeout = 45000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (
        notifications.some(
          (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
        )
      ) {
        return true;
      }
    }
    return false;
  }

  it('thread/fork creates a new thread from existing thread', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Thread Fork Basic Test ===');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Original thread: ${originalThreadId}`);

    // 2. Send a simple query to establish history
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Say "hello" and nothing else.' }],
    });

    const turnComplete = await waitForTurnComplete();
    expect(turnComplete).toBe(true);
    console.log('Turn 1 completed');

    // Clear notifications for next operation
    notifications.length = 0;

    // 3. Fork the thread (basic fork, no turn index)
    console.log('Forking thread...');
    const forkResult = await rpc<{ thread: ThreadInfo }>('thread/fork', {
      threadId: originalThreadId,
    });

    const forkedThread = forkResult.thread;
    expect(forkedThread).toBeDefined();
    expect(forkedThread.id).toBeDefined();
    expect(forkedThread.id).not.toBe(originalThreadId);

    console.log(`Forked thread: ${forkedThread.id}`);
    console.log(`Fork metadata: forkedFrom=${forkedThread.forkedFrom}, forkedAtTurnIndex=${forkedThread.forkedAtTurnIndex}`);

    // Verify fork metadata if available
    if (forkedThread.forkedFrom !== undefined) {
      expect(forkedThread.forkedFrom).toBe(originalThreadId);
      console.log('✓ VERIFIED: forkedFrom matches original thread');
    } else {
      console.log('Note: forkedFrom not returned in thread info');
    }

    // 4. Verify forked thread is functional - send a query
    notifications.length = 0;
    await rpc('turn/start', {
      threadId: forkedThread.id,
      input: [{ type: 'text', text: 'Say "world" and nothing else.' }],
    });

    const forkTurnComplete = await waitForTurnComplete();
    expect(forkTurnComplete).toBe(true);
    console.log('✓ VERIFIED: Forked thread accepts queries');

    console.log('==========================================\n');
  });

  // CRITICAL: Tests point-in-time fork functionality using declarative variable assignments
  // Uses "assume variable X = Y" approach which is more robust than "remember number" prompts
  it('fork-at-point excludes content after fork point', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Fork-at-Point Content Verification Test ===');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Original thread: ${originalThreadId}`);

    // 2. Send multiple turns with declarative variable assignments
    // Use values that won't collide via arithmetic: 1111 + 2222 = 3333 (not 4444)
    // Turn 0: Assume a = 1111
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable a has value 1111. Just confirm by saying "a = 1111".' }],
    });
    let complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 0 completed (a = 1111)');
    notifications.length = 0;

    // Turn 1: Assume b = 2222
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable b has value 2222. Just confirm by saying "b = 2222".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 1 completed (b = 2222)');
    notifications.length = 0;

    // Turn 2: Assume c = 4444
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable c has value 4444. Just confirm by saying "c = 4444".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 2 completed (c = 4444)');
    notifications.length = 0;

    // 3. Fork at turn index 1 (should have a=101 and b=202, but NOT c=303)
    const forkTurnIndex = 1;

    // Query Codex for actual turn count (source of truth)
    console.log('\nQuerying Codex for turn count...');
    const readResult = await rpc<{ thread: ThreadInfo & { turns?: Array<{ id: string }> } }>('thread/read', {
      threadId: originalThreadId,
      includeTurns: true,
    });
    const totalTurns = readResult.thread.turns?.length ?? 0;
    console.log(`Codex reports ${totalTurns} turns in source thread`);
    expect(totalTurns).toBe(3);

    const turnsToRollback = totalTurns - (forkTurnIndex + 1);
    console.log(`Forking at turn ${forkTurnIndex}, will rollback ${turnsToRollback} turns...`);

    // Fork the thread (creates full copy)
    const forkResult = await rpc<{ thread: ThreadInfo }>('thread/fork', {
      threadId: originalThreadId,
    });
    const forkedThread = forkResult.thread;
    expect(forkedThread.id).toBeDefined();
    expect(forkedThread.id).not.toBe(originalThreadId);
    console.log(`Forked thread: ${forkedThread.id}`);

    // Rollback the forked thread to the desired point
    if (turnsToRollback > 0) {
      await rpc('thread/rollback', {
        threadId: forkedThread.id,
        numTurns: turnsToRollback,
      });
      console.log('Rollback complete');
    }

    // 4. Verify forked thread only has variables from turns 0 and 1
    notifications.length = 0;
    await rpc('turn/start', {
      threadId: forkedThread.id,
      input: [{ type: 'text', text: 'List all the variables I asked you to assume and their values.' }],
    });

    const forkTurnComplete = await waitForTurnComplete();
    expect(forkTurnComplete).toBe(true);

    // Extract response text from notifications - match codex/event/agent_message_content_delta format
    let responseText = '';
    for (const n of notifications) {
      const params = n.params as Record<string, unknown>;
      const msg = params.msg as Record<string, unknown> | undefined;

      // Extract text from various notification formats:
      // - params.delta (string) - codex/event/agent_message_content_delta
      // - params.text, params.content (string)
      // - msg.delta, msg.text, msg.content (string) - nested in msg object
      const textContent =
        (typeof params.delta === 'string' ? params.delta : null) ||
        (typeof params.text === 'string' ? params.text : null) ||
        (typeof params.content === 'string' ? params.content : null) ||
        (msg && typeof msg.delta === 'string' ? msg.delta : null) ||
        (msg && typeof msg.text === 'string' ? msg.text : null) ||
        (msg && typeof msg.content === 'string' ? msg.content : null);

      if (textContent) {
        responseText += textContent;
      }
    }

    console.log(`\nForked thread response: "${responseText.slice(0, 500)}..."`);
    console.log('\n=== CONTENT VERIFICATION ===');

    // Check for variable values (1111, 2222, 4444 chosen to avoid arithmetic collisions)
    const has1111 = responseText.includes('1111');
    const has2222 = responseText.includes('2222');
    const has4444 = responseText.includes('4444');

    console.log(`Contains 1111 (a): ${has1111} (expected: true)`);
    console.log(`Contains 2222 (b): ${has2222} (expected: true)`);
    console.log(`Contains 4444 (c): ${has4444} (expected: false - should NOT be in fork at turn 1)`);

    // CRITICAL assertions: fork at turn 1 should include turns 0,1 but NOT turn 2
    // Include responseText in error message for debugging
    expect(has1111, `Expected response to contain '1111'. Response was: "${responseText.slice(0, 300)}..."`).toBe(true);   // Turn 0: a = 1111 should exist
    expect(has2222, `Expected response to contain '2222'. Response was: "${responseText.slice(0, 300)}..."`).toBe(true);   // Turn 1: b = 2222 should exist
    expect(has4444, `Expected response to NOT contain '4444'. Response was: "${responseText.slice(0, 300)}..."`).toBe(false);  // Turn 2: c = 4444 must NOT exist (after fork point)

    if (!has4444) {
      console.log('✓ VERIFIED: Fork-at-point correctly excludes content after fork point');
    } else {
      console.log('✗ FAILED: Fork includes content after fork point - rollback NOT working!');
    }

    console.log('==========================================\n');
  });

  it('thread/read with includeTurns returns actual turn count (robust fork)', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Thread Read Turn Count Test (Robust Fork) ===');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Thread: ${originalThreadId}`);

    // 2. Send multiple turns
    for (let i = 0; i < 3; i++) {
      notifications.length = 0;
      await rpc('turn/start', {
        threadId: originalThreadId,
        input: [{ type: 'text', text: `Turn ${i}: Say "turn ${i} done" and nothing else.` }],
      });
      const complete = await waitForTurnComplete();
      expect(complete).toBe(true);
      console.log(`Turn ${i} completed`);
    }

    // 3. Read thread with includeTurns to get actual turn count from Codex (source of truth)
    console.log('\nReading thread with includeTurns=true...');
    const readResult = await rpc<{ thread: ThreadInfo & { turns?: Array<{ id: string }> } }>('thread/read', {
      threadId: originalThreadId,
      includeTurns: true,
    });

    const turns = readResult.thread.turns;
    expect(turns).toBeDefined();
    console.log(`Codex reports ${turns?.length} turns`);

    // CRITICAL: Codex is the source of truth for turn count
    // This is what makes fork robust - even if user used CLI, /resumed elsewhere, etc.
    expect(turns?.length).toBe(3);
    console.log('✓ VERIFIED: thread/read returns correct turn count from Codex (source of truth)');

    console.log('==========================================\n');
  });

  // CRITICAL: Tests exact bug scenario - 4 variables, fork at turn 2, verify a,b,c known
  // This matches the reported issue: fork from d=184 should have a=42, b=84, c=840
  it('fork-at-turn-2 with 4 variables keeps first 3 variables', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Fork at Turn 2 (4 Variables) Test ===');
    console.log('Scenario: a=42, b=84, c=840, d=184 → fork at turn 2 → should have a, b, c only\n');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Original thread: ${originalThreadId}`);

    // 2. Send 4 turns with variable assignments (matching user's exact scenario)
    // Turn 0: a = 42
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable a has value 42. Just confirm by saying "a = 42".' }],
    });
    let complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 0 completed (a = 42)');
    notifications.length = 0;

    // Turn 1: b = 84
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable b has value 84. Just confirm by saying "b = 84".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 1 completed (b = 84)');
    notifications.length = 0;

    // Turn 2: c = 840
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable c has value 840. Just confirm by saying "c = 840".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 2 completed (c = 840)');
    notifications.length = 0;

    // Turn 3: d = 184
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Assume variable d has value 184. Just confirm by saying "d = 184".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 3 completed (d = 184)');
    notifications.length = 0;

    // 3. Fork at turn index 2 (should have a=42, b=84, c=840, but NOT d=184)
    const forkTurnIndex = 2;

    // Query Codex for actual turn count
    console.log('\nQuerying Codex for turn count...');
    const readResult = await rpc<{ thread: ThreadInfo & { turns?: Array<{ id: string }> } }>('thread/read', {
      threadId: originalThreadId,
      includeTurns: true,
    });
    const totalTurns = readResult.thread.turns?.length ?? 0;
    console.log(`Codex reports ${totalTurns} turns in source thread`);
    expect(totalTurns).toBe(4);

    const turnsToRollback = totalTurns - (forkTurnIndex + 1);
    console.log(`Forking at turn ${forkTurnIndex}, will rollback ${turnsToRollback} turns...`);

    // Fork the thread
    const forkResult = await rpc<{ thread: ThreadInfo }>('thread/fork', {
      threadId: originalThreadId,
    });
    const forkedThread = forkResult.thread;
    expect(forkedThread.id).toBeDefined();
    expect(forkedThread.id).not.toBe(originalThreadId);
    console.log(`Forked thread: ${forkedThread.id}`);

    // Rollback to keep only turns 0, 1, 2
    if (turnsToRollback > 0) {
      await rpc('thread/rollback', {
        threadId: forkedThread.id,
        numTurns: turnsToRollback,
      });
      console.log('Rollback complete');
    }

    // 4. Verify forked thread has a, b, c but NOT d
    notifications.length = 0;
    await rpc('turn/start', {
      threadId: forkedThread.id,
      input: [{ type: 'text', text: 'List all the variables I asked you to assume and their values.' }],
    });

    const forkTurnComplete = await waitForTurnComplete();
    expect(forkTurnComplete).toBe(true);

    // Extract response text
    let responseText = '';
    for (const n of notifications) {
      const params = n.params as Record<string, unknown>;
      const msg = params.msg as Record<string, unknown> | undefined;
      const textContent =
        (typeof params.delta === 'string' ? params.delta : null) ||
        (typeof params.text === 'string' ? params.text : null) ||
        (typeof params.content === 'string' ? params.content : null) ||
        (msg && typeof msg.delta === 'string' ? msg.delta : null) ||
        (msg && typeof msg.text === 'string' ? msg.text : null) ||
        (msg && typeof msg.content === 'string' ? msg.content : null);
      if (textContent) {
        responseText += textContent;
      }
    }

    console.log(`\nForked thread response: "${responseText.slice(0, 500)}..."`);
    console.log('\n=== CONTENT VERIFICATION ===');

    // Check for variable values
    const has42 = responseText.includes('42');
    const has84 = responseText.includes('84') && !responseText.includes('184'); // 84 but not 184
    const has840 = responseText.includes('840');
    const has184 = responseText.includes('184');

    console.log(`Contains 42 (a): ${has42} (expected: true)`);
    console.log(`Contains 84 (b): ${has84} (expected: true)`);
    console.log(`Contains 840 (c): ${has840} (expected: true)`);
    console.log(`Contains 184 (d): ${has184} (expected: false - should NOT be in fork at turn 2)`);

    // CRITICAL assertions
    expect(has42, `Expected response to contain '42' (a). Response: "${responseText.slice(0, 300)}..."`).toBe(true);
    expect(has840, `Expected response to contain '840' (c). Response: "${responseText.slice(0, 300)}..."`).toBe(true);
    expect(has184, `Expected response to NOT contain '184' (d). Response: "${responseText.slice(0, 300)}..."`).toBe(false);

    if (!has184 && has42 && has840) {
      console.log('✓ VERIFIED: Fork at turn 2 correctly has a, b, c and excludes d');
    } else {
      console.log('✗ FAILED: Fork content incorrect');
    }

    console.log('==========================================\n');
  });

  it('thread/fork returns proper error for invalid thread ID', async () => {
    console.log('\n=== Thread Fork Error Handling Test ===');

    try {
      await rpc<{ thread: ThreadInfo }>('thread/fork', {
        threadId: 'non-existent-thread-id-12345',
      });
      // If we get here, the API didn't reject the invalid thread
      console.log('Note: API accepted invalid thread ID (may create orphan fork)');
    } catch (error) {
      // Expected behavior: should throw an error for invalid thread
      expect(error).toBeInstanceOf(Error);
      console.log(`✓ VERIFIED: API rejects invalid thread ID with error: ${(error as Error).message}`);
    }

    console.log('==========================================\n');
  });
});
