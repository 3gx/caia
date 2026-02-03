/**
 * Tool formatting utilities.
 * Unified tool name normalization, emoji mapping, and input summarization.
 */
import type { TodoItem } from './types.js';
import { truncatePath, truncateText, truncateUrl } from './truncation.js';
import { isTodoItem } from './todos.js';

/**
 * Tool emoji mapping.
 * Consolidated from both providers with all known tools.
 */
const TOOL_EMOJI: Record<string, string> = {
  Read: ':mag:',
  Glob: ':mag:',
  Grep: ':mag:',
  Edit: ':memo:',
  Write: ':memo:',
  Bash: ':computer:',
  Shell: ':computer:',
  WebFetch: ':globe_with_meridians:',
  WebSearch: ':globe_with_meridians:',
  Task: ':robot_face:',
  TodoWrite: ':clipboard:',
  NotebookEdit: ':notebook:',
  Skill: ':zap:',
  AskUserQuestion: ':question:',
  // Codex aliases
  CommandExecution: ':computer:',
  FileRead: ':mag:',
  FileWrite: ':memo:',
  FileChange: ':memo:',
};

/**
 * Canonical tool name mapping.
 * Maps alternative/legacy tool names to their display names.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  commandexecution: 'Bash',
  fileread: 'Read',
  filewrite: 'Write',
  shell: 'Bash',
  filechange: 'FileChange',
  file_change: 'FileChange',
  websearch: 'WebSearch',
  web_search: 'WebSearch',
};

/**
 * Normalize tool name for display and comparison.
 * Handles:
 * - MCP-style names like "mcp__claude-code__Read" → "Read"
 * - Legacy names like "commandExecution" → "Bash"
 * - Case normalization
 */
export function normalizeToolName(toolName: string): string {
  // Handle MCP-style names first
  let name = toolName;
  if (name.includes('__')) {
    name = name.split('__').pop()!;
  }

  // Check for aliases (case-insensitive)
  const alias = TOOL_NAME_ALIASES[name.toLowerCase()];
  if (alias) {
    return alias;
  }

  return name;
}

/**
 * Get emoji for a tool based on its name.
 * Uses substring matching for flexibility (e.g., 'TodoWrite' matches 'todo').
 * Falls back to normalized name lookup for exact matches.
 */
export function getToolEmoji(toolName?: string): string {
  if (!toolName) return ':gear:';

  // Try exact match first with normalized name
  const normalized = normalizeToolName(toolName);
  if (TOOL_EMOJI[normalized]) {
    return TOOL_EMOJI[normalized];
  }

  // Fallback to substring matching (Claude-style behavior)
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.includes('glob') || lower.includes('grep')) return ':mag:';
  if (lower.includes('edit') || lower.includes('write')) return ':memo:';
  if (lower.includes('bash') || lower.includes('shell')) return ':computer:';
  if (lower.includes('web') || lower.includes('fetch')) return ':globe_with_meridians:';
  if (lower.includes('task')) return ':robot_face:';
  if (lower.includes('todo')) return ':clipboard:';
  return ':gear:';
}

/**
 * Format SDK tool name for display.
 * Handles MCP-style names like "mcp__claude-code__Read" → "Read"
 * (Simpler version without normalization aliases for Claude compatibility)
 */
export function formatToolName(sdkToolName: string): string {
  if (!sdkToolName.includes('__')) return sdkToolName;
  return sdkToolName.split('__').pop()!;
}

/**
 * Get formatted tool name with emoji.
 * Returns: `emoji *NormalizedName*`
 */
export function formatToolNameWithEmoji(tool: string): string {
  const normalized = normalizeToolName(tool);
  const emoji = getToolEmoji(tool);
  return `${emoji} *${normalized}*`;
}

/**
 * Format tool input as compact inline summary for display.
 * Returns a short string with the key parameter for each tool type.
 *
 * @param toolName - The tool name (may be MCP-style or legacy)
 * @param input - Tool input (object or string for legacy support)
 * @returns Formatted summary string, or empty string if no relevant input
 */
export function formatToolInputSummary(toolName: string, input?: string | Record<string, unknown>): string {
  if (!input) return '';

  // Handle string input (legacy format)
  if (typeof input === 'string') {
    const truncated = input.length > 80 ? input.slice(0, 77) + '...' : input;
    return ` \`${truncated}\``;
  }

  const tool = normalizeToolName(toolName).toLowerCase();

  switch (tool) {
    // Tools with special UI - show tool name only (no input details)
    case 'askuserquestion':
      return '';  // Has its own button UI

    case 'read':
    case 'edit':
    case 'write':
    case 'filechange':
      return input.file_path ? ` \`${truncatePath(input.file_path as string, 40)}\`` : '';

    case 'grep':
      return input.pattern ? ` \`"${truncateText(input.pattern as string, 25)}"\`` : '';

    case 'glob':
      return input.pattern ? ` \`${truncateText(input.pattern as string, 30)}\`` : '';

    case 'bash':
    case 'commandexecution':
      return input.command ? ` \`${truncateText(input.command as string, 35)}\`` : '';

    case 'task':
      const subtype = input.subagent_type ? `:${input.subagent_type}` : '';
      const desc = input.description ? ` "${truncateText(input.description as string, 25)}"` : '';
      return `${subtype}${desc}`;

    case 'webfetch':
      return input.url ? ` \`${truncateUrl(input.url as string)}\`` : '';

    case 'websearch':
      if (input.query) {
        return ` "${truncateText(input.query as string, 30)}"`;
      }
      return input.url ? ` \`${truncateUrl(input.url as string)}\`` : '';

    case 'lsp':
      const op = input.operation || '';
      const file = input.filePath ? truncatePath(input.filePath as string, 25) : '';
      return op ? ` \`${op}\` \`${file}\`` : '';

    case 'todowrite': {
      const todoItems = Array.isArray(input.todos) ? input.todos.filter(isTodoItem) : [];
      if (todoItems.length === 0) return '';
      const completedCnt = todoItems.filter((t: TodoItem) => t.status === 'completed').length;
      const inProgressCnt = todoItems.filter((t: TodoItem) => t.status === 'in_progress').length;
      const pendingCnt = todoItems.filter((t: TodoItem) => t.status === 'pending').length;
      // Build compact status: "3✓ 1→ 5☐" (omit zeros)
      const parts: string[] = [];
      if (completedCnt > 0) parts.push(`${completedCnt}✓`);
      if (inProgressCnt > 0) parts.push(`${inProgressCnt}→`);
      if (pendingCnt > 0) parts.push(`${pendingCnt}☐`);
      return parts.length > 0 ? ` ${parts.join(' ')}` : '';
    }

    case 'notebookedit':
      return input.notebook_path ? ` \`${truncatePath(input.notebook_path as string, 35)}\`` : '';

    case 'skill':
      return input.skill ? ` \`${input.skill}\`` : '';

    default:
      // Generic fallback: show first meaningful string parameter
      const firstParam = Object.entries(input)
        .find(([k, v]) => typeof v === 'string' && v.length > 0 && v.length < 50 && !k.startsWith('_'));
      if (firstParam) {
        return ` \`${truncateText(String(firstParam[1]), 30)}\``;
      }
      return '';
  }
}
