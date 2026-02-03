/**
 * Stats line formatting.
 * Renders capability-based stats - shows what's available, skips missing fields.
 */
import type { ProviderStats } from './types.js';
import { formatTokensK, formatTokenCount } from './tokens.js';

/**
 * Format a stats line from provider stats.
 *
 * Output format varies based on available data:
 * - Full (Claude): "9.5% ctx (87.7% 135.9k tok to ⚡) | 10/48 | $0.03 | 4.4s"
 * - Minimal (Codex): "96% left, 10.2k / 258.4k | 10.2k/30 | 4.3s"
 *
 * @param stats - Provider stats (whatever is available)
 * @returns Formatted stats string, or empty string if no stats
 */
export function formatStatsLine(stats: ProviderStats): string {
  const parts: string[] = [];

  // Context usage with auto-compact indicator (Claude-style)
  if (stats.compactPercent !== undefined && stats.tokensToCompact !== undefined && stats.contextPercent !== undefined) {
    parts.push(
      `${stats.contextPercent.toFixed(1)}% ctx (${stats.compactPercent.toFixed(1)}% ${formatTokensK(stats.tokensToCompact)} tok to :zap:)`
    );
  } else if (stats.contextPercent !== undefined && stats.contextWindow !== undefined) {
    // Codex-style: show percent left and used/total
    const percentLeft = (100 - stats.contextPercent).toFixed(0);
    const usedTokens = (stats.inputTokens ?? 0) + (stats.outputTokens ?? 0);
    const usedK = formatTokensK(usedTokens);
    const windowK = formatTokensK(stats.contextWindow);
    parts.push(`${percentLeft}% left, ${usedK} / ${windowK}`);
  } else if (stats.contextPercent !== undefined) {
    parts.push(`${stats.contextPercent.toFixed(1)}% ctx`);
  }

  // Tool count: "10/48" or just "10" if no total
  if (stats.toolsCompleted !== undefined) {
    if (stats.totalTools !== undefined) {
      parts.push(`${stats.toolsCompleted}/${stats.totalTools}`);
    } else {
      parts.push(`${stats.toolsCompleted}`);
    }
  }

  // Token I/O: "input/output" format
  if (stats.inputTokens !== undefined || stats.outputTokens !== undefined) {
    const inStr = formatTokenCount(stats.inputTokens ?? 0);
    const outStr = formatTokenCount(stats.outputTokens ?? 0);
    parts.push(`${inStr}/${outStr}`);
  }

  // Cost
  if (stats.costUsd !== undefined) {
    parts.push(`$${stats.costUsd.toFixed(2)}`);
  }

  // Duration
  if (stats.durationMs !== undefined) {
    parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  }

  // Rate limit indicator
  if (stats.rateLimitHits !== undefined && stats.rateLimitHits > 0) {
    parts.push(`:warning: ${stats.rateLimitHits}x rate limited`);
  }

  return parts.join(' | ');
}
