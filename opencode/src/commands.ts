/**
 * Slash command parser and handlers for OpenCode Slack bot.
 */

import fs from 'fs';
import path from 'path';
import { Session, PermissionMode } from './session-manager.js';
import {
  Block,
  buildStatusDisplayBlocks,
  buildContextDisplayBlocks,
  buildModeSelectionBlocks,
  buildWatchingStatusSection,
} from './blocks.js';
import { getContinueCommand } from './concurrent-check.js';

// Thinking token limits (stored locally; OpenCode SDK does not enforce)
const THINKING_TOKENS_MIN = 1024;
const THINKING_TOKENS_MAX = 128000;
const THINKING_TOKENS_DEFAULT = 31999;

// Update rate limits (seconds)
export const UPDATE_RATE_MIN = 1;
export const UPDATE_RATE_MAX = 10;
export const UPDATE_RATE_DEFAULT = 3;

// Message size limits (Slack)
const MESSAGE_SIZE_MIN = 100;
const MESSAGE_SIZE_MAX = 36000; // ~90% of Slack 40k cap
export const MESSAGE_SIZE_DEFAULT = 500;

// Thinking message size for thread posts
export const THINKING_MESSAGE_SIZE = 3000;

export interface CommandResult {
  handled: boolean;
  response?: string;
  blocks?: Block[];
  isError?: boolean;
  sessionUpdate?: Partial<Session>;
  showModelSelection?: boolean;
  showModeSelection?: boolean;
  compactSession?: boolean;
  clearSession?: boolean;
  startTerminalWatch?: boolean;
  fastForward?: boolean;
  showPlan?: boolean;
  planFilePath?: string;
  deferredQuery?: string;  // Query to execute after model/mode selection
}

export const MODE_SHORTCUTS: Record<string, PermissionMode> = {
  plan: 'plan',
  ask: 'default',
  bypass: 'bypassPermissions',
  default: 'default',
};

export interface InlineModeResult {
  mode?: PermissionMode;
  remainingText: string;
  error?: string;
}

export interface MentionModeResult {
  mode?: PermissionMode;
  remainingText: string;
  error?: string;
}

export interface MentionModelResult {
  hasModelCommand: boolean;
  deferredQuery?: string;
  remainingText: string;
}

export function extractFirstMentionId(text: string): string | undefined {
  const match = text.match(/<@([A-Z0-9]+)>/i);
  return match?.[1];
}

export function extractMentionMode(text: string, botUserId: string): MentionModeResult {
  const normalized = text.replace(/\s+/g, ' ').trim();
  // Pattern: bot mention immediately followed by /mode (only whitespace allowed between)
  const pattern = new RegExp(`<@${botUserId}>\\s*/mode\\s+(\\S+)(?:\\s+(.*))?$`, 'i');

  const match = normalized.match(pattern);

  if (!match) {
    // No immediate /mode command found - remove all bot mentions and return remaining text
    const remainingText = normalized.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
    return { remainingText };
  }

  const modeArg = match[1].toLowerCase();
  const mode = MODE_SHORTCUTS[modeArg];

  if (!mode) {
    // Extract remaining text after the invalid mode command
    const afterMode = match[2] || '';
    const remainingText = afterMode.trim();
    return {
      remainingText,
      error: `Unknown mode \`${modeArg}\`. Valid modes: plan, ask, bypass`,
    };
  }

  // Extract remaining text after the mode command
  const afterMode = match[2] || '';
  const remainingText = afterMode.trim();

  return { mode, remainingText };
}

export function extractMentionModel(text: string, botUserId: string): MentionModelResult {
  const normalized = text.replace(/\s+/g, ' ').trim();
  // Pattern: bot mention immediately followed by /model (only whitespace allowed between)
  const pattern = new RegExp(`<@${botUserId}>\\s*/model(?:\\s+(.*))?$`, 'i');

  const match = normalized.match(pattern);

  if (!match) {
    // No immediate /model command found
    const remainingText = normalized.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
    return { hasModelCommand: false, remainingText };
  }

  // Extract the query after /model
  const deferredQuery = match[1] ? match[1].trim() : '';

  return {
    hasModelCommand: true,
    deferredQuery: deferredQuery || undefined,
    remainingText: deferredQuery,
  };
}

export function extractInlineMode(text: string): InlineModeResult {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const modePattern = /^\/mode\s+(\S+)/i;
  const match = normalized.match(modePattern);
  if (!match) return { remainingText: normalized };

  const modeArg = match[1].toLowerCase();
  const fullMatch = match[0];
  const mode = MODE_SHORTCUTS[modeArg];
  if (!mode) {
    return {
      remainingText: normalized,
      error: `Unknown mode \`${modeArg}\`. Valid modes: plan, ask, bypass`,
    };
  }

  const remainingText = normalized.replace(fullMatch, '').replace(/\s+/g, ' ').trim();
  return { mode, remainingText };
}

/**
 * Parse and handle slash commands.
 */
export function parseCommand(text: string, session: Session, threadTs?: string): CommandResult {
  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const [command, ...args] = text.slice(1).split(/\s+/);
  const argString = args.join(' ').trim();

  switch (command.toLowerCase()) {
    case 'mode':
      return handleMode(argString, session);
    case 'model':
      return handleModel(argString);
    case 'clear':
      return handleClear(session);
    case 'compact':
      return handleCompact(session);
    case 'status':
      return handleStatus(session);
    case 'context':
      return handleContext(session);
    case 'thinking':
      return handleThinking(argString, session);
    case 'path':
      return handlePath(argString, session);
    case 'cwd':
      return handleCwd(argString, session);
    case 'ls':
      return handleLs(argString, session);
    case 'cd':
      return handleCd(argString, session);
    case 'set-current-path':
      return handleSetCurrentPath(session);
    case 'show-plan':
      return handleShowPlan(session);
    case 'watch':
      return handleWatch(session, threadTs);
    case 'ff':
      return handleFastForward(session, threadTs);
    case 'continue':
      return handleContinue(session);
    case 'update-rate':
      return handleUpdateRate(argString, session);
    case 'message-size':
      return handleMessageSize(argString, session);
    default:
      return {
        handled: true,
        response: `Unknown command: \`/${command}\`\nType \`/status\` for current session info.`,
        isError: true,
      };
  }
}

function handleStatus(session: Session): CommandResult {
  return {
    handled: true,
    blocks: buildStatusDisplayBlocks({
      sessionId: session.sessionId,
      mode: session.mode,
      workingDir: session.workingDir,
      lastActiveAt: session.lastActiveAt,
      pathConfigured: session.pathConfigured,
      configuredBy: session.configuredBy,
      configuredAt: session.configuredAt,
      lastUsage: session.lastUsage,
      maxThinkingTokens: session.maxThinkingTokens,
      updateRateSeconds: session.updateRateSeconds,
      messageSize: session.threadCharLimit,
      planFilePath: session.planFilePath,
      planPresentationCount: session.planPresentationCount,
    }),
  };
}

function handleContext(session: Session): CommandResult {
  if (!session.lastUsage) {
    return {
      handled: true,
      response: 'No usage data yet. Run a query first.',
      isError: true,
    };
  }

  return {
    handled: true,
    blocks: buildContextDisplayBlocks(session.lastUsage),
  };
}

function handleMode(modeArg: string, session: Session): CommandResult {
  if (!modeArg) {
    return {
      handled: true,
      showModeSelection: true,
      blocks: buildModeSelectionBlocks(session.mode),
    };
  }

  const normalized = modeArg.toLowerCase();
  const mode = MODE_SHORTCUTS[normalized];
  if (!mode) {
    return {
      handled: true,
      response: `❌ Unknown mode \`${modeArg}\`. Usage: \`/mode [plan|ask|bypass]\``,
      isError: true,
    };
  }

  return {
    handled: true,
    response: `Mode set to \`${mode}\``,
    sessionUpdate: { mode },
  };
}

function handleModel(modelArg: string): CommandResult {
  const query = modelArg.trim();
  if (query) {
    return {
      handled: true,
      showModelSelection: true,
      deferredQuery: query,
    };
  }
  return { handled: true, showModelSelection: true };
}

function handleCompact(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session to compact. Start a conversation first.',
      isError: true,
    };
  }
  return { handled: true, compactSession: true };
}

function handleClear(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session to clear. Start a conversation first.',
      isError: true,
    };
  }
  return { handled: true, clearSession: true };
}

function handleThinking(args: string, session: Session): CommandResult {
  if (!args.trim()) {
    const current = session.maxThinkingTokens;
    if (current === 0) {
      return { handled: true, response: 'Thinking tokens: disabled' };
    }
    if (current === undefined) {
      return { handled: true, response: `Thinking tokens: ${THINKING_TOKENS_DEFAULT.toLocaleString()} (default)` };
    }
    return { handled: true, response: `Thinking tokens: ${current.toLocaleString()}` };
  }

  const value = parseInt(args.trim(), 10);
  if (Number.isNaN(value)) {
    return {
      handled: true,
      response: 'Invalid value. Provide a number (0 to disable, or 1,024-128,000).',
      isError: true,
    };
  }

  if (value !== 0 && (value < THINKING_TOKENS_MIN || value > THINKING_TOKENS_MAX)) {
    return {
      handled: true,
      response: `Value must be 0 or between ${THINKING_TOKENS_MIN.toLocaleString()} and ${THINKING_TOKENS_MAX.toLocaleString()}.`,
      isError: true,
    };
  }

  return {
    handled: true,
    response: value === 0 ? 'Thinking tokens disabled.' : `Thinking tokens set to ${value.toLocaleString()}.`,
    sessionUpdate: { maxThinkingTokens: value },
  };
}

function handlePath(pathArg: string, session: Session): CommandResult {
  const trimmed = pathArg.trim();
  if (!trimmed) {
    return {
      handled: true,
      response: `Current directory: \`${session.workingDir}\`\n\nUsage: \`/path <directory>\``,
    };
  }

  if (session.pathConfigured) {
    if (session.configuredPath === trimmed) {
      return {
        handled: true,
        response: `Path already locked to \`${session.configuredPath}\`.`,
      };
    }
    return {
      handled: true,
      response: `❌ Path is locked to \`${session.configuredPath}\`. It cannot be changed.`,
      isError: true,
    };
  }

  let targetPath = trimmed;
  if (!trimmed.startsWith('/')) {
    targetPath = path.resolve(session.workingDir, trimmed);
  }

  if (!fs.existsSync(targetPath)) {
    return {
      handled: true,
      response: `❌ Directory not found: \`${targetPath}\``,
      isError: true,
    };
  }

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return {
        handled: true,
        response: `❌ Not a directory: \`${targetPath}\``,
        isError: true,
      };
    }
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access directory: \`${targetPath}\``,
      isError: true,
    };
  }

  const normalized = fs.realpathSync(targetPath);

  return {
    handled: true,
    response: `Path locked to \`${normalized}\`.`,
    sessionUpdate: {
      workingDir: normalized,
      pathConfigured: true,
      configuredPath: normalized,
      configuredAt: Date.now(),
    },
  };
}

function handleCwd(pathArg: string, session: Session): CommandResult {
  const trimmed = pathArg.trim();
  if (!trimmed) {
    return {
      handled: true,
      response: `Current working directory: \`${session.workingDir}\``,
    };
  }

  if (session.pathConfigured) {
    if (session.configuredPath === trimmed) {
      return {
        handled: true,
        response: `Working directory already locked to \`${session.configuredPath}\`.`,
      };
    }
    return {
      handled: true,
      response: `❌ Working directory is locked to \`${session.configuredPath}\`. It cannot be changed.`,
      isError: true,
    };
  }

  return handlePath(trimmed, session);
}

function handleLs(pathArg: string, session: Session): CommandResult {
  const currentWorkingDir = session.workingDir || process.cwd();
  const pathConfigured = session.pathConfigured ?? false;
  const configuredPath = session.configuredPath;
  const trimmed = pathArg.trim();

  let targetDir: string;
  if (!trimmed) {
    targetDir = currentWorkingDir;
  } else if (trimmed.startsWith('/')) {
    targetDir = trimmed;
  } else {
    targetDir = path.resolve(currentWorkingDir, trimmed);
  }

  if (!fs.existsSync(targetDir)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${targetDir}\``,
      isError: true,
    };
  }

  try {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      return {
        handled: true,
        response: `❌ Not a directory: \`${targetDir}\``,
        isError: true,
      };
    }
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot access: \`${targetDir}\`\n\n${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }

  try {
    const files = fs.readdirSync(targetDir);
    const totalFiles = files.length;
    const fileList = files.map((entry) => {
      try {
        const stat = fs.statSync(path.join(targetDir, entry));
        return stat.isDirectory() ? `${entry}/` : entry;
      } catch {
        return entry;
      }
    }).join('\n');

    const hint = pathConfigured
      ? `:lock: Current locked directory: \`${configuredPath}\``
      : `To navigate: \`/cd <path>\`\nTo lock directory: \`/set-current-path\``;

    return {
      handled: true,
      response: `:file_folder: Files in \`${targetDir}\` (${totalFiles} total):\n\`\`\`\n${fileList || '(empty)'}\n\`\`\`\n\n${hint}`,
    };
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

function handleCd(pathArg: string, session: Session): CommandResult {
  const currentWorkingDir = session.workingDir || process.cwd();
  const pathConfigured = session.pathConfigured ?? false;
  const configuredPath = session.configuredPath;
  const trimmed = pathArg.trim();

  if (pathConfigured) {
    return {
      handled: true,
      response: `❌ /cd is disabled after path locked.\n\nWorking directory is locked to: \`${configuredPath}\`\n\nUse \`/ls [path]\` to explore other directories.`,
      isError: true,
    };
  }

  if (!trimmed) {
    return {
      handled: true,
      response: `Current directory: \`${currentWorkingDir}\`\n\nUsage: \`/cd <path>\` (relative or absolute)\n\nTo lock this directory: \`/set-current-path\``,
    };
  }

  let targetPath: string;
  if (trimmed.startsWith('/')) {
    targetPath = trimmed;
  } else {
    targetPath = path.resolve(currentWorkingDir, trimmed);
  }

  if (!fs.existsSync(targetPath)) {
    return {
      handled: true,
      response: `❌ Directory does not exist: \`${targetPath}\``,
      isError: true,
    };
  }

  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return {
      handled: true,
      response: `❌ Not a directory: \`${targetPath}\``,
      isError: true,
    };
  }

  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return {
      handled: true,
      response: `❌ Cannot access directory: \`${targetPath}\`\n\nPermission denied or directory not readable.`,
      isError: true,
    };
  }

  const normalized = fs.realpathSync(targetPath);
  return {
    handled: true,
    response: `📂 Changed to \`${normalized}\`\n\nUse \`/ls\` to see files, or \`/set-current-path\` to lock this directory.`,
    sessionUpdate: {
      workingDir: normalized,
    },
  };
}

function handleSetCurrentPath(session: Session): CommandResult {
  const currentWorkingDir = session.workingDir || process.cwd();
  const pathConfigured = session.pathConfigured ?? false;
  const configuredPath = session.configuredPath;

  if (pathConfigured) {
    return {
      handled: true,
      response: `❌ Working directory already locked: \`${configuredPath}\`\n\nThis cannot be changed. If you need a different directory, use a different channel.`,
      isError: true,
    };
  }

  let normalized: string;
  try {
    normalized = fs.realpathSync(currentWorkingDir);
  } catch (error) {
    return {
      handled: true,
      response: `❌ Cannot resolve path: \`${currentWorkingDir}\`\n\n${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }

  return {
    handled: true,
    response: `✅ Working directory locked to \`${normalized}\`\n\n⚠️ This cannot be changed. \`/cd\` is now disabled. All OpenCode operations will use this directory.`,
    sessionUpdate: {
      workingDir: normalized,
      pathConfigured: true,
      configuredPath: normalized,
      configuredAt: Date.now(),
    },
  };
}

function handleShowPlan(session: Session): CommandResult {
  if (!session.planFilePath) {
    return {
      handled: true,
      response: 'No plan file recorded for this session.',
      isError: true,
    };
  }
  return {
    handled: true,
    showPlan: true,
    planFilePath: session.planFilePath,
  };
}

function handleWatch(session: Session, threadTs?: string): CommandResult {
  if (threadTs) {
    return {
      handled: true,
      response: ':warning: `/watch` can only be used in the main channel, not in threads.',
      isError: true,
    };
  }

  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
      isError: true,
    };
  }

  const command = `cd ${session.workingDir} && ${getContinueCommand(session.sessionId)}`;
  const updateRate = session.updateRateSeconds ?? UPDATE_RATE_DEFAULT;

  return {
    handled: true,
    startTerminalWatch: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Continue in Terminal' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Run this command to continue your session locally:' } },
      { type: 'section', text: { type: 'mrkdwn', text: '```' + command + '```' } },
      { type: 'divider' },
      buildWatchingStatusSection(session.sessionId, updateRate),
    ],
  };
}

function handleFastForward(session: Session, threadTs?: string): CommandResult {
  if (threadTs) {
    return {
      handled: true,
      response: ':warning: `/ff` can only be used in the main channel, not in threads.',
      isError: true,
    };
  }

  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
      isError: true,
    };
  }

  return { handled: true, fastForward: true };
}

function handleContinue(session: Session): CommandResult {
  if (!session.sessionId) {
    return {
      handled: true,
      response: 'No active session. Start a conversation first.',
      isError: true,
    };
  }

  const command = `cd ${session.workingDir} && ${getContinueCommand(session.sessionId)}`;
  return {
    handled: true,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Continue in Terminal' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Run this command to continue your session locally:' } },
      { type: 'section', text: { type: 'mrkdwn', text: '```' + command + '```' } },
    ],
  };
}

function handleUpdateRate(args: string, session: Session): CommandResult {
  if (!args.trim()) {
    const current = session.updateRateSeconds;
    if (current === undefined) {
      return { handled: true, response: `Update rate: ${UPDATE_RATE_DEFAULT}s (default)` };
    }
    return { handled: true, response: `Update rate: ${current}s` };
  }

  const value = parseFloat(args.trim());
  if (Number.isNaN(value)) {
    return {
      handled: true,
      response: `Invalid value. Provide a number between ${UPDATE_RATE_MIN} and ${UPDATE_RATE_MAX} seconds.`,
      isError: true,
    };
  }

  if (value < UPDATE_RATE_MIN) {
    return {
      handled: true,
      response: `Invalid value. Minimum is ${UPDATE_RATE_MIN} second.`,
      isError: true,
    };
  }
  if (value > UPDATE_RATE_MAX) {
    return {
      handled: true,
      response: `Invalid value. Maximum is ${UPDATE_RATE_MAX} seconds.`,
      isError: true,
    };
  }

  return {
    handled: true,
    response: `Update rate set to ${value}s.`,
    sessionUpdate: { updateRateSeconds: value },
  };
}

function handleMessageSize(args: string, session: Session): CommandResult {
  if (!args.trim()) {
    const current = session.threadCharLimit;
    if (current === undefined) {
      return { handled: true, response: `Message size limit: ${MESSAGE_SIZE_DEFAULT} (default)` };
    }
    return { handled: true, response: `Message size limit: ${current}` };
  }

  const value = parseInt(args.trim(), 10);
  if (Number.isNaN(value)) {
    return {
      handled: true,
      response: `Invalid number. Usage: /message-size <${MESSAGE_SIZE_MIN}-${MESSAGE_SIZE_MAX}> (default=${MESSAGE_SIZE_DEFAULT})`,
      isError: true,
    };
  }

  if (value < MESSAGE_SIZE_MIN || value > MESSAGE_SIZE_MAX) {
    return {
      handled: true,
      response: `Value must be between ${MESSAGE_SIZE_MIN} and ${MESSAGE_SIZE_MAX}. Default is ${MESSAGE_SIZE_DEFAULT}.`,
      isError: true,
    };
  }

  return {
    handled: true,
    response: `Message size limit set to ${value}.`,
    sessionUpdate: { threadCharLimit: value },
  };
}
