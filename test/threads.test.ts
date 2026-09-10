import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ShellSnapshot } from "../src/http.js";
import { threadStatus } from "../src/wait.js";
import { matchProject, matchThread } from "../src/ops.js";

const shell = JSON.parse(readFileSync(new URL("./fixtures/shell.json", import.meta.url), "utf8")) as ShellSnapshot;

test("threadStatus mirrors the UI heuristic", () => {
  const byTitle = Object.fromEntries(shell.threads.map((t) => [t.title, t]));
  assert.equal(threadStatus(byTitle["thread-0"]), "running");        // active turn
  assert.equal(threadStatus(byTitle["thread-1"]), "idle");           // completed, no active turn
  assert.equal(threadStatus(byTitle["thread-2"]), "needs-input");    // flag wins over running
  assert.equal(threadStatus({ ...byTitle["thread-1"], archivedAt: "2026-01-01T00:00:00Z" }), "archived");
  assert.equal(threadStatus({ ...byTitle["thread-1"], hasPendingApprovals: true }), "needs-approval");
  assert.equal(threadStatus({ ...byTitle["thread-1"], latestTurn: { state: "error" } }), "error");
  assert.equal(threadStatus({ ...byTitle["thread-1"], latestTurn: { state: "interrupted" } }), "interrupted");
  assert.equal(threadStatus({ id: "x", projectId: "p", title: "fresh" }), "new");
});

test("matchThread: id, id prefix, exact title", () => {
  const t = shell.threads[1];
  assert.equal(matchThread(shell.threads, t.id).id, t.id);
  assert.equal(matchThread(shell.threads, t.id.slice(0, 8)).id, t.id);
  assert.equal(matchThread(shell.threads, "thread-1").id, t.id);
  assert.throws(() => matchThread(shell.threads, "nope"), /thread not found/);
});

test("matchProject: id, prefix, title, workspaceRoot; error lists known titles", () => {
  const p = shell.projects[0];
  assert.equal(matchProject(shell.projects, p.id).id, p.id);
  assert.equal(matchProject(shell.projects, p.title).id, p.id);
  assert.equal(matchProject(shell.projects, p.workspaceRoot).id, p.id);
  assert.throws(() => matchProject(shell.projects, "zzz"), /project not found: zzz\. Known: project-0/);
});
