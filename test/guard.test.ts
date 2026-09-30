import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkRate, enforceGuard, findDuplicate, GUARD_DEFAULTS, GUARD_EXIT, MAX_BATCH, recentThreads, similarity } from "../src/guard.js";
import { CliError } from "../src/errors.js";
import { createThread, createThreads, parseBatch } from "../src/ops.js";
import type { ShellThread } from "../src/http.js";
import { runCli, startFake, type Fake } from "./fake-server.js";

// Two prompts an agent wrote for the same double-submitted request, and one for an unrelated task.
const PROMPT_A = "Fix the CJS build: `pnpm build` fails because package.json exports point at dist/index.js but tsup emits index.cjs. Update the exports map and add a regression test. Use branch fix-cjs.";
const PROMPT_B = "Fix the CJS build. `pnpm build` fails since the package.json exports point at dist/index.js while tsup emits index.cjs. Update the exports map and add a regression test. Branch: fix-cjs.";
const PROMPT_OTHER = "Write user docs for the scheduler: how grace windows work, what happens to missed runs, and how to install the launchd ticker.";

const now = new Date("2026-09-30T12:00:00.000Z");
const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
const th = (id: string, title: string, secondsAgo: number, projectId = "p"): ShellThread => ({ id, projectId, title, createdAt: at(secondsAgo), archivedAt: null });
const cfg = GUARD_DEFAULTS;

const guardErr = (code: string) => (e: unknown) => e instanceof CliError && e.code === code && e.exitCode === GUARD_EXIT;

test("similarity: near-identical prompts score high, unrelated ones low, case/punctuation ignored", () => {
  assert.equal(similarity("Fix the build!", "fix   the BUILD"), 1);
  assert.ok(similarity(PROMPT_A, PROMPT_B) >= cfg.similarity, `A~B = ${similarity(PROMPT_A, PROMPT_B)}`);
  assert.ok(similarity(PROMPT_A, PROMPT_OTHER) < 0.4, `A~other = ${similarity(PROMPT_A, PROMPT_OTHER)}`);
  assert.equal(similarity("", "x"), 0);
});

test("recentThreads: same project, inside the window, not archived, newest first", () => {
  const ts = [th("old", "a", 120), th("new", "b", 5), th("mid", "c", 30), th("other", "d", 5, "q"), { ...th("arch", "e", 5), archivedAt: at(1) }];
  assert.deepEqual(recentThreads(ts, "p", 60, now).map((t) => t.id), ["new", "mid"]);
});

test("findDuplicate: compares prompts when both exist, else titles; returns the best match", () => {
  const a = th("a", "Fix CJS build", 11), b = th("b", "Scheduler docs", 3);
  const d = findDuplicate([{ thread: a, prompt: PROMPT_A }, { thread: b, prompt: PROMPT_OTHER }], { title: "whatever", text: PROMPT_B }, now, cfg);
  assert.equal(d?.threadId, "a");
  assert.equal(d?.matchedOn, "prompt");
  assert.equal(d?.secondsAgo, 11);
  // Draft (no prompt on one side) → title comparison.
  assert.equal(findDuplicate([{ thread: a }], { title: "fix cjs build", text: PROMPT_B }, now, cfg)?.matchedOn, "title");
  assert.equal(findDuplicate([{ thread: a, prompt: PROMPT_A }], { title: "Fix CJS build", text: PROMPT_OTHER }, now, cfg), undefined);
});

test("checkRate: allows up to rateMax per window, counts batch size, reports retryAfterSec", () => {
  const four = [th("1", "a", 50), th("2", "b", 40), th("3", "c", 30), th("4", "d", 20), th("x", "old", 300)];
  checkRate(four, "p", "dev", 1, now, cfg); // 4 + 1 = 5: ok
  assert.throws(() => checkRate(four, "p", "dev", 2, now, cfg), (e: unknown) => {
    assert.ok(guardErr("rate_limited")(e));
    const d = (e as CliError).details as { retryAfterSec: number; recent: unknown[]; limit: { max: number } };
    assert.equal(d.recent.length, 4);
    assert.equal(d.limit.max, 5);
    assert.equal(d.retryAfterSec, 10); // oldest (50 s ago) leaves the 60 s window in 10 s
    return true;
  });
  checkRate(four, "p", "dev", 5, now, { ...cfg, rateMax: 0 }); // 0 disables
});

test("parseBatch: strings and objects, cap, unknown keys, types", () => {
  assert.deepEqual(parseBatch('["one", {"prompt": "two", "title": "T", "effort": "low"}]'), [
    { text: "one" },
    { text: "two", title: "T", model: undefined, effort: "low", branch: undefined },
  ]);
  assert.throws(() => parseBatch(JSON.stringify(Array(MAX_BATCH + 1).fill("x"))), /1\.\.5 threads per call \(got 6\)/);
  assert.throws(() => parseBatch("[]"), /got 0/);
  assert.throws(() => parseBatch('{"prompt": "x"}'), /expected a JSON array/);
  assert.throws(() => parseBatch('[{"promt": "x"}]'), /unknown key\(s\) promt/);
  assert.throws(() => parseBatch('[{"prompt": 1}]'), /prompt must be string/);
  assert.throws(() => parseBatch("nope"), /invalid JSON/);
});

// ---- Against the in-process fake server ----

let fake: Fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
beforeEach(() => { fake.threads.length = 0; fake.messages.clear(); fake.commands.length = 0; });

test("createThread guard: near-identical prompt 11 s after the first → duplicate_thread, nothing dispatched", async () => {
  const first = await createThread(fake.ctx, {}, { project: "dev", text: PROMPT_A }, { guard: true });
  fake.threads[0].createdAt = new Date(Date.now() - 11_000).toISOString();
  await assert.rejects(createThread(fake.ctx, {}, { project: "dev", text: PROMPT_B }, { guard: true }), (e: unknown) => {
    assert.ok(guardErr("duplicate_thread")(e));
    const d = (e as CliError).details as { duplicate: { threadId: string; title: string; secondsAgo: number } };
    assert.equal(d.duplicate.threadId, first.threadId);
    assert.equal(d.duplicate.title, first.title);
    assert.equal(d.duplicate.secondsAgo, 11);
    assert.equal((e as CliError).details.retryAfterSec, 49);
    return true;
  });
  assert.equal(fake.commands.length, 1);
});

test("createThread guard: unrelated prompt, or the same prompt outside the window, is created", async () => {
  fake.seed("Fix CJS build", PROMPT_A, 5);
  await createThread(fake.ctx, {}, { project: "dev", text: PROMPT_OTHER }, { guard: true });
  fake.threads.length = 0;
  fake.seed("Fix CJS build", PROMPT_A, 90);
  await createThread(fake.ctx, {}, { project: "dev", text: PROMPT_B }, { guard: true });
  assert.equal(fake.commands.length, 2);
});

test("createThread guard: rate limit once rateMax threads exist in the window", async () => {
  for (let i = 0; i < 5; i++) fake.seed(`task ${i} ${"xyz".repeat(i)}`, `unrelated prompt number ${i} about topic ${i * 7}`, 10 + i);
  await assert.rejects(enforceGuard(fake.ctx.client, fake.threads, fake.project, { title: "new", text: PROMPT_OTHER }), guardErr("rate_limited"));
});

test("createThreads: creates each item, skips the duplicate check, enforces cap and rate limit", async () => {
  fake.seed("Fix CJS build", PROMPT_A, 5);
  const out = await createThreads(fake.ctx, {}, { project: "dev" }, [{ text: PROMPT_B }, { text: PROMPT_OTHER, title: "Docs" }, { text: "third" }]);
  assert.deepEqual(out.map((s) => s.title), [PROMPT_B.slice(0, 80), "Docs", "third"]);
  assert.equal(fake.commands.length, 3);
  // 4 in the window now; 2 more would make 6 > 5.
  await assert.rejects(createThreads(fake.ctx, {}, { project: "dev" }, [{ text: "a" }, { text: "b" }]), guardErr("rate_limited"));
  // Once they age out of the window there is room again.
  for (const t of fake.threads) t.createdAt = new Date(Date.now() - 61_000).toISOString();
  assert.equal((await createThreads(fake.ctx, {}, { project: "dev" }, [{ text: "a" }, { text: "b" }])).length, 2);
  await assert.rejects(createThreads(fake.ctx, {}, { project: "dev" }, Array(6).fill({ text: "x" })), /1\.\.5 threads per call/);
  assert.equal(fake.commands.length, 5);
});

// ---- The real CLI, end to end ----

test("cli: duplicate → exit 6 with machine-readable error; --force is not an option", async () => {
  const first = fake.seed("Fix CJS build", PROMPT_A, 11);
  const dup = await runCli(fake.origin, ["threads", "new", "-p", "dev", PROMPT_B]);
  assert.equal(dup.code, GUARD_EXIT, dup.stderr);
  const err = JSON.parse(dup.stdout).error;
  assert.equal(err.code, "duplicate_thread");
  assert.equal(err.duplicate.threadId, first.id);
  assert.equal(err.duplicate.title, "Fix CJS build");
  assert.equal(err.project, "dev");
  assert.match(dup.stderr, /t3ctl: a very similar thread 00000000 "Fix CJS build" was created 1\ds ago/);
  assert.equal(fake.commands.length, 0);

  assert.equal(typeof err.retryAfterSec, "number");
  const forced = await runCli(fake.origin, ["threads", "new", "-p", "dev", "--force", PROMPT_B]);
  assert.equal(forced.code, 1);
  assert.match(forced.stderr, /unknown option '--force'/);
  assert.equal(fake.commands.length, 0);
});

test("cli: --batch from stdin creates several threads; flag clashes and cap are rejected", async () => {
  const ok = await runCli(fake.origin, ["threads", "new", "-p", "dev", "--batch", "-"], JSON.stringify(["first task", { prompt: "second task", title: "Second" }]));
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).map((s: { title: string }) => s.title), ["first task", "Second"]);
  const clash = await runCli(fake.origin, ["threads", "new", "-p", "dev", "--batch", "-", "-t", "x"], '["a"]');
  assert.equal(clash.code, 1);
  assert.match(clash.stderr, /--batch cannot be combined with -t/);
  const cap = await runCli(fake.origin, ["threads", "new", "-p", "dev", "--batch", "-"], JSON.stringify(Array(6).fill("x")));
  assert.equal(cap.code, 1);
  assert.match(cap.stderr, /got 6/);
  assert.equal(fake.commands.length, 2);
});
