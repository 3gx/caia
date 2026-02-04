import { vi } from 'vitest';

export function createMockWebClient() {
  return {
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.0', channel: 'C123' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      startStream: vi.fn().mockRejectedValue(new Error('stream unsupported')),
      appendStream: vi.fn().mockResolvedValue({ ok: true }),
      stopStream: vi.fn().mockResolvedValue({ ok: true }),
      getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://example.slack.com/archives/C123/p1' }),
    },
    conversations: {
      history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      create: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'CNEW', name: 'new-channel' } }),
      invite: vi.fn().mockResolvedValue({ ok: true }),
      info: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'C123' } }),
    },
    views: {
      open: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ id: 'F123' }] }),
      info: vi.fn().mockResolvedValue({ ok: true, file: { shares: { public: { C123: [{ ts: '1.0' }] } } } }),
    },
  };
}

export function createMockBoltApp(registeredHandlers: Record<string, any>) {
  return class MockApp {
    client = createMockWebClient();
    constructor() {}
    event(name: string, handler: any) { registeredHandlers[`event_${name}`] = handler; }
    message(handler: any) { registeredHandlers['message'] = handler; }
    action(pattern: RegExp, handler: any) { registeredHandlers[`action_${pattern.source}`] = handler; }
    view(pattern: string, handler: any) { registeredHandlers[`view_${pattern}`] = handler; }
    async start() { return Promise.resolve(); }
  };
}
