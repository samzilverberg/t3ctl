import type { Server } from "./discover.js";
import type { Message, Run, RuntimeRequest, ShellThread, ThreadProjection } from "./http.js";
import { RpcSocket } from "./ws.js";

export type ThreadStatus = "running" | "idle" | "needs-approval" | "needs-input" | "error" | "interrupted" | "archived" | "new" | string;

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const USER_INPUT_KINDS = new Set(["user_input"]);

/** `needs-input` for questions, `needs-approval` for every other pending runtime request (command, file-change, permission, …). */
export function statusOfRequest(kind: string | undefined): "needs-approval" | "needs-input" {
  return kind && USER_INPUT_KINDS.has(kind) ? "needs-input" : "needs-approval";
}

/**
 * Derived from the V2 shell row: `status` is `idle` or the active/latest run's status, and `pendingRuntimeRequest`
 * is set while the run waits on a human. A pending request wins over "running" (the run is blocked on it).
 */
export function threadStatus(t: ShellThread): ThreadStatus {
  if (t.archivedAt) return "archived";
  if (t.pendingRuntimeRequest) return statusOfRequest(t.pendingRuntimeRequest.kind);
  if (t.activeRunId) return "running";
  const st = t.status;
  if (st === undefined) return t.latestRunId ? "idle" : "new";
  if (ACTIVE_RUN.has(st)) return "running";
  if (st === "idle" || st === "completed" || st === "rolled_back") return t.latestRunId === undefined && !t.updatedAt ? "new" : "idle";
  if (st === "failed") return "error";
  if (st === "interrupted" || st === "cancelled") return "interrupted";
  return st;
}

export interface WaitOutcome {
  threadId: string;
  status: ThreadStatus;
  reason: "idle" | "needs-human" | "error" | "timeout" | "aborted";
  runId?: string;
  lastAssistantText?: string;
  events: number;
}

export interface StreamItem { kind: string; snapshotSequence?: number; projection?: ThreadProjection; sequence?: number; event?: { type: string; payload?: unknown; [k: string]: unknown } }

const terminal = (run: Run): "idle" | "error" | "interrupted" | undefined =>
  run.status === "completed" || run.status === "rolled_back" ? "idle" : run.status === "failed" ? "error" : run.status === "interrupted" || run.status === "cancelled" ? "interrupted" : undefined;

/**
 * Subscribe to a thread and resolve when its run finishes (or a human is needed). State is derived from the
 * snapshot's runs/runtimeRequests and from `run.updated` / `runtime-request.updated` / `message.updated` events.
 * `poll` (shell row) is a safety net for anything the stream does not carry.
 */
export async function waitForIdle(server: Server, token: string, threadId: string, opts: { timeoutMs?: number; afterSequence?: number; signal?: AbortSignal; onEvent?: (item: StreamItem) => void; requireRunStart?: boolean; poll?: () => Promise<ShellThread | undefined>; pollMs?: number } = {}): Promise<WaitOutcome> {
  const sock = new RpcSocket(server, token);
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; ac.abort(); }, opts.timeoutMs) : undefined;
  let sawActive = false;
  let status: ThreadStatus = "new";
  let runId: string | undefined;
  let lastAssistantText: string | undefined;
  let events = 0;
  let reason: WaitOutcome["reason"] = "aborted";
  const runs = new Map<string, Run>();
  let pollTimer: NodeJS.Timeout | undefined;
  let pollStatus: ThreadStatus | undefined;
  if (opts.poll) {
    const tick = async () => {
      try {
        const t = await opts.poll!();
        if (!t) return;
        const st = threadStatus(t);
        if (st === "running") sawActive = true;
        if (st === "needs-approval" || st === "needs-input" || (sawActive && (st === "idle" || st === "error" || st === "interrupted"))) { pollStatus = st; ac.abort(); }
      } catch { /* transient */ }
    };
    pollTimer = setInterval(tick, opts.pollMs ?? 5000);
  }
  const noteRun = (run: Run) => {
    runs.set(run.id, run);
    if (ACTIVE_RUN.has(run.status)) { sawActive = true; runId = run.id; status = "running"; return undefined; }
    const t = terminal(run);
    if (t && (runId === undefined || runId === run.id)) { runId = run.id; status = t; }
    return t;
  };
  const noteMessage = (m: Message) => { if (m.role === "assistant" && typeof m.text === "string" && m.text.length > 0) lastAssistantText = m.text; };
  try {
    const payload: Record<string, unknown> = { threadId, requestCompletionMarker: true };
    if (opts.afterSequence !== undefined) payload.afterSequence = opts.afterSequence;
    for await (const item of sock.subscribe<StreamItem>("orchestration.subscribeThread", payload, ac.signal)) {
      events++;
      opts.onEvent?.(item);
      if (item.kind === "snapshot" && item.projection) {
        const p = item.projection;
        for (const m of p.messages ?? []) noteMessage(m);
        const pending = (p.runtimeRequests ?? []).find((r) => r.status === "pending");
        if (pending) { status = statusOfRequest(pending.kind); reason = "needs-human"; break; }
        const latest = [...(p.runs ?? [])].sort((a, b) => a.ordinal - b.ordinal).at(-1);
        if (latest) {
          const t = noteRun(latest);
          if (t && !opts.requireRunStart && !sawActive) { reason = t === "idle" ? "idle" : "error"; break; }
        } else if (!opts.requireRunStart) { status = "new"; reason = "idle"; break; }
        continue;
      }
      if (item.kind !== "event" || !item.event) continue;
      const ev = item.event;
      const p = ev.payload as Record<string, unknown> | undefined;
      if (!p) continue;
      if (ev.type === "run.created" || ev.type === "run.updated") {
        const t = noteRun(p as unknown as Run);
        if (t && sawActive) { reason = t === "idle" ? "idle" : "error"; break; }
      } else if (ev.type === "runtime-request.updated") {
        const r = p as unknown as RuntimeRequest;
        if (r.status === "pending") { status = statusOfRequest(r.kind); reason = "needs-human"; break; }
      } else if (ev.type === "message.updated") {
        noteMessage(p as unknown as Message);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (pollTimer) clearInterval(pollTimer);
    sock.close();
  }
  if (pollStatus) { status = pollStatus; reason = pollStatus === "needs-approval" || pollStatus === "needs-input" ? "needs-human" : pollStatus === "idle" ? "idle" : "error"; }
  else if (timedOut) reason = "timeout";
  else if (reason === "aborted" && opts.signal?.aborted) reason = "aborted";
  return { threadId, status, reason, runId, lastAssistantText, events };
}
