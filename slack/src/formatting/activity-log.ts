/**
 * Shared activity log rendering for unified activity window across providers.
 *
 * Uses the tail-window pattern: shows the N most recent entries,
 * reduces N until text fits maxChars. Most recent activity is always visible,
 * old entries scroll off the top.
 */
import type { ActivityEntry } from './activity-types.js';
import type { Block } from '../blocks/types.js';
import { getToolEmoji, formatToolName, formatToolInputSummary } from './tools.js';
import { buildTextBlocks } from '../blocks/builders.js';
import {
  THINKING_TRUNCATE_LENGTH,
  ACTIVITY_LOG_MAX_CHARS,
  ROLLING_WINDOW_SIZE,
} from '../blocks/constants.js';

// Re-export constants so consumers can import from this module
export { THINKING_TRUNCATE_LENGTH, ACTIVITY_LOG_MAX_CHARS };

/** Max number of entries to consider for the tail window. */
export const MAX_DISPLAY_ENTRIES = ROLLING_WINDOW_SIZE;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape pipe characters in link labels to prevent Slack mrkdwn parsing issues.
 */
function escapeLinkLabel(label: string): string {
  return label.replace(/\|/g, '\u00A6');
}

/**
 * Wrap an activity label with a clickable link to its thread message.
 * If no link is provided, returns the label unchanged.
 */
export function linkifyActivityLabel(label: string, link?: string): string {
  if (!link) return label;
  return `<${link}|${escapeLinkLabel(label)}>`;
}

/**
 * Format result metrics as inline summary for main channel display.
 * Shows line counts, match counts, or edit diff depending on tool type.
 */
export function formatToolResultSummary(entry: ActivityEntry): string {
  if (entry.matchCount !== undefined) {
    return ` \u2192 ${entry.matchCount} ${entry.matchCount === 1 ? 'match' : 'matches'}`;
  }
  if (entry.lineCount !== undefined) {
    return ` (${entry.lineCount} lines)`;
  }
  if (entry.linesAdded !== undefined || entry.linesRemoved !== undefined) {
    return ` (+${entry.linesAdded || 0}/-${entry.linesRemoved || 0})`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// renderEntry — renders a single activity entry into lines
// ---------------------------------------------------------------------------

/**
 * Render a single activity entry, pushing one or more lines into the output array.
 */
export function renderEntry(entry: ActivityEntry, lines: string[]): void {
  const link = entry.threadMessageLink;
  switch (entry.type) {
    case 'starting': {
      const label = linkifyActivityLabel('Analyzing request...', link);
      lines.push(`:brain: *${label}*`);
      break;
    }
    case 'thinking': {
      const thinkingText = (typeof entry.thinkingTruncated === 'string' ? entry.thinkingTruncated : '') || entry.thinkingContent || '';
      const charCount = entry.thinkingContent?.length || thinkingText.length;
      const thinkingDuration = entry.durationMs
        ? ` [${(entry.durationMs / 1000).toFixed(1)}s]`
        : '';

      if (entry.thinkingInProgress) {
        const charIndicator = charCount > 0 ? ` _[${charCount} chars]_` : '';
        const label = linkifyActivityLabel('Thinking...', link);
        lines.push(`:brain: *${label}*${thinkingDuration}${charIndicator}`);
        if (thinkingText) {
          const displayText = thinkingText.replace(/\n/g, ' ').trim();
          const preview = displayText.length > 300
            ? displayText.substring(displayText.length - 300)
            : displayText;
          if (preview) {
            const prefix = thinkingText.startsWith('...') && !preview.startsWith('...') ? '...' : '';
            lines.push(`> ${prefix}${preview}`);
          }
        }
      } else {
        const truncatedIndicator = charCount > THINKING_TRUNCATE_LENGTH
          ? ` _[${charCount} chars]_`
          : '';
        const label = linkifyActivityLabel('Thinking', link);
        lines.push(`:brain: *${label}*${thinkingDuration}${truncatedIndicator}`);
        if (thinkingText) {
          const displayText = thinkingText.replace(/\n/g, ' ').trim();
          const preview = displayText.length > THINKING_TRUNCATE_LENGTH
            ? '...' + displayText.substring(displayText.length - THINKING_TRUNCATE_LENGTH)
            : displayText;
          if (preview) {
            lines.push(`> ${preview}`);
          }
        }
      }
      break;
    }
    case 'tool_start': {
      const startEmoji = getToolEmoji(entry.tool);
      const startInputSummary = formatToolInputSummary(entry.tool || '', entry.toolInput);
      const toolLabel = linkifyActivityLabel(formatToolName(entry.tool || 'Unknown'), link);
      lines.push(`${startEmoji} *${toolLabel}*${startInputSummary} [in progress]`);
      break;
    }
    case 'tool_complete': {
      const tcInputSummary = formatToolInputSummary(entry.tool || '', entry.toolInput);
      const resultSummary = formatToolResultSummary(entry);
      const tcDuration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      const errorFlag = entry.toolIsError ? ' :warning:' : '';
      const outputHint = (!entry.toolIsError && entry.toolOutputPreview)
        ? ` \u2192 \`${entry.toolOutputPreview.replace(/\s+/g, ' ').slice(0, 50)}${entry.toolOutputPreview.length > 50 ? '...' : ''}\``
        : '';
      const toolLabel = linkifyActivityLabel(formatToolName(entry.tool || 'Unknown'), link);
      lines.push(`:white_check_mark: *${toolLabel}*${tcInputSummary}${resultSummary}${outputHint}${tcDuration}${errorFlag}`);
      break;
    }
    case 'error': {
      const label = linkifyActivityLabel('Error', link);
      lines.push(`:x: ${label}: ${entry.message}`);
      break;
    }
    case 'generating': {
      const responseText = entry.generatingTruncated || entry.generatingContent || '';
      const responseCharCount = entry.generatingContent?.length || entry.generatingChars || responseText.length;
      const genDuration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      const charInfo = responseCharCount > 0 ? ` _[${responseCharCount.toLocaleString()} chars]_` : '';

      if (entry.generatingInProgress) {
        const label = linkifyActivityLabel('Generating...', link);
        lines.push(`:pencil: *${label}*${genDuration}${charInfo}`);
      } else {
        const label = linkifyActivityLabel('Response', link);
        lines.push(`:pencil: *${label}*${genDuration}${charInfo}`);
      }
      if (responseText) {
        const displayText = responseText.replace(/\n/g, ' ').trim();
        const preview = displayText.length > 300
          ? displayText.substring(0, 300) + '...'
          : displayText;
        if (preview) {
          lines.push(`> ${preview}`);
        }
      }
      break;
    }
    case 'mode_changed':
      lines.push(`:gear: Mode changed to *${entry.mode}*`);
      break;
    case 'context_cleared':
      lines.push('\u2500\u2500\u2500\u2500\u2500\u2500 Context Cleared \u2500\u2500\u2500\u2500\u2500\u2500');
      break;
    case 'session_changed': {
      if (entry.previousSessionId) {
        const prevCwd = entry.previousWorkingDir ? ` in \`${entry.previousWorkingDir}\`` : '';
        lines.push(`:bookmark: Previous: \`${entry.previousSessionId}\`${prevCwd}`);
        lines.push(`_Use_ \`/resume ${entry.previousSessionId}\` _to return_`);
      }
      if (entry.message) {
        const newCwd = entry.newWorkingDir ? ` in \`${entry.newWorkingDir}\`` : '';
        lines.push(`:arrow_forward: Resumed: \`${entry.message}\`${newCwd}`);
      }
      break;
    }
    case 'aborted': {
      const label = linkifyActivityLabel('Aborted by user', link);
      lines.push(`:octagonal_sign: *${label}*`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// buildActivityLogText — tail-window activity log
// ---------------------------------------------------------------------------

/**
 * Build activity log text for live display (during processing).
 *
 * Uses tail-window pattern: shows the N most recent entries, reduces N until
 * text fits maxChars. Most recent activity always visible, old entries scroll
 * off the top.
 *
 * @param entries - Full activity log
 * @param inProgress - Whether processing is still in progress (unused but kept for API symmetry)
 * @param maxChars - Maximum character limit for the output text
 */
export function buildActivityLogText(entries: ActivityEntry[], inProgress: boolean, maxChars: number = Infinity): string {
  // Dedup: filter out tool_start entries whose toolUseId has a matching tool_complete
  const completedIds = new Set<string>();
  for (const e of entries) {
    if (e.type === 'tool_complete' && e.toolUseId) completedIds.add(e.toolUseId);
  }
  const filtered = entries.filter(e =>
    !(e.type === 'tool_start' && e.toolUseId && completedIds.has(e.toolUseId))
  );

  if (filtered.length === 0) return ':brain: Analyzing request...';

  // Tail-window: start with MAX_DISPLAY_ENTRIES from the end, reduce until text fits maxChars
  let n = Math.min(filtered.length, MAX_DISPLAY_ENTRIES);
  while (n > 0) {
    const display = filtered.slice(-n);
    const hidden = filtered.length - n;
    const lines: string[] = [];
    if (hidden > 0) lines.push(`_... ${hidden} earlier entries ..._`);
    for (const entry of display) renderEntry(entry, lines);
    if (lines.length === 0) lines.push(':brain: Analyzing request...');
    const text = lines.join('\n');
    if (text.length <= maxChars) return text;
    n--;
  }
  return '_... activity too long ..._';
}

// ---------------------------------------------------------------------------
// Resume confirmation blocks — shared across providers
// ---------------------------------------------------------------------------

export interface ResumeConfirmationParams {
  resumedSessionId: string;
  workingDir: string;
  previousSessionId?: string;
  previousWorkingDir?: string;
  isNewChannel: boolean;
}

/**
 * Build blocks for a resume confirmation message.
 * Shared implementation so all providers (claude, opencode, codex) render identically.
 */
export function buildResumeConfirmationBlocks(params: ResumeConfirmationParams): Block[] {
  const { resumedSessionId, workingDir, previousSessionId, previousWorkingDir, isNewChannel } = params;
  const lines: string[] = [];

  if (previousSessionId) {
    const prevCwd = previousWorkingDir ? ` in \`${previousWorkingDir}\`` : '';
    lines.push(`:bookmark: Previous session: \`${previousSessionId}\`${prevCwd}`);
    lines.push(`_Use_ \`/resume ${previousSessionId}\` _to return_`);
    lines.push('');
  }

  lines.push(`Resuming session \`${resumedSessionId}\` in \`${workingDir}\``);

  if (isNewChannel) {
    lines.push(`Path locked to \`${workingDir}\``);
  } else if (previousWorkingDir && previousWorkingDir !== workingDir) {
    lines.push(`Path changed from \`${previousWorkingDir}\` to \`${workingDir}\``);
  }

  lines.push('');
  lines.push('Your next message will continue this session.');

  return buildTextBlocks(lines.join('\n'));
}
