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

test("cli: schedule install/uninstall are no-ops under T3CTL_NO_LAUNCHD (the suite never touches the real agent); idle tick is silent", async () => {
  const inst = await runCli(fake.origin, ["schedule", "install"]);
  assert.equal(inst.code, 0, inst.stderr);
  assert.equal(JSON.parse(inst.stdout).installed, false);
  assert.equal(JSON.parse(inst.stdout).label, "dev.t3ctl.scheduler");
  const un = await runCli(fake.origin, ["schedule", "uninstall"]);
  assert.equal(JSON.parse(un.stdout).removed, false);
  const tick = await runCli(fake.origin, ["schedule", "tick"]);
  assert.equal(tick.code, 0, tick.stderr);
  assert.deepEqual(JSON.parse(tick.stdout), []);
  assert.equal(tick.stderr, "");
});

test("cli: schedule migrate (dry run) skips legacy jobs the server already schedules for the same target, converts the rest", async () => {
  const t = fake.seed("Board", "x", 5);
  fake.tasks.push({ id: "task-existing", title: "Daily planner loop", prompt: "plan", enabled: true, projectId: fake.project.id, threadId: t.id, schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }, workspaceStrategy: { type: "root" }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-8" }, runtimeMode: "auto", interactionMode: "default", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", nextRunAt: "2030-01-01T09:00:00.000Z", lastRunAt: null, lastRunStatus: "never", lastRunError: null, runCount: 0 } as never);
  const dir = mkdtempSync(join(tmpdir(), "t3ctl-legacy-"));
  writeFileSync(join(dir, "config.json"), "{}");
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
  assert.equal(byJob.once0000.action, "would-create-once");   // future one-shot → t3ctl one-shot job
  assert.equal(fake.tasks.length, 1);     // dry run creates nothing
});

// ---- One-shots (client-side, --once) ----

const onceDir = () => { const dir = mkdtempSync(join(tmpdir(), "t3ctl-once-")); writeFileSync(join(dir, "config.json"), "{}"); return dir; };
const readOnceFile = (dir: string) => JSON.parse(readFileSync(join(dir, "once.json"), "utf8")).jobs as Array<Record<string, unknown> & { id: string; at: string; status: string; send?: { thread: string; text: string } }>;

test("cli: schedule add --once keeps the job client-side (no server task), validates the target, and rejects mixes", async () => {
  const dir = onceDir();
  const t = fake.seed("Board", "x", 5);
  const r = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "--thread", t.id, "-e", "low", "Check the board later"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kind, "once");
  assert.match(out.id, /^once:[0-9a-f]{8}$/);
  assert.equal(out.status, "pending");
  assert.equal(out.send.thread, t.id);
  assert.equal(out.send.effort, "low");
  assert.equal(out.graceSec, 3600);
  assert.equal(out.tickerInstalled, false);          // T3CTL_NO_LAUNCHD in tests
  assert.ok(Date.parse(out.at) > Date.now() + 110 * 60_000);
  assert.equal(fake.tasks.length, 0);
  assert.equal(readOnceFile(dir).length, 1);

  const mixed = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "--every", "1h", "--thread", t.id, "x"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(errorOf(mixed).code, "invalid_option");
  const past = await runCli(fake.origin, ["schedule", "add", "--once", "2020-01-01T00:00:00Z", "--thread", t.id, "x"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.match(errorOf(past).message, /in the past/);
  const graceAlone = await runCli(fake.origin, ["schedule", "add", "--every", "1h", "--grace", "5m", "--thread", t.id, "x"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.match(errorOf(graceAlone).message, /--grace only applies to --once/);
  const badModel = await runCli(fake.origin, ["schedule", "add", "--once", "2h", "-p", "dev", "-m", "nonexistent-model", "x"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(badModel.code, 1);
  assert.equal(readOnceFile(dir).length, 1);

  const list = await runCli(fake.origin, ["schedule"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  const l = JSON.parse(list.stdout);
  assert.equal(l.tasks.length, 0);
  assert.equal(l.once.length, 1);
  assert.equal(l.ticker.installed, false);
  const show = await runCli(fake.origin, ["schedule", "show", out.id.slice(5, 11)], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(JSON.parse(show.stdout).id, out.id);
  const upd = await runCli(fake.origin, ["schedule", "update", out.id, "--once", "3h", "--grace", "10m", "-t", "Renamed"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(upd.code, 0, upd.stderr);
  assert.equal(JSON.parse(upd.stdout).graceSec, 600);
  assert.equal(JSON.parse(upd.stdout).title, "Renamed");
  const dis = await runCli(fake.origin, ["schedule", "disable", out.id], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(errorOf(dis).code, "invalid_option");
  const rm = await runCli(fake.origin, ["schedule", "remove", out.id], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(readOnceFile(dir).length, 0);
});

test("cli: schedule tick fires due one-shots once (queued into a busy thread), marks late ones missed, ignores the rest", async () => {
  const dir = onceDir();
  const idle = fake.seed("Idle target", "x", 5);
  const busy = fake.seed("Busy target", "x", 5, { status: "running", activeRunId: "run:busy:9" });
  for (const [ref, when] of [[idle.id, "1h"], [busy.id, "1h"], [idle.id, "2h"]]) {
    const r = await runCli(fake.origin, ["schedule", "add", "--once", when, "--thread", ref, `fire ${when} ${ref.slice(-2)}`], undefined, {}, { T3CTL_CONFIG_DIR: dir });
    assert.equal(r.code, 0, r.stderr);
  }
  const jobs = readOnceFile(dir);
  jobs[0].at = new Date(Date.now() - 60_000).toISOString();          // due 1 min ago → fires
  jobs[1].at = new Date(Date.now() - 120_000).toISOString();         // due, thread busy → queued
  jobs[2].at = new Date(Date.now() - 2 * 3600_000).toISOString();    // 2 h late, grace 1 h → missed
  writeFileSync(join(dir, "once.json"), JSON.stringify({ jobs }));
  const before = fake.commands.length;

  const quiet = await runCli(fake.origin, ["schedule", "tick"], undefined, {}, { T3CTL_CONFIG_DIR: onceDir() });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.deepEqual(JSON.parse(quiet.stdout), []);

  const tick = await runCli(fake.origin, ["schedule", "tick"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(tick.code, 0, tick.stderr);
  const results = JSON.parse(tick.stdout) as Array<{ id: string; status: string; threadId?: string; reason?: string }>;
  assert.deepEqual(results.map((r) => r.status).sort(), ["fired", "fired", "missed"]);
  const fired = results.filter((r) => r.status === "fired");
  assert.deepEqual(fired.map((r) => r.threadId).sort(), [busy.id, idle.id].sort());
  assert.match(fired.find((r) => r.threadId === busy.id)!.reason ?? "", /queued/);
  assert.match(results.find((r) => r.status === "missed")!.reason ?? "", /late by 2\.0h/);
  const dispatched = fake.commands.slice(before).filter((c) => c.type === "message.dispatch");
  assert.equal(dispatched.length, 2);
  assert.deepEqual(dispatched.find((c) => c.threadId === busy.id)!.dispatchMode, { type: "queue_after_active" });
  assert.deepEqual(readOnceFile(dir).map((j) => j.status).sort(), ["fired", "fired", "missed"]);

  const again = await runCli(fake.origin, ["schedule", "tick"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.deepEqual(JSON.parse(again.stdout), []);                    // nothing fires twice
  assert.equal(fake.commands.length - before, 2);
  const listAll = await runCli(fake.origin, ["schedule", "-a"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(JSON.parse(listAll.stdout).once.length, 3);
  const listPending = await runCli(fake.origin, ["schedule"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(JSON.parse(listPending.stdout).once.length, 0);
});

test("cli: schedule run <once> fires a pending one-shot immediately", async () => {
  const dir = onceDir();
  const t = fake.seed("Run me", "x", 5);
  const add = await runCli(fake.origin, ["schedule", "add", "--once", "5h", "--thread", t.id, "now please"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  const id = JSON.parse(add.stdout).id as string;
  const run = await runCli(fake.origin, ["schedule", "run", id], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "fired");
  assert.equal(fake.commands.at(-1)!.text, "now please");
  const twice = await runCli(fake.origin, ["schedule", "run", id], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(errorOf(twice).code, "invalid_option");
});

test("cli: schedule migrate turns future legacy one-shots into t3ctl one-shots and reads the renamed legacy file", async () => {
  const dir = onceDir();
  const t = fake.seed("Legacy target", "x", 5);
  const job = (id: string, nextAt: string) => ({ id, createdAt: "2026-09-01T00:00:00.000Z", nextAt, graceSec: 1800, send: { thread: t.id, text: `legacy ${id}` }, runs: [] });
  const future = new Date(Date.now() + 3 * 86400_000).toISOString();
  writeFileSync(join(dir, "schedule.legacy.json"), JSON.stringify({ jobs: [job("fut00001", future), job("past0001", "2020-01-01T00:00:00.000Z")] }));
  const dry = await runCli(fake.origin, ["schedule", "migrate"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(dry.code, 0, dry.stderr);
  const d = JSON.parse(dry.stdout);
  assert.match(d.source, /schedule\.legacy\.json$/);
  const by = Object.fromEntries(d.plan.map((p: { job: string }) => [p.job, p]));
  assert.equal(by.fut00001.action, "would-create-once");
  assert.equal(by.past0001.action, "skip");
  assert.match(by.past0001.reason, /already in the past/);
  assert.ok(!existsSync(join(dir, "once.json")));

  const apply = await runCli(fake.origin, ["schedule", "migrate", "--apply"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  assert.equal(apply.code, 0, apply.stderr);
  const a = JSON.parse(apply.stdout);
  assert.equal(a.createdOnce.length, 1);
  assert.equal(a.createdOnce[0].at, future);
  assert.equal(a.createdOnce[0].graceSec, 1800);
  assert.equal(a.createdOnce[0].send.text, "legacy fut00001");
  assert.equal(readOnceFile(dir).length, 1);
  assert.ok(existsSync(join(dir, "schedule.legacy.json")), "the archived file is left in place");

  const second = await runCli(fake.origin, ["schedule", "migrate"], undefined, {}, { T3CTL_CONFIG_DIR: dir });
  const by2 = Object.fromEntries(JSON.parse(second.stdout).plan.map((p: { job: string }) => [p.job, p]));
  assert.equal(by2.fut00001.action, "skip");
  assert.match(by2.fut00001.reason, /already a one-shot/);
});
