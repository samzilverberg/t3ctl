import type { Server } from "./discover.js";
import { SUPPORTED_PROTOCOL } from "./discover.js";

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`${status} ${url}: ${body.slice(0, 300)}`);
  }
}

/** Orchestrator V2 (T3 Code ≥ 0.1.0) rejects `/api/orchestration/*` reads without this header (400). */
export const PROTOCOL_HEADER = "x-t3-orchestration-protocol";

export interface Client {
  server: Server;
  token: string;
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function makeClient(server: Server, token: string): Client {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json", [PROTOCOL_HEADER]: String(SUPPORTED_PROTOCOL) };
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

// ---- Read endpoints (orchestration:read) ----
export const api = {
  session: (c: Client) => c.get<AuthSessionState>("/api/auth/session"),
  /** Live threads, archived threads and projects in one snapshot. */
  shell: (c: Client) => c.get<ShellSnapshot>("/api/orchestration/shell"),
  /** Full thread projection (messages, runs, runtime requests, turn items). */
  thread: (c: Client, threadId: string) => c.get<ThreadDetail>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
  /** Project CRUD moved off the orchestration command bus to its own HTTP route in 0.1. */
  mutateProject: (c: Client, mutation: Record<string, unknown>) => c.post<Project>("/api/projects/mutate", mutation),
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
export interface ShellProject { id: string; title: string; workspaceRoot: string; defaultModelSelection?: unknown; defaultThreadEnvMode?: string | null; [k: string]: unknown }
export type Project = ShellProject;

export type RunStatus = "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";
export type RuntimeRequestKind = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission" | "dynamic_tool_call" | "user_input" | "auth_refresh" | string;

/** One row of the shell snapshot (`OrchestrationV2ThreadShell`). */
export interface ShellThread {
  id: string;
  projectId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  snoozedUntil?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  providerInstanceId?: string;
  modelSelection?: { instanceId?: string; model?: string; options?: Array<{ id: string; value: unknown }> };
  runtimeMode?: string;
  interactionMode?: string;
  /** `idle` or the active/latest run's status. */
  status?: "idle" | RunStatus | string;
  activeRunId?: string | null;
  latestRunId?: string | null;
  lastError?: string | null;
  pendingRuntimeRequest?: { id: string; kind: RuntimeRequestKind; createdAt?: string; blocking?: boolean } | null;
  latestVisibleMessage?: { id: string; role: string; text: string; updatedAt?: string } | null;
  [k: string]: unknown;
}
export interface ShellSnapshot { snapshotSequence: number; projects: ShellProject[]; threads: ShellThread[]; archivedThreads?: ShellThread[]; [k: string]: unknown }

export interface Message { id: string; threadId: string; runId?: string | null; role: "user" | "assistant" | "system" | string; text: string; createdAt?: string; updatedAt?: string; streaming?: boolean; [k: string]: unknown }
export interface Run { id: string; threadId: string; ordinal: number; status: RunStatus | string; requestedAt?: string; startedAt?: string | null; completedAt?: string | null; [k: string]: unknown }
export interface RuntimeRequest { id: string; kind: RuntimeRequestKind; status: "pending" | "resolved" | "expired" | "cancelled" | string; createdAt?: string; resolvedAt?: string | null; [k: string]: unknown }
export interface TurnItem { id: string; type: string; runId?: string | null; requestId?: string; requestKind?: string; prompt?: string; appName?: string; options?: Array<{ decision: string; label: string; warning?: string }>; questions?: Array<{ id: string; header?: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>; [k: string]: unknown }
/** `OrchestrationV2ThreadProjection`, the parts we read. */
export interface ThreadProjection { thread: ShellThread & { [k: string]: unknown }; runs: Run[]; runtimeRequests: RuntimeRequest[]; messages: Message[]; turnItems: TurnItem[]; [k: string]: unknown }
export interface ThreadDetail { snapshotSequence: number; projection: ThreadProjection; [k: string]: unknown }

// ---- Write path (orchestration:operate) ----
export interface DispatchResult { sequence: number; [k: string]: unknown }
export interface LaunchResult { threadId: string; projection: ThreadProjection; resumed: boolean }

/** Run one unary WebSocket RPC on a fresh socket. */
export async function rpc<T>(c: Client, tag: string, payload: unknown): Promise<T> {
  const { RpcSocket } = await import("./ws.js");
  const sock = new RpcSocket(c.server, c.token);
  try {
    return await sock.request<T>(tag, payload);
  } finally { sock.close(); }
}

/** Dispatch an `OrchestrationV2Command` (`thread.*`, `message.dispatch`, `runtime-request.respond`, …). */
export const dispatch = (c: Client, command: Record<string, unknown>) => rpc<DispatchResult>(c, "orchestration.dispatchCommand", command);

/** Create a thread, prepare its workspace (worktree) and start the first run in one server-side operation. */
export const launchThread = (c: Client, input: Record<string, unknown>) => rpc<LaunchResult>(c, "orchestration.launchThread", input);
