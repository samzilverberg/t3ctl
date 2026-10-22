/**
 * Pending approvals / questions in orchestrator V2 are first-class: `projection.runtimeRequests` with
 * `status: "pending"`. What is being asked (the prompt/options of an approval, the questions of a user-input
 * request) lives on the matching `approval_request` / `user_input_request` turn item with the same `requestId`.
 */
import type { ThreadProjection, TurnItem } from "./http.js";

export interface PendingApproval { requestId: string; requestKind?: string; detail?: string; appName?: string; options?: Array<{ decision: string; label: string; warning?: string }>; createdAt: string }
export interface UserInputQuestion { id: string; header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }
export interface PendingUserInput { requestId: string; questions: UserInputQuestion[]; createdAt: string }

const byRequest = (items: TurnItem[], type: string) => new Map(items.filter((i) => i.type === type && typeof i.requestId === "string").map((i) => [i.requestId as string, i]));
const sortByCreated = <T extends { createdAt: string }>(xs: T[]) => xs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function derivePendingApprovals(p: Pick<ThreadProjection, "runtimeRequests" | "turnItems">): PendingApproval[] {
  const items = byRequest(p.turnItems ?? [], "approval_request");
  return sortByCreated((p.runtimeRequests ?? []).filter((r) => r.status === "pending" && r.kind !== "user_input").map((r) => {
    const it = items.get(r.id);
    return { requestId: r.id, createdAt: r.createdAt ?? "", requestKind: it?.requestKind ?? r.kind, detail: it?.prompt, appName: it?.appName, options: it?.options };
  }));
}

export function derivePendingUserInputs(p: Pick<ThreadProjection, "runtimeRequests" | "turnItems">): PendingUserInput[] {
  const items = byRequest(p.turnItems ?? [], "user_input_request");
  return sortByCreated((p.runtimeRequests ?? []).filter((r) => r.status === "pending" && r.kind === "user_input").map((r) => {
    const qs = items.get(r.id)?.questions ?? [];
    return {
      requestId: r.id, createdAt: r.createdAt ?? "",
      questions: qs.map((q) => ({ id: q.id, header: q.header ?? "", question: q.question, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })), multiSelect: q.multiSelect === true })),
    };
  }));
}
