import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { CliError } from "../src/errors.js";
import { acquireOnceLock, describeOnce, evaluateOnce, matchOnce, ONCE_PATH, parseOnceAt, pruneOnce, readOnce, writeOnce, type OnceJob } from "../src/once.js";

const NOW = new Date("2026-10-22T10:00:00Z");
const job = (over: Partial<OnceJob> = {}): OnceJob => ({ id: "once:aabbccdd", createdAt: "2026-10-22T09:00:00Z", at: "2026-10-22T10:00:00Z", graceSec: 3600, title: "ping", send: { thread: "t1", text: "ping" }, status: "pending", ...over });

test("parseOnceAt: future only; relative, clock, tomorrow and ISO forms", () => {
  assert.equal(parseOnceAt("2h", NOW), "2026-10-22T12:00:00.000Z");
  assert.equal(parseOnceAt("2026-10-25T07:30:00Z", NOW), "2026-10-25T07:30:00.000Z");
  assert.ok(Date.parse(parseOnceAt("tomorrow 09:00", NOW)) > NOW.getTime());
  assert.throws(() => parseOnceAt("2026-10-22T09:59:00Z", NOW), (e: unknown) => e instanceof CliError && e.code === "invalid_option" && /in the past/.test(e.message));
  assert.throws(() => parseOnceAt("90", NOW), (e: unknown) => e instanceof CliError && e.code === "invalid_option");
});

test("evaluateOnce: not before `at`; due within grace; late past grace; never for finished jobs", () => {
  assert.deepEqual(evaluateOnce(job(), new Date("2026-10-22T09:59:59Z")), { due: false });
  assert.deepEqual(evaluateOnce(job(), NOW), { due: true, lateSec: 0, withinGrace: true });
  assert.deepEqual(evaluateOnce(job(), new Date("2026-10-22T10:59:00Z")), { due: true, lateSec: 3540, withinGrace: true });
  assert.deepEqual(evaluateOnce(job(), new Date("2026-10-22T11:00:01Z")), { due: true, lateSec: 3601, withinGrace: false });
  assert.deepEqual(evaluateOnce(job({ status: "fired" }), new Date("2026-10-23T00:00:00Z")), { due: false });
});

test("matchOnce: full id, id without the once: prefix, prefix (≥ 4 chars), exact title; empty refs never match", () => {
  const jobs = [job(), job({ id: "once:ffff0000", title: "other" })];
  assert.equal(matchOnce(jobs, "once:aabbccdd")?.id, "once:aabbccdd");
  assert.equal(matchOnce(jobs, "aabbccdd")?.id, "once:aabbccdd");
  assert.equal(matchOnce(jobs, "once:ffff")?.id, "once:ffff0000");
  assert.equal(matchOnce(jobs, "other")?.id, "once:ffff0000");
  assert.equal(matchOnce(jobs, "on"), undefined);
  assert.equal(matchOnce(jobs, ""), undefined);
  assert.equal(matchOnce(jobs, "nope"), undefined);
});

test("pruneOnce keeps every pending job and the latest 50 finished ones", () => {
  const many = Array.from({ length: 60 }, (_, i) => job({ id: `once:${String(i).padStart(8, "0")}`, status: "fired", firedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` }));
  const kept = pruneOnce([...many, job({ id: "once:pending1" })]);
  assert.equal(kept.length, 51);
  assert.equal(kept[0].id, "once:pending1");
});

test("store round-trip under T3CTL_CONFIG_DIR and the exclusive tick lock", () => {
  assert.ok(process.env.T3CTL_CONFIG_DIR, "pnpm test sets a temp config dir");
  writeOnce([job()]);
  assert.ok(existsSync(ONCE_PATH));
  assert.equal(readOnce()[0].id, "once:aabbccdd");
  assert.equal(describeOnce(job()), "once 2026-10-22T10:00:00Z");
  const release = acquireOnceLock();
  assert.ok(release, "first lock acquired");
  assert.equal(acquireOnceLock(), null, "second lock refused");
  release!();
  const again = acquireOnceLock(); assert.ok(again); again!();
  writeOnce([]);
});
