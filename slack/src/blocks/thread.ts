/**
 * Shared thread message formatters.
 * Used for formatting activity entries posted to Slack threads.
 */

/**
 * Format starting message for thread posting.
 * Identical across providers.
 */
export function formatThreadStartingMessage(): string {
  return ':brain: *Analyzing request...*';
}

/**
 * Format error message for thread posting.
 * Uses consistent format: `:x: *Error:* {message}`
 *
 * @param message - Error message to display
 */
export function formatThreadErrorMessage(message: string): string {
  return `:x: *Error:* ${message}`;
}
