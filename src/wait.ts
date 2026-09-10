import type { Server } from "./discover.js";
import type { ShellThread } from "./http.js";
import { RpcSocket } from "./ws.js";

export type ThreadStatus = "running" | "idle" | "needs-approval" | "needs-input" | "error" | "interrupted" | "archived" | "new" | string;

/** Mirrors the UI's idle heuristic: no active turn and latest turn in a terminal state. */
export function threadStatus(t: ShellThread): ThreadStatus {
  if (t.archivedAt) return "archived";
  if (t.hasPendingApprovals) return "needs-approval";
  if (t.hasPendingUserInput) return "needs-input";
  if (t.session?.activeTurnId) return "running";
  const st = t.latestTurn?.state;
  if (st === "running" || st === "requested") return "running";
  if (st === "completed") return "idle";
  if (st === "error") return "error";
  if (st === "interrupted") return "interrupted";
  if (t.session?.status) return t.session.status;
  return st ?? "new";
}

export interface WaitOutcome {
  threadId: string;
  status: ThreadStatus;
  reason: "idle" | "needs-human" | "error" | "timeout" | "aborted";
  turnId?: string;
  lastAssistantText?: string;
  events: number;
}

interface StreamItem { kind: string; snapshot?: { thread: ShellThread & { messages?: Array<Record<string, unknown>> } }; event?: Record<string, unknown> }

/**
 * Subscribe to a thread and resolve when its current turn finishes (or a human is needed).
 * Uses the live thread stream; state is derived from `thread.session-set` and turn events.
 * `afterSequence` lets a caller start right after a dispatch it just made.
 */
export async function waitForIdle(server: Server, token: string, threadId: string, opts: { timeoutMs?: number; afterSequence?: number; signal?: AbortSignal; onEvent?: (item: StreamItem) => void; requireTurnStart?: boolean; poll?: () => Promise<ShellThread | undefined>; pollMs?: number } = {}): Promise<WaitOutcome> {
  const sock = new RpcSocket(server, token);
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; ac.abort(); }, opts.timeoutMs) : undefined;
  let sawActive = false;
  let status: ThreadStatus = "new";
  let turnId: string | undefined;
  let lastAssistantText: string | undefined;
  let events = 0;
  let reason: WaitOutcome["reason"] = "aborted";
  const assistantBuf = new Map<string, string>();
  // `hasPendingApprovals` / `hasPendingUserInput` live on the shell row, not in the thread stream,
  // so poll the shell snapshot on the side to detect "needs a human".
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
  try {
    const payload: Record<string, unknown> = { threadId, turnLimit: 1, requestCompletionMarker: true };
    if (opts.afterSequence !== undefined) payload.afterSequence = opts.afterSequence;
    for await (const item of sock.subscribe<StreamItem>("orchestration.subscribeThread", payload, ac.signal)) {
      events++;
      opts.onEvent?.(item);
      if (item.kind === "snapshot" && item.snapshot) {
        const t = item.snapshot.thread;
        status = threadStatus(t);
        turnId = t.session?.activeTurnId ?? t.latestTurn?.turnId ?? undefined;
        if (status === "running") sawActive = true;
        const lastA = [...(t.messages ?? [])].reverse().find((m) => m.role === "assistant");
        if (lastA && typeof lastA.text === "string") lastAssistantText = lastA.text;
        if (!opts.requireTurnStart && (status === "idle" || status === "error" || status === "interrupted") && !sawActive) {
          // Already idle before we started and caller does not insist on observing a turn.
          reason = status === "idle" ? "idle" : "error"; break;
        }
        if (status === "needs-approval" || status === "needs-input") { reason = "needs-human"; break; }
        continue;
      }
      if (item.kind !== "event" || !item.event) continue;
      const ev = item.event;
      const type = String(ev.type);
      // OrchestrationEvent = { type, sequence, ...EventBaseFields, payload }
      const p = (ev.payload as Record<string, unknown> | undefined) ?? {};
      if (type === "thread.turn-start-requested") { sawActive = true; if (typeof p.turnId === "string") turnId = p.turnId; status = "running"; }
      else if (type === "thread.message.assistant.delta") {
        const id = String(p.messageId); assistantBuf.set(id, (assistantBuf.get(id) ?? "") + String(p.delta ?? ""));
        lastAssistantText = assistantBuf.get(id);
      } else if (type === "thread.message-sent" || type === "thread.message.assistant.complete") {
        const msg = (p.message as Record<string, unknown> | undefined) ?? p;
        // The finalize event re-sends the message with streaming:false and an empty text; keep the last non-empty text.
        if (msg.role === "assistant" && typeof msg.text === "string" && msg.text.length > 0) lastAssistantText = msg.text;
      } else if (type === "thread.session-set") {
        const s = p.session as { status?: string; activeTurnId?: string | null; lastError?: unknown } | undefined;
        if (!s) continue;
        if (s.activeTurnId) { sawActive = true; turnId = s.activeTurnId; status = "running"; continue; }
        if (s.status === "starting") continue;
        if (sawActive) {
          status = s.lastError || s.status === "error" ? "error" : s.status === "interrupted" ? "interrupted" : "idle";
          reason = status === "idle" ? "idle" : "error"; break;
        }
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
  return { threadId, status, reason, turnId, lastAssistantText, events };
}
