/**
 * Unified status line builder for all providers.
 *
 * Produces a 3-line Slack-formatted status:
 *   Line 1: mode | model [reasoning] | session [| title]
 *   Line 2: workingDir (when provided)
 *   Line 3: ctx | tokens | cost | duration | rate limits
 *
 * Uses params-object pattern so each provider only passes what it has.
 */
import type { StatusLineParams } from './activity-types.js';
import { formatTokensK, formatTokenCount } from './tokens.js';

/**
 * Map PermissionMode values to unified display labels.
 * Claude/opencode pass PermissionMode ('plan'|'default'|'bypassPermissions').
 * Codex passes UnifiedMode ('plan'|'ask'|'bypass') which maps to itself.
 */
const MODE_LABELS: Record<string, string> = {
  plan: 'plan',
  default: 'ask',
  bypassPermissions: 'bypass',
  ask: 'ask',
  bypass: 'bypass',
};

/**
 * Build a unified status line from provider params.
 *
 * @example
 * // Claude/opencode
 * buildUnifiedStatusLine({ mode: 'bypassPermissions', model: 'claude-opus-4-5', sessionId: 'abc123', workingDir: '/home/user/project' })
 * // → "_bypass | claude-opus-4-5 | abc123_\n_/home/user/project_"
 *
 * @example
 * // Codex
 * buildUnifiedStatusLine({ mode: 'bypass', model: 'gpt-5.2-codex', sandboxMode: 'workspace-write', reasoningEffort: 'xhigh' })
 * // → "_bypass [workspace-write] | gpt-5.2-codex [xhigh] | n/a_"
 */
export function buildUnifiedStatusLine(params: StatusLineParams): string {
  const line1Parts: string[] = [];

  // --- Mode ---
  const modeLabel = MODE_LABELS[params.mode] || params.mode;
  if (params.sandboxMode) {
    // Codex: mode [sandbox, auto-approve?]
    const autoApproveEnabled = params.autoApprove === true && params.sandboxMode !== 'danger-full-access';
    line1Parts.push(`${modeLabel} [${params.sandboxMode}${autoApproveEnabled ? ', auto-approve' : ''}]`);
  } else {
    line1Parts.push(modeLabel);
  }

  // --- Model ---
  let modelStr = params.model || 'n/a';
  if (params.reasoningEffort) {
    // Codex: model [effort]
    modelStr = `${modelStr} [${params.reasoningEffort}]`;
  } else if (params.reasoningTokens && params.reasoningTokens > 0) {
    // Claude/opencode: model [reasoning]
    modelStr += ' [reasoning]';
  }
  line1Parts.push(modelStr);

  // --- Session ---
  let sessionStr = params.sessionId || 'n/a';
  if (params.sessionId && params.isNewSession) {
    sessionStr = `[new] ${params.sessionId}`;
  }
  line1Parts.push(sessionStr);

  // --- Session title (full, no truncation) ---
  if (params.sessionTitle) {
    line1Parts.push(params.sessionTitle);
  }

  // --- Stats parts (Line 3) ---
  const statsParts: string[] = [];

  // Context usage — multiple formats depending on available data
  if (params.totalTokensUsed !== undefined && params.contextWindow !== undefined && params.contextWindow > 0) {
    // OpenCode format: "X% used (Yk / Zk)"
    const pct = Math.min(100, Math.max(0, Number(((params.totalTokensUsed / params.contextWindow) * 100).toFixed(1))));
    statsParts.push(`${pct.toFixed(1)}% used (${formatTokensK(params.totalTokensUsed)} / ${formatTokensK(params.contextWindow)})`);
  } else if (params.contextTokens !== undefined && params.contextWindow !== undefined && params.contextPercent !== undefined) {
    // Codex format: "X% left, Yk / Zk"
    const percentLeft = (100 - params.contextPercent).toFixed(0);
    statsParts.push(`${percentLeft}% left, ${formatTokensK(params.contextTokens)} / ${formatTokensK(params.contextWindow)}`);
  } else if (params.contextPercent !== undefined) {
    // Claude compact info format
    if (params.compactPercent !== undefined && params.tokensToCompact !== undefined) {
      statsParts.push(`${params.contextPercent.toFixed(1)}% ctx (${params.compactPercent.toFixed(1)}% ${formatTokensK(params.tokensToCompact)} tok to \u26A1)`);
    } else if (params.compactPercent !== undefined) {
      statsParts.push(`${params.contextPercent.toFixed(1)}% ctx (${params.compactPercent.toFixed(1)}% to \u26A1)`);
    } else {
      statsParts.push(`${params.contextPercent.toFixed(1)}% ctx`);
    }
  }

  // Tokens: input/output
  if (params.inputTokens !== undefined || params.outputTokens !== undefined) {
    const inStr = formatTokenCount(params.inputTokens ?? 0);
    const outStr = formatTokenCount(params.outputTokens ?? 0);
    statsParts.push(`${inStr}/${outStr}`);
  }

  // Cost
  if (params.cost !== undefined) {
    statsParts.push(`$${params.cost.toFixed(2)}`);
  }

  // Duration
  if (params.durationMs !== undefined) {
    statsParts.push(`${(params.durationMs / 1000).toFixed(1)}s`);
  }

  // Rate limit warning
  if (params.rateLimitHits && params.rateLimitHits > 0) {
    statsParts.push(`:warning: ${params.rateLimitHits} limits`);
  }

  // --- Assemble lines ---
  const lines: string[] = [`_${line1Parts.join(' | ')}_`];

  if (params.workingDir) {
    lines.push(`_${params.workingDir}_`);
  }

  if (statsParts.length > 0) {
    lines.push(`_${statsParts.join(' | ')}_`);
  }

  return lines.join('\n');
}
