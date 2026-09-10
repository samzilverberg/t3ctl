export type Format = "json" | "table";

export function pickFormat(flag?: string): Format {
  if (flag === "json") return "json";
  if (flag === "table") return "table";
  // Agent-friendly default: JSON when not a TTY or when an agent marker is set.
  if (!process.stdout.isTTY || process.env.T3CTL_AGENT || process.env.CI) return "json";
  return "table";
}

export function emit(format: Format, data: unknown, table?: () => string): void {
  if (format === "json" || !table) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(table() + "\n");
  }
}

export function renderTable(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join("\n");
}

export function short(id: string, n = 8): string { return id.slice(0, n); }
export function ago(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
