/**
 * SDK Live Test: on-request approval flow (Codex)
 *
 * Verifies that with approvalPolicy=on-request:
 * 1. Codex emits an approval request
 * 2. Accepting the request allows the turn to complete
 *
 * Runs for both sandbox modes:
 * - danger-full-access
 * - workspace-write
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import readline from 'readline';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

type SandboxMode = 'danger-full-access' | 'workspace-write';

interface ServerRequest {
  id: number;
  method: string;
  params: unknown;
}

interface Notification {
  method: string;
  params: unknown;
}

interface LiveHarness {
  server: ChildProcess;
  rl: readline.Interface;
  requestId: number;
  responseHandlers: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  notifications: Notification[];
  serverRequests: ServerRequest[];
}

function createRequest(id: number, method: string, params?: Record<string, unknown>) {
  const request: Record<string, unknown> = { jsonrpc: '2.0', id, method };
  if (params) request.params = params;
  return JSON.stringify(request) + '\n';
}

async function startHarness(sandboxMode: SandboxMode): Promise<LiveHarness> {
  const server = spawn('codex', ['app-server', '-c', `sandbox_mode="${sandboxMode}"`], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = readline.createInterface({
    input: server.stdout!,
    crlfDelay: Infinity,
  });

  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Notification[] = [];
  const serverRequests: ServerRequest[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const msgId = typeof msg.id === 'number' ? msg.id : undefined;
      const msgMethod = typeof msg.method === 'string' ? msg.method : undefined;

      if (msgId !== undefined && responseHandlers.has(msgId)) {
        const handler = responseHandlers.get(msgId)!;
        responseHandlers.delete(msgId);
        if (msg.error && typeof msg.error === 'object' && msg.error !== null) {
          const message = (msg.error as Record<string, unknown>).message;
          handler.reject(new Error(typeof message === 'string' ? message : 'Unknown JSON-RPC error'));
        } else {
          handler.resolve(msg.result);
        }
        return;
      }

      if (!msgMethod) return;

      if (msgId !== undefined) {
        serverRequests.push({
          id: msgId,
          method: msgMethod,
          params: msg.params,
        });
        return;
      }

      notifications.push({
        method: msgMethod,
        params: msg.params,
      });
    } catch {
      // Ignore non-JSON output lines
    }
  });

  const harness: LiveHarness = {
    server,
    rl,
    requestId: 0,
    responseHandlers,
    notifications,
    serverRequests,
  };

  await rpc(harness, 'initialize', {
    clientInfo: { name: 'cxslack-approval-live-test', version: '1.0.0' },
  });

  return harness;
}

function stopHarness(harness: LiveHarness): void {
  harness.rl.close();
  harness.server.kill();
}

async function rpc<T = unknown>(
  harness: LiveHarness,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  const id = ++harness.requestId;
  return new Promise((resolve, reject) => {
    harness.responseHandlers.set(id, { resolve: resolve as (v: unknown) => void, reject });
    harness.server.stdin!.write(createRequest(id, method, params));

    setTimeout(() => {
      if (harness.responseHandlers.has(id)) {
        harness.responseHandlers.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out`));
      }
    }, 30000);
  });
}

function respondToApproval(harness: LiveHarness, requestId: number, decision: 'accept' | 'decline'): void {
  const response = {
    jsonrpc: '2.0',
    id: requestId,
    result: { decision },
  };
  harness.server.stdin!.write(JSON.stringify(response) + '\n');
}

async function waitForApprovalRequest(
  harness: LiveHarness,
  threadId: string,
  timeoutMs: number
): Promise<ServerRequest | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const approval = harness.serverRequests.find((req) => {
      if (
        req.method !== 'item/commandExecution/requestApproval' &&
        req.method !== 'item/fileChange/requestApproval'
      ) {
        return false;
      }
      const params = req.params as Record<string, unknown> | undefined;
      return params?.threadId === threadId;
    });
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function waitForTurnComplete(harness: LiveHarness, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const completed = harness.notifications.some(
      (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
    );
    if (completed) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe.skipIf(SKIP_LIVE)('Codex on-request approval flow', { timeout: 120000 }, () => {
  it.each<SandboxMode>(['danger-full-access', 'workspace-write'])(
    'requests approval and completes turn after accept (%s)',
    async (sandboxMode) => {
      const harness = await startHarness(sandboxMode);
      try {
        harness.notifications.length = 0;
        harness.serverRequests.length = 0;

        const threadResult = await rpc<{ thread: { id: string } }>(harness, 'thread/start', {
          workingDirectory: process.cwd(),
        });
        const threadId = threadResult.thread.id;
        expect(threadId).toBeDefined();

        // Empirically, low-risk commands like `pwd` may execute without approval in on-request mode.
        // Use a high-risk command to deterministically trigger requestApproval.
        const targetPath = `/tmp/cxslack_sdk_live_approval_probe_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        await rpc(harness, 'turn/start', {
          threadId,
          approvalPolicy: 'on-request',
          input: [
            {
              type: 'text',
              text: `Run this exact shell command via command execution: rm -rf ${targetPath}. Return only the command output.`,
            },
          ],
        });

        const approvalRequest = await waitForApprovalRequest(harness, threadId, 45000);
        expect(approvalRequest).toBeDefined();
        expect(approvalRequest?.id).toBeTypeOf('number');
        expect([
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
        ]).toContain(approvalRequest?.method);

        respondToApproval(harness, approvalRequest!.id, 'accept');

        const completed = await waitForTurnComplete(harness, 60000);
        expect(completed).toBe(true);
      } finally {
        stopHarness(harness);
      }
    }
  );
});
