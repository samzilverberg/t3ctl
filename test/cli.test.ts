import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { matchProject, matchThread } from "../src/ops.js";
import { CliError } from "../src/errors.js";
import { INCOMPATIBLE_EXIT } from "../src/discover.js";
import { runCli, startFake, type Fake } from "./fake-server.js";

let fake: Fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
beforeEach(() => {
  fake.threads.length = 0; fake.messages.clear(); fake.commands.length = 0; fake.launches.length = 0; fake.mutations.length = 0; fake.tasks.length = 0;
  fake.descriptor.serverVersion = "0.1.1"; fake.descriptor.orchestrationProtocolVersion = 2;
});

const errorOf = (r: { stdout: string }) => JSON.parse(r.stdout).error as { code: string; message: string; [k: string]: unknown };

test("empty refs never prefix-match the first project/thread (unset $VAR)", () => {
  const projects = [{ id: "aaa", title: "a", workspaceRoot: "/a" }, { id: "bbb", title: "b", workspaceRoot: "/b" }];
  for (const ref of ["", "  "]) {
    assert.throws(() => matchProject(projects, ref), (e: unknown) => e instanceof CliError && e.code === "project_not_found");
    assert.throws(() => matchThread([{ id: "t1", projectId: "aaa", title: "x" }], ref), (e: unknown) => e instanceof CliError && e.code === "thread_not_found");
  }
});

test("matchProject treats a ref as a path only when it looks like one", () => {
  const cwdChild = { id: "ccc", title: "other", workspaceRoot: `${process.cwd()}/foo` };
  assert.throws(() => matchProject([cwdChild], "foo"), /project not found: foo/);
  assert.equal(matchProject([cwdChild], "./foo").id, "ccc");
  assert.equal(matchProject([{ ...cwdChild, workspaceRoot: process.cwd() }], ".").id, "ccc");
});

// ---- Version gate ----

test("cli: a pre-0.1.0 (alpha) server is refused up front with incompatible_server, exit 7, before any request", async () => {
  fake.descriptor.serverVersion = "0.0.44";
  delete fake.descriptor.orchestrationProtocolVersion;
  for (const args of [["threads"], ["projects"], ["schedule"], ["threads", "new", "-p", "dev", "x"], ["auth", "pair"]]) {
    const r = await runCli(fake.origin, args);
    assert.equal(r.code, INCOMPATIBLE_EXIT, `${args.join(" ")}: ${r.stderr}`);
    const err = errorOf(r);
    assert.equal(err.code, "incompatible_server");
    assert.match(err.message, /0\.0\.44 is older than the minimum 0\.1\.0/);
    assert.match(err.message, /Update T3 Code/);
    assert.equal(err.serverVersion, "0.0.44");
    assert.equal(err.minServerVersion, "0.1.0");
    assert.equal(err.supportedProtocol, 2);
  }
  assert.equal(fake.commands.length, 0);
});

test("cli: env still describes an unsupported server, reports supported:false and exits 7", async () => {
  fake.descriptor.serverVersion = "0.0.40";
  delete fake.descriptor.orchestrationProtocolVersion;
  const r = await runCli(fake.origin, ["env"]);
  assert.equal(r.code, INCOMPATIBLE_EXIT);
  const j = JSON.parse(r.stdout);
  assert.equal(j.supported, false);
  assert.equal(j.serverVersion, "0.0.40");
  assert.match(j.unsupportedReason, /older than the minimum/);
  assert.match(r.stderr, /needs T3 Code ≥ 0\.1\.0/);
});

test("cli: a newer protocol generation is refused too, pointing at a t3ctl update", async () => {
  fake.descriptor.serverVersion = "0.4.0";
  fake.descriptor.orchestrationProtocolVersion = 3;
  const r = await runCli(fake.origin, ["threads"]);
  assert.equal(r.code, INCOMPATIBLE_EXIT);
  assert.match(errorOf(r).message, /protocol 3; this t3ctl supports 2.*or update t3ctl/);
});

test("cli: a supported server passes the gate and reads carry the protocol header", async () => {
  fake.seed("Some thread", "hello", 5);
  const r = await runCli(fake.origin, ["threads"]);
  assert.equal(r.code, 0, r.stderr);           // the fake answers 400 without x-t3-orchestration-protocol: 2
  assert.equal(JSON.parse(r.stdout).length, 1);
  const env = await runCli(fake.origin, ["env"]);
  assert.equal(JSON.parse(env.stdout).supported, true);
});

// ---- Wiring ----

test("cli: -a merges live and archived threads without dropping either (regression: dedupe set was pre-seeded)", async () => {
  const live = fake.seed("Live", "x", 5);
  const gone = fake.seed("Gone", "x", 50, { archivedAt: new Date().toISOString() });
  const plain = await runCli(fake.origin, ["threads"]);
  assert.deepEqual(JSON.parse(plain.stdout).map((t: { id: string }) => t.id), [live.id]);
  const all = await runCli(fake.origin, ["threads", "-a"]);
  assert.deepEqual(JSON.parse(all.stdout).map((t: { id: string; status: string }) => [t.id, t.status]).sort(), [[gone.id, "archived"], [live.id, "idle"]].sort());
  const show = await runCli(fake.origin, ["threads", "show", gone.id]);
  assert.equal(show.code, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).status, "archived");
});

test("cli: -p \"\" is refused before anything is created", async () => {
  const r = await runCli(fake.origin, ["threads", "new", "-p", "", "some task"]);
  assert.equal(r.code, 1);
  assert.equal(errorOf(r).code, "project_not_found");
  assert.equal(fake.commands.length, 0);
});

test("cli: --no-auto-pair fails with code auth instead of pairing", async () => {
  const r = await runCli(fake.origin, ["--no-auto-pair", "threads"], undefined, {}, { T3CTL_TOKEN: "" });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(errorOf(r).code, "auth");
  assert.match(r.stderr, /Not paired/);
  assert.doesNotMatch(r.stderr, /re-pairing/);
});

test("cli: invalid values are usage / invalid_option, and nothing is created", async () => {
  const cases: Array<[string[], string]> = [
    [["threads", "-n", "abc"], "usage"],
    [["threads", "wait", "x", "--timeout", "1.5"], "usage"],
    [["threads", "new", "-p", "dev", "--snooze", "90", "task"], "invalid_option"],
    [["threads", "new", "-p", "dev", "--env", "cloud", "task"], "invalid_option"],
    [["threads", "new", "-p", "dev", "--draft", "--wait", "-t", "x"], "error"],
    [["threads", "new", "-p", "dev", "--batch", "-", "-t", "x"], "error"],
    [["threads", "approve", "x", "-d", "maybe"], "invalid_option"],
  ];
  for (const [args, code] of cases) {
    const r = await runCli(fake.origin, args, "[]");
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(errorOf(r).code, code, args.join(" "));
  }
  assert.equal(fake.commands.length, 0);
});

test("cli: threads new launches via orchestration.launchThread with a root workspace for a non-git project", async () => {
  const r = await runCli(fake.origin, ["threads", "new", "-p", "dev", "-m", "opus", "-e", "high", "-t", "Hello", "Do the thing"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.env, "local");
  assert.equal(fake.launches.length, 1);
  const l = fake.launches[0];
  assert.equal(l.threadId, out.threadId);
  assert.equal(l.title, "Hello");
  assert.deepEqual(l.workspaceStrategy, { type: "root" });
  assert.deepEqual((l.initialMessage as { text: string }).text, "Do the thing");
  assert.deepEqual(l.modelSelection, { instanceId: "claudeAgent", model: "claude-opus-4-8", options: [{ id: "effort", value: "high" }] });
  assert.equal(l.runtimeMode, "auto");
});

test("cli: threads send is message.dispatch; refused on a running thread unless --queue / --steer", async () => {
  const idle = fake.seed("Idle one", "hello", 5);
  const r = await runCli(fake.origin, ["threads", "send", idle.id, "follow up"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).dispatchMode, "start_immediately");
  const cmd = fake.commands.at(-1)!;
  assert.equal(cmd.type, "message.dispatch");
  assert.equal(cmd.text, "follow up");
  assert.deepEqual(cmd.dispatchMode, { type: "start_immediately" });

  const busy = fake.seed("Busy one", "hello", 5, { status: "running", activeRunId: "run:busy:1" });
  const refused = await runCli(fake.origin, ["threads", "send", busy.id, "nope"]);
  assert.equal(refused.code, 1);
  assert.equal(errorOf(refused).code, "thread_running");
  const queued = await runCli(fake.origin, ["threads", "send", busy.id, "--queue", "later"]);
  assert.equal(queued.code, 0, queued.stderr);
  assert.deepEqual(fake.commands.at(-1)!.dispatchMode, { type: "queue_after_active" });
  const steered = await runCli(fake.origin, ["threads", "send", busy.id, "--steer", "now"]);
  assert.equal(steered.code, 0, steered.stderr);
  assert.deepEqual(fake.commands.at(-1)!.dispatchMode, { type: "steer_active", targetRunId: "run:busy:1" });
  const both = await runCli(fake.origin, ["threads", "send", busy.id, "--queue", "--steer", "x"]);
  assert.equal(errorOf(both).code, "invalid_option");
});

test("cli: interrupt is thread.stop and needs an active run", async () => {
  const idle = fake.seed("Idle", "x", 5);
  const r = await runCli(fake.origin, ["threads", "interrupt", idle.id]);
  assert.equal(errorOf(r).code, "thread_idle");
  const busy = fake.seed("Busy", "x", 5, { status: "running", activeRunId: "run:b:1" });
  const ok = await runCli(fake.origin, ["threads", "interrupt", busy.id]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fake.commands.at(-1)!.type, "thread.stop");
});

test("cli: projects add/remove go through POST /api/projects/mutate", async () => {
  const r = await runCli(fake.origin, ["projects", "add", fake.project.workspaceRoot + "/../", "-t", "Other", "--create-dir"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.mutations.length, 1);
  assert.equal(fake.mutations[0].type, "project.create");
  assert.equal(fake.mutations[0].createWorkspaceRootIfMissing, true);
  assert.equal(fake.commands.length, 0);
  const rm = await runCli(fake.origin, ["projects", "remove", "dev"]);
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(fake.mutations.at(-1)!.type, "project.delete");
});

// ---- Scheduler (server-side scheduledTasks.*) ----

test("cli: schedule add validates target, model and schedule, then upserts a server task", async () => {
  const bad = await runCli(fake.origin, ["schedule", "add", "--every", "1h", "-p", "dev", "-m", "opus", "-e", "ludicrous", "task"]);
  assert.equal(bad.code, 1, bad.stderr);
  assert.equal(errorOf(bad).code, "invalid_option");
  const none = await runCli(fake.origin, ["schedule", "add", "-p", "dev", "task"]);
  assert.equal(errorOf(none).code, "invalid_option");
  const two = await runCli(fake.origin, ["schedule", "add", "-p", "dev", "--every", "1h", "--at", "09:00", "task"]);
  assert.equal(errorOf(two).code, "invalid_option");
  const short = await runCli(fake.origin, ["schedule", "add", "-p", "dev", "--every", "30s", "task"]);
  assert.equal(errorOf(short).code, "invalid_option");
  const cron = await runCli(fake.origin, ["schedule", "add", "-p", "dev", "--cron", "0 9 1 * *", "task"]);
  assert.equal(errorOf(cron).code, "cron_not_expressible");
  assert.equal(fake.tasks.length, 0);

  const ok = await runCli(fake.origin, ["schedule", "add", "--at", "9:30", "--days", "mon-fri", "-p", "dev", "-e", "low", "-t", "Morning", "Triage the board"]);
  assert.equal(ok.code, 0, ok.stderr);
  const task = JSON.parse(ok.stdout);
  assert.equal(task.projectId, fake.project.id);
  assert.equal(task.threadId, null);
  assert.deepEqual(task.schedule, { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(task.workspaceStrategy, { type: "root" });
  assert.equal(task.enabled, true);
  assert.equal(task.createdBy, "user");
  assert.deepEqual(task.modelSelection, { instanceId: "claudeAgent", model: "claude-opus-4-8", options: [{ id: "effort", value: "low" }] });
  assert.equal(fake.tasks.length, 1);
});

test("cli: schedule add --thread binds the task to that thread; list/show/update/enable/disable/run/remove round-trip", async () => {
  const t = fake.seed("Board", "x", 5);
  const add = await runCli(fake.origin, ["schedule", "add", "--thread", t.id, "--every", "2h", "Check the board"]);
  assert.equal(add.code, 0, add.stderr);
  const task = JSON.parse(add.stdout);
  assert.equal(task.threadId, t.id);
  assert.deepEqual(task.schedule, { type: "interval", everyMs: 7_200_000 });

  const list = await runCli(fake.origin, ["schedule"]);
  assert.equal(JSON.parse(list.stdout).tasks.length, 1);
  const show = await runCli(fake.origin, ["schedule", "show", "Check the board"]);
  assert.equal(JSON.parse(show.stdout).id, task.id);

  const upd = await runCli(fake.origin, ["schedule", "update", task.id, "--cron", "0 8 * * 4", "-t", "Thursday check"]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.deepEqual(JSON.parse(upd.stdout).schedule, { type: "fixed_time", timeOfDay: "08:00", weekdays: [4] });
  assert.equal(JSON.parse(upd.stdout).title, "Thursday check");
  assert.equal(JSON.parse(upd.stdout).prompt, "Check the board");   // kept

  const off = await runCli(fake.origin, ["schedule", "disable", task.id]);
  assert.equal(JSON.parse(off.stdout).enabled, false);
  const on = await runCli(fake.origin, ["schedule", "enable", task.id]);
  assert.equal(JSON.parse(on.stdout).enabled, true);
  const run = await runCli(fake.origin, ["schedule", "run", task.id]);
  assert.equal(JSON.parse(run.stdout).runCount, 1);
  const rm = await runCli(fake.origin, ["schedule", "remove", task.id]);
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(fake.tasks.length, 0);
  const gone = await runCli(fake.origin, ["schedule", "show", task.id]);
  assert.equal(errorOf(gone).code, "task_not_found");
});

test("cli: the removed client-side scheduler commands say so", async () => {
  const r = await runCli(fake.origin, ["schedule", "install"]);
  assert.equal(errorOf(r).code, "removed_command");
  const tick = await runCli(fake.origin, ["schedule", "tick"]);
  assert.equal(tick.code, 0);                                 // the old launchd agent must not log a failure every minute
  assert.match(tick.stderr, /schedule migrate/);
});
