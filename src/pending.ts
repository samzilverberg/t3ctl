/**
 * Pending approvals / user-input requests are not first-class fields on the thread; the UI derives
 * them from retained activities (apps/web/src/session-logic.ts derivePendingApprovals). Mirror that:
 * an `approval.requested` / `user-input.requested` activity with no later `*.resolved` (or stale
 * respond.failed) activity for the same requestId is open.
 */
export interface Activity { id: string; tone: string; kind: string; summary: string; payload: unknown; turnId: string | null; sequence?: number; createdAt: string }

export interface PendingApproval { requestId: string; requestKind?: string; requestType?: string; detail?: string; appName?: string; options?: Array<{ decision: string; label: string }>; createdAt: string }
export interface UserInputQuestion { id: string; header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }
export interface PendingUserInput { requestId: string; questions: UserInputQuestion[]; createdAt: string }

const STALE = ["stale pending approval request", "unknown pending approval request", "unknown pending permission request", "stale pending user-input request", "unknown pending user-input request"];
const isStale = (detail?: string) => !!detail && STALE.some((s) => detail.toLowerCase().includes(s));
const order = (a: Activity, b: Activity) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

export function derivePendingApprovals(activities: Activity[]): PendingApproval[] {
  const open = new Map<string, PendingApproval>();
  for (const a of [...activities].sort(order)) {
    const p = rec(a.payload); const requestId = typeof p?.requestId === "string" ? p.requestId : null;
    if (!requestId) continue;
    const detail = typeof p?.detail === "string" ? p.detail : undefined;
    if (a.kind === "approval.requested") {
      open.set(requestId, { requestId, createdAt: a.createdAt, requestKind: typeof p?.requestKind === "string" ? p.requestKind : undefined, requestType: typeof p?.requestType === "string" ? p.requestType : undefined, detail, appName: typeof p?.appName === "string" ? p.appName : undefined, options: Array.isArray(p?.options) ? (p!.options as PendingApproval["options"]) : undefined });
    } else if (a.kind === "approval.resolved" || (a.kind === "provider.approval.respond.failed" && isStale(detail))) open.delete(requestId);
  }
  return [...open.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

export function derivePendingUserInputs(activities: Activity[]): PendingUserInput[] {
  const open = new Map<string, PendingUserInput>();
  for (const a of [...activities].sort(order)) {
    const p = rec(a.payload); const requestId = typeof p?.requestId === "string" ? p.requestId : null;
    if (!requestId) continue;
    const detail = typeof p?.detail === "string" ? p.detail : undefined;
    if (a.kind === "user-input.requested" && Array.isArray(p?.questions)) {
      const questions = (p!.questions as unknown[]).map(rec).filter((q): q is Record<string, unknown> => !!q && typeof q.id === "string" && typeof q.question === "string").map((q) => ({ id: String(q.id), header: String(q.header ?? ""), question: String(q.question), options: (Array.isArray(q.options) ? q.options : []).map(rec).filter((o): o is Record<string, unknown> => !!o).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })), multiSelect: q.multiSelect === true }));
      open.set(requestId, { requestId, createdAt: a.createdAt, questions });
    } else if (a.kind === "user-input.resolved" || (a.kind === "provider.user-input.respond.failed" && isStale(detail))) open.delete(requestId);
  }
  return [...open.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}
