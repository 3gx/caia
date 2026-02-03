/**
 * Markdown to Slack mrkdwn conversion utilities.
 */

/**
 * Parse a markdown table row into cells.
 * Handles escaped pipes (\|) within cell content.
 */
function parseTableRow(line: string): string[] {
  const placeholder = '\x00PIPE\x00';
  const escaped = line.replace(/\\\|/g, placeholder);
  return escaped
    .split('|')
    .slice(1, -1)  // Remove empty first/last from leading/trailing |
    .map(cell => cell.trim().replace(new RegExp(placeholder, 'g'), '|'));
}

/**
 * Normalize a markdown table (currently returns trimmed input).
 * Table normalization with formatting stripping is disabled pending investigation.
 */
export function normalizeTable(tableText: string): string {
  return tableText.trimEnd();
}

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Conversions:
 * - Bold: **text** or __text__ → *text*
 * - Italic: *text* or _text_ → _text_
 * - Bold+Italic: ***text*** or ___text___ → *_text_*
 * - Strikethrough: ~~text~~ → ~text~
 * - Links: [text](url) → <url|text>
 * - Headers: # Header → *Header*
 * - Tables: | col | col | → wrapped in code block (Slack doesn't support tables)
 * - Horizontal rules: --- → unicode line separator (28 ─ chars)
 *
 * Code blocks and inline code are protected from conversion.
 */
export function markdownToSlack(text: string): string {
  let result = text;

  // Protect code blocks from conversion
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `⟦CODE_BLOCK_${codeBlocks.length - 1}⟧`;
  });

  // Convert markdown tables to code blocks with normalized formatting
  result = result.replace(
    /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm,
    (table) => {
      const normalized = normalizeTable(table);
      const wrapped = '```\n' + normalized + '\n```';
      codeBlocks.push(wrapped);
      const suffix = table.endsWith('\n') ? '\n' : '';
      return `⟦CODE_BLOCK_${codeBlocks.length - 1}⟧${suffix}`;
    }
  );

  // Protect inline code
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `⟦INLINE_CODE_${inlineCode.length - 1}⟧`;
  });

  // Convert links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headers: # Header → temporary marker (will become bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '⟦B⟧$1⟦/B⟧');

  // Convert bold+italic combinations FIRST (before bold/italic separately)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '⟦BI⟧$1⟦/BI⟧');
  result = result.replace(/___(.+?)___/g, '⟦BI⟧$1⟦/BI⟧');

  // Convert bold: **text** or __text__ → temporary marker
  result = result.replace(/\*\*(.+?)\*\*/g, '⟦B⟧$1⟦/B⟧');
  result = result.replace(/__(.+?)__/g, '⟦B⟧$1⟦/B⟧');

  // Convert italic *text* → _text_ (safe now since bold/headers are marked)
  result = result.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Restore bold+italic markers to _*text*_ (italic wrapping bold)
  result = result.replace(/⟦BI⟧/g, '_*').replace(/⟦\/BI⟧/g, '*_');

  // Restore bold markers to *text*
  result = result.replace(/⟦B⟧/g, '*').replace(/⟦\/B⟧/g, '*');

  // Convert strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Convert horizontal rules: --- or *** or ___ → unicode line
  result = result.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '────────────────────────────');

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`⟦INLINE_CODE_${i}⟧`, inlineCode[i]);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`⟦CODE_BLOCK_${i}⟧`, codeBlocks[i]);
  }

  return result;
}

/**
 * Strip markdown code fence wrapper if present.
 *
 * Case A: Explicit ```markdown or ```md tag → Always strip
 * Case B: Code blocks with language tags (```python, etc.) → Never strip
 * Case C: Empty ``` (bare fence) → Don't strip (preserve as-is)
 *
 * @param content - The content to process
 */
export function stripMarkdownCodeFence(content: string): string {
  // Must start with ``` and end with ``` on its own line
  if (!content.startsWith('```')) return content;
  if (!/\n```\s*$/.test(content)) return content;

  // Find first newline
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) return content;

  // Extract first word as language tag (handles "js filename=x" info strings)
  const tagLine = content.slice(3, firstNewline).trim();
  const tag = tagLine.split(/\s/)[0].toLowerCase();

  // Helper to extract inner content
  const extractInner = (): string | null => {
    const afterFirstLine = content.slice(firstNewline + 1);
    const match = afterFirstLine.match(/^([\s\S]*)\n```\s*$/);
    return match ? match[1].replace(/\r$/, '') : null;
  };

  // CASE A: Explicit markdown/md tag → strip
  if (tag === 'markdown' || tag === 'md') {
    return extractInner() ?? content;
  }

  // CASE B: Non-empty tag that isn't markdown/md → don't strip (it's code)
  if (tag !== '') {
    return content;
  }

  // CASE C: Empty tag (bare fence) → don't strip
  return content;
}
