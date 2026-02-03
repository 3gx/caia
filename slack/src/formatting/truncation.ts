/**
 * Text truncation utilities with smart formatting preservation.
 */

/**
 * Truncate a file path, keeping the most relevant parts.
 * Prioritizes last 2 path segments for context.
 *
 * @example truncatePath('/very/long/path/to/file.ts', 25) → "path/to/file.ts"
 * @example truncatePath('/a/b/c.ts', 5) → "...ts"
 */
export function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return path.slice(-maxLen);
  // Keep last 2 segments
  const lastTwo = parts.slice(-2).join('/');
  return lastTwo.length <= maxLen ? lastTwo : '...' + path.slice(-(maxLen - 3));
}

/**
 * Simple text truncation with ellipsis.
 *
 * @example truncateText('Hello World!', 8) → "Hello..."
 */
export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Truncate a URL, showing hostname and shortened path.
 *
 * @example truncateUrl('https://example.com/very/long/path/to/page') → "example.com/very/long/pa..."
 */
export function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 20 ? u.pathname.slice(0, 17) + '...' : u.pathname;
    return u.hostname + path;
  } catch {
    return truncateText(url, 35);
  }
}

/**
 * Truncate text and close any open formatting markers.
 * Handles: ``` code blocks, ` inline code, * bold, _ italic, ~ strikethrough
 *
 * Finds good break points (newline > 80% → word boundary → hard split)
 * and ensures all formatting markers are properly closed.
 *
 * @param text - The text to truncate
 * @param limit - Maximum length including suffix
 * @returns Truncated text with closed formatting and truncation suffix
 */
export function truncateWithClosedFormatting(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Reserve space for suffix and potential closing markers
  const suffix = '\n\n_...truncated. Full response attached._';
  const maxContent = limit - suffix.length - 10; // 10 chars buffer for closing markers

  let truncated = text.substring(0, maxContent);

  // Find good break point (newline or space)
  const lastNewline = truncated.lastIndexOf('\n');
  const lastSpace = truncated.lastIndexOf(' ');
  const minBreak = Math.floor(maxContent * 0.8);
  const breakPoint = Math.max(
    lastNewline > minBreak ? lastNewline : -1,
    lastSpace > minBreak ? lastSpace : -1,
    minBreak
  );
  truncated = truncated.substring(0, breakPoint);

  // Close open code blocks (```)
  const codeBlockCount = (truncated.match(/```/g) || []).length;
  const insideCodeBlock = codeBlockCount % 2 === 1;
  if (insideCodeBlock) {
    truncated += '\n```';
  }

  // Only check inline formatting if NOT inside a code block
  if (!insideCodeBlock) {
    // Close open inline code (`) - count single backticks not part of ```
    const inlineCodeCount = (truncated.match(/(?<!`)`(?!`)/g) || []).length;
    if (inlineCodeCount % 2 === 1) {
      truncated += '`';
    }

    // Close open bold (*) - count single asterisks not part of ** or ***
    const boldCount = (truncated.match(/(?<!\*)\*(?!\*)/g) || []).length;
    if (boldCount % 2 === 1) {
      truncated += '*';
    }

    // Close open italic (_)
    const italicCount = (truncated.match(/(?<!_)_(?!_)/g) || []).length;
    if (italicCount % 2 === 1) {
      truncated += '_';
    }

    // Close open strikethrough (~)
    const strikeCount = (truncated.match(/~/g) || []).length;
    if (strikeCount % 2 === 1) {
      truncated += '~';
    }
  }

  return truncated + suffix;
}
