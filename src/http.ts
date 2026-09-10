import type { Server } from "./discover.js";

export class HttpError extends Error {
  constructor(public status: number, public body: string, url: string) {
    super(`${status} ${url}: ${body.slice(0, 300)}`);
  }
}

export interface Client {
  server: Server;
  token: string;
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function makeClient(server: Server, token: string): Client {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, server.origin);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const r = await fetch(url, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new HttpError(r.status, await r.text(), url.pathname);
    return (await r.json()) as T;
  }
  return {
    server,
    token,
    get: (path, query) => call("GET", path, undefined, query),
    post: (path, body) => call("POST", path, body),
  };
}

// ---- Read endpoints (all require orchestration:read) ----
export const api = {
  session: (c: Client) => c.get<AuthSessionState>("/api/auth/session"),
  shell: (c: Client) => c.get<ShellSnapshot>("/api/orchestration/shell"),
  snapshot: (c: Client) => c.get<unknown>("/api/orchestration/snapshot"),
  thread: (c: Client, threadId: string, turnLimit?: number) =>
    c.get<ThreadDetail>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, { turnLimit }),
};

// Loose types: the contract (@t3tools/contracts) is unpublished and changes per release.
// We type only the fields we render and pass everything else through.
export interface AuthSessionState {
  authenticated: boolean;
  scopes?: string[];
  sessionMethod?: string;
  expiresAt?: string;
  [k: string]: unknown;
}
export interface ShellProject { id: string; title: string; workspaceRoot: string; defaultModelSelection?: unknown; [k: string]: unknown }
export interface ShellThread {
  id: string;
  projectId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  modelSelection?: { instanceId?: string; model?: string; options?: Array<{ id: string; value: unknown }> };
  latestTurn?: { turnId?: string; state?: string } | null;
  session?: { status?: string; activeTurnId?: string | null } | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  runtimeMode?: string;
  interactionMode?: string;
  [k: string]: unknown;
}
export interface ShellSnapshot { snapshotSequence: number; projects: ShellProject[]; threads: ShellThread[]; [k: string]: unknown }
export interface ThreadDetail { snapshotSequence: number; thread: ShellThread & { messages?: unknown[]; [k: string]: unknown }; page?: unknown; [k: string]: unknown }

// ---- Write path (requires orchestration:operate) ----
export interface DispatchResult { sequence: number; [k: string]: unknown }

/**
 * Dispatch a ClientOrchestrationCommand. We use the WebSocket RPC `orchestration.dispatchCommand`
 * rather than `POST /api/orchestration/dispatch`: only the WS handler implements the
 * `thread.turn.start` bootstrap (create thread + prepare worktree + run setup script). The HTTP
 * route passes bootstrap straight to the engine and fails with orchestration_dispatch_failed.
 */
export async function dispatch(c: Client, command: Record<string, unknown>): Promise<DispatchResult> {
  const { RpcSocket } = await import("./ws.js");
  const sock = new RpcSocket(c.server, c.token);
  try {
    return await sock.request<DispatchResult>("orchestration.dispatchCommand", command);
  } finally { sock.close(); }
}
