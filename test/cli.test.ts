import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { matchProject, matchThread } from "../src/ops.js";
import { CliError } from "../src/errors.js";
import { runCli, startFake, type Fake } from "./fake-server.js";

let fake: Fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
beforeEach(() => { fake.threads.length = 0; fake.messages.clear(); fake.commands.length = 0; });

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
  ];
  for (const [args, code] of cases) {
    const r = await runCli(fake.origin, args, "[]");
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(errorOf(r).code, code, args.join(" "));
  }
  assert.equal(fake.commands.length, 0);
});

test("cli: schedule add validates effort and env up front and stores the project id", async () => {
  const bad = await runCli(fake.origin, ["schedule", "add", "2h", "-p", "dev", "-m", "opus", "-e", "ludicrous", "task"]);
  assert.equal(bad.code, 1, bad.stderr);
  assert.equal(errorOf(bad).code, "invalid_option");
  const env = await runCli(fake.origin, ["schedule", "add", "2h", "-p", "dev", "--env", "cloud", "task"]);
  assert.equal(errorOf(env).code, "invalid_option");
  const ok = await runCli(fake.origin, ["schedule", "add", "2h", "-p", "dev", "-e", "low", "task"]);
  assert.equal(ok.code, 0, ok.stderr);
  const job = JSON.parse(ok.stdout);
  assert.equal(job.new.project, fake.project.id);
  assert.equal(job.new.projectTitle, "dev");
});
