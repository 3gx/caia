/**
 * Error handling for the OpenCode Slack bot.
 * Principle: Bot must NEVER crash on invalid input. Always report error gracefully.
 */

export enum ErrorCode {
  // Slack errors
  SLACK_RATE_LIMITED = 'SLACK_RATE_LIMITED',
  SLACK_CHANNEL_NOT_FOUND = 'SLACK_CHANNEL_NOT_FOUND',
  SLACK_MESSAGE_TOO_LONG = 'SLACK_MESSAGE_TOO_LONG',
  SLACK_API_ERROR = 'SLACK_API_ERROR',

  // OpenCode errors
  OPENCODE_SDK_ERROR = 'OPENCODE_SDK_ERROR',
  OPENCODE_TIMEOUT = 'OPENCODE_TIMEOUT',

  // Session errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_FILE_MISSING = 'SESSION_FILE_MISSING',
  SESSION_FILE_CORRUPTED = 'SESSION_FILE_CORRUPTED',

  // File system errors
  WORKING_DIR_NOT_FOUND = 'WORKING_DIR_NOT_FOUND',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',
  FILE_DOWNLOAD_ERROR = 'FILE_DOWNLOAD_ERROR',

  // Git errors
  GIT_CONFLICT = 'GIT_CONFLICT',

  // Input errors
  INVALID_INPUT = 'INVALID_INPUT',
  EMPTY_MESSAGE = 'EMPTY_MESSAGE',

  // Approval errors
  APPROVAL_TIMEOUT = 'APPROVAL_TIMEOUT',
  APPROVAL_DECLINED = 'APPROVAL_DECLINED',
}

export class SlackBotError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean = false
  ) {
    super(message);
    this.name = 'SlackBotError';
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof SlackBotError) {
    switch (error.code) {
      case ErrorCode.SESSION_NOT_FOUND:
      case ErrorCode.SESSION_FILE_MISSING:
        return 'Session not found. Starting a new session.';
      case ErrorCode.SESSION_FILE_CORRUPTED:
        return 'Session data was corrupted. Starting a new session.';
      case ErrorCode.WORKING_DIR_NOT_FOUND:
        return 'Directory not found. Use `/cwd` to set a valid working directory.';
      case ErrorCode.GIT_CONFLICT:
        return 'Git conflicts detected. Proceeding anyway.';
      case ErrorCode.OPENCODE_SDK_ERROR:
        return `OpenCode encountered an error: ${error.message}`;
      case ErrorCode.OPENCODE_TIMEOUT:
        return 'Request timed out. Please try again.';
      case ErrorCode.SLACK_RATE_LIMITED:
        return 'Rate limited. Retrying...';
      case ErrorCode.SLACK_MESSAGE_TOO_LONG:
        return 'Response was too long and has been split into multiple messages.';
      case ErrorCode.SLACK_API_ERROR:
        return 'Failed to communicate with Slack. Please try again.';
      case ErrorCode.FILE_READ_ERROR:
        return `Could not read file: ${error.message}`;
      case ErrorCode.FILE_WRITE_ERROR:
        return `Could not write file: ${error.message}`;
      case ErrorCode.FILE_DOWNLOAD_ERROR:
        return `Could not download file: ${error.message}`;
      case ErrorCode.EMPTY_MESSAGE:
        return 'Please provide a message.';
      case ErrorCode.INVALID_INPUT:
        return `Invalid input: ${error.message}`;
      case ErrorCode.APPROVAL_TIMEOUT:
        return 'Approval request timed out.';
      case ErrorCode.APPROVAL_DECLINED:
        return 'Action was declined.';
      default:
        return error.message || 'An unexpected error occurred. Please try again.';
    }
  }

  if (isSlackError(error)) {
    if (error.data?.error === 'ratelimited') {
      return 'Rate limited. Retrying...';
    }
    if (error.data?.error === 'channel_not_found') {
      return 'Channel not found.';
    }
    return `Slack error: ${error.data?.error || 'Unknown error'}`;
  }

  if (error instanceof Error) {
    return error.message || 'An unexpected error occurred. Please try again.';
  }

  return 'An unexpected error occurred. Please try again.';
}

export function isRecoverable(error: unknown): boolean {
  if (error instanceof SlackBotError) {
    return error.recoverable;
  }

  if (isSlackError(error) && error.data?.error === 'ratelimited') {
    return true;
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
      return true;
    }
  }

  return false;
}

interface SlackApiError {
  data?: {
    error?: string;
    response_metadata?: {
      retry_after?: number;
    };
  };
}

function isSlackError(error: unknown): error is SlackApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof (error as SlackApiError).data === 'object'
  );
}

export function getRetryAfter(error: unknown): number | null {
  if (isSlackError(error)) {
    return error.data?.response_metadata?.retry_after ?? null;
  }
  return null;
}

export const Errors = {
  sessionNotFound: (sessionId: string) =>
    new SlackBotError(
      `Session ${sessionId} not found`,
      ErrorCode.SESSION_NOT_FOUND,
      false
    ),

  sessionFileMissing: (sessionId: string) =>
    new SlackBotError(
      `Session file for ${sessionId} is missing`,
      ErrorCode.SESSION_FILE_MISSING,
      false
    ),

  sessionFileCorrupted: (sessionId: string) =>
    new SlackBotError(
      `Session file for ${sessionId} is corrupted`,
      ErrorCode.SESSION_FILE_CORRUPTED,
      false
    ),

  opencodeError: (message: string) =>
    new SlackBotError(message, ErrorCode.OPENCODE_SDK_ERROR, true),

  opencodeTimeout: () =>
    new SlackBotError('OpenCode request timed out', ErrorCode.OPENCODE_TIMEOUT, true),

  invalidInput: (message: string) =>
    new SlackBotError(message, ErrorCode.INVALID_INPUT, false),

  emptyMessage: () =>
    new SlackBotError('Empty message', ErrorCode.EMPTY_MESSAGE, false),

  approvalTimeout: () =>
    new SlackBotError('Approval timed out', ErrorCode.APPROVAL_TIMEOUT, true),

  approvalDeclined: () =>
    new SlackBotError('Approval declined', ErrorCode.APPROVAL_DECLINED, false),
};
