/**
 * Tracks aborted queries to prevent race conditions.
 */

const abortedQueries = new Set<string>();

export function markAborted(conversationKey: string): void {
  abortedQueries.add(conversationKey);
}

export function isAborted(conversationKey: string): boolean {
  return abortedQueries.has(conversationKey);
}

export function clearAborted(conversationKey: string): void {
  abortedQueries.delete(conversationKey);
}

export function reset(): void {
  abortedQueries.clear();
}
