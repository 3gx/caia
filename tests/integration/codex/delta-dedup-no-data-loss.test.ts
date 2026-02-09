/**
 * Integration test: Delta deduplication preserves all genuine tokens.
 *
 * Verifies that the method-aware dedup in CodexClient correctly:
 *  1. Drops cross-method duplicates (same content from different Codex event types)
 *  2. Preserves genuine repeated tokens from the same method (e.g. ` =` appearing
 *     twice in `a = 42\nb = 84`)
 *
 * This test replays the EXACT event sequence captured by the SDK live test
 * (delta-dedup-diagnostic.test.ts) through a real CodexClient instance,
 * then verifies the emitted item:delta stream reconstructs the correct text
 * with zero data loss.
 */

import { describe, it, expect } from 'vitest';
import { CodexClient } from '../../../codex/src/codex-client.js';

// Replay data from SDK live test: "repeated characters prompt"
// Prompt: "Show me this exact text, nothing else:\n```\na = 42\nb = 84\n```"
// Expected output: "``" + "`\n" + "a" + " =" + " " + "42" + "\n" + "b" + " =" + " " + "84" + "\n" + "```"
// = "```\na = 42\nb = 84\n```"
//
// Each token arrives as a perfect triple from 3 methods (verified live data).
const LIVE_DELTAS: Array<{ method: string; itemId: string; content: string }> = [
  // Token 1: "``"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '``' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '``' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '``' },
  // Token 2: "`\n"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '`\n' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '`\n' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '`\n' },
  // Token 3: "a"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: 'a' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: 'a' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: 'a' },
  // Token 4: " =" (first occurrence — for `a =`)
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: ' =' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: ' =' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: ' =' },
  // Token 5: " "
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: ' ' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: ' ' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: ' ' },
  // Token 6: "42"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '42' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '42' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '42' },
  // Token 7: "\n"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '\n' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '\n' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '\n' },
  // Token 8: "b"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: 'b' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: 'b' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: 'b' },
  // Token 9: " =" (SECOND occurrence — for `b =`, identical content to token 4)
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: ' =' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: ' =' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: ' =' },
  // Token 10: " "
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: ' ' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: ' ' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: ' ' },
  // Token 11: "84"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '84' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '84' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '84' },
  // Token 12: "\n"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '\n' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '\n' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '\n' },
  // Token 13: "```"
  { method: 'codex/event/agent_message_content_delta', itemId: 'msg_test', content: '```' },
  { method: 'item/agentMessage/delta', itemId: 'msg_test', content: '```' },
  { method: 'codex/event/agent_message_delta', itemId: '', content: '```' },
];

const EXPECTED_TEXT = '```\na = 42\nb = 84\n```';
const EXPECTED_TOKEN_COUNT = 13; // 13 unique tokens, each delivered 3x = 39 raw events

describe('Delta dedup: no data loss on genuine repeated tokens', () => {
  it('reconstructs correct text from triple-delivered deltas (live replay)', () => {
    const client = new CodexClient({ requestTimeout: 10 });
    const received: Array<{ itemId: string; delta: string }> = [];
    client.on('item:delta', (ev: { itemId: string; delta: string }) => {
      received.push(ev);
    });

    // Replay all 39 raw events through the real CodexClient
    for (const d of LIVE_DELTAS) {
      const params: Record<string, unknown> =
        d.method === 'codex/event/agent_message_content_delta'
          ? { msg: { delta: d.content, item_id: d.itemId } }
          : d.method === 'codex/event/agent_message_delta'
            ? { msg: { delta: d.content } }
            : { delta: d.content, itemId: d.itemId };

      (client as any).handleNotification({ method: d.method, params });
    }

    // Must accept exactly 13 tokens — one per genuine token
    expect(received).toHaveLength(EXPECTED_TOKEN_COUNT);

    // Reconstructed text must match with zero data loss
    const text = received.map((r) => r.delta).join('');
    expect(text).toBe(EXPECTED_TEXT);
  });

  it('the OLD content-only dedup would have lost tokens (regression guard)', () => {
    // Simulate the old broken logic: content-only hash, drop if seen within window
    const hashes = new Map<string, boolean>();
    const accepted: string[] = [];

    for (const d of LIVE_DELTAS) {
      const hash = d.content.slice(0, 100);
      if (hashes.has(hash)) {
        continue; // Old logic: drop
      }
      hashes.set(hash, true);
      accepted.push(d.content);
    }

    // Old logic accepts fewer tokens than the 13 genuine ones
    expect(accepted.length).toBeLessThan(EXPECTED_TOKEN_COUNT);

    // And the reconstructed text is WRONG — missing characters
    const text = accepted.join('');
    expect(text).not.toBe(EXPECTED_TEXT);
    // Specifically: the second ` =` and second ` ` and second `\n` are lost
    expect(text.length).toBeLessThan(EXPECTED_TEXT.length);
  });
});
