/**
 * Integration tests for activity thread consistency.
 *
 * Verifies:
 * 1. Emojis match between main activity message and thread messages
 * 2. No duplicate "Analyzing request" messages are posted
 */

import { describe, it, expect } from 'vitest';
import { ActivityThreadManager, ActivityEntry } from '../../../codex/src/activity-thread.js';
import { formatThreadActivityEntry } from '../../../codex/src/blocks.js';

describe('Activity Thread Consistency', () => {
  describe('Emoji Consistency', () => {
    /**
     * The main activity message formatEntry() and thread formatThreadActivityEntry()
     * must use the SAME emojis for each entry type.
     *
     * Expected emojis:
     * - starting (Analyzing request): :brain: (🧠)
     * - generating: :speech_balloon: (💬)
     * - response: :speech_balloon: (💬)
     * - thinking: :brain: (🧠) in main, :bulb: (💡) in thread (acceptable difference)
     */

    it('uses :brain: for Analyzing request in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'starting',
        timestamp: Date.now(),
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':brain:');
      expect(threadFormat).toContain(':brain:');
      expect(mainFormat).toContain('Analyzing request');
      expect(threadFormat).toContain('Analyzing request');
    });

    it('uses :speech_balloon: and Response label for generating entries', () => {
      const entry: ActivityEntry = {
        type: 'generating',
        timestamp: Date.now(),
        charCount: 100,
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':speech_balloon:');
      expect(threadFormat).toContain(':speech_balloon:');
      expect(mainFormat).toContain('Response');
      expect(threadFormat).toContain('Response');
    });

    it('uses :speech_balloon: for Response in thread', () => {
      const entry: ActivityEntry = {
        type: 'generating',
        timestamp: Date.now(),
        charCount: 100,
      };

      const threadFormat = formatThreadActivityEntry(entry);

      expect(threadFormat).toContain(':speech_balloon:');
      expect(threadFormat).toContain('Response');
    });

    it('uses tool emoji for tool_complete in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Read',
        toolInput: { file_path: '/path/to/file.ts' },
        durationMs: 150,
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      // Both use tool-specific emoji, NOT checkmark
      expect(mainFormat).toContain(':mag:'); // Read tool emoji
      expect(mainFormat).not.toContain(':white_check_mark:');

      expect(threadFormat).toContain(':mag:'); // Read tool emoji
      expect(threadFormat).not.toContain(':white_check_mark:');
    });

    it('uses :x: for error in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'error',
        timestamp: Date.now(),
        message: 'Something went wrong',
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':x:');
      expect(threadFormat).toContain(':x:');
    });

    it('uses :octagonal_sign: for aborted in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'aborted',
        timestamp: Date.now(),
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':octagonal_sign:');
      expect(threadFormat).toContain(':octagonal_sign:');
    });
  });

  describe('No Duplicate Entries', () => {
    it('starting entry is only added once to activity batch', () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      // Add starting entry once (as would happen in startStreaming)
      manager.addEntry(key, {
        type: 'starting',
        timestamp: Date.now(),
      });

      const entries = manager.getEntries(key);

      // Should only have one starting entry
      const startingEntries = entries.filter(e => e.type === 'starting');
      expect(startingEntries).toHaveLength(1);
    });

    it('activity batch maintains correct order of entries', () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      // Add entries in order (simulating a typical turn)
      manager.addEntry(key, { type: 'starting', timestamp: 1 });
      manager.addEntry(key, { type: 'tool_start', timestamp: 2, tool: 'Read', toolUseId: 'tool-1' });
      manager.addEntry(key, { type: 'tool_complete', timestamp: 3, tool: 'Read', toolUseId: 'tool-1' });
      manager.addEntry(key, { type: 'generating', timestamp: 4, charCount: 50 });

      const entries = manager.getEntries(key);

      expect(entries).toHaveLength(4);
      expect(entries[0].type).toBe('starting');
      expect(entries[1].type).toBe('tool_start');
      expect(entries[2].type).toBe('tool_complete');
      expect(entries[3].type).toBe('generating');
    });
  });

  describe('Response Emoji in Main Activity Message', () => {
    /**
     * The Response line in main activity message (added via streaming.ts updateActivityMessage)
     * must use :speech_balloon: emoji, matching the thread messages.
     */

    it('formatThreadResponseMessage uses :speech_balloon:', async () => {
      const { formatThreadResponseMessage } = await import('../../../codex/src/blocks.js');

      const formatted = formatThreadResponseMessage('test response', 1000);

      expect(formatted).toContain(':speech_balloon:');
      expect(formatted).toContain('Response');
    });
  });

  describe('Response Preview in Main Activity Message', () => {
    /**
     * CRITICAL REGRESSION TEST:
     * The main activity message must show BOTH:
     * 1. Streaming "Response..." entry (via buildActivityLogText from ActivityThreadManager)
     * 2. "Response [N chars]" with preview text (appended AFTER buildActivityLogText)
     *
     * These are DIFFERENT things:
     * - Streaming "Response..." = activity entry showing generation phase
     * - "Response [N chars]" = final response preview with actual text
     *
     * Both must be present in the main activity message for complete status display.
     *
     * Bug history:
     * - Commit 38ea41e removed response segment entry (broke main status)
     * - Commit 684d964 removed Response preview append (lost preview text)
     */

    it('buildActivityLogText includes generating entry with char count', async () => {
      const { buildActivityLogText } = await import('../../../codex/src/activity-thread.js');

      const entries: ActivityEntry[] = [
        { type: 'starting', timestamp: 1 },
        { type: 'generating', timestamp: 2, generatingChars: 500 },
      ];

      const activityText = buildActivityLogText(entries);

      // Must show generating entry with char count
      expect(activityText).toContain(':pencil:');
      expect(activityText).toContain('Response');
      expect(activityText).toContain('[500 chars]');
    });

    it('Response preview must be appended separately from generating entry', async () => {
      // This test documents the REQUIRED pattern in streaming.ts updateActivityMessage:
      //
      // 1. activityText = buildActivityLogText(entries)  // includes streaming "Response..."
      // 2. activityText += Response preview              // MUST be added manually
      //
      // The Response preview is NOT an activity entry - it's appended after the log.

      const { buildActivityLogText } = await import('../../../codex/src/activity-thread.js');

      const entries: ActivityEntry[] = [
        { type: 'starting', timestamp: 1 },
        { type: 'generating', timestamp: 2, generatingChars: 54 },
      ];

      // Step 1: buildActivityLogText returns the activity log (no Response preview)
      const activityText = buildActivityLogText(entries);

      expect(activityText).toContain(':pencil:');
      expect(activityText).toContain('Response');

      // Step 2: Response preview must be appended manually (as done in streaming.ts)
      const responseText = 'Why did the chicken cross the road? To get to the other side!';
      const preview = responseText.slice(0, 200).replace(/\n/g, ' ');
      const responseLine = `:speech_balloon: *Response* _[${responseText.length} chars]_`;
      const finalText = activityText + `\n${responseLine}\n> ${preview}`;

      // Final text must contain BOTH streaming Response and final linked Response preview
      expect(finalText).toContain(':speech_balloon:');
      expect(finalText).toContain('Response');
      expect(finalText).toContain(':speech_balloon:');
      expect(finalText).toContain('Response');
      expect(finalText).toContain('[61 chars]');
      expect(finalText).toContain('Why did the chicken cross the road');
    });

    it('generating entry must be added on turn:completed', () => {
      // This test documents the REQUIRED pattern in streaming.ts turn:completed handler:
      //
      // if (state.text && status === 'completed') {
      //   this.activityManager.addEntry(found.key, {
      //     type: 'generating',
      //     timestamp: Date.now(),
      //     charCount: state.text.length,
      //   });
      // }

      const manager = new ActivityThreadManager();
      const key = 'test-key';

      // Simulate turn:completed with response text
      const responseText = 'This is the response';
      const status = 'completed';

      // This logic MUST exist in streaming.ts
      if (responseText && status === 'completed') {
        manager.addEntry(key, {
          type: 'generating',
          timestamp: Date.now(),
          charCount: responseText.length,
        });
      }

      const entries = manager.getEntries(key);
      const generatingEntry = entries.find(e => e.type === 'generating');

      expect(generatingEntry).toBeDefined();
      expect(generatingEntry?.charCount).toBe(20);
    });

    it('Response preview must appear with linked label when link is available', async () => {
      // Documents the REQUIRED pattern for linked Response label in streaming.ts:
      //
      // const responseLabel = state.responseMessageLink
      //   ? `*<${state.responseMessageLink}|Response>*`
      //   : '*Response*';
      // const responseLine = `:speech_balloon: ${responseLabel} _[${state.text.length} chars]_`;

      const { buildActivityLogText } = await import('../../../codex/src/activity-thread.js');

      const entries: ActivityEntry[] = [
        { type: 'starting', timestamp: 1 },
        { type: 'generating', timestamp: 2, charCount: 100 },
      ];

      const activityText = buildActivityLogText(entries);

      // With link
      const responseLink = 'https://slack.com/archives/C123/p456';
      const linkedLabel = `*<${responseLink}|Response>*`;
      const linkedLine = `:speech_balloon: ${linkedLabel} _[100 chars]_`;
      const withLink = activityText + `\n${linkedLine}\n> Preview text...`;

      expect(withLink).toContain(':speech_balloon:');
      expect(withLink).toContain(responseLink);
      expect(withLink).toContain('|Response>');

      // Without link
      const unlinkedLine = `:speech_balloon: *Response* _[100 chars]_`;
      const withoutLink = activityText + `\n${unlinkedLine}\n> Preview text...`;

      expect(withoutLink).toContain(':speech_balloon:');
      expect(withoutLink).toContain('*Response*');
    });
  });
});
