import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ShellSnapshot } from "../src/http.js";
import { threadStatus } from "../src/wait.js";
import { matchProject, matchThread } from "../src/ops.js";

const shell = JSON.parse(readFileSync(new URL("./fixtures/shell.json", import.meta.url), "utf8")) as ShellSnapshot;
const byTitle = Object.fromEntries(shell.threads.map((t) => [t.title, t]));

test("threadStatus derives from the V2 shell row: status, activeRunId, pendingRuntimeRequest", () => {
  assert.equal(threadStatus(byTitle["thread-0"]), "running");          // activeRunId set, status running
  assert.equal(threadStatus(byTitle["thread-1"]), "idle");             // status idle, no active run
  assert.equal(threadStatus(byTitle["thread-2"]), "needs-input");      // pending user_input wins over the waiting run
  assert.equal(threadStatus(byTitle["thread-3"]), "needs-approval");   // pending file-change request
  assert.equal(threadStatus(byTitle["thread-4"]), "error");            // latest run failed
  assert.equal(threadStatus(byTitle["thread-5"]), "interrupted");
  assert.equal(threadStatus(byTitle["thread-6"]), "idle");             // never ran, but the server already says idle
  assert.equal(threadStatus({ ...byTitle["thread-1"], archivedAt: "2026-01-01T00:00:00Z" }), "archived");
  assert.equal(threadStatus({ ...byTitle["thread-1"], status: "completed" }), "idle");
  for (const st of ["preparing", "queued", "starting", "waiting"]) assert.equal(threadStatus({ ...byTitle["thread-1"], status: st }), "running", st);
  assert.equal(threadStatus({ ...byTitle["thread-1"], status: "cancelled" }), "interrupted");
  assert.equal(threadStatus({ ...byTitle["thread-1"], pendingRuntimeRequest: { id: "x", kind: "permission" } }), "needs-approval");
  assert.equal(threadStatus({ id: "x", projectId: "p", title: "fresh" }), "new");   // no status at all (draft row)
});

test("matchThread: id, id prefix, exact title (ids are not always UUIDs any more)", () => {
  const t = byTitle["thread-0"];
  assert.equal(matchThread(shell.threads, t.id).id, t.id);
  assert.equal(matchThread(shell.threads, "mcp:513352c3").id, t.id);
  assert.equal(matchThread(shell.threads, "thread-1").id, byTitle["thread-1"].id);
  assert.throws(() => matchThread(shell.threads, "nope"), /thread not found/);
});

test("matchProject: id, prefix, title, workspaceRoot; error lists known titles", () => {
  const p = shell.projects[0];
  assert.equal(matchProject(shell.projects, p.id).id, p.id);
  assert.equal(matchProject(shell.projects, p.title).id, p.id);
  assert.equal(matchProject(shell.projects, p.workspaceRoot).id, p.id);
  assert.equal(matchProject(shell.projects, `${p.workspaceRoot}/`).id, p.id);             // resolved like a path
  assert.equal(matchProject(shell.projects, `${p.workspaceRoot}/sub/..`).id, p.id);
  assert.throws(() => matchProject(shell.projects, "zzz"), /project not found: zzz\. Known: project-0/);
});
