/**
 * Pending approvals / questions in orchestrator V2 are first-class: `projection.runtimeRequests` with
 * `status: "pending"`. What is being asked (the prompt/options of an approval, the questions of a user-input
 * request) lives on the matching `approval_request` / `user_input_request` turn item with the same `requestId`.
 * The rules mirror the app's `derivePendingThreadRequests` (client-runtime state/threadRequests.ts): internal
 * request kinds are never shown, and a question is shown only once its turn item exists.
 */
import type { RuntimeRequest, ThreadProjection, TurnItem } from "./http.js";
import { isActionableRequest, isBlockingRequest } from "./wait.js";

/** `live`: answered in the running agent session · `message`: async, answered as a message · `not_resumable`: the session is gone. */
export type ResponseCapability = "live" | "message" | "not_resumable";

export interface PendingApproval {
  requestId: string; requestKind?: string; detail?: string; reason?: string; fullAccessOverride?: unknown; appName?: string;
  options?: Array<{ decision: string; label: string; warning?: string }>; createdAt: string;
  responseCapability: ResponseCapability; supportsFeedback: boolean;
}
export interface UserInputQuestion { id: string; header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }
export interface PendingUserInput { requestId: string; questions: UserInputQuestion[]; createdAt: string; responseCapability: ResponseCapability; blocking: boolean }

const byRequest = (items: TurnItem[], type: string) => new Map(items.filter((i) => i.type === type && typeof i.requestId === "string").map((i) => [i.requestId as string, i]));
const sortByCreated = <T extends { createdAt: string }>(xs: T[]) => xs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const capability = (r: RuntimeRequest): ResponseCapability => (r.responseCapability?.type === "live" || r.responseCapability?.type === "message" ? r.responseCapability.type : "not_resumable");
const pendingOf = (p: Pick<ThreadProjection, "runtimeRequests">) => (p.runtimeRequests ?? []).filter((r) => r.status === "pending" && isActionableRequest(r));

export function derivePendingApprovals(p: Pick<ThreadProjection, "runtimeRequests" | "turnItems">): PendingApproval[] {
  const items = byRequest(p.turnItems ?? [], "approval_request");
  return sortByCreated(pendingOf(p).filter((r) => r.kind !== "user_input").map((r) => {
    const it = items.get(r.id);
    return {
      requestId: r.id, createdAt: r.createdAt ?? "", requestKind: it?.requestKind ?? r.kind, detail: it?.prompt,
      ...(typeof it?.reason === "string" && it.reason ? { reason: it.reason } : {}),
      ...(it?.fullAccessOverride ? { fullAccessOverride: it.fullAccessOverride } : {}),
      appName: it?.appName, options: it?.options,
      responseCapability: capability(r), supportsFeedback: r.responseCapability?.type === "live" && r.responseCapability.supportsFeedback === true,
    };
  }));
}

export function derivePendingUserInputs(p: Pick<ThreadProjection, "runtimeRequests" | "turnItems">): PendingUserInput[] {
  const items = byRequest(p.turnItems ?? [], "user_input_request");
  return sortByCreated(pendingOf(p).filter((r) => r.kind === "user_input" && items.has(r.id)).map((r) => {
    const qs = items.get(r.id)?.questions ?? [];
    return {
      requestId: r.id, createdAt: r.createdAt ?? "", responseCapability: capability(r), blocking: isBlockingRequest(r),
      questions: qs.map((q) => ({ id: q.id, header: q.header ?? "", question: q.question, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })), multiSelect: q.multiSelect === true })),
    };
  }));
}
