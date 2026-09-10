import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { derivePendingApprovals, derivePendingUserInputs, type Activity } from "../src/pending.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Activity[];
const approval = load("activities-approval");
const userInput = load("activities-user-input");

test("resolved requests are not pending", () => {
  assert.deepEqual(derivePendingApprovals(approval), []);
  assert.deepEqual(derivePendingUserInputs(userInput), []);
  assert.deepEqual(derivePendingUserInputs(approval), []);   // wrong-kind activities are ignored
});

test("an approval.requested without a later approval.resolved is pending", () => {
  const acts = approval.filter((a) => a.kind !== "approval.resolved");
  const pending = derivePendingApprovals(acts);
  assert.equal(pending.length, 1);
  const p = pending[0];
  assert.match(p.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(p.requestKind, "file-change");
  assert.equal(p.requestType, "file_change_approval");
  assert.match(p.detail ?? "", /^Write:/);
  assert.equal(p.options, undefined);   // the server sends no option list for file-change approvals
});

test("a user-input.requested without a later user-input.resolved is pending, with question shape", () => {
  const acts = userInput.filter((a) => a.kind !== "user-input.resolved");
  const pending = derivePendingUserInputs(acts);
  assert.equal(pending.length, 1);
  const q = pending[0].questions[0];
  assert.equal(typeof q.id, "string");
  assert.equal(typeof q.question, "string");
  assert.ok(q.options.length >= 2);
  assert.equal(typeof q.options[0].label, "string");
  assert.equal(q.multiSelect, false);
});

test("order is by sequence, so an out-of-order resolved still closes the request", () => {
  const shuffled = [...approval].reverse();
  assert.deepEqual(derivePendingApprovals(shuffled), []);
});
