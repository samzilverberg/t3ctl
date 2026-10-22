import { test } from "node:test";
import assert from "node:assert/strict";
import { convertLegacyJob, cronToSchedule, describeSchedule, fixedTimeSchedule, intervalSchedule, matchTask, parseDuration, parseWeekdays, type LegacyJob, type ScheduledTask } from "../src/schedule.js";
import { CliError } from "../src/errors.js";

test("parseDuration", () => {
  assert.equal(parseDuration("30m"), 1800);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1d"), 86400);
  assert.equal(parseDuration("90"), 5400);          // bare number = minutes
  assert.throws(() => parseDuration("soon"), /cannot parse duration/);
});

test("interval schedule enforces the server's 1 minute floor", () => {
  assert.deepEqual(intervalSchedule("30m"), { type: "interval", everyMs: 1_800_000 });
  assert.throws(() => intervalSchedule("30s"), (e: unknown) => e instanceof CliError && e.code === "invalid_option");
});

test("weekday specs", () => {
  assert.deepEqual(parseWeekdays("mon-fri"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdays("weekends"), [0, 6]);
  assert.deepEqual(parseWeekdays("fri-mon"), [0, 1, 5, 6]);       // wraps around the week
  assert.deepEqual(parseWeekdays("2,4"), [2, 4]);
  assert.deepEqual(parseWeekdays("7"), [0]);                      // cron-style Sunday
  assert.equal(parseWeekdays("*"), undefined);
  assert.equal(parseWeekdays("sun-sat"), undefined);              // all seven = every day
  assert.throws(() => parseWeekdays("funday"), /unknown weekday/);
});

test("fixed time schedule", () => {
  assert.deepEqual(fixedTimeSchedule("9:05", "mon-fri"), { type: "fixed_time", timeOfDay: "09:05", weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(fixedTimeSchedule("23:30"), { type: "fixed_time", timeOfDay: "23:30" });
  assert.throws(() => fixedTimeSchedule("25:00"), /cannot parse time/);
});

test("cron → T3 schedule for the expressible subset", () => {
  assert.deepEqual(cronToSchedule("0 9 * * 1-5"), { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(cronToSchedule("7 9 * * 2,4"), { type: "fixed_time", timeOfDay: "09:07", weekdays: [2, 4] });
  assert.deepEqual(cronToSchedule("0 8 * * 0"), { type: "fixed_time", timeOfDay: "08:00", weekdays: [0] });
  assert.deepEqual(cronToSchedule("30 6 * * *"), { type: "fixed_time", timeOfDay: "06:30" });
  assert.deepEqual(cronToSchedule("*/15 * * * *"), { type: "interval", everyMs: 900_000 });
  assert.deepEqual(cronToSchedule("0 */2 * * *"), { type: "interval", everyMs: 7_200_000 });
  assert.deepEqual(cronToSchedule("@hourly"), { type: "interval", everyMs: 3_600_000 });
  assert.deepEqual(cronToSchedule("@daily"), { type: "fixed_time", timeOfDay: "00:00" });
  assert.deepEqual(cronToSchedule("@weekly"), { type: "fixed_time", timeOfDay: "00:00", weekdays: [0] });
  for (const bad of ["0 9 1 * *", "0 9 * 6 *", "0 9,17 * * *", "* * * * *", "@reboot", "0 9 * *"]) {
    assert.throws(() => cronToSchedule(bad), (e: unknown) => e instanceof CliError && e.code === "cron_not_expressible", bad);
  }
});

test("describeSchedule", () => {
  assert.equal(describeSchedule({ type: "interval", everyMs: 3_600_000 }), "every 1h");
  assert.equal(describeSchedule({ type: "interval", everyMs: 90_000 }), "every 90s");
  assert.equal(describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }), "weekdays 09:00");
  assert.equal(describeSchedule({ type: "fixed_time", timeOfDay: "08:00", weekdays: [0] }), "sun 08:00");
  assert.equal(describeSchedule({ type: "fixed_time", timeOfDay: "08:00" }), "daily 08:00");
  assert.equal(describeSchedule({ type: "webhook", signature: null }), "webhook");
});

test("legacy launchd jobs: recurring cron converts, one-shots and finished jobs are skipped with a reason", () => {
  const base = { createdAt: "2026-09-10T00:00:00Z", graceSec: 3600, runs: [] };
  const cron: LegacyJob = { ...base, id: "a", cron: "0 9 * * 1-5", tz: "UTC", nextAt: "2026-10-23T09:00:00Z", new: { project: "p", text: "Morning: triage\nmore", model: "sonnet" } };
  const once: LegacyJob = { ...base, id: "b", nextAt: "2026-10-23T09:00:00Z", send: { thread: "t", text: "ping" } };
  const done: LegacyJob = { ...base, id: "c", nextAt: null, new: { project: "p", text: "x" } };
  const weird: LegacyJob = { ...base, id: "d", cron: "0 9 1 * *", nextAt: "2026-11-01T09:00:00Z", new: { project: "p", text: "monthly" } };
  const c = convertLegacyJob(cron);
  assert.ok(c.ok);
  if (c.ok) { assert.deepEqual(c.schedule, { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }); assert.equal(c.title, "Morning: triage"); assert.match(c.note ?? "", /UTC/); }
  const o = convertLegacyJob(once); assert.equal(o.ok, false); if (!o.ok) assert.match(o.reason, /one-shot/);
  const d = convertLegacyJob(done); assert.equal(d.ok, false); if (!d.ok) assert.match(d.reason, /finished/);
  const w = convertLegacyJob(weird); assert.equal(w.ok, false); if (!w.ok) assert.match(w.reason, /cannot be expressed/);
});

test("matchTask: id, prefix, exact title", () => {
  const tasks = [{ id: "scheduled-task:abc", title: "Daily" }, { id: "scheduled-task:def", title: "Weekly" }] as ScheduledTask[];
  assert.equal(matchTask(tasks, "scheduled-task:def").title, "Weekly");
  assert.equal(matchTask(tasks, "scheduled-task:a").title, "Daily");
  assert.equal(matchTask(tasks, "Weekly").id, "scheduled-task:def");
  assert.throws(() => matchTask(tasks, ""), (e: unknown) => e instanceof CliError && e.code === "task_not_found");
  assert.throws(() => matchTask(tasks, "nope"), /scheduled task not found/);
});
