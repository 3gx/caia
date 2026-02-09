/**
 * SDK Live Test: Delta Deduplication Diagnostic
 *
 * Captures raw delta events from a real Codex session to answer:
 *
 *  1. Does Codex actually send duplicate deltas via multiple event types?
 *  2. Do different event types carry different itemIds for the same content?
 *  3. What is the timing gap between duplicate events?
 *  4. How many event types fire per delta (2? 3? varies?)
 *  5. Does concatenating deltas from a single event type reconstruct the full response?
 *  6. Are there genuine repeated tokens (backticks, `=`, punctuation) that a
 *     content-only dedup would falsely drop?
 *
 * Run with: make codex-sdk-test
 *           or: npx vitest run tests/sdk-live/codex/delta-dedup-diagnostic.test.ts --config vitest.config.sdk-live.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RawNotification {
  /** Monotonically increasing counter — order of arrival */
  seq: number;
  /** High-resolution timestamp (ms since epoch) */
  ts: number;
  /** JSON-RPC method name, e.g. 'item/agentMessage/delta' */
  method: string;
  /** Full params object as received from Codex */
  params: Record<string, unknown>;
}

interface ParsedDelta {
  seq: number;
  ts: number;
  method: string;
  /** itemId extracted from params (top-level or nested in msg) */
  itemId: string;
  /** The actual delta text content */
  content: string;
  /** Length of content */
  contentLength: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createRequest(id: number, method: string, params?: Record<string, unknown>) {
  const request: Record<string, unknown> = { jsonrpc: '2.0', id, method };
  if (params) request.params = params;
  return JSON.stringify(request) + '\n';
}

/** Known delta event methods */
const DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'codex/event/agent_message_content_delta',
  'codex/event/agent_message_delta',
]);

/** Extract delta text from params regardless of nesting format */
function extractDelta(params: Record<string, unknown>): string {
  const msg = params.msg as Record<string, unknown> | undefined;
  const raw =
    params.delta || params.content || params.text ||
    msg?.delta || msg?.content || msg?.text || '';
  return String(raw);
}

/** Extract itemId from params regardless of nesting format */
function extractItemId(params: Record<string, unknown>): string {
  const msg = params.msg as Record<string, unknown> | undefined;
  const raw =
    params.itemId || params.item_id ||
    msg?.item_id || msg?.itemId || '';
  return String(raw);
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(SKIP_LIVE)('Delta Dedup Diagnostic', { timeout: 120000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** ALL notifications captured with sequence number and timestamp */
  const raw: RawNotification[] = [];
  let seq = 0;

  beforeAll(async () => {
    server = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    rl = readline.createInterface({
      input: server.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && responseHandlers.has(msg.id)) {
          const handler = responseHandlers.get(msg.id)!;
          responseHandlers.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message));
          else handler.resolve(msg.result);
        } else if (msg.method) {
          raw.push({
            seq: ++seq,
            ts: Date.now(),
            method: msg.method,
            params: msg.params ?? {},
          });
        }
      } catch {
        // ignore non-JSON
      }
    });

    await rpc('initialize', {
      clientInfo: { name: 'delta-dedup-diagnostic', version: '1.0.0' },
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
      setTimeout(() => {
        if (responseHandlers.has(id)) {
          responseHandlers.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 60000);
    });
  }

  // ─── Test 1: Simple prompt — captures ALL events for analysis ──────────

  it('captures raw delta events for dedup analysis (simple prompt)', async () => {
    raw.length = 0;
    seq = 0;

    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Simple prompt: short response, likely no tools
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'What is 2+2? Reply with just the number.' }],
    });

    // Wait for completion
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 50));
      if (raw.some((n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed')) break;
    }

    // ── Extract delta events ──
    const deltas: ParsedDelta[] = raw
      .filter((n) => DELTA_METHODS.has(n.method))
      .map((n) => ({
        seq: n.seq,
        ts: n.ts,
        method: n.method,
        itemId: extractItemId(n.params),
        content: extractDelta(n.params),
        contentLength: extractDelta(n.params).length,
      }));

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║         DELTA DEDUP DIAGNOSTIC — SIMPLE PROMPT              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // ── 1. Event type breakdown ──
    const byMethod = new Map<string, ParsedDelta[]>();
    for (const d of deltas) {
      if (!byMethod.has(d.method)) byMethod.set(d.method, []);
      byMethod.get(d.method)!.push(d);
    }

    console.log('─── 1. EVENT TYPE BREAKDOWN ───');
    console.log(`Total delta events received: ${deltas.length}`);
    for (const [method, list] of byMethod) {
      console.log(`  ${method}: ${list.length} events`);
    }
    console.log();

    // ── 2. Full event log ──
    console.log('─── 2. FULL EVENT LOG (every delta in arrival order) ───');
    for (const d of deltas) {
      const escaped = d.content.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      console.log(`  seq=${d.seq} ts=${d.ts} method=${d.method} itemId=${d.itemId} content=${JSON.stringify(escaped)} len=${d.contentLength}`);
    }
    console.log();

    // ── 3. Duplicate pair analysis ──
    // Group deltas by content to find potential duplicates
    console.log('─── 3. DUPLICATE PAIR ANALYSIS ───');

    // Within each 200ms window, group identical content from different methods
    const duplicateGroups: Array<{ content: string; events: ParsedDelta[] }> = [];
    const used = new Set<number>(); // seq numbers already grouped

    for (let i = 0; i < deltas.length; i++) {
      if (used.has(deltas[i].seq)) continue;
      const group = [deltas[i]];
      used.add(deltas[i].seq);

      for (let j = i + 1; j < deltas.length; j++) {
        if (used.has(deltas[j].seq)) continue;
        if (
          deltas[j].content === deltas[i].content &&
          Math.abs(deltas[j].ts - deltas[i].ts) <= 200
        ) {
          group.push(deltas[j]);
          used.add(deltas[j].seq);
        }
      }
      duplicateGroups.push({ content: deltas[i].content, events: group });
    }

    let trueDuplicateCount = 0;
    let genuineRepeatCount = 0;

    for (const g of duplicateGroups) {
      const methods = new Set(g.events.map((e) => e.method));
      if (g.events.length > 1 && methods.size > 1) {
        trueDuplicateCount++;
        const escaped = g.content.replace(/\n/g, '\\n');
        console.log(`  TRUE DUPLICATE: content=${JSON.stringify(escaped)}`);
        for (const e of g.events) {
          console.log(`    seq=${e.seq} method=${e.method} itemId=${e.itemId} ts=${e.ts}`);
        }
      } else if (g.events.length > 1 && methods.size === 1) {
        genuineRepeatCount++;
        const escaped = g.content.replace(/\n/g, '\\n');
        console.log(`  GENUINE REPEAT (same method): content=${JSON.stringify(escaped)}`);
        for (const e of g.events) {
          console.log(`    seq=${e.seq} method=${e.method} itemId=${e.itemId} ts=${e.ts}`);
        }
      }
    }

    console.log(`\n  Summary: ${trueDuplicateCount} true duplicates (cross-method), ${genuineRepeatCount} genuine repeats (same method)`);
    console.log();

    // ── 4. itemId comparison across methods ──
    console.log('─── 4. ITEM-ID COMPARISON ACROSS METHODS ───');
    const itemIdsByMethod = new Map<string, Set<string>>();
    for (const d of deltas) {
      if (!itemIdsByMethod.has(d.method)) itemIdsByMethod.set(d.method, new Set());
      itemIdsByMethod.get(d.method)!.add(d.itemId);
    }
    for (const [method, ids] of itemIdsByMethod) {
      console.log(`  ${method}: itemIds = [${[...ids].join(', ')}]`);
    }

    // Check: do methods share any itemIds?
    const allIdSets = [...itemIdsByMethod.values()];
    if (allIdSets.length >= 2) {
      const intersection = [...allIdSets[0]].filter((id) =>
        allIdSets.slice(1).every((s) => s.has(id))
      );
      console.log(`  Shared itemIds across ALL methods: [${intersection.join(', ')}]`);
      if (intersection.length === 0) {
        console.log('  CONFIRMED: Different event types have DIFFERENT itemIds for same content');
      } else {
        console.log('  FINDING: Some event types SHARE itemIds');
      }
    }
    console.log();

    // ── 5. Timing gap between duplicates ──
    console.log('─── 5. TIMING GAP BETWEEN DUPLICATE EVENTS ───');
    const gaps: number[] = [];
    for (const g of duplicateGroups) {
      if (g.events.length > 1 && new Set(g.events.map((e) => e.method)).size > 1) {
        // Sort by ts
        const sorted = [...g.events].sort((a, b) => a.ts - b.ts);
        for (let k = 1; k < sorted.length; k++) {
          const gap = sorted[k].ts - sorted[0].ts;
          gaps.push(gap);
          console.log(`  content=${JSON.stringify(g.content)} gap=${gap}ms (${sorted[0].method} → ${sorted[k].method})`);
        }
      }
    }
    if (gaps.length > 0) {
      console.log(`\n  Min gap: ${Math.min(...gaps)}ms`);
      console.log(`  Max gap: ${Math.max(...gaps)}ms`);
      console.log(`  Avg gap: ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}ms`);
    } else {
      console.log('  No duplicate pairs found — no timing gaps to measure');
    }
    console.log();

    // ── 6. Text reconstruction per method ──
    console.log('─── 6. TEXT RECONSTRUCTION PER METHOD ───');
    for (const [method, list] of byMethod) {
      // Sort by seq to preserve arrival order
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const reconstructed = sorted.map((d) => d.content).join('');
      console.log(`  ${method}:`);
      console.log(`    delta count: ${sorted.length}`);
      console.log(`    total chars: ${reconstructed.length}`);
      console.log(`    text: ${JSON.stringify(reconstructed)}`);
    }
    console.log();

    // ── 7. Naive dedup simulation (content-only, 100ms TTL — current bot logic) ──
    console.log('─── 7. NAIVE DEDUP SIMULATION (content-only, 100ms TTL) ───');
    {
      const hashes = new Map<string, number>(); // hash → timestamp
      const accepted: ParsedDelta[] = [];
      const dropped: ParsedDelta[] = [];

      for (const d of deltas) {
        const hash = d.content.slice(0, 100);
        const now = d.ts;

        // Clean expired
        for (const [h, ts] of hashes) {
          if (now - ts > 100) hashes.delete(h);
        }

        if (hashes.has(hash)) {
          dropped.push(d);
        } else {
          accepted.push(d);
          hashes.set(hash, now);
        }
      }

      const acceptedText = accepted.map((d) => d.content).join('');
      console.log(`  Accepted: ${accepted.length} deltas`);
      console.log(`  Dropped:  ${dropped.length} deltas`);
      console.log(`  Result text: ${JSON.stringify(acceptedText)} (${acceptedText.length} chars)`);
      console.log();

      // Classify drops
      let correctDrops = 0;
      let incorrectDrops = 0;
      for (const d of dropped) {
        // A drop is "correct" if the same content was also delivered by a different method
        // within the same 200ms window
        const sameContentDiffMethod = deltas.some(
          (other) =>
            other.seq !== d.seq &&
            other.content === d.content &&
            other.method !== d.method &&
            Math.abs(other.ts - d.ts) <= 200
        );
        if (sameContentDiffMethod) {
          correctDrops++;
        } else {
          incorrectDrops++;
          console.log(`  *** INCORRECT DROP: seq=${d.seq} method=${d.method} content=${JSON.stringify(d.content)} — this was a genuine token!`);
        }
      }
      console.log(`  Correct drops (true duplicates): ${correctDrops}`);
      console.log(`  INCORRECT drops (genuine tokens lost): ${incorrectDrops}`);
    }
    console.log();

    // ── 8. Method-aware dedup simulation (proposed fix) ──
    console.log('─── 8. METHOD-AWARE DEDUP SIMULATION ───');
    {
      const hashes = new Map<string, { ts: number; acceptedMethod: string }>();
      const accepted: ParsedDelta[] = [];
      const dropped: ParsedDelta[] = [];

      for (const d of deltas) {
        const hash = d.content.slice(0, 100);
        const now = d.ts;

        // Clean expired
        for (const [h, entry] of hashes) {
          if (now - entry.ts > 200) hashes.delete(h);
        }

        const existing = hashes.get(hash);
        if (!existing) {
          // First time seeing this content — accept
          accepted.push(d);
          hashes.set(hash, { ts: now, acceptedMethod: d.method });
        } else if (d.method === existing.acceptedMethod) {
          // Same method, same content — genuine repeated token — accept
          accepted.push(d);
          hashes.set(hash, { ts: now, acceptedMethod: d.method });
        } else {
          // Different method, same content within TTL — true duplicate — drop
          dropped.push(d);
        }
      }

      const acceptedText = accepted.map((d) => d.content).join('');
      console.log(`  Accepted: ${accepted.length} deltas`);
      console.log(`  Dropped:  ${dropped.length} deltas`);
      console.log(`  Result text: ${JSON.stringify(acceptedText)} (${acceptedText.length} chars)`);
    }
    console.log();

    // ── Dump raw data to file for offline analysis ──
    const dumpPath = path.join(process.cwd(), 'tests', 'sdk-live', 'codex', '.delta-dedup-dump-simple.json');
    fs.writeFileSync(dumpPath, JSON.stringify({ deltas, raw: raw.map((r) => ({ seq: r.seq, ts: r.ts, method: r.method, params: r.params })) }, null, 2));
    console.log(`Raw data dumped to: ${dumpPath}`);

    // ── Assertions (document what we found, don't prescribe) ──
    // We DO expect delta events to exist
    expect(deltas.length).toBeGreaterThan(0);
  });

  // ─── Test 2: Prompt with repeated characters ─────────────────────────────
  // This tests whether genuine repeated tokens are lost by content-only dedup

  it('captures raw delta events for dedup analysis (repeated characters prompt)', async () => {
    raw.length = 0;
    seq = 0;

    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Prompt designed to produce repeated tokens: backticks, equals signs, etc.
    await rpc('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Show me this exact text, nothing else:\n```\na = 42\nb = 84\n```',
      }],
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 50));
      if (raw.some((n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed')) break;
    }

    const deltas: ParsedDelta[] = raw
      .filter((n) => DELTA_METHODS.has(n.method))
      .map((n) => ({
        seq: n.seq,
        ts: n.ts,
        method: n.method,
        itemId: extractItemId(n.params),
        content: extractDelta(n.params),
        contentLength: extractDelta(n.params).length,
      }));

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║    DELTA DEDUP DIAGNOSTIC — REPEATED CHARACTERS PROMPT      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // ── Full event log ──
    console.log('─── FULL EVENT LOG ───');
    for (const d of deltas) {
      const escaped = d.content.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      console.log(`  seq=${d.seq} ts=${d.ts} method=${d.method} itemId=${d.itemId} content=${JSON.stringify(escaped)} len=${d.contentLength}`);
    }
    console.log();

    // ── Event type breakdown ──
    const byMethod = new Map<string, ParsedDelta[]>();
    for (const d of deltas) {
      if (!byMethod.has(d.method)) byMethod.set(d.method, []);
      byMethod.get(d.method)!.push(d);
    }

    console.log('─── EVENT TYPE BREAKDOWN ───');
    for (const [method, list] of byMethod) {
      console.log(`  ${method}: ${list.length} events`);
    }
    console.log();

    // ── Text reconstruction per method ──
    console.log('─── TEXT RECONSTRUCTION PER METHOD ───');
    for (const [method, list] of byMethod) {
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const reconstructed = sorted.map((d) => d.content).join('');
      console.log(`  ${method}:`);
      console.log(`    delta count: ${sorted.length}`);
      console.log(`    total chars: ${reconstructed.length}`);
      console.log(`    text: ${JSON.stringify(reconstructed)}`);
    }
    console.log();

    // ── Naive dedup simulation ──
    console.log('─── NAIVE DEDUP (content-only, 100ms TTL) ───');
    {
      const hashes = new Map<string, number>();
      const accepted: ParsedDelta[] = [];
      const dropped: ParsedDelta[] = [];

      for (const d of deltas) {
        const hash = d.content.slice(0, 100);
        const now = d.ts;
        for (const [h, ts] of hashes) {
          if (now - ts > 100) hashes.delete(h);
        }
        if (hashes.has(hash)) {
          dropped.push(d);
        } else {
          accepted.push(d);
          hashes.set(hash, now);
        }
      }

      const acceptedText = accepted.map((d) => d.content).join('');
      console.log(`  Accepted: ${accepted.length}, Dropped: ${dropped.length}`);
      console.log(`  Result: ${JSON.stringify(acceptedText)} (${acceptedText.length} chars)`);

      // Flag incorrect drops
      let incorrectDrops = 0;
      for (const d of dropped) {
        const sameContentDiffMethod = deltas.some(
          (other) =>
            other.seq !== d.seq &&
            other.content === d.content &&
            other.method !== d.method &&
            Math.abs(other.ts - d.ts) <= 200
        );
        if (!sameContentDiffMethod) {
          incorrectDrops++;
          console.log(`  *** INCORRECT DROP: seq=${d.seq} method=${d.method} content=${JSON.stringify(d.content)}`);
        }
      }
      console.log(`  Incorrect drops (data loss): ${incorrectDrops}`);
    }
    console.log();

    // ── Method-aware dedup simulation ──
    console.log('─── METHOD-AWARE DEDUP (proposed fix) ───');
    {
      const hashes = new Map<string, { ts: number; acceptedMethod: string }>();
      const accepted: ParsedDelta[] = [];
      const dropped: ParsedDelta[] = [];

      for (const d of deltas) {
        const hash = d.content.slice(0, 100);
        const now = d.ts;
        for (const [h, entry] of hashes) {
          if (now - entry.ts > 200) hashes.delete(h);
        }
        const existing = hashes.get(hash);
        if (!existing) {
          accepted.push(d);
          hashes.set(hash, { ts: now, acceptedMethod: d.method });
        } else if (d.method === existing.acceptedMethod) {
          accepted.push(d);
          hashes.set(hash, { ts: now, acceptedMethod: d.method });
        } else {
          dropped.push(d);
        }
      }

      const acceptedText = accepted.map((d) => d.content).join('');
      console.log(`  Accepted: ${accepted.length}, Dropped: ${dropped.length}`);
      console.log(`  Result: ${JSON.stringify(acceptedText)} (${acceptedText.length} chars)`);
    }
    console.log();

    // ── Dump ──
    const dumpPath = path.join(process.cwd(), 'tests', 'sdk-live', 'codex', '.delta-dedup-dump-repeated.json');
    fs.writeFileSync(dumpPath, JSON.stringify({ deltas, raw: raw.map((r) => ({ seq: r.seq, ts: r.ts, method: r.method, params: r.params })) }, null, 2));
    console.log(`Raw data dumped to: ${dumpPath}`);

    expect(deltas.length).toBeGreaterThan(0);
  });

  // ─── Test 3: Prompt with code block (the exact failing scenario) ─────────

  it('captures raw delta events for dedup analysis (code block — original bug scenario)', async () => {
    raw.length = 0;
    seq = 0;

    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // This is close to the prompt that produced the broken segment in the screenshot
    await rpc('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Write a Python snippet that assigns a = 42 and b = 84, with no explanation, just the code block.',
      }],
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 50));
      if (raw.some((n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed')) break;
    }

    const deltas: ParsedDelta[] = raw
      .filter((n) => DELTA_METHODS.has(n.method))
      .map((n) => ({
        seq: n.seq,
        ts: n.ts,
        method: n.method,
        itemId: extractItemId(n.params),
        content: extractDelta(n.params),
        contentLength: extractDelta(n.params).length,
      }));

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║   DELTA DEDUP DIAGNOSTIC — CODE BLOCK (ORIGINAL BUG)        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // ── Full event log ──
    console.log('─── FULL EVENT LOG ───');
    for (const d of deltas) {
      const escaped = d.content.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      console.log(`  seq=${d.seq} ts=${d.ts} method=${d.method} itemId=${d.itemId} content=${JSON.stringify(escaped)} len=${d.contentLength}`);
    }
    console.log();

    // ── Event type breakdown ──
    const byMethod = new Map<string, ParsedDelta[]>();
    for (const d of deltas) {
      if (!byMethod.has(d.method)) byMethod.set(d.method, []);
      byMethod.get(d.method)!.push(d);
    }

    console.log('─── EVENT TYPE BREAKDOWN ───');
    for (const [method, list] of byMethod) {
      console.log(`  ${method}: ${list.length} events`);
    }
    console.log();

    // ── Text reconstruction per method ──
    console.log('─── TEXT RECONSTRUCTION PER METHOD ───');
    const reconstructions: string[] = [];
    for (const [method, list] of byMethod) {
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const reconstructed = sorted.map((d) => d.content).join('');
      reconstructions.push(reconstructed);
      console.log(`  ${method}:`);
      console.log(`    delta count: ${sorted.length}`);
      console.log(`    total chars: ${reconstructed.length}`);
      console.log(`    text: ${JSON.stringify(reconstructed)}`);
    }
    console.log();

    // ── Cross-method content comparison ──
    if (reconstructions.length >= 2) {
      console.log('─── CROSS-METHOD CONTENT COMPARISON ───');
      const identical = reconstructions.every((r) => r === reconstructions[0]);
      console.log(`  All methods produce identical text: ${identical}`);
      if (!identical) {
        for (let i = 0; i < reconstructions.length; i++) {
          for (let j = i + 1; j < reconstructions.length; j++) {
            if (reconstructions[i] !== reconstructions[j]) {
              // Find first difference
              const minLen = Math.min(reconstructions[i].length, reconstructions[j].length);
              let diffAt = -1;
              for (let k = 0; k < minLen; k++) {
                if (reconstructions[i][k] !== reconstructions[j][k]) {
                  diffAt = k;
                  break;
                }
              }
              if (diffAt === -1) diffAt = minLen; // length difference
              console.log(`  Methods ${i} vs ${j} differ at char ${diffAt}`);
              console.log(`    Method ${i}: ...${JSON.stringify(reconstructions[i].slice(Math.max(0, diffAt - 10), diffAt + 10))}...`);
              console.log(`    Method ${j}: ...${JSON.stringify(reconstructions[j].slice(Math.max(0, diffAt - 10), diffAt + 10))}...`);
            }
          }
        }
      }
      console.log();
    }

    // ── Duplicate pair analysis with timing ──
    console.log('─── DUPLICATE PAIR ANALYSIS WITH TIMING ───');
    const used = new Set<number>();
    let pairCount = 0;
    const allGaps: number[] = [];

    for (let i = 0; i < deltas.length; i++) {
      if (used.has(deltas[i].seq)) continue;
      const group = [deltas[i]];
      used.add(deltas[i].seq);

      for (let j = i + 1; j < deltas.length; j++) {
        if (used.has(deltas[j].seq)) continue;
        if (
          deltas[j].content === deltas[i].content &&
          Math.abs(deltas[j].ts - deltas[i].ts) <= 200
        ) {
          group.push(deltas[j]);
          used.add(deltas[j].seq);
        }
      }

      if (group.length > 1) {
        const methods = new Set(group.map((e) => e.method));
        const type = methods.size > 1 ? 'CROSS-METHOD DUPLICATE' : 'SAME-METHOD REPEAT';
        pairCount++;

        const sorted = [...group].sort((a, b) => a.ts - b.ts);
        const gap = sorted[sorted.length - 1].ts - sorted[0].ts;
        if (methods.size > 1) allGaps.push(gap);

        console.log(`  ${type}: content=${JSON.stringify(group[0].content)} gap=${gap}ms`);
        for (const e of sorted) {
          console.log(`    seq=${e.seq} method=${e.method} itemId=${e.itemId} ts=${e.ts}`);
        }
      }
    }

    if (allGaps.length > 0) {
      console.log(`\n  Cross-method gaps: min=${Math.min(...allGaps)}ms max=${Math.max(...allGaps)}ms avg=${(allGaps.reduce((a, b) => a + b, 0) / allGaps.length).toFixed(1)}ms`);
    }
    console.log();

    // ── Both dedup simulations ──
    console.log('─── NAIVE DEDUP (content-only, 100ms TTL) ───');
    {
      const hashes = new Map<string, number>();
      const accepted: ParsedDelta[] = [];
      const dropped: ParsedDelta[] = [];

      for (const d of deltas) {
        const hash = d.content.slice(0, 100);
        const now = d.ts;
        for (const [h, ts] of hashes) {
          if (now - ts > 100) hashes.delete(h);
        }
        if (hashes.has(hash)) {
          dropped.push(d);
        } else {
          accepted.push(d);
          hashes.set(hash, now);
        }
      }

      const acceptedText = accepted.map((d) => d.content).join('');
      console.log(`  Accepted: ${accepted.length}, Dropped: ${dropped.length}`);
      console.log(`  Result: ${JSON.stringify(acceptedText)} (${acceptedText.length} chars)`);

      let incorrectDrops = 0;
      for (const d of dropped) {
        const sameContentDiffMethod = deltas.some(
          (other) =>
            other.seq !== d.seq &&
            other.content === d.content &&
            other.method !== d.method &&
            Math.abs(other.ts - d.ts) <= 200
        );
        if (!sameContentDiffMethod) {
          incorrectDrops++;
          console.log(`  *** INCORRECT DROP: seq=${d.seq} content=${JSON.stringify(d.content)}`);
        }
      }
      console.log(`  Incorrect drops (data loss): ${incorrectDrops}`);
    }
    console.log();

    console.log('─── METHOD-AWARE DEDUP (proposed fix) ───');
    {
      const hashes = new Map<string, { ts: number; acceptedMethod: string }>();
      const accepted: ParsedDelta[] = [];
      const dropped: ParsedDelta[] = [];

      for (const d of deltas) {
        const hash = d.content.slice(0, 100);
        const now = d.ts;
        for (const [h, entry] of hashes) {
          if (now - entry.ts > 200) hashes.delete(h);
        }
        const existing = hashes.get(hash);
        if (!existing) {
          accepted.push(d);
          hashes.set(hash, { ts: now, acceptedMethod: d.method });
        } else if (d.method === existing.acceptedMethod) {
          accepted.push(d);
          hashes.set(hash, { ts: now, acceptedMethod: d.method });
        } else {
          dropped.push(d);
        }
      }

      const acceptedText = accepted.map((d) => d.content).join('');
      console.log(`  Accepted: ${accepted.length}, Dropped: ${dropped.length}`);
      console.log(`  Result: ${JSON.stringify(acceptedText)} (${acceptedText.length} chars)`);
    }
    console.log();

    // ── Dump ──
    const dumpPath = path.join(process.cwd(), 'tests', 'sdk-live', 'codex', '.delta-dedup-dump-codeblock.json');
    fs.writeFileSync(dumpPath, JSON.stringify({ deltas, raw: raw.map((r) => ({ seq: r.seq, ts: r.ts, method: r.method, params: r.params })) }, null, 2));
    console.log(`Raw data dumped to: ${dumpPath}`);

    expect(deltas.length).toBeGreaterThan(0);
  });
});
