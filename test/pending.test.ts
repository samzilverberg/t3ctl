import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ThreadDetail } from "../src/http.js";
import { derivePendingApprovals, derivePendingUserInputs } from "../src/pending.js";

const detail = JSON.parse(readFileSync(new URL("./fixtures/projection-pending.json", import.meta.url), "utf8")) as ThreadDetail;
const p = detail.projection;

test("pending approvals: pending non-question runtime requests, enriched from the approval_request turn item", () => {
  const pending = derivePendingApprovals(p);
  assert.equal(pending.length, 1);                       // the resolved command request is not pending
  const a = pending[0];
  assert.equal(a.requestId, "rr-approval-1");
  assert.equal(a.requestKind, "file-change");
  assert.match(a.detail ?? "", /^Write:/);
  assert.deepEqual(a.options?.map((o) => o.decision), ["accept", "acceptForSession", "decline"]);
});

test("pending user inputs: user_input requests with their questions", () => {
  const pending = derivePendingUserInputs(p);
  assert.equal(pending.length, 1);
  const q = pending[0].questions[0];
  assert.equal(pending[0].requestId, "rr-user-input-1");
  assert.equal(q.id, "approach");
  assert.equal(q.options.length, 2);
  assert.equal(q.options[0].label, "Remove");
  assert.equal(q.multiSelect, false);
});

test("without its turn item an approval still shows up (kind only); a question does not (the app's rule)", () => {
  const stripped = { runtimeRequests: p.runtimeRequests, turnItems: [] };
  assert.deepEqual(derivePendingApprovals(stripped).map((a) => [a.requestId, a.requestKind, a.detail]), [["rr-approval-1", "file-change", undefined]]);
  assert.deepEqual(derivePendingUserInputs(stripped), []);
});

test("internal request kinds are never pending for a human; feedback and async questions are flagged", () => {
  const live = { type: "live", providerSessionId: "s", supportsFeedback: true };
  const reqs = [
    { id: "auth", kind: "auth_refresh", status: "pending", createdAt: "2026-01-01T00:00:00Z", responseCapability: live },
    { id: "dyn", kind: "dynamic_tool_call", status: "pending", createdAt: "2026-01-01T00:00:00Z", responseCapability: live },
    { id: "cmd", kind: "command", status: "pending", createdAt: "2026-01-01T00:00:01Z", responseCapability: live },
    { id: "q", kind: "user_input", status: "pending", createdAt: "2026-01-01T00:00:02Z", responseCapability: { type: "message" } },
  ];
  const items = [{ id: "i1", type: "user_input_request", requestId: "q", questions: [{ id: "a", question: "Which?", options: [{ label: "x" }] }] }];
  const approvals = derivePendingApprovals({ runtimeRequests: reqs, turnItems: items });
  assert.deepEqual(approvals.map((a) => [a.requestId, a.supportsFeedback, a.responseCapability]), [["cmd", true, "live"]]);
  assert.deepEqual(derivePendingUserInputs({ runtimeRequests: reqs, turnItems: items }).map((u) => [u.requestId, u.blocking, u.responseCapability]), [["q", false, "message"]]);
});

test("nothing pending once requests are resolved", () => {
  const resolved = { runtimeRequests: p.runtimeRequests.map((r) => ({ ...r, status: "resolved" })), turnItems: p.turnItems };
  assert.deepEqual(derivePendingApprovals(resolved), []);
  assert.deepEqual(derivePendingUserInputs(resolved), []);
});
