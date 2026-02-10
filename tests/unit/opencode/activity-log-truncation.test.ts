import { describe, it, expect } from 'vitest';
import { buildActivityLogText, type ActivityEntry, ACTIVITY_LOG_MAX_CHARS } from '../../../opencode/src/blocks.js';

/** Helper to create an ActivityEntry with defaults. */
function entry(type: ActivityEntry['type'], overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return { timestamp: Date.now(), type, ...overrides };
}

function thinkingEntry(content = 'reasoning about the task'): ActivityEntry {
  return entry('thinking', { thinkingContent: content, thinkingTruncated: content });
}

function generatingEntry(content = 'response text'): ActivityEntry {
  return entry('generating', { generatingContent: content, generatingTruncated: content, generatingChars: content.length });
}

function toolCompleteEntry(tool = 'Read', preview = 'file contents', toolUseId?: string): ActivityEntry {
  return entry('tool_complete', { tool, toolOutputPreview: preview, durationMs: 100, toolUseId });
}

function toolStartEntry(tool = 'Read', toolUseId?: string): ActivityEntry {
  return entry('tool_start', { tool, toolUseId });
}

describe('buildActivityLogText tail-window truncation', () => {
  it('under budget: all entries visible, no truncation', () => {
    const entries: ActivityEntry[] = [
      thinkingEntry(),
      toolCompleteEntry('Read'),
      toolCompleteEntry('Grep'),
      generatingEntry(),
    ];

    const result = buildActivityLogText(entries, false, Infinity);
    expect(result).toContain(':brain:');
    expect(result).toContain(':white_check_mark:');
    expect(result).toContain(':pencil:');
    expect(result).not.toContain('earlier entries');
  });

  it('tail window: most recent entries shown, old entries scroll off', () => {
    // 1 thinking at the start + 20 tool entries = 21 entries
    // With maxChars=1000, some early entries drop off the top
    const entries: ActivityEntry[] = [
      thinkingEntry(),
      ...Array.from({ length: 20 }, (_, i) => toolCompleteEntry('Read', `content ${i} padding text`)),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    // Most recent tool entries should be visible (they're at the tail)
    expect(result).toContain(':white_check_mark:');
    // Old entries scrolled off — should show "earlier entries" notice
    expect(result).toContain('earlier entries');
  });

  it('tools visible: tool entries are never preferentially dropped', () => {
    // Tools are the most recent entries — they MUST appear
    const entries: ActivityEntry[] = [
      thinkingEntry(),
      generatingEntry(),
      ...Array.from({ length: 10 }, (_, i) => toolCompleteEntry('Read', `content ${i} extra`)),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    // Tools are the most recent, so they must be visible
    expect(result).toContain(':white_check_mark:');
    // Must NOT show "tool calls" summary — no preferential dropping
    expect(result).not.toMatch(/tool calls?\s*\.\.\./);
  });

  it('tool_start dedup by toolUseId: hidden only when matching tool_complete exists', () => {
    const entries: ActivityEntry[] = [
      toolStartEntry('Read', 'tu_1'),
      toolCompleteEntry('Read', 'data', 'tu_1'),    // matches tu_1 — tool_start should be hidden
      toolStartEntry('Read', 'tu_2'),                // no matching complete — should show [in progress]
    ];

    const result = buildActivityLogText(entries, false, Infinity);
    // tool_complete for tu_1 should show
    expect(result).toContain(':white_check_mark:');
    // tool_start for tu_2 should show [in progress] (no matching complete)
    expect(result).toContain('[in progress]');
    // Only one [in progress] — tu_1's tool_start was deduped
    expect(result.match(/\[in progress\]/g)?.length).toBe(1);
  });

  it('hidden count: shows correct number of hidden entries', () => {
    // 25 tool entries, maxChars will force tail truncation
    const entries = Array.from({ length: 25 }, (_, i) => toolCompleteEntry('Read', `file ${i} with some extra text`));
    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toMatch(/_\.\.\. \d+ earlier entries \.\.\._/);
  });

  it('extreme: single huge entry falls back gracefully', () => {
    // Even one entry with huge preview won't fit in 100 chars
    const entries = [generatingEntry('x'.repeat(2000))];
    const result = buildActivityLogText(entries, false, 100);
    expect(result).toBe('_... activity too long ..._');
  });

  it('empty entries: returns default analyzing message', () => {
    const result = buildActivityLogText([], false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toContain('Analyzing request');
  });
});
