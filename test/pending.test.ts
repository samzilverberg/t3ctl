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

test("a request without a matching turn item still shows up (kind only)", () => {
  const stripped = { runtimeRequests: p.runtimeRequests, turnItems: [] };
  assert.deepEqual(derivePendingApprovals(stripped).map((a) => [a.requestId, a.requestKind, a.detail]), [["rr-approval-1", "file-change", undefined]]);
  assert.deepEqual(derivePendingUserInputs(stripped).map((u) => [u.requestId, u.questions.length]), [["rr-user-input-1", 0]]);
});

test("nothing pending once requests are resolved", () => {
  const resolved = { runtimeRequests: p.runtimeRequests.map((r) => ({ ...r, status: "resolved" })), turnItems: p.turnItems };
  assert.deepEqual(derivePendingApprovals(resolved), []);
  assert.deepEqual(derivePendingUserInputs(resolved), []);
});
