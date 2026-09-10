/**
 * Re-record test fixtures from the live server. Usage:
 *   pnpm tsx test/record-fixtures.ts <approvalThreadRef> <userInputThreadRef>
 * Threads must be unarchived (archived detail endpoints 404). Output is scrubbed: titles, paths and
 * message text are replaced; ids are kept (they are random UUIDs).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "../src/context.js";
import { api } from "../src/http.js";
import { fetchProviders } from "../src/models.js";
import { matchThread } from "../src/ops.js";

const [approvalRef, userInputRef] = process.argv.slice(2);
if (!approvalRef || !userInputRef) throw new Error("usage: record-fixtures <approvalThreadRef> <userInputThreadRef>");

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

// Shell: a handful of threads covering each derived status, scrubbed.
const shell = await api.shell(ctx.client);
const projects = shell.projects.slice(0, 2).map((p, i) => ({ id: p.id, title: `project-${i}`, workspaceRoot: `/tmp/project-${i}`, defaultModelSelection: p.defaultModelSelection }));
const pick = (pred: (t: (typeof shell.threads)[number]) => boolean) => shell.threads.find(pred);
const samples = [
  pick((t) => !!t.session?.activeTurnId),
  pick((t) => t.latestTurn?.state === "completed" && !t.session?.activeTurnId && !t.hasPendingApprovals && !t.hasPendingUserInput),
  pick((t) => !!t.hasPendingApprovals), pick((t) => !!t.hasPendingUserInput),
  pick((t) => t.latestTurn?.state === "error"), pick((t) => t.latestTurn?.state === "interrupted"), pick((t) => !t.latestTurn),
].filter((t): t is NonNullable<typeof t> => !!t);
save("shell.json", {
  snapshotSequence: shell.snapshotSequence, projects,
  threads: samples.map((t, i) => ({
    id: t.id, projectId: projects[0]?.id ?? t.projectId, title: `thread-${i}`, createdAt: t.createdAt, updatedAt: t.updatedAt, archivedAt: t.archivedAt ?? null,
    branch: t.branch ? "feature/x" : null, worktreePath: null, modelSelection: t.modelSelection, latestTurn: t.latestTurn ?? null, session: t.session ?? null,
    hasPendingApprovals: t.hasPendingApprovals ?? false, hasPendingUserInput: t.hasPendingUserInput ?? false, runtimeMode: t.runtimeMode, interactionMode: t.interactionMode,
  })),
});

// Activities: everything the pending-request derivation looks at, text scrubbed.
const scrubActivities = async (ref: string) => {
  const t = matchThread(shell.threads, ref);
  const detail = await api.thread(ctx.client, t.id, 20);
  const acts = ((detail.thread as { activities?: Array<Record<string, unknown>> }).activities ?? []);
  return acts.map((a) => ({ ...a, summary: typeof a.summary === "string" ? a.summary.slice(0, 40) : a.summary, payload: scrub(a.payload) }));
};
const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ["command", "cwd", "path", "content", "text", "workspaceRoot"].includes(k) && typeof x === "string" ? `<${k}>` : scrub(x)]));
  return v;
};
save("activities-approval.json", await scrubActivities(approvalRef));
save("activities-user-input.json", await scrubActivities(userInputRef));
process.stdout.write("fixtures written to test/fixtures/\n");
