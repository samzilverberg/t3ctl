/**
 * Parse a "when" for snooze: ISO datetime, relative duration (30m, 2h, 3d, 1w), clock time (09:00 → today
 * if still ahead, else tomorrow), or "tomorrow [HH:MM]" (default 09:00). Returns ISO in UTC.
 */
export function parseWhen(input: string, now = new Date()): string {
  const s = input.trim().toLowerCase();
  const dur = /^(\d+)\s*(m|min|h|hr|d|day|days|w|wk|week|weeks|hours?|minutes?)$/.exec(s);
  if (dur) {
    const n = Number(dur[1]); const u = dur[2][0];
    const ms = u === "m" ? 60e3 : u === "h" ? 3600e3 : u === "d" ? 86400e3 : 7 * 86400e3;
    return new Date(now.getTime() + n * ms).toISOString();
  }
  const clock = /^(?:(today|tomorrow)\s*)?(?:(\d{1,2}):(\d{2}))?$/.exec(s);
  if (clock && (clock[1] || clock[2])) {
    const d = new Date(now);
    const hh = clock[2] ? Number(clock[2]) : 9; const mm = clock[3] ? Number(clock[3]) : 0;
    d.setHours(hh, mm, 0, 0);
    if (clock[1] === "tomorrow" || (!clock[1] && d.getTime() <= now.getTime())) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  throw new Error(`cannot parse time "${input}" (use ISO, 30m/2h/3d/1w, HH:MM, or "tomorrow [HH:MM]")`);
}
