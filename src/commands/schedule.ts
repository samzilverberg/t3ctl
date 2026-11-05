import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { connect, withAuthRetry, type Ctx, type GlobalOpts } from "../context.js";
import { api, rpc, rpcFirst, type Client, type ShellProject, type ShellThread } from "../http.js";
import { fetchConfig, type ModelSelection, type ServerConfig } from "../models.js";
import { ago, emit, pickFormat, renderTable, short } from "../output.js";
import { applyDefaults, envModeOf, matchProject, matchThread, resolveNewModel, resolveTurnModel, INTERACTION_MODES, RUNTIME_MODES, type InteractionMode, type RuntimeMode } from "../ops.js";
import { uuid } from "../ids.js";
import { CliError } from "../errors.js";
import { compareVersions, INCOMPATIBLE_EXIT } from "../discover.js";
import { convertLegacyJob, convertLegacyOnce, cronToSchedule, describeSchedule, fixedTimeSchedule, intervalSchedule, onceSchedule, LEGACY_LOG_PATH, LEGACY_ONCE_PATH, LEGACY_SCHEDULE_PATH, matchTask, ONCE_MIN_SERVER_VERSION, shortTaskId, readLegacyJobs, readLegacyOnce, type LegacyConversion, type Schedule, type ScheduledTask } from "../schedule.js";
import { retireTicker, tickerPresent } from "../launchd.js";

/**
 * `t3ctl schedule` drives T3 Code's built-in scheduler: one source of truth shared with the desktop UI and the MCP
 * `schedule_task` tools. Tasks persist in the app's own database and fire from the server, with or without a client
 * around. Recurring (interval / fixed time), webhook, and since T3 Code 0.1.7 one-time (`--once`) schedules are all
 * the server's; t3ctl keeps no job state of its own. `migrate` moves job files from older t3ctl versions over.
 */
export function registerSchedule(program: Command) {
  const sched = program.command("schedule").description("T3 Code scheduled tasks: recurring, webhook and one-time (--once)");

  const scheduleFlags = (c: Command) => c
    .option("--every <dur>", "run every <dur> (≥ 1m: 30m, 2h, 1d)")
    .option("--at <HH:MM>", "run daily at this local time (server's time zone)")
    .option("--days <spec>", "with --at: mon-fri, weekdays, weekends, mon,wed,fri, 0-6 (0 = Sunday)")
    .option("--cron <expr>", "convenience: a cron expression T3 can express (*/N * * * *, M H * * D, @hourly, @daily, @weekly)")
    .option("--webhook", "run on each request to the task's webhook URL (prompt may use {{body.x}} placeholders)", false)
    .option("--once <when>", "run once at <when> (30m, 2h, 17:30, \"tomorrow 09:00\", ISO); T3 Code ≥ 0.1.7");

  const targetFlags = (c: Command) => c
    .option("-m, --model <ref>", "model slug or alias (default: project default → server default)")
    .option("-e, --effort <level>", "reasoning effort")
    .option("-t, --title <title>", "task title (default: first line of the prompt)")
    .option("--runtime-mode <mode>", RUNTIME_MODES.join("|"))
    .option("--interaction-mode <mode>", INTERACTION_MODES.join("|"))
    .option("--env <mode>", "worktree|local for new-thread tasks (default: project/server setting)")
    .option("--base <ref>", "base ref for worktree tasks (default: the project checkout's current branch)")
    .option("--branch <name>", "fixed worktree branch name (default: server picks one per run)");

  targetFlags(scheduleFlags(sched
    .command("add")
    .argument("<prompt>", "prompt text, or - to read it from stdin")
    .description("Create a scheduled task. Pick exactly one of --every / --at / --cron / --webhook / --once, and -p (new thread per run) or --thread (message into that thread).")
    .option("-p, --project <ref>", "project: every run starts a new thread here")
    .option("--thread <ref>", "instead, send the prompt into this existing thread on every run")
    .option("--disabled", "create paused", false)))
    .action(async (promptArg: string, o: AddOpts) => {
      const g = program.opts<GlobalOpts>();
      if (!o.project === !o.thread) throw new CliError("invalid_option", "pass exactly one of -p <project> or --thread <ref>", { option: "project" });
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      if (!text) throw new CliError("invalid_option", "empty prompt", { option: "prompt" });
      const schedule = scheduleFromFlags(o);
      if (!schedule) throw new CliError("invalid_option", "pass one of --every <dur>, --at HH:MM [--days …], --cron <expr>, --webhook, --once <when>", { option: "schedule" });
      const ctx = await connect(g, { write: true });
      assertScheduleSupported(ctx, schedule);
      const shell = await withAuthRetry(ctx, g, api.shell);
      const config = await fetchConfig(ctx.server, ctx.client.token);
      const target = await resolveTarget(ctx, shell, config, o);
      const input = {
        commandId: uuid(), title: (o.title ?? text.split("\n")[0]).trim().slice(0, 80) || "Scheduled task", prompt: text, enabled: !o.disabled, schedule,
        ...target, createdBy: "user", creationSource: "server",
      };
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.upsert", input));
      emit(ctx.format, task, () => `scheduled ${task.id}  ${describeSchedule(task.schedule)}  next ${task.nextRunAt ?? "-"}${task.webhook?.url ? `\nwebhook ${task.webhook.url}` : task.schedule.type === "webhook" ? "\nwebhook URL needs T3 Connect remote access" : ""}`);
    });

  sched
    .command("list", { isDefault: true })
    .description("List scheduled tasks")
    .option("-p, --project <ref>", "only this project")
    .action(async (o: { project?: string }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const [shell, { tasks }] = await Promise.all([withAuthRetry(ctx, g, api.shell), withAuthRetry(ctx, g, listTasks)]);
      const projects = new Map(shell.projects.map((p) => [p.id, p.title]));
      let list = tasks;
      if (o.project) { const p = matchProject(shell.projects, o.project, { includeArchived: true }); list = list.filter((t) => t.projectId === p.id); }
      list = [...list].sort((a, b) => (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~"));
      const legacy = legacyState();
      emit(ctx.format, { tasks: list.map((t) => ({ ...t, projectTitle: projects.get(t.projectId) ?? "" })), ...(legacy ? { legacy } : {}) }, () => {
        const table = renderTable(list.map((t) => ({
          id: shortTaskId(t.id), on: t.enabled ? "on" : "off", schedule: describeSchedule(t.schedule), target: t.threadId ? `→ ${short(t.threadId)}` : `new @${projects.get(t.projectId) ?? short(t.projectId)}`,
          model: `${t.modelSelection.model}${effort(t.modelSelection) ? "@" + effort(t.modelSelection) : ""}`, title: t.title.slice(0, 40), next: t.nextRunAt ? ago(t.nextRunAt).replace(/^/, "in ") : "-", last: t.lastRunStatus === "never" ? "" : `${t.lastRunStatus} ${t.lastRunAt ? ago(t.lastRunAt) + " ago" : ""}${t.lastRunError ? " (" + t.lastRunError.slice(0, 40) + ")" : ""}`, runs: t.runCount,
        })), ["id", "on", "schedule", "target", "model", "title", "next", "last", "runs"]);
        return table + (legacy ? `\n\nolder t3ctl scheduler state found (${legacy.pendingJobs} pending job(s)${legacy.ticker ? ", launchd ticker still installed" : ""}); run \`t3ctl schedule migrate\`` : "");
      });
    });

  sched
    .command("show <ref>")
    .description("Show one task (full JSON)")
    .action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const task = await findTask(ctx, g, ref);
      emit(ctx.format, task, () => JSON.stringify(task, null, 2));
    });

  targetFlags(scheduleFlags(sched
    .command("update <ref>")
    .argument("[prompt]", "new prompt text, or - to read it from stdin")
    .description("Change a task's schedule, prompt, title, model or modes (unspecified fields are kept)")))
    .action(async (ref: string, promptArg: string | undefined, o: UpdateOpts) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const existing = await findTask(ctx, g, ref);
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      const schedule = scheduleFromFlags(o) ?? existing.schedule;
      assertScheduleSupported(ctx, schedule);
      let modelSelection: ModelSelection = existing.modelSelection;
      if (o.model || o.effort) {
        const shell = await withAuthRetry(ctx, g, api.shell);
        const project = shell.projects.find((p) => p.id === existing.projectId);
        if (!project) throw new CliError("project_not_found", `task's project ${existing.projectId} no longer exists`, { ref: existing.projectId });
        modelSelection = (await resolveNewModel(ctx, project, { model: o.model ?? `${existing.modelSelection.instanceId}/${existing.modelSelection.model}`, effort: o.effort })).modelSelection;
      }
      const d = applyDefaults({ runtimeMode: (o.runtimeMode ?? existing.runtimeMode) as RuntimeMode, interactionMode: (o.interactionMode ?? existing.interactionMode) as InteractionMode });
      const input = {
        id: existing.id, requireExisting: true, commandId: uuid(),
        title: o.title ?? existing.title, prompt: text ?? existing.prompt, enabled: existing.enabled, schedule,
        projectId: existing.projectId, threadId: existing.threadId, workspaceStrategy: existing.workspaceStrategy, modelSelection,
        runtimeMode: d.runtimeMode, interactionMode: d.interactionMode, createdBy: existing.createdBy, creationSource: existing.creationSource,
      };
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.upsert", input));
      emit(ctx.format, task, () => `updated ${task.id}  ${describeSchedule(task.schedule)}  next ${task.nextRunAt ?? "-"}`);
    });

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    sched.command(`${name} <ref>`).description(`${name === "enable" ? "Resume" : "Pause"} a task`).action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const existing = await findTask(ctx, g, ref);
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.setEnabled", { id: existing.id, enabled }));
      emit(ctx.format, task, () => `${name}d ${task.id}  next ${task.nextRunAt ?? "-"}`);
    });
  }

  sched.command("remove <ref>").alias("delete").description("Delete a task").action(async (ref: string) => {
    const g = program.opts<GlobalOpts>();
    const ctx = await connect(g, { write: true });
    const existing = await findTask(ctx, g, ref);
    const res = await withAuthRetry(ctx, g, (c) => rpc<{ id: string }>(c, "scheduledTasks.delete", { id: existing.id }));
    emit(ctx.format, { ...res, title: existing.title }, () => `removed ${res.id} (${existing.title})`);
  });

  sched.command("run <ref>").description("Run a task now (its next scheduled run, including a pending one-time run, is unaffected)").action(async (ref: string) => {
    const g = program.opts<GlobalOpts>();
    const ctx = await connect(g, { write: true });
    const existing = await findTask(ctx, g, ref);
    const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.runNow", { id: existing.id }));
    emit(ctx.format, task, () => `run requested for ${task.id}  last ${task.lastRunStatus}${task.lastRunError ? " (" + task.lastRunError + ")" : ""}`);
  });

  sched
    .command("migrate")
    .description(`Move jobs from older t3ctl schedulers (${LEGACY_SCHEDULE_PATH} from ≤ 0.4, ${LEGACY_ONCE_PATH} from 0.6) into T3 Code tasks and remove the old launchd ticker. Dry run unless --apply.`)
    .option("--apply", "create the tasks, rename the old files to *.legacy.json, remove the ticker", false)
    .option("--from <file>", "≤ 0.4 job file to read (default: schedule.json, else schedule.legacy.json)")
    .action(async (o: { apply: boolean; from?: string }) => {
      const g = program.opts<GlobalOpts>();
      const out = await migrate(g, { apply: o.apply, from: o.from, includeLegacySchedule: true });
      emit(pickFormatFor(program), out, () => [
        `old jobs: ${out.sources.map((s) => `${s.file} ${s.jobs} (${s.pending} pending)`).join(", ") || "none"}  ticker: ${out.tickerPresent ? "installed" : "not installed"}`,
        ...out.plan.map((p) => `  ${p.job}  ${p.action}  ${p.schedule ?? ""}${p.target ? `  ${p.target}` : ""}${p.reason ? `  (${p.reason})` : ""}${p.note ? `  [${p.note}]` : ""}`),
        o.apply ? `created ${out.created.length} task(s); ticker ${out.tickerRemoved ? "removed" : "not present"}; old files → ${out.renamed?.join(", ") || "(none)"}` : "dry run; re-run with --apply",
      ].join("\n"));
    });

  // What the retired launchd agent (t3ctl ≤ 0.6) still runs every minute: hand any pending one-shots to the server,
  // then remove the agent. Kept so an upgrade cleans itself up without a manual `migrate`.
  sched
    .command("tick", { hidden: true })
    .description("Legacy launchd entry point: migrate pending one-shots to T3 Code and remove the ticker")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const out = await migrate(g, { apply: true, includeLegacySchedule: false });
      process.stderr.write(`${new Date().toISOString()} retired the t3ctl ticker; created ${out.created.length} T3 Code task(s)\n`);
      if (g.format === "json") emit("json", out);
    });
}

function pickFormatFor(program: Command) { return pickFormat(program.opts<GlobalOpts>().format); }

/** `{ type: "once" }` is new in T3 Code 0.1.7; older 0.1.x servers would reject it with a schema error. */
function assertScheduleSupported(ctx: Ctx, schedule: Schedule): void {
  const version = ctx.server.descriptor.serverVersion;
  if (schedule.type === "once" && compareVersions(version, ONCE_MIN_SERVER_VERSION) < 0) {
    throw new CliError("incompatible_server", `one-time schedules need T3 Code ${ONCE_MIN_SERVER_VERSION} or newer (connected: ${version})`, { serverVersion: version, minServerVersion: ONCE_MIN_SERVER_VERSION }, INCOMPATIBLE_EXIT);
  }
}

interface PlanRow { job: string; action: string; schedule?: string; target?: string; reason?: string; note?: string; existingTaskId?: string }

/**
 * Convert pending jobs from the old client-side files into server tasks. `commandId` is derived from the job id, so a
 * re-run (or a tick racing a manual migrate) replays the same upsert instead of creating a second task.
 */
async function migrate(g: GlobalOpts, o: { apply: boolean; from?: string; includeLegacySchedule: boolean }) {
  const legacyArchived = (p: string) => `${p.replace(/\.json$/, "")}.legacy.json`;
  const scheduleSource = o.from ?? (existsSync(LEGACY_SCHEDULE_PATH) ? LEGACY_SCHEDULE_PATH : legacyArchived(LEGACY_SCHEDULE_PATH));
  const legacyJobs = o.includeLegacySchedule ? readLegacyJobs(scheduleSource) : [];
  const onceJobs = readLegacyOnce();
  const conversions: LegacyConversion[] = [
    ...legacyJobs.filter((j) => j.nextAt).map((j) => convertLegacyJob(j)),
    ...onceJobs.filter((j) => j.status === "pending").map((j) => convertLegacyOnce(j)),
  ];
  const ticker = tickerPresent();
  const plan: PlanRow[] = [];
  const created: ScheduledTask[] = [];
  if (conversions.length > 0) {
    const ctx = await connect(g, { write: o.apply });
    const shell = await withAuthRetry(ctx, g, api.shell);
    const config = await fetchConfig(ctx.server, ctx.client.token);
    const existing = (await withAuthRetry(ctx, g, listTasks)).tasks;
    for (const c of conversions) {
      if (!c.ok) { plan.push({ job: c.id, action: "skip", reason: c.reason }); continue; }
      const schedule = describeSchedule(c.schedule);
      try {
        assertScheduleSupported(ctx, c.schedule);
        const t = c.new ?? c.send;
        const target = await resolveTarget(ctx, shell, config, { project: c.new?.project, thread: c.send?.thread, model: t?.model, effort: t?.effort, env: c.new?.env, base: c.new?.base, branch: c.new?.branch, runtimeMode: c.new?.runtimeMode as RuntimeMode | undefined, interactionMode: c.new?.interactionMode as InteractionMode | undefined });
        const targetLabel = target.threadId ? `thread ${short(target.threadId)}` : `project ${target.projectId}`;
        // Same target + same schedule already on the server (hand-made in the app, or an earlier migrate run): creating
        // another would fire twice. Skip it; the old job is retired with its file either way.
        const dup = [...existing, ...created].find((x) => sameTarget(x, target) && describeSchedule(x.schedule) === schedule);
        if (dup) { plan.push({ job: c.id, action: "skip", reason: `already scheduled as task ${dup.id} (${dup.title})`, schedule, target: targetLabel, existingTaskId: dup.id }); continue; }
        plan.push({ job: c.id, action: o.apply ? "create" : "would-create", schedule, target: targetLabel, ...(c.note ? { note: c.note } : {}) });
        if (o.apply) {
          const input = { commandId: `t3ctl-migrate:${c.id}`, title: c.title, prompt: c.prompt, enabled: true, schedule: c.schedule, ...target, createdBy: "user", creationSource: "server" };
          created.push((await withAuthRetry(ctx, g, (cl) => rpc<{ task: ScheduledTask }>(cl, "scheduledTasks.upsert", input))).task);
        }
      } catch (e) {
        plan.push({ job: c.id, action: "skip", reason: e instanceof Error ? e.message : String(e), schedule });
      }
    }
  }
  const renamed: string[] = [];
  let tickerRemoved = false;
  if (o.apply) {
    for (const file of [...(o.includeLegacySchedule && scheduleSource === LEGACY_SCHEDULE_PATH ? [LEGACY_SCHEDULE_PATH] : []), LEGACY_ONCE_PATH]) {
      if (existsSync(file)) { renameSync(file, legacyArchived(file)); renamed.push(legacyArchived(file)); }
    }
    tickerRemoved = retireTicker().removed;
  }
  return {
    apply: o.apply,
    sources: [
      ...(o.includeLegacySchedule ? [{ file: scheduleSource, jobs: legacyJobs.length, pending: legacyJobs.filter((j) => j.nextAt).length }] : []),
      { file: LEGACY_ONCE_PATH, jobs: onceJobs.length, pending: onceJobs.filter((j) => j.status === "pending").length },
    ].filter((s) => s.jobs > 0),
    tickerPresent: ticker, plan, created: created.map((t) => ({ id: t.id, title: t.title, schedule: describeSchedule(t.schedule), nextRunAt: t.nextRunAt })),
    ...(o.apply ? { renamed, tickerRemoved, log: LEGACY_LOG_PATH } : {}),
  };
}

/** A task targets the same place as a resolved target: the same thread, or (thread-less) the same project. */
function sameTarget(t: ScheduledTask, target: { projectId: string; threadId: string | null }): boolean {
  return target.threadId ? t.threadId === target.threadId : (!t.threadId && t.projectId === target.projectId);
}

interface TargetOpts { project?: string; thread?: string; model?: string; effort?: string; env?: string; base?: string; branch?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }
interface ScheduleOpts { every?: string; at?: string; days?: string; cron?: string; webhook?: boolean; once?: string }
type AddOpts = TargetOpts & ScheduleOpts & { title?: string; disabled: boolean };
type UpdateOpts = Omit<TargetOpts, "project" | "thread"> & ScheduleOpts & { title?: string };

function scheduleFromFlags(o: ScheduleOpts): Schedule | undefined {
  const picked = [o.every !== undefined, o.at !== undefined, o.cron !== undefined, o.webhook === true, o.once !== undefined].filter(Boolean).length;
  if (picked > 1) throw new CliError("invalid_option", "pass only one of --every, --at, --cron, --webhook, --once", { option: "schedule" });
  if (o.days !== undefined && o.at === undefined) throw new CliError("invalid_option", "--days needs --at HH:MM", { option: "days" });
  if (o.every !== undefined) return intervalSchedule(o.every);
  if (o.at !== undefined) return fixedTimeSchedule(o.at, o.days);
  if (o.cron !== undefined) return cronToSchedule(o.cron);
  if (o.once !== undefined) return onceSchedule(o.once);
  if (o.webhook) return { type: "webhook", signature: null };
  return undefined;
}

const effort = (ms: { options?: Array<{ id: string; value: unknown }> }) => { const v = ms.options?.find((x) => x.id === "effort")?.value; return typeof v === "string" ? v : undefined; };

function gitBranch(cwd: string): string | undefined {
  try { const b = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return b && b !== "HEAD" ? b : undefined; } catch { return undefined; }
}

/** Project / thread / model / modes / workspace strategy for an upsert, validated against the live catalog. */
async function resolveTarget(ctx: Ctx, shell: { projects: ShellProject[]; threads: ShellThread[]; archivedThreads?: ShellThread[] }, config: ServerConfig, o: TargetOpts): Promise<{ projectId: string; threadId: string | null; workspaceStrategy: Record<string, unknown>; modelSelection: ModelSelection; runtimeMode: RuntimeMode; interactionMode: InteractionMode }> {
  const d = applyDefaults({ model: o.model, effort: o.effort, env: o.env, runtimeMode: o.runtimeMode, interactionMode: o.interactionMode });
  if (o.thread) {
    const t = matchThread([...shell.threads, ...(shell.archivedThreads ?? [])], o.thread);
    if (t.archivedAt) throw new CliError("thread_archived", `thread ${short(t.id)} is archived`, { threadId: t.id });
    const project = shell.projects.find((p) => p.id === t.projectId);
    if (!project) throw new CliError("project_not_found", `thread ${short(t.id)} belongs to an unknown project`, { ref: t.projectId });
    // A bound run follows the thread's current provider; the stored selection only matters for new threads.
    const modelSelection = (await resolveTurnModel(ctx, t, { model: d.model, effort: d.effort })) ?? (t.modelSelection as ModelSelection | undefined) ?? (await resolveNewModel(ctx, project, { effort: d.effort }, config)).modelSelection;
    return { projectId: project.id, threadId: t.id, workspaceStrategy: { type: "root" }, modelSelection, runtimeMode: (o.runtimeMode ?? (t.runtimeMode as RuntimeMode | undefined) ?? d.runtimeMode), interactionMode: (o.interactionMode ?? (t.interactionMode as InteractionMode | undefined) ?? d.interactionMode) };
  }
  const project = matchProject(shell.projects, o.project ?? "");
  const { modelSelection, settings } = await resolveNewModel(ctx, project, { model: d.model, effort: d.effort }, config);
  const envMode = envModeOf(d.env, settings, project.defaultThreadEnvMode);
  const branch = gitBranch(project.workspaceRoot);
  const baseRef = o.base ?? branch;
  const workspaceStrategy = envMode === "worktree" && baseRef
    ? { type: "worktree", baseRef, ...(o.branch ? { branch: o.branch } : {}), ...(settings.newWorktreesStartFromOrigin === true ? { startFromOrigin: true } : {}) }
    : { type: "root", ...(branch ? { branch } : {}) };
  return { projectId: project.id, threadId: null, workspaceStrategy, modelSelection, runtimeMode: d.runtimeMode, interactionMode: d.interactionMode };
}

/**
 * T3 Code 0.1.7 dropped the unary `scheduledTasks.list`; the stream `scheduledTasks.subscribe` (same payload and
 * result) is the only reader now. Its first value is the full list.
 */
const listTasks = (c: Client) => rpcFirst<{ tasks: ScheduledTask[] }>(c, "scheduledTasks.subscribe", {});

async function findTask(ctx: Ctx, g: GlobalOpts, ref: string): Promise<ScheduledTask> {
  const { tasks } = await withAuthRetry(ctx, g, listTasks);
  return matchTask(tasks, ref);
}

/** Leftovers from older t3ctl schedulers that `schedule migrate` would act on. */
function legacyState(): { pendingJobs: number; ticker: boolean } | undefined {
  const pendingJobs = readLegacyJobs().filter((j) => j.nextAt).length + readLegacyOnce().filter((j) => j.status === "pending").length;
  const ticker = tickerPresent();
  return pendingJobs > 0 || ticker ? { pendingJobs, ticker } : undefined;
}

export { pickFormat };
