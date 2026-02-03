/**
 * Unified status line formatting.
 * Renders: <mode> | <model> | [new] <session-id>
 */
import type { ProviderSessionInfo } from './types.js';

/**
 * Truncate session ID to first segment of UUID for display.
 * e.g., "c177e1d2-abc1-def2-ghi3-jkl4mnop5678" → "c177e1d2-..."
 */
function truncateSessionId(sessionId: string): string {
  // If it's a UUID format, show first segment + ellipsis
  const uuidParts = sessionId.split('-');
  if (uuidParts.length >= 2 && uuidParts[0].length >= 8) {
    return `${uuidParts[0]}-...`;
  }
  // Otherwise truncate to first 12 chars
  return sessionId.length > 12 ? sessionId.slice(0, 12) + '...' : sessionId;
}

/**
 * Format a unified status line from provider session info.
 *
 * Output format: `<mode> | <model> | [new] <session-id>`
 *
 * @example
 * // Claude
 * formatStatusLine({ mode: 'bypass', model: 'claude-opus-4-5-20251101', sessionId: 'c177e1d2-...', isNewSession: true })
 * // Returns: "bypass | claude-opus-4-5-20251101 | [new] c177e1d2-..."
 *
 * @example
 * // Codex
 * formatStatusLine({ mode: 'ask', model: 'gpt-5.2-codex [xhigh]', sessionId: '019c20ef-...' })
 * // Returns: "ask | gpt-5.2-codex [xhigh] | 019c20ef-..."
 */
export function formatStatusLine(session: ProviderSessionInfo): string {
  const parts: string[] = [];

  parts.push(session.mode);
  parts.push(session.model);

  const sessionDisplay = truncateSessionId(session.sessionId);
  if (session.isNewSession) {
    parts.push(`[new] ${sessionDisplay}`);
  } else {
    parts.push(sessionDisplay);
  }

  return parts.join(' | ');
}
