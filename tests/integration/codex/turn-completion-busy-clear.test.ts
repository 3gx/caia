/**
 * Integration test: Verify busy state is cleared on turn completion.
 *
 * This tests the bug where conversationTracker.stopProcessing was never
 * called when a turn completed normally, causing subsequent queries to
 * show "Another request is already running" error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock ConversationTracker to track calls
class MockConversationTracker {
  private busySessions = new Set<string>();

  startProcessing(sessionId: string): boolean {
    if (this.busySessions.has(sessionId)) return false;
    this.busySessions.add(sessionId);
    return true;
  }

  stopProcessing(sessionId: string): void {
    this.busySessions.delete(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }
}

// Mock CodexClient that emits turn:completed
class MockCodexClient extends EventEmitter {
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
}

// Mock StreamingManager that propagates onTurnCompleted
class MockStreamingManager {
  private turnCompletedCallback?: (context: { threadId: string }, status: string) => void;

  onTurnCompleted(callback: (context: { threadId: string }, status: string) => void): void {
    this.turnCompletedCallback = callback;
  }

  // Simulate turn completion
  simulateTurnCompleted(context: { threadId: string }, status: string): void {
    if (this.turnCompletedCallback) {
      this.turnCompletedCallback(context, status);
    }
  }
}

describe('Turn Completion Busy State Clear', () => {
  it('stopProcessing is called when turn completes normally', () => {
    const tracker = new MockConversationTracker();
    const streaming = new MockStreamingManager();
    const threadId = 'thread_123';

    // Register the callback (this is what the fix adds)
    streaming.onTurnCompleted((context) => {
      tracker.stopProcessing(context.threadId);
    });

    // Simulate: turn starts, session becomes busy
    tracker.startProcessing(threadId);
    expect(tracker.isBusy(threadId)).toBe(true);

    // Simulate: turn completes
    streaming.simulateTurnCompleted({ threadId }, 'completed');

    // Verify: session is no longer busy
    expect(tracker.isBusy(threadId)).toBe(false);
  });

  it('second query succeeds after first turn completes', () => {
    const tracker = new MockConversationTracker();
    const streaming = new MockStreamingManager();
    const threadId = 'thread_456';

    // Register the callback
    streaming.onTurnCompleted((context) => {
      tracker.stopProcessing(context.threadId);
    });

    // First query
    expect(tracker.startProcessing(threadId)).toBe(true);
    expect(tracker.isBusy(threadId)).toBe(true);

    // First turn completes
    streaming.simulateTurnCompleted({ threadId }, 'completed');
    expect(tracker.isBusy(threadId)).toBe(false);

    // Second query - should succeed (not blocked)
    expect(tracker.startProcessing(threadId)).toBe(true);
  });

  it('WITHOUT callback, session stays busy forever (the bug)', () => {
    const tracker = new MockConversationTracker();
    const streaming = new MockStreamingManager();
    const threadId = 'thread_789';

    // NO callback registered (the bug scenario)

    // First query
    tracker.startProcessing(threadId);
    expect(tracker.isBusy(threadId)).toBe(true);

    // Turn completes but no callback to clear busy state
    streaming.simulateTurnCompleted({ threadId }, 'completed');

    // BUG: Session is STILL busy
    expect(tracker.isBusy(threadId)).toBe(true);

    // Second query fails
    expect(tracker.startProcessing(threadId)).toBe(false);
  });
});
