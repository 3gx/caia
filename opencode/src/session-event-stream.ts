import type { OpencodeClient, GlobalEvent } from '@opencode-ai/sdk';
import type { SessionEventStreamOptions } from './types.js';

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(attempt: number, base: number, max: number): number {
  const exponential = base * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 100;
  return Math.min(exponential + jitter, max);
}

/**
 * Manages a single global SSE stream with automatic reconnection.
 */
export class SessionEventStream {
  private client: OpencodeClient;
  private listeners = new Set<(event: GlobalEvent) => void>();
  private abortController: AbortController | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private options: Required<SessionEventStreamOptions>;

  constructor(client: OpencodeClient, options: SessionEventStreamOptions = {}) {
    this.client = client;
    this.options = {
      baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    };
  }

  subscribe(callback: (event: GlobalEvent) => void): () => void {
    this.listeners.add(callback);
    if (!this.running) {
      this.start();
    }

    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempt = 0;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const result = await this.client.global.event({ signal });
      for await (const event of result.stream) {
        if (!this.running) break;
        for (const listener of this.listeners) {
          try {
            listener(event as GlobalEvent);
          } catch (err) {
            console.error('[opencode:event-stream] Listener error:', err);
          }
        }
      }
    } catch (error) {
      if (signal.aborted || !this.running) {
        return;
      }
      console.warn('[opencode:event-stream] Stream error, reconnecting:', error);
    }

    if (!this.running) return;

    this.reconnectAttempt += 1;
    const delay = nextDelay(
      this.reconnectAttempt,
      this.options.baseDelayMs,
      this.options.maxDelayMs
    );
    await sleep(delay);
    if (this.running) {
      await this.connect();
    }
  }
}
