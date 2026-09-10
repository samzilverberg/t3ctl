import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhen } from "../src/time.js";

const now = new Date("2026-09-10T10:00:00.000Z");

test("relative durations", () => {
  assert.equal(parseWhen("30m", now), "2026-09-10T10:30:00.000Z");
  assert.equal(parseWhen("2h", now), "2026-09-10T12:00:00.000Z");
  assert.equal(parseWhen("3d", now), "2026-09-13T10:00:00.000Z");
  assert.equal(parseWhen("1w", now), "2026-09-17T10:00:00.000Z");
  assert.equal(parseWhen("45 minutes", now), "2026-09-10T10:45:00.000Z");
});

test("clock times roll to tomorrow when already past (local time)", () => {
  const atNine = new Date(2026, 8, 10, 9, 0, 0, 0);     // exactly 09:00 → tomorrow
  assert.equal(new Date(parseWhen("09:00", atNine)).getDate(), 11);
  const atEight = new Date(2026, 8, 10, 8, 0, 0, 0);    // still ahead → today
  assert.equal(new Date(parseWhen("09:00", atEight)).getDate(), 10);
  assert.equal(new Date(parseWhen("today 09:00", atEight)).getDate(), 10);
});

test("tomorrow defaults to 09:00 local", () => {
  const d = new Date(parseWhen("tomorrow", now));
  assert.equal(d.getHours(), 9); assert.equal(d.getMinutes(), 0);
  const e = new Date(parseWhen("tomorrow 14:30", now));
  assert.equal(e.getHours(), 14); assert.equal(e.getMinutes(), 30);
});

test("ISO passthrough and garbage", () => {
  assert.equal(parseWhen("2026-12-01T08:00:00Z", now), "2026-12-01T08:00:00.000Z");
  assert.throws(() => parseWhen("next thursday-ish", now), /cannot parse time/);
});
