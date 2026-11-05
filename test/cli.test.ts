import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { matchProject, matchThread } from "../src/ops.js";
import { CliError } from "../src/errors.js";
import { INCOMPATIBLE_EXIT } from "../src/discover.js";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, startFake, type Fake } from "./fake-server.js";

let fake: Fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
beforeEach(() => {
  fake.threads.length = 0; fake.messages.clear(); fake.commands.length = 0; fake.launches.length = 0; fake.mutations.length = 0; fake.tasks.length = 0; fake.requests.clear(); delete (fake.descriptor.capabilities as Record<string, unknown>).threadForceStop;
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

test("cli: schedule migrate (dry run) skips legacy jobs the server already schedules for the same target, converts the rest", async () => {
  fake.descriptor.serverVersion = "0.1.7";
  const t = fake.seed("Board", "x", 5);
  fake.tasks.push({ id: "task-existing", title: "Daily planner loop", prompt: "plan", enabled: true, projectId: fake.project.id, threadId: t.id, schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }, workspaceStrategy: { type: "root" }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-8" }, runtimeMode: "auto", interactionMode: "default", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", nextRunAt: "2030-01-01T09:00:00.000Z", lastRunAt: null, lastRunStatus: "never", lastRunError: null, runCount: 0 } as never);
  const dir = configDir();
  const job = (id: string, cron: string | undefined, nextAt: string, send: Record<string, unknown>) => ({ id, createdAt: "2026-09-01T00:00:00.000Z", cron, nextAt, graceSec: 3600, send, runs: [] });
  writeFileSync(join(dir, "schedule.json"), JSON.stringify({ jobs: [
    job("dup00000", "0 9 * * 1-5", "2030-01-01T09:00:00.000Z", { thread: t.id, text: "plan the day" }),
    job("new00000", "0 8 * * 4", "2030-01-01T08:00:00.000Z", { thread: t.id, text: "weekly review", effort: "low" }),
    job("once0000", undefined, "2030-01-01T10:00:00.000Z", { thread: t.id, text: "one shot" }),
  ] }));
  const r = await runCli(fake.origin, ["schedule", "migrate"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.apply, false);
  const byJob = Object.fromEntries(out.plan.map((p: { job: string }) => [p.job, p]));
  assert.equal(byJob.dup00000.action, "skip");
  assert.match(byJob.dup00000.reason, /already scheduled as task task-existing/);
  assert.equal(byJob.new00000.action, "would-create");
  assert.equal(byJob.new00000.schedule, "thu 08:00");
  assert.equal(byJob.once0000.action, "would-create");          // future one-shot → server `once` task
  assert.equal(byJob.once0000.schedule, "once 2030-01-01T10:00:00Z");
  assert.equal(fake.tasks.length, 1);     // dry run creates nothing
});

// ---- One-time schedules (server-side since T3 Code 0.1.7) ----

const configDir = () => { const dir = mkdtempSync(join(tmpdir(), "t3ctl-sched-")); writeFileSync(join(dir, "config.json"), "{}"); return dir; };

test("cli: schedule add --once upserts a server `once` task, needs T3 Code 0.1.7, rejects past times and mixes", async () => {
  fake.descriptor.serverVersion = "0.1.7";
  const t = fake.seed("Board", "x", 5);
  const r = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "--thread", t.id, "-e", "low", "Check the board later"]);
  assert.equal(r.code, 0, r.stderr);
  const task = JSON.parse(r.stdout);
  assert.equal(task.schedule.type, "once");
  assert.ok(Date.parse(task.schedule.runAt) > Date.now() + 110 * 60_000);
  assert.equal(task.threadId, t.id);
  assert.equal(fake.tasks.length, 1);

  const upd = await runCli(fake.origin, ["schedule", "update", task.id, "--once", "2030-01-02T03:04:00Z"]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.deepEqual(JSON.parse(upd.stdout).schedule, { type: "once", runAt: "2030-01-02T03:04:00.000Z" });

  const mixed = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "--every", "1h", "--thread", t.id, "x"]);
  assert.equal(errorOf(mixed).code, "invalid_option");
  const past = await runCli(fake.origin, ["schedule", "add", "--once", "2020-01-01T00:00:00Z", "--thread", t.id, "x"]);
  assert.match(errorOf(past).message, /in the past/);
  const grace = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "--grace", "5m", "--thread", t.id, "x"]);
  assert.notEqual(grace.code, 0);                                   // --grace is gone with the client-side ticker

  fake.descriptor.serverVersion = "0.1.6";
  const old = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "--thread", t.id, "x"]);
  assert.equal(old.code, INCOMPATIBLE_EXIT);
  assert.equal(errorOf(old).code, "incompatible_server");
  assert.equal(fake.tasks.length, 1);
});

test("cli: schedule migrate moves pending 0.6 one-shots (once.json) to server tasks, renames the file, and the hidden tick does the same", async () => {
  fake.descriptor.serverVersion = "0.1.7";
  const t = fake.seed("Legacy target", "x", 5);
  const once = (id: string, at: string, status = "pending", graceSec = 3600) => ({ id, createdAt: "2026-10-01T00:00:00.000Z", at, graceSec, title: `legacy ${id}`, status, send: { thread: t.id, text: `legacy ${id}` } });
  const future = new Date(Date.now() + 3 * 86400_000).toISOString();
  const dir = configDir();
  writeFileSync(join(dir, "once.json"), JSON.stringify({ jobs: [
    once("once:fut1", future),
    once("once:late", new Date(Date.now() - 10 * 60_000).toISOString()),           // 10 min late, grace 1 h → a minute from now
    once("once:miss", new Date(Date.now() - 2 * 3600_000).toISOString()),          // 2 h late → skipped
    once("once:done", "2026-10-01T00:00:00.000Z", "fired"),
  ] }));
  const dry = await runCli(fake.origin, ["schedule", "migrate"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(dry.code, 0, dry.stderr);
  const by = Object.fromEntries(JSON.parse(dry.stdout).plan.map((p: { job: string }) => [p.job, p]));
  assert.deepEqual(Object.keys(by).sort(), ["once:fut1", "once:late", "once:miss"]);
  assert.equal(by["once:fut1"].action, "would-create");
  assert.equal(by["once:late"].action, "would-create");
  assert.match(by["once:late"].note, /runs a minute from now/);
  assert.equal(by["once:miss"].action, "skip");
  assert.equal(fake.tasks.length, 0);

  const tick = await runCli(fake.origin, ["schedule", "tick"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(tick.code, 0, tick.stderr);
  const a = JSON.parse(tick.stdout);
  assert.equal(a.created.length, 2);
  assert.deepEqual(fake.tasks.map((x) => x.schedule.type), ["once", "once"]);
  assert.ok(!existsSync(join(dir, "once.json")));
  assert.ok(existsSync(join(dir, "once.legacy.json")));

  const again = await runCli(fake.origin, ["schedule", "tick"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fake.tasks.length, 2);                                // nothing migrates twice
  const list = await runCli(fake.origin, ["schedule"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(JSON.parse(list.stdout).legacy, undefined);
});

// ---- Delegated children, approval feedback, interrupt variants (T3 Code 0.1.7) ----

test("cli: a child blocked on an approval shows on the parent (list/pending) and approve answers it there, with feedback", async () => {
  const parent = fake.seed("Parent", "x", 50, { status: "running", activeRunId: "run:p:1" });
  const child = fake.seed("Child task", undefined, 40, { status: "waiting", activeRunId: "run:c:1", lineage: { parentThreadId: parent.id, relationshipToParent: "subagent", rootThreadId: parent.id }, pendingRuntimeRequest: { id: "rr-1", kind: "command", createdAt: "2026-11-05T00:00:00Z" } });
  fake.requests.set(child.id, {
    runtimeRequests: [{ id: "rr-1", kind: "command", status: "pending", createdAt: "2026-11-05T00:00:00Z", responseCapability: { type: "live", providerSessionId: "s", supportsFeedback: true } }],
    turnItems: [{ id: "ti-1", type: "approval_request", requestId: "rr-1", requestKind: "command", prompt: "rm -rf /tmp/x", reason: "cleanup" }],
  });
  const list = JSON.parse((await runCli(fake.origin, ["threads"])).stdout) as Array<{ id: string; status: string; blockedBy?: string }>;
  assert.deepEqual(list.map((t) => t.id), [parent.id]);                               // the subagent row is hidden…
  assert.equal(list[0].status, "needs-approval");                                     // …but its approval shows on the parent
  assert.equal(list[0].blockedBy, child.id);
  assert.equal(JSON.parse((await runCli(fake.origin, ["threads", "--subagents"])).stdout).length, 2);

  const pending = JSON.parse((await runCli(fake.origin, ["threads", "pending", parent.id])).stdout);
  assert.equal(pending.children[0].threadId, child.id);
  assert.equal(pending.children[0].approvals[0].reason, "cleanup");
  assert.equal(pending.children[0].approvals[0].supportsFeedback, true);

  const ok = await runCli(fake.origin, ["threads", "approve", parent.id, "-d", "decline", "--feedback", "use trash instead"]);
  assert.equal(ok.code, 0, ok.stderr);
  const cmd = fake.commands.at(-1)!;
  assert.deepEqual([cmd.type, cmd.threadId, cmd.requestId, cmd.decision, cmd.feedback], ["runtime-request.respond", child.id, "rr-1", "decline", "use trash instead"]);

  fake.requests.get(child.id)!.runtimeRequests[0] = { id: "rr-1", kind: "command", status: "pending", createdAt: "2026-11-05T00:00:00Z", responseCapability: { type: "not_resumable", reason: "gone" } };
  const noFeedback = await runCli(fake.origin, ["threads", "approve", parent.id, "--feedback", "x"]);
  assert.equal(errorOf(noFeedback).code, "invalid_option");

  const wait = await runCli(fake.origin, ["threads", "wait", parent.id, "--timeout", "5"]);
  assert.equal(wait.code, 2, wait.stderr);                                            // needs-human, via the child
  assert.equal(JSON.parse(wait.stdout).blockedBy, child.id);
});

test("cli: interrupt stops delegated tasks by default; --keep-tasks opts out; --force needs the capability", async () => {
  const t = fake.seed("Busy", "x", 5, { status: "running", activeRunId: "run:b:1" });
  await runCli(fake.origin, ["threads", "interrupt", t.id]);
  assert.equal(fake.commands.at(-1)!.stopDelegatedTasks, undefined);                  // server default: stop them too
  await runCli(fake.origin, ["threads", "interrupt", t.id, "--keep-tasks"]);
  assert.equal(fake.commands.at(-1)!.stopDelegatedTasks, false);
  const old = await runCli(fake.origin, ["threads", "interrupt", t.id, "--force"]);
  assert.equal(old.code, INCOMPATIBLE_EXIT);
  (fake.descriptor.capabilities as Record<string, unknown>).threadForceStop = true;
  const force = await runCli(fake.origin, ["threads", "interrupt", t.id, "--force"]);
  assert.equal(force.code, 0, force.stderr);
  assert.equal(JSON.parse(force.stdout).outcome, "killed");
  assert.deepEqual([fake.commands.at(-1)!.type, fake.commands.at(-1)!.runId], ["orchestration.forceStopThread", "run:b:1"]);
});
