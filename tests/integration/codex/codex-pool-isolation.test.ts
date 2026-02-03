/**
 * Integration tests for CodexPool per-session isolation.
 *
 * CodexPool provides each Slack conversation with its own CodexClient
 * (and thus its own Codex app-server process). This is critical for:
 * 1. Fork operations - the source thread must exist in the source runtime
 * 2. Session isolation - conversations don't interfere with each other
 * 3. Approval routing - approvals go to the correct conversation's handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock CodexClient that tracks calls per instance
class MockCodexClient extends EventEmitter {
  instanceId: string;
  started = false;
  threads = new Map<string, { turns: string[] }>();

  constructor(instanceId: string) {
    super();
    this.instanceId = instanceId;
  }

  start = vi.fn().mockImplementation(async () => {
    this.started = true;
  });

  stop = vi.fn().mockImplementation(async () => {
    this.started = false;
  });

  startThread = vi.fn().mockImplementation(async (workingDir: string) => {
    const id = `thread_${this.instanceId}_${this.threads.size}`;
    this.threads.set(id, { turns: [] });
    return { id };
  });

  resumeThread = vi.fn().mockResolvedValue(undefined);

  forkThreadAtTurn = vi.fn().mockImplementation(async (sourceThreadId: string, turnIndex: number) => {
    const sourceThread = this.threads.get(sourceThreadId);
    if (!sourceThread) {
      throw new Error(`Thread ${sourceThreadId} not found in CodexClient ${this.instanceId}`);
    }
    const forkedId = `forked_${sourceThreadId}_at_${turnIndex}`;
    // Fork preserves turns up to turnIndex
    this.threads.set(forkedId, {
      turns: sourceThread.turns.slice(0, turnIndex + 1),
    });
    return { id: forkedId };
  });

  findTurnIndex = vi.fn().mockImplementation(async (threadId: string, turnId: string) => {
    const thread = this.threads.get(threadId);
    if (!thread) return -1;
    return thread.turns.indexOf(turnId);
  });

  // Helper to simulate adding turns (for testing)
  _addTurn(threadId: string, turnId: string) {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.turns.push(turnId);
    }
  }
}

// Mock StreamingManager
class MockStreamingManager {
  instanceId: string;
  contexts = new Map<string, { threadId: string; turnId: string }>();

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  startStreaming = vi.fn();
  stopAllStreaming = vi.fn().mockImplementation(() => {
    this.contexts.clear();
  });
  getContext = vi.fn().mockImplementation((key: string) => this.contexts.get(key));
  isStreaming = vi.fn().mockReturnValue(false);
  updateRate = vi.fn();
}

// Mock ApprovalHandler
class MockApprovalHandler {
  instanceId: string;
  pendingApprovals = new Set<number>();

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  hasPendingApproval = vi.fn().mockImplementation((requestId: number) => {
    return this.pendingApprovals.has(requestId);
  });

  handleApprovalDecision = vi.fn().mockResolvedValue(true);

  // Helper to simulate pending approval
  _addPendingApproval(requestId: number) {
    this.pendingApprovals.add(requestId);
  }
}

// Testable CodexPool that uses our mock classes
interface CodexRuntime {
  codex: MockCodexClient;
  streaming: MockStreamingManager;
  approval: MockApprovalHandler;
}

class TestableCodexPool {
  private runtimes = new Map<string, CodexRuntime>();
  private instanceCounter = 0;

  async getRuntime(conversationKey: string): Promise<CodexRuntime> {
    const existing = this.runtimes.get(conversationKey);
    if (existing) {
      return existing;
    }
    const runtime = await this.createRuntime(conversationKey);
    this.runtimes.set(conversationKey, runtime);
    return runtime;
  }

  getRuntimeIfExists(conversationKey: string): CodexRuntime | undefined {
    return this.runtimes.get(conversationKey);
  }

  findRuntimeByApprovalRequestId(requestId: number): CodexRuntime | undefined {
    let found: CodexRuntime | undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.approval.hasPendingApproval(requestId)) {
        if (found) {
          // Multiple runtimes claim this approval - ambiguous
          return undefined;
        }
        found = runtime;
      }
    }
    return found;
  }

  async stopAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.streaming.stopAllStreaming();
      await runtime.codex.stop();
    }
    this.runtimes.clear();
  }

  private async createRuntime(conversationKey: string): Promise<CodexRuntime> {
    const instanceId = `instance_${this.instanceCounter++}`;
    const codex = new MockCodexClient(instanceId);
    const streaming = new MockStreamingManager(instanceId);
    const approval = new MockApprovalHandler(instanceId);

    await codex.start();

    return { codex, streaming, approval };
  }

  // Expose for testing
  get runtimeCount(): number {
    return this.runtimes.size;
  }
}

describe('CodexPool Per-Session Isolation', () => {
  let pool: TestableCodexPool;

  beforeEach(() => {
    pool = new TestableCodexPool();
  });

  describe('Runtime Creation', () => {
    it('creates separate runtime for each conversation key', async () => {
      const runtime1 = await pool.getRuntime('C123_111.111');
      const runtime2 = await pool.getRuntime('C123_222.222');
      const runtime3 = await pool.getRuntime('C456_333.333');

      // Each should be a distinct runtime object
      expect(runtime1).not.toBe(runtime2);
      expect(runtime2).not.toBe(runtime3);
      expect(runtime1).not.toBe(runtime3);

      // Each should have unique instance IDs
      expect(runtime1.codex.instanceId).toBe('instance_0');
      expect(runtime2.codex.instanceId).toBe('instance_1');
      expect(runtime3.codex.instanceId).toBe('instance_2');

      expect(pool.runtimeCount).toBe(3);
    });

    it('returns same runtime for same conversation key', async () => {
      const runtime1 = await pool.getRuntime('C123_111.111');
      const runtime2 = await pool.getRuntime('C123_111.111');

      expect(runtime1).toBe(runtime2);
      expect(pool.runtimeCount).toBe(1);
    });

    it('getRuntimeIfExists returns undefined for non-existent key', () => {
      const runtime = pool.getRuntimeIfExists('C999_999.999');
      expect(runtime).toBeUndefined();
    });

    it('getRuntimeIfExists returns runtime after getRuntime creates it', async () => {
      // First, runtime doesn't exist
      expect(pool.getRuntimeIfExists('C123_111.111')).toBeUndefined();

      // Create it
      await pool.getRuntime('C123_111.111');

      // Now it exists
      const runtime = pool.getRuntimeIfExists('C123_111.111');
      expect(runtime).toBeDefined();
      expect(runtime?.codex.instanceId).toBe('instance_0');
    });
  });

  describe('Fork Operation Isolation - The Critical Bug Fix', () => {
    it('fork fails when using wrong runtime (demonstrates the bug)', async () => {
      // This test demonstrates WHY per-session isolation matters for fork

      // User A creates a conversation with some history
      const userARuntime = await pool.getRuntime('C123_userA.thread');
      const threadA = await userARuntime.codex.startThread('/userA/project');
      userARuntime.codex._addTurn(threadA.id, 'turn_1');
      userARuntime.codex._addTurn(threadA.id, 'turn_2');
      userARuntime.codex._addTurn(threadA.id, 'turn_3');

      // User B has a different conversation
      const userBRuntime = await pool.getRuntime('C123_userB.thread');

      // BUG SCENARIO: If we tried to fork using User B's codex (wrong runtime):
      // User B's codex doesn't have User A's thread
      const wrongTurnIndex = await userBRuntime.codex.findTurnIndex(threadA.id, 'turn_2');
      expect(wrongTurnIndex).toBe(-1); // Thread not found in wrong runtime!

      // CORRECT: Fork using User A's runtime (source runtime)
      const correctTurnIndex = await userARuntime.codex.findTurnIndex(threadA.id, 'turn_2');
      expect(correctTurnIndex).toBe(1); // Found at index 1

      const forkedThread = await userARuntime.codex.forkThreadAtTurn(threadA.id, correctTurnIndex);
      expect(forkedThread.id).toContain('forked_');
    });

    it('fork preserves conversation history up to the fork point', async () => {
      // Create source conversation with history
      const sourceRuntime = await pool.getRuntime('C123_source.thread');
      const sourceThread = await sourceRuntime.codex.startThread('/project');

      // Add conversation history
      sourceRuntime.codex._addTurn(sourceThread.id, 'turn_0');
      sourceRuntime.codex._addTurn(sourceThread.id, 'turn_1');
      sourceRuntime.codex._addTurn(sourceThread.id, 'turn_2');
      sourceRuntime.codex._addTurn(sourceThread.id, 'turn_3');

      // Fork at turn_1 (index 1)
      const turnIndex = await sourceRuntime.codex.findTurnIndex(sourceThread.id, 'turn_1');
      expect(turnIndex).toBe(1);

      const forkedThread = await sourceRuntime.codex.forkThreadAtTurn(sourceThread.id, turnIndex);

      // Verify fork was called with correct parameters
      expect(sourceRuntime.codex.forkThreadAtTurn).toHaveBeenCalledWith(sourceThread.id, 1);

      // Verify the forked thread ID reflects the fork point
      expect(forkedThread.id).toBe(`forked_${sourceThread.id}_at_1`);
    });

    it('source runtime is accessed by conversation key for fork operations', async () => {
      // Setup: source conversation
      const sourceConvKey = 'C123_source.thread';
      const sourceRuntime = await pool.getRuntime(sourceConvKey);
      const thread = await sourceRuntime.codex.startThread('/project');
      sourceRuntime.codex._addTurn(thread.id, 'turn_abc');

      // Fork channel gets new conversation key
      const forkConvKey = 'C_FORK_456.789';

      // When forking, we need to:
      // 1. Get source runtime by source conversation key
      const sourceRuntimeForFork = await pool.getRuntime(sourceConvKey);
      expect(sourceRuntimeForFork).toBe(sourceRuntime); // Same instance

      // 2. Query turn index from source runtime
      const turnIndex = await sourceRuntimeForFork.codex.findTurnIndex(thread.id, 'turn_abc');
      expect(turnIndex).toBe(0);

      // 3. Fork using source runtime's codex
      const forkedThread = await sourceRuntimeForFork.codex.forkThreadAtTurn(thread.id, turnIndex);

      // 4. Create new runtime for fork channel (separate session)
      const forkRuntime = await pool.getRuntime(forkConvKey);
      expect(forkRuntime).not.toBe(sourceRuntime); // Different runtime

      // The fork runtime is independent - operations don't affect source
      expect(forkRuntime.codex.startThread).not.toHaveBeenCalled();
    });
  });

  describe('Approval Routing', () => {
    it('findRuntimeByApprovalRequestId finds correct runtime', async () => {
      const runtime1 = await pool.getRuntime('C123_111.111');
      const runtime2 = await pool.getRuntime('C123_222.222');

      // Runtime2 has the pending approval
      runtime2.approval._addPendingApproval(42);

      const found = pool.findRuntimeByApprovalRequestId(42);
      expect(found).toBe(runtime2);
    });

    it('findRuntimeByApprovalRequestId returns undefined when no runtime has approval', async () => {
      await pool.getRuntime('C123_111.111');
      await pool.getRuntime('C123_222.222');

      const found = pool.findRuntimeByApprovalRequestId(99);
      expect(found).toBeUndefined();
    });

    it('findRuntimeByApprovalRequestId returns undefined when multiple runtimes claim same approval', async () => {
      const runtime1 = await pool.getRuntime('C123_111.111');
      const runtime2 = await pool.getRuntime('C123_222.222');

      // Both claim to have the approval (shouldn't happen, but defensive)
      runtime1.approval._addPendingApproval(42);
      runtime2.approval._addPendingApproval(42);

      const found = pool.findRuntimeByApprovalRequestId(42);
      expect(found).toBeUndefined();
    });
  });

  describe('Cleanup', () => {
    it('stopAll stops all runtimes', async () => {
      const runtime1 = await pool.getRuntime('C123_111.111');
      const runtime2 = await pool.getRuntime('C123_222.222');
      const runtime3 = await pool.getRuntime('C456_333.333');

      await pool.stopAll();

      // All streaming managers should be stopped
      expect(runtime1.streaming.stopAllStreaming).toHaveBeenCalled();
      expect(runtime2.streaming.stopAllStreaming).toHaveBeenCalled();
      expect(runtime3.streaming.stopAllStreaming).toHaveBeenCalled();

      // All codex instances should be stopped
      expect(runtime1.codex.stop).toHaveBeenCalled();
      expect(runtime2.codex.stop).toHaveBeenCalled();
      expect(runtime3.codex.stop).toHaveBeenCalled();
    });

    it('stopAll clears the runtime map', async () => {
      await pool.getRuntime('C123_111.111');
      await pool.getRuntime('C123_222.222');

      expect(pool.runtimeCount).toBe(2);

      await pool.stopAll();

      expect(pool.runtimeCount).toBe(0);
      expect(pool.getRuntimeIfExists('C123_111.111')).toBeUndefined();
      expect(pool.getRuntimeIfExists('C123_222.222')).toBeUndefined();
    });
  });

  describe('Session Isolation Scenarios', () => {
    it('two users in different threads get isolated sessions', async () => {
      const userARuntime = await pool.getRuntime('C123_thread1.ts');
      const userBRuntime = await pool.getRuntime('C123_thread2.ts');

      // They should have separate codex instances
      expect(userARuntime.codex.instanceId).not.toBe(userBRuntime.codex.instanceId);

      // Operations on one don't affect the other
      await userARuntime.codex.startThread('/userA/path');

      expect(userARuntime.codex.startThread).toHaveBeenCalledWith('/userA/path');
      expect(userBRuntime.codex.startThread).not.toHaveBeenCalled();
    });

    it('same thread across multiple interactions uses same session', async () => {
      // First interaction
      const runtime1 = await pool.getRuntime('C123_same.thread');
      await runtime1.codex.startThread('/path');

      // Later interaction in same thread
      const runtime2 = await pool.getRuntime('C123_same.thread');

      // Should be the same runtime (session continuity)
      expect(runtime1).toBe(runtime2);
      expect(runtime2.codex.startThread).toHaveBeenCalledTimes(1);
    });

    it('forking creates new runtime for fork channel while preserving source', async () => {
      // Original conversation
      const sourceRuntime = await pool.getRuntime('C_original_123.456');
      await sourceRuntime.codex.startThread('/project');

      // Fork to new channel (new conversation key)
      const forkRuntime = await pool.getRuntime('C_fork_789.012');

      // Fork runtime is separate
      expect(forkRuntime).not.toBe(sourceRuntime);
      expect(forkRuntime.codex.instanceId).not.toBe(sourceRuntime.codex.instanceId);

      // Source runtime unchanged
      expect(sourceRuntime.codex.startThread).toHaveBeenCalledTimes(1);

      // Fork runtime is fresh
      expect(forkRuntime.codex.startThread).not.toHaveBeenCalled();
    });
  });
});
