import fs from 'fs';
import os from 'os';
import path from 'path';
import { Mutex } from 'async-mutex';
import type { SessionStore } from './types.js';

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.config', 'caia');

export function getSessionsDir(): string {
  const configured = process.env.CAIA_SESSIONS_PATH?.trim();
  if (configured) {
    return configured;
  }
  return DEFAULT_SESSIONS_DIR;
}

export function getSessionsFilePath(agentName: string): string {
  const fileName = `${agentName}-sessions.json`;
  return path.join(getSessionsDir(), fileName);
}

function ensureSessionsDirExists(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanupLegacySessionsFile(): void {
  const legacyPath = path.join(process.cwd(), 'sessions.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  try {
    fs.unlinkSync(legacyPath);
    console.warn(`[sessions] Removed legacy sessions file at ${legacyPath}`);
  } catch (error) {
    console.warn(`[sessions] Failed to remove legacy sessions file ${legacyPath}:`, error);
  }
}

export class SessionStoreManager<S, T> {
  private readonly filePath: string;
  private readonly mutex = new Mutex();

  constructor(agentName: string) {
    this.filePath = getSessionsFilePath(agentName);
    cleanupLegacySessionsFile();
  }

  getFilePath(): string {
    return this.filePath;
  }

  loadStore(): SessionStore<S, T> {
    ensureSessionsDirExists();
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && parsed.channels) {
          return parsed as SessionStore<S, T>;
        }
      } catch (error) {
        console.error(`[sessions] Failed to parse ${this.filePath}, resetting:`, error);
      }
    }
    return { channels: {} } as SessionStore<S, T>;
  }

  saveStore(store: SessionStore<S, T>): void {
    ensureSessionsDirExists();
    fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
  }

  async runExclusive<R>(fn: () => R): Promise<R> {
    return this.mutex.runExclusive(fn);
  }
}
