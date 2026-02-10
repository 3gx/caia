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

function toolCompleteEntry(tool = 'Read', preview = 'file contents'): ActivityEntry {
  return entry('tool_complete', { tool, toolOutputPreview: preview, durationMs: 100 });
}

describe('buildActivityLogText smart truncation', () => {
  it('Scenario 1: text before tools — thinking and generating survive', () => {
    // Simulates Issue 1 ordering: [thinking, thinking(spliced), generating, tool×10]
    const entries: ActivityEntry[] = [
      thinkingEntry(),
      thinkingEntry('more reasoning'),
      generatingEntry('The answer is 42'),
      ...Array.from({ length: 10 }, (_, i) => toolCompleteEntry('Read', `content of file ${i}`)),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toContain(':brain:');
    expect(result).toContain(':pencil:');
  });

  it('Scenario 2: tools first — thinking and generating survive at tail', () => {
    const entries: ActivityEntry[] = [
      ...Array.from({ length: 10 }, (_, i) => toolCompleteEntry('Bash', `output ${i}`)),
      thinkingEntry(),
      generatingEntry(),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toContain(':brain:');
    expect(result).toContain(':pencil:');
  });

  it('Scenario 3: no early text — thinking entries interleaved with tools', () => {
    const entries: ActivityEntry[] = [
      thinkingEntry('first round'),
      ...Array.from({ length: 5 }, () => toolCompleteEntry('Grep')),
      thinkingEntry('second round'),
      generatingEntry(),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    // Both thinking entries should be present
    expect(result.match(/:brain:/g)?.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain(':pencil:');
  });

  it('Many tools: thinking/generating visible, dropped tools show summary', () => {
    const entries: ActivityEntry[] = [
      thinkingEntry(),
      generatingEntry(),
      ...Array.from({ length: 20 }, (_, i) => toolCompleteEntry('Read', `content ${i} with some extra text to fill space`)),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toContain(':brain:');
    expect(result).toContain(':pencil:');
    // Should show dropped tool summary
    expect(result).toMatch(/\.\.\. \d+ tool calls? \.\.\./);
  });

  it('Under budget: all entries visible, no truncation', () => {
    const entries: ActivityEntry[] = [
      thinkingEntry(),
      toolCompleteEntry('Read'),
      toolCompleteEntry('Grep'),
      generatingEntry(),
    ];

    const result = buildActivityLogText(entries, false, Infinity);
    expect(result).toContain(':brain:');
    expect(result).toContain(':pencil:');
    expect(result).toContain(':white_check_mark:');
    expect(result).not.toContain('... ');
  });

  it('Extreme case: many thinking entries + many tools + generating survive', () => {
    const entries: ActivityEntry[] = [
      ...Array.from({ length: 5 }, (_, i) => thinkingEntry(`reasoning round ${i}`)),
      ...Array.from({ length: 30 }, (_, i) => toolCompleteEntry('Read', `file ${i} output`)),
      generatingEntry('Final answer'),
    ];

    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toContain(':brain:');
    expect(result).toContain(':pencil:');
  });

  it('Rolling window: 310 entries with early thinking/generating preserved', () => {
    const entries: ActivityEntry[] = [
      thinkingEntry('early thinking'),
      generatingEntry('early response'),
      // Fill up to 310 entries with tools
      ...Array.from({ length: 308 }, (_, i) => toolCompleteEntry('Read', `file ${i}`)),
    ];

    // With 310 entries (> MAX_LIVE_ENTRIES=300), the rolling window kicks in.
    // thinking and generating should still appear even though they're outside the tail window.
    const result = buildActivityLogText(entries, false, ACTIVITY_LOG_MAX_CHARS);
    expect(result).toContain(':brain:');
    expect(result).toContain(':pencil:');
    // Should show the rolling window notice
    expect(result).toContain('earlier entries');
  });
});
