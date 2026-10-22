/**
 * Re-record test fixtures from the live server (T3 Code ≥ 0.1). Usage:
 *   pnpm record-fixtures <pendingThreadRef>
 * `pendingThreadRef` should be a thread currently blocked on an approval and/or a question; its projection is
 * trimmed to the fields the pending-request derivation reads. Output is scrubbed: titles, paths, message text and
 * prompts are replaced; ids are kept.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "../src/context.js";
import { api } from "../src/http.js";
import { fetchProviders } from "../src/models.js";
import { matchThread } from "../src/ops.js";
import { threadStatus } from "../src/wait.js";

const [pendingRef] = process.argv.slice(2);
if (!pendingRef) throw new Error("usage: record-fixtures <pendingThreadRef>");

const ctx = await connect({}, { write: false });
const out = new URL("./fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(new URL(name, out), JSON.stringify(data, null, 2) + "\n");

// Providers: model catalog + option descriptors. Drop anything that is not needed for resolution.
const providers = (await fetchProviders(ctx.server, ctx.client.token)).map((p) => ({
  instanceId: p.instanceId, driver: p.driver, displayName: p.displayName, enabled: p.enabled,
  models: p.models.map((m) => ({ slug: m.slug, name: m.name, aliases: m.aliases, isLegacy: m.isLegacy, capabilities: m.capabilities })),
}));
save("providers.json", providers);

// Shell: one thread per derived status, scrubbed.
const shell = await api.shell(ctx.client);
const projects = shell.projects.slice(0, 1).map((p, i) => ({ id: p.id, title: `project-${i}`, workspaceRoot: `/tmp/project-${i}`, defaultModelSelection: p.defaultModelSelection, defaultThreadEnvMode: p.defaultThreadEnvMode ?? null, scripts: [], createdAt: p.createdAt, updatedAt: p.updatedAt }));
const wanted = ["running", "idle", "needs-input", "needs-approval", "error", "interrupted"];
const samples = wanted.map((st) => shell.threads.find((t) => threadStatus(t) === st)).filter((t): t is NonNullable<typeof t> => !!t);
save("shell.json", {
  schemaVersion: shell.schemaVersion, snapshotSequence: shell.snapshotSequence, projects,
  threads: samples.map((t, i) => ({
    createdBy: t.createdBy, creationSource: t.creationSource, id: t.id, projectId: projects[0]?.id ?? t.projectId, title: `thread-${i}`, providerInstanceId: t.providerInstanceId, modelSelection: t.modelSelection,
    runtimeMode: t.runtimeMode, interactionMode: t.interactionMode, branch: t.branch ? "feature/x" : null, worktreePath: t.worktreePath ? "/tmp/project-0" : null,
    latestRunId: t.latestRunId ?? null, activeRunId: t.activeRunId ?? null, status: t.status, lastError: t.lastError ? "<error>" : null, pendingRuntimeRequest: t.pendingRuntimeRequest ?? null,
    latestVisibleMessage: t.latestVisibleMessage ? { ...t.latestVisibleMessage, text: "<text>" } : null,
    createdAt: t.createdAt, updatedAt: t.updatedAt, archivedAt: t.archivedAt ?? null, settledAt: t.settledAt ?? null, snoozedUntil: t.snoozedUntil ?? null,
  })),
  archivedThreads: [],
});

// Projection of a thread with pending requests, trimmed to runs / runtimeRequests / messages / request turn items.
const t = matchThread(shell.threads, pendingRef);
const detail = await api.thread(ctx.client, t.id);
const p = detail.projection;
const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ["command", "cwd", "path", "content", "text", "workspaceRoot", "input", "output", "prompt", "title"].includes(k) && typeof x === "string" ? `<${k}>` : scrub(x)]));
  return v;
};
save("projection-pending.json", {
  snapshotSequence: detail.snapshotSequence,
  projection: {
    thread: { id: p.thread.id, projectId: p.thread.projectId, title: "thread-pending" },
    runs: p.runs.map((r) => ({ id: r.id, threadId: r.threadId, ordinal: r.ordinal, status: r.status, requestedAt: r.requestedAt, startedAt: r.startedAt, completedAt: r.completedAt })),
    runtimeRequests: p.runtimeRequests,
    messages: scrub(p.messages.slice(-4)),
    turnItems: scrub(p.turnItems.filter((i) => i.type === "approval_request" || i.type === "user_input_request")),
  },
});
console.log(`recorded ${samples.length} shell threads (${samples.map((t) => threadStatus(t)).join(", ")}) and projection of ${t.id}`);
