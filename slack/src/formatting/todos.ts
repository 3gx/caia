/**
 * Todo list extraction and formatting utilities.
 */
import type { TodoItem, BaseActivityEntry } from './types.js';

/** Maximum characters for todo list display. */
export const TODO_LIST_MAX_CHARS = 500;

/**
 * Normalize tool name for todo extraction.
 * Handles MCP-style names like "mcp__claude-code__TodoWrite" → "todowrite"
 * Local implementation to avoid circular dependency with tools.ts
 */
function normalizeToolNameForTodos(toolName: string): string {
  let name = toolName;
  if (name.includes('__')) {
    name = name.split('__').pop()!;
  }
  return name.toLowerCase();
}

/**
 * Type guard to validate a todo item structure.
 */
export function isTodoItem(item: unknown): item is TodoItem {
  return typeof item === 'object' && item !== null &&
    'content' in item && typeof (item as any).content === 'string' &&
    'status' in item && ['pending', 'in_progress', 'completed'].includes((item as any).status);
}

/**
 * Extract the latest todo list from activity log.
 * Searches backwards for the most recent TodoWrite tool_complete entry.
 * Falls back to tool_start if no complete entry exists (for in-progress display).
 */
export function extractLatestTodos(activityLog: BaseActivityEntry[]): TodoItem[] {
  // Search backwards for the most recent TodoWrite entry
  for (let i = activityLog.length - 1; i >= 0; i--) {
    const entry = activityLog[i];
    const toolName = normalizeToolNameForTodos(entry.tool || '');

    // Prefer tool_complete entries
    if (entry.type === 'tool_complete' && toolName === 'todowrite') {
      // toolInput can be string (legacy) or object
      const toolInput = entry.toolInput;
      if (toolInput && typeof toolInput === 'object' && 'todos' in toolInput) {
        const todos = (toolInput as { todos?: unknown }).todos;
        if (Array.isArray(todos)) {
          return todos.filter(isTodoItem);
        }
      }
    }
  }

  // Fallback: check for tool_start if no complete entry found
  for (let i = activityLog.length - 1; i >= 0; i--) {
    const entry = activityLog[i];
    const toolName = normalizeToolNameForTodos(entry.tool || '');

    if (entry.type === 'tool_start' && toolName === 'todowrite') {
      // toolInput can be string (legacy) or object
      const toolInput = entry.toolInput;
      if (toolInput && typeof toolInput === 'object' && 'todos' in toolInput) {
        const todos = (toolInput as { todos?: unknown }).todos;
        if (Array.isArray(todos)) {
          return todos.filter(isTodoItem);
        }
      }
    }
  }

  return [];
}

/**
 * Format a single todo item for display.
 * Truncates text to 50 chars max.
 */
function formatTodoItem(item: TodoItem): string {
  const text = item.status === 'in_progress'
    ? (item.activeForm || item.content)
    : item.content;
  const truncated = text.length > 50 ? text.slice(0, 47) + '...' : text;

  switch (item.status) {
    case 'completed':
      return `:ballot_box_with_check: ~${truncated}~`;
    case 'in_progress':
      return `:arrow_right: *${truncated}*`;
    case 'pending':
      return `:white_large_square: ${truncated}`;
    default:
      return `:white_large_square: ${truncated}`;
  }
}

/**
 * Format todo list for display at top of activity message.
 * Implements smart truncation algorithm:
 * 1. Try to fit all items first
 * 2. If exceeds maxChars, prioritize in_progress items
 * 3. Show up to 3 most recent completed, pending items until limit
 * 4. Add summaries for truncated sections
 */
export function formatTodoListDisplay(todos: TodoItem[], maxChars: number = TODO_LIST_MAX_CHARS): string {
  if (todos.length === 0) return '';

  // Separate todos by status (preserving order)
  const completed: TodoItem[] = [];
  const inProgress: TodoItem[] = [];
  const pending: TodoItem[] = [];

  for (const todo of todos) {
    if (todo.status === 'completed') completed.push(todo);
    else if (todo.status === 'in_progress') inProgress.push(todo);
    else pending.push(todo);
  }

  const total = todos.length;
  const completedCount = completed.length;
  const allDone = completedCount === total;

  // Header: 📋 Tasks (completed/total) ✓ (checkmark when all done)
  const header = allDone
    ? `:clipboard: *Tasks (${completedCount}/${total})* :white_check_mark:`
    : `:clipboard: *Tasks (${completedCount}/${total})*`;

  // Special case: no in_progress items - add divider between completed and pending
  const hasInProgress = inProgress.length > 0;
  const needsDivider = !hasInProgress && completed.length > 0 && pending.length > 0;

  // Try to fit all items first
  const allLines = [
    ...completed.map(formatTodoItem),
    ...(needsDivider ? ['────'] : []),
    ...inProgress.map(formatTodoItem),
    ...pending.map(formatTodoItem),
  ];
  const fullText = [header, ...allLines].join('\n');

  if (fullText.length <= maxChars) {
    // All items fit - return full list
    return fullText;
  }

  // Smart truncation needed
  const lines: string[] = [header];
  let charCount = header.length;

  // Track truncation
  let completedShown = 0;
  let pendingShown = 0;
  const MAX_COMPLETED_SHOWN = 3;
  const MAX_PENDING_SHOWN = 3;

  // Helper to add line if it fits
  const addLine = (line: string): boolean => {
    if (charCount + 1 + line.length <= maxChars - 30) { // Reserve 30 chars for summaries
      lines.push(line);
      charCount += 1 + line.length;
      return true;
    }
    return false;
  };

  // Show last 3 completed (most recent)
  const completedToShow = completed.slice(-MAX_COMPLETED_SHOWN);
  const completedTruncated = completed.length - completedToShow.length;

  // Add completed truncation summary at top if needed
  if (completedTruncated > 0) {
    addLine(`...${completedTruncated} more completed`);
  }

  // Add shown completed items
  for (const item of completedToShow) {
    if (addLine(formatTodoItem(item))) completedShown++;
  }

  // Add all in_progress items (non-negotiable)
  for (const item of inProgress) {
    addLine(formatTodoItem(item));
  }

  // Add divider if no in_progress (between completed and pending)
  if (!hasInProgress && completed.length > 0 && pending.length > 0) {
    addLine('────');
  }

  // Add pending items until limit
  for (const item of pending.slice(0, MAX_PENDING_SHOWN)) {
    if (addLine(formatTodoItem(item))) pendingShown++;
    else break;
  }

  // Add pending truncation summary if needed
  const pendingTruncated = pending.length - pendingShown;
  if (pendingTruncated > 0) {
    lines.push(`...${pendingTruncated} more pending`);
  }

  return lines.join('\n');
}
