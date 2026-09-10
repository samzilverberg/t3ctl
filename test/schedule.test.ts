import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, parseDuration, parseSchedule, readStore, recordRun, writeStore, type Job } from "../src/schedule.js";

const now = new Date("2026-09-10T10:00:00.000Z");
const job = (over: Partial<Job>): Job => ({ id: "j1", createdAt: now.toISOString(), nextAt: null, graceSec: 3600, runs: [], new: { project: "p", text: "x" }, ...over });

test("parseDuration", () => {
  assert.equal(parseDuration("30m"), 1800);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1d"), 86400);
  assert.equal(parseDuration("90"), 5400);          // bare number = minutes
  assert.throws(() => parseDuration("soon"), /cannot parse duration/);
});

test("parseSchedule: one-shot", () => {
  const s = parseSchedule("2h", now);
  assert.equal(s.cron, undefined);
  assert.equal(s.nextAt, "2026-09-10T12:00:00.000Z");
  assert.equal(s.defaultGraceSec, 3600);
  assert.throws(() => parseSchedule("2026-01-01T00:00:00Z", now), /in the past/);
});

test("parseSchedule: cron → recurring with grace = min(60m, interval/2)", () => {
  const hourly = parseSchedule("@hourly", now);
  assert.equal(hourly.cron, "@hourly");
  assert.equal(hourly.nextAt, "2026-09-10T11:00:00.000Z");
  assert.equal(hourly.defaultGraceSec, 1800);
  const daily = parseSchedule("0 9 * * 1-5", now);
  assert.equal(daily.defaultGraceSec, 3600);
  const minutely = parseSchedule("* * * * *", now);
  assert.equal(minutely.defaultGraceSec, 60);       // floor of 60 s
  assert.throws(() => parseSchedule("61 * * * *", now), /invalid cron/);
});

test("evaluate: not due", () => {
  assert.deepEqual(evaluate(job({ nextAt: "2026-09-10T10:00:01.000Z" }), now), { due: false });
  assert.deepEqual(evaluate(job({ nextAt: null }), now), { due: false });
});

test("evaluate: one-shot inside and outside grace", () => {
  const inside = evaluate(job({ nextAt: "2026-09-10T09:30:00.000Z" }), now);
  assert.deepEqual(inside, { due: true, at: "2026-09-10T09:30:00.000Z", late: false, missed: 0, nextAt: null });
  const late = evaluate(job({ nextAt: "2026-09-10T08:00:00.000Z" }), now);
  assert.equal(late.due && late.late, true);
});

test("evaluate: recurring picks only the most recent due occurrence and advances", () => {
  // Hourly job last armed for 06:00; ticker was away until 10:00:30. Only 10:00 is considered; 06..09 are missed.
  const ev = evaluate(job({ cron: "@hourly", graceSec: 1800, nextAt: "2026-09-10T06:00:00.000Z" }), new Date("2026-09-10T10:00:30.000Z"));
  assert.deepEqual(ev, { due: true, at: "2026-09-10T10:00:00.000Z", late: false, missed: 4, nextAt: "2026-09-10T11:00:00.000Z" });
});

test("evaluate: recurring late occurrence is reported late but still advances", () => {
  const ev = evaluate(job({ cron: "@hourly", graceSec: 1800, nextAt: "2026-09-10T09:00:00.000Z" }), new Date("2026-09-10T09:45:00.000Z"));
  assert.equal(ev.due && ev.late, true);
  assert.equal(ev.due && ev.nextAt, "2026-09-10T10:00:00.000Z");
});

test("store round-trips through T3CTL_CONFIG_DIR and caps run history", () => {
  const j = job({ nextAt: "2026-09-11T10:00:00.000Z" });
  for (let i = 0; i < 40; i++) recordRun(j, { at: `${i}`, firedAt: "x", status: "fired" });
  assert.equal(j.runs.length, 30);
  assert.equal(j.runs[0].at, "10");
  writeStore({ jobs: [j] });
  assert.deepEqual(readStore(), { jobs: [j] });
});
