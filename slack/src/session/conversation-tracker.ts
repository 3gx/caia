export interface ActiveContext {
  conversationKey: string;
  sessionId: string;
  statusMsgTs: string;
  originalTs: string;
  startTime: number;
  userId?: string;
  query?: string;
}

export class ConversationTracker<T extends ActiveContext> {
  private busySessions = new Set<string>();
  private contexts = new Map<string, T>();

  isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  startProcessing(sessionId: string, context: T): boolean {
    if (this.busySessions.has(sessionId)) {
      return false;
    }
    this.busySessions.add(sessionId);
    this.contexts.set(context.conversationKey, context);
    return true;
  }

  stopProcessing(sessionId: string): void {
    this.busySessions.delete(sessionId);
    for (const [key, context] of this.contexts.entries()) {
      if (context.sessionId === sessionId) {
        this.contexts.delete(key);
      }
    }
  }

  getContext(conversationKey: string): T | undefined {
    return this.contexts.get(conversationKey);
  }

  getContextBySessionId(sessionId: string): T | undefined {
    for (const context of this.contexts.values()) {
      if (context.sessionId === sessionId) {
        return context;
      }
    }
    return undefined;
  }

  updateContext(conversationKey: string, updates: Partial<T>): void {
    const existing = this.contexts.get(conversationKey);
    if (!existing) {
      return;
    }
    this.contexts.set(conversationKey, { ...existing, ...updates });
  }

  clearContext(conversationKey: string): void {
    this.contexts.delete(conversationKey);
  }

  getBusySessions(): string[] {
    return Array.from(this.busySessions);
  }
}
