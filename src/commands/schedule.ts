import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { connect, withAuthRetry, type Ctx, type GlobalOpts } from "../context.js";
import { api, rpc, type ShellProject, type ShellThread } from "../http.js";
import { fetchConfig, type ModelSelection, type ServerConfig } from "../models.js";
import { ago, emit, pickFormat, renderTable, short } from "../output.js";
import { applyDefaults, createThread, envModeOf, matchProject, matchThread, resolveNewModel, resolveTurnModel, startTurn, INTERACTION_MODES, RUNTIME_MODES, type InteractionMode, type RuntimeMode } from "../ops.js";
import { nowIso, uuid } from "../ids.js";
import { CliError } from "../errors.js";
import { convertLegacyJob, cronToSchedule, describeSchedule, fixedTimeSchedule, intervalSchedule, parseDuration, LEGACY_LOG_PATH, LEGACY_SCHEDULE_PATH, matchTask, readLegacyJobs, type Schedule, type ScheduledTask } from "../schedule.js";
import { acquireOnceLock, DEFAULT_GRACE_SEC, describeOnce, evaluateOnce, matchOnce, newOnceId, ONCE_LOG_PATH, ONCE_PATH, parseOnceAt, pruneOnce, readOnce, writeOnce, type OnceJob } from "../once.js";
import * as launchd from "../launchd.js";
import { existsSync as fileExists, readFileSync } from "node:fs";

/**
 * `t3ctl schedule` drives T3 Code's built-in scheduler (0.1+): one source of truth for recurring work, shared with
 * the desktop UI and the MCP `schedule_task` tools. Tasks persist in the app's own database and fire from the
 * server, with or without a client around.
 *
 * The one thing the server cannot do yet is fire once at a date (upstream discussions #6748, #20863). `--once <when>`
 * keeps such a job client-side (src/once.ts) and a launchd ticker (`schedule tick`, every minute) fires it. Nothing
 * recurring ever goes through the ticker, so the two schedulers cannot double-fire.
 */
export function registerSchedule(program: Command) {
  const sched = program.command("schedule").description("Scheduled tasks: recurring ones run by T3 Code's scheduler, one-shots (--once) by the t3ctl ticker");

  const scheduleFlags = (c: Command) => c
    .option("--every <dur>", "run every <dur> (≥ 1m: 30m, 2h, 1d)")
    .option("--at <HH:MM>", "run daily at this local time (server's time zone)")
    .option("--days <spec>", "with --at: mon-fri, weekdays, weekends, mon,wed,fri, 0-6 (0 = Sunday)")
    .option("--cron <expr>", "convenience: a cron expression T3 can express (*/N * * * *, M H * * D, @hourly, @daily, @weekly)")
    .option("--webhook", "run on each request to the task's webhook URL (prompt may use {{body.x}} placeholders)", false)
    .option("--once <when>", "run once at <when> (30m, 2h, 17:30, \"tomorrow 09:00\", ISO); client-side, fired by the t3ctl ticker")
    .option("--grace <dur>", "with --once: still fire if the Mac was asleep and the ticker is up to <dur> late (default 60m)");

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
    .description("Create a scheduled task. Pick exactly one of --every / --at / --cron / --webhook (server) or --once (t3ctl ticker), and -p (new thread per run) or --thread (message into that thread).")
    .option("-p, --project <ref>", "project: every run starts a new thread here")
    .option("--thread <ref>", "instead, send the prompt into this existing thread on every run")
    .option("--disabled", "create paused", false)))
    .action(async (promptArg: string, o: AddOpts) => {
      const g = program.opts<GlobalOpts>();
      if (!o.project === !o.thread) throw new CliError("invalid_option", "pass exactly one of -p <project> or --thread <ref>", { option: "project" });
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      if (!text) throw new CliError("invalid_option", "empty prompt", { option: "prompt" });
      const schedule = scheduleFromFlags(o);
      if (!schedule && o.once === undefined) throw new CliError("invalid_option", "pass one of --every <dur>, --at HH:MM [--days …], --cron <expr>, --webhook, --once <when>", { option: "schedule" });
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const config = await fetchConfig(ctx.server, ctx.client.token);
      const target = await resolveTarget(ctx, shell, config, o);   // validates project/thread/model/effort for both kinds
      if (o.once !== undefined) {
        if (o.disabled) throw new CliError("invalid_option", "--disabled does not apply to --once (remove the job instead)", { option: "disabled" });
        const job = addOnceJob({ at: parseOnceAt(o.once), graceSec: o.grace ? parseDuration(o.grace) : DEFAULT_GRACE_SEC, title: (o.title ?? text.split("\n")[0]).trim().slice(0, 80) || "One-shot", text, target, shell, o });
        const ticker = ensureTicker();
        emit(ctx.format, onceView(job, ticker), () => `scheduled ${job.id}  ${describeOnce(job)}  ${job.send ? `→ ${short(job.send.thread)}` : `new @${job.new?.projectTitle}`}${ticker.installed ? "" : "\nWARNING: no ticker; run `t3ctl schedule install` or nothing fires"}`);
        return;
      }
      if (o.grace) throw new CliError("invalid_option", "--grace only applies to --once", { option: "grace" });
      const input = {
        commandId: uuid(), title: (o.title ?? text.split("\n")[0]).trim().slice(0, 80) || "Scheduled task", prompt: text, enabled: !o.disabled, schedule,
        ...target, createdBy: "user", creationSource: "server",
      };
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.upsert", input));
      emit(ctx.format, task, () => `scheduled ${task.id}  ${describeSchedule(task.schedule)}  next ${task.nextRunAt ?? "-"}${task.webhook?.url ? `\nwebhook ${task.webhook.url}` : task.schedule.type === "webhook" ? "\nwebhook URL needs T3 Connect remote access" : ""}`);
    });

  sched
    .command("list", { isDefault: true })
    .description("List scheduled tasks (server) and pending one-shots (t3ctl ticker)")
    .option("-p, --project <ref>", "only this project")
    .option("-a, --all", "also list one-shots that already fired, were missed or failed", false)
    .action(async (o: { project?: string; all: boolean }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const [shell, { tasks }] = await Promise.all([withAuthRetry(ctx, g, api.shell), withAuthRetry(ctx, g, (c) => rpc<{ tasks: ScheduledTask[] }>(c, "scheduledTasks.list", {}))]);
      const projects = new Map(shell.projects.map((p) => [p.id, p.title]));
      let list = tasks;
      let once = readOnce();
      if (o.project) {
        const p = matchProject(shell.projects, o.project);
        list = list.filter((t) => t.projectId === p.id);
        const threadsOfProject = new Set(shell.threads.filter((t) => t.projectId === p.id).map((t) => t.id));
        once = once.filter((j) => (j.new ? j.new.project === p.id : threadsOfProject.has(j.send?.thread ?? "")));
      }
      if (!o.all) once = once.filter((j) => j.status === "pending");
      list = [...list].sort((a, b) => (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~"));
      once = [...once].sort((a, b) => a.at.localeCompare(b.at));
      const ticker = { installed: launchd.isLoaded() };
      const legacy = legacyState();
      emit(ctx.format, { tasks: list.map((t) => ({ ...t, projectTitle: projects.get(t.projectId) ?? "" })), once: once.map((j) => onceView(j)), ticker, ...(legacy ? { legacy } : {}) }, () => {
        const table = renderTable(list.map((t) => ({
          id: short(t.id), on: t.enabled ? "on" : "off", schedule: describeSchedule(t.schedule), target: t.threadId ? `→ ${short(t.threadId)}` : `new @${projects.get(t.projectId) ?? short(t.projectId)}`,
          model: `${t.modelSelection.model}${effort(t.modelSelection) ? "@" + effort(t.modelSelection) : ""}`, title: t.title.slice(0, 40), next: t.nextRunAt ? ago(t.nextRunAt).replace(/^/, "in ") : "-", last: t.lastRunStatus === "never" ? "" : `${t.lastRunStatus} ${t.lastRunAt ? ago(t.lastRunAt) + " ago" : ""}${t.lastRunError ? " (" + t.lastRunError.slice(0, 40) + ")" : ""}`, runs: t.runCount,
        })), ["id", "on", "schedule", "target", "model", "title", "next", "last", "runs"]);
        const onceTable = once.length ? `\n\none-shots (t3ctl ticker${ticker.installed ? "" : " NOT INSTALLED: run t3ctl schedule install"}):\n` + renderTable(once.map((j) => ({
          id: j.id, status: j.status, at: j.at.replace(/\.\d{3}Z$/, "Z"), in: j.status === "pending" ? ago(j.at).replace(/^/, "in ") : "", target: j.send ? `→ ${short(j.send.thread)}` : `new @${j.new?.projectTitle ?? short(j.new?.project ?? "")}`, title: j.title.slice(0, 40), result: j.threadId ? `thread ${short(j.threadId)}` : (j.reason ?? ""),
        })), ["id", "status", "at", "in", "target", "title", "result"]) : (ticker.installed ? "" : "\n\n(t3ctl ticker not installed; `--once` jobs would not fire)");
        return table + onceTable + (legacy ? `\n\nlegacy t3ctl scheduler file still present (${legacy.pendingJobs} pending job(s)); run \`t3ctl schedule migrate\`` : "");
      });
    });

  sched
    .command("show <ref>")
    .description("Show one task or one-shot (full JSON)")
    .action(async (ref: string) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const found = await findAny(ctx, program.opts<GlobalOpts>(), ref);
      const out = found.kind === "task" ? found.task : onceView(found.job, { installed: launchd.isLoaded() });
      emit(ctx.format, out, () => JSON.stringify(out, null, 2));
    });

  targetFlags(scheduleFlags(sched
    .command("update <ref>")
    .argument("[prompt]", "new prompt text, or - to read it from stdin")
    .description("Change a task's schedule, prompt, title, model or modes (unspecified fields are kept)")))
    .action(async (ref: string, promptArg: string | undefined, o: UpdateOpts) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const found = await findAny(ctx, g, ref);
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      if (found.kind === "once") {
        const job = found.job;
        if (job.status !== "pending") throw new CliError("invalid_option", `one-shot ${job.id} already ${job.status}; add a new one`, { option: "ref", status: job.status });
        if (scheduleFromFlags(o)) throw new CliError("invalid_option", "a one-shot cannot become recurring; remove it and add a server task", { option: "schedule" });
        if (o.once !== undefined) job.at = parseOnceAt(o.once);
        if (o.grace !== undefined) job.graceSec = parseDuration(o.grace);
        if (o.title !== undefined) job.title = o.title.slice(0, 80);
        if (text !== undefined) { if (job.send) job.send.text = text; if (job.new) job.new.text = text; }
        if (o.model !== undefined || o.effort !== undefined) { const tgt = job.send ?? job.new; if (tgt) { if (o.model !== undefined) tgt.model = o.model; if (o.effort !== undefined) tgt.effort = o.effort; } }
        if (job.new) { if (o.runtimeMode) job.new.runtimeMode = o.runtimeMode; if (o.interactionMode) job.new.interactionMode = o.interactionMode; if (o.env) job.new.env = o.env; if (o.base) job.new.base = o.base; if (o.branch) job.new.branch = o.branch; }
        const jobs = readOnce(); const i = jobs.findIndex((j) => j.id === job.id); if (i >= 0) jobs[i] = job; writeOnce(jobs);
        emit(ctx.format, onceView(job), () => `updated ${job.id}  ${describeOnce(job)}`);
        return;
      }
      if (o.once !== undefined || o.grace !== undefined) throw new CliError("invalid_option", "--once/--grace apply to one-shots only; remove the task and add one with --once", { option: "once" });
      const existing = found.task;
      const schedule = scheduleFromFlags(o) ?? existing.schedule;
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
      const found = await findAny(ctx, g, ref);
      if (found.kind === "once") throw new CliError("invalid_option", `one-shots cannot be paused; \`schedule remove ${found.job.id}\` or \`schedule update ${found.job.id} --once <when>\``, { option: "ref" });
      const existing = found.task;
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.setEnabled", { id: existing.id, enabled }));
      emit(ctx.format, task, () => `${name}d ${task.id}  next ${task.nextRunAt ?? "-"}`);
    });
  }

  sched.command("remove <ref>").alias("delete").description("Delete a task or one-shot").action(async (ref: string) => {
    const g = program.opts<GlobalOpts>();
    const ctx = await connect(g, { write: true });
    const found = await findAny(ctx, g, ref);
    if (found.kind === "once") {
      writeOnce(readOnce().filter((j) => j.id !== found.job.id));
      emit(ctx.format, { id: found.job.id, title: found.job.title, status: found.job.status }, () => `removed ${found.job.id} (${found.job.title})`);
      return;
    }
    const existing = found.task;
    const res = await withAuthRetry(ctx, g, (c) => rpc<{ id: string }>(c, "scheduledTasks.delete", { id: existing.id }));
    emit(ctx.format, { ...res, title: existing.title }, () => `removed ${res.id} (${existing.title})`);
  });

  sched.command("run <ref>").description("Run a task now (its next scheduled run is unaffected); a pending one-shot fires now instead of at its time").action(async (ref: string) => {
    const g = program.opts<GlobalOpts>();
    const ctx = await connect(g, { write: true });
    const found = await findAny(ctx, g, ref);
    if (found.kind === "once") {
      if (found.job.status !== "pending") throw new CliError("invalid_option", `one-shot ${found.job.id} already ${found.job.status}`, { option: "ref", status: found.job.status });
      const [result] = await fireOnce(ctx, g, [found.job], { force: true });   // `run` fires regardless of time or grace
      emit(ctx.format, result, () => `${result.id} ${result.status}${result.threadId ? " thread " + result.threadId : ""}${result.reason ? " — " + result.reason : ""}`);
      return;
    }
    const existing = found.task;
    const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.runNow", { id: existing.id }));
    emit(ctx.format, task, () => `run requested for ${task.id}  last ${task.lastRunStatus}${task.lastRunError ? " (" + task.lastRunError + ")" : ""}`);
  });

  sched
    .command("migrate")
    .description(`Move jobs from the pre-0.5 scheduler file (${LEGACY_SCHEDULE_PATH}, or its .legacy.json rename) into T3 Code tasks (recurring) and t3ctl one-shots (--once). Dry run unless --apply.`)
    .option("--apply", "create the tasks and one-shots, rename the legacy file, make sure the ticker matches", false)
    .option("--from <file>", "legacy job file to read (default: schedule.json, else schedule.legacy.json)")
    .action(async (o: { apply: boolean; from?: string }) => {
      const g = program.opts<GlobalOpts>();
      const legacyArchived = `${LEGACY_SCHEDULE_PATH.replace(/\.json$/, "")}.legacy.json`;
      const source = o.from ?? (fileExists(LEGACY_SCHEDULE_PATH) ? LEGACY_SCHEDULE_PATH : legacyArchived);
      const jobs = readLegacyJobs(source);
      const pending = jobs.filter((j) => j.nextAt);
      const alreadyOnce = readOnce();
      const conversions = pending.map((j) => convertLegacyJob(j));
      const ticker = launchd.isLoaded();
      const ctx = await connect(g, { write: o.apply });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const config = await fetchConfig(ctx.server, ctx.client.token);
      const existing = (await withAuthRetry(ctx, g, (cl) => rpc<{ tasks: ScheduledTask[] }>(cl, "scheduledTasks.list", {}))).tasks;
      const plan: Array<Record<string, unknown>> = [];
      const created: ScheduledTask[] = [];
      const createdOnce: OnceJob[] = [];
      for (const c of conversions) {
        if (!c.ok) { plan.push({ job: c.job.id, action: "skip", reason: c.reason, cron: c.job.cron ?? null, nextAt: c.job.nextAt }); continue; }
        if (c.kind === "once") {
          const dupOnce = [...alreadyOnce, ...createdOnce].find((j) => j.status === "pending" && j.at === c.at && (j.send?.thread ?? j.new?.project) === (c.job.send?.thread ?? c.job.new?.project));
          if (dupOnce) { plan.push({ job: c.job.id, action: "skip", reason: `already a one-shot ${dupOnce.id}`, cron: null, nextAt: c.at, existingOnceId: dupOnce.id }); continue; }
          try {
            const target = await resolveTarget(ctx, shell, config, { project: c.job.new?.project, thread: c.job.send?.thread, model: c.job.new?.model ?? c.job.send?.model, effort: c.job.new?.effort ?? c.job.send?.effort, env: c.job.new?.env, runtimeMode: c.job.new?.runtimeMode as RuntimeMode | undefined, interactionMode: c.job.new?.interactionMode as InteractionMode | undefined });
            plan.push({ job: c.job.id, action: o.apply ? "create-once" : "would-create-once", cron: null, nextAt: c.at, target: target.threadId ? `thread ${short(target.threadId)}` : `project ${target.projectId}` });
            if (o.apply) createdOnce.push(addOnceJob({ at: c.at, graceSec: c.job.graceSec || DEFAULT_GRACE_SEC, title: c.title, text: c.prompt, target, shell, o: { model: c.job.new?.model ?? c.job.send?.model, effort: c.job.new?.effort ?? c.job.send?.effort, title: c.job.new?.title, env: c.job.new?.env, runtimeMode: c.job.new?.runtimeMode as RuntimeMode | undefined, interactionMode: c.job.new?.interactionMode as InteractionMode | undefined } }));
          } catch (e) {
            plan.push({ job: c.job.id, action: "skip", reason: e instanceof Error ? e.message : String(e), cron: null, nextAt: c.at });
          }
          continue;
        }
        try {
          const target = await resolveTarget(ctx, shell, config, { project: c.job.new?.project, thread: c.job.send?.thread, model: c.job.new?.model ?? c.job.send?.model, effort: c.job.new?.effort ?? c.job.send?.effort, env: c.job.new?.env, runtimeMode: c.job.new?.runtimeMode as RuntimeMode | undefined, interactionMode: c.job.new?.interactionMode as InteractionMode | undefined });
          const targetLabel = target.threadId ? `thread ${short(target.threadId)}` : `project ${target.projectId}`;
          // Same target + same schedule already on the server (hand-made in the app, or an earlier migrate run): creating
          // another would fire twice. Skip it; the legacy job is retired with the file either way.
          const dup = [...existing, ...created].find((t) => sameTarget(t, target) && describeSchedule(t.schedule) === describeSchedule(c.schedule));
          if (dup) { plan.push({ job: c.job.id, action: "skip", reason: `already scheduled as task ${dup.id} (${dup.title})`, cron: c.job.cron, schedule: describeSchedule(c.schedule), target: targetLabel, existingTaskId: dup.id }); continue; }
          const input = { commandId: `t3ctl-migrate:${c.job.id}`, title: c.title, prompt: c.prompt, enabled: true, schedule: c.schedule, ...target, createdBy: "user", creationSource: "server" };
          plan.push({ job: c.job.id, action: o.apply ? "create" : "would-create", cron: c.job.cron, schedule: describeSchedule(c.schedule), target: targetLabel, ...(c.note ? { note: c.note } : {}) });
          if (o.apply) created.push((await withAuthRetry(ctx, g, (cl) => rpc<{ task: ScheduledTask }>(cl, "scheduledTasks.upsert", input))).task);
        } catch (e) {
          plan.push({ job: c.job.id, action: "skip", reason: e instanceof Error ? e.message : String(e), cron: c.job.cron ?? null });
        }
      }
      let cleanup: Record<string, unknown> = {};
      if (o.apply) {
        if (source === LEGACY_SCHEDULE_PATH && existsSync(LEGACY_SCHEDULE_PATH)) renameSync(LEGACY_SCHEDULE_PATH, legacyArchived);
        // The ticker now serves one-shots only: keep it exactly when there is something for it to fire.
        const pendingOnce = readOnce().some((j) => j.status === "pending");
        const tick = pendingOnce ? { installed: ensureTicker().installed } : { installed: false, removed: launchd.uninstall().removed };
        cleanup = { ticker: tick, legacyFile: existsSync(legacyArchived) ? legacyArchived : null, onceFile: ONCE_PATH, log: LEGACY_LOG_PATH };
      }
      const out = { apply: o.apply, source, legacyJobs: jobs.length, pendingJobs: pending.length, tickerInstalled: ticker, plan, created: created.map((t) => ({ id: t.id, title: t.title, schedule: describeSchedule(t.schedule), nextRunAt: t.nextRunAt })), createdOnce: createdOnce.map((j) => onceView(j)), ...cleanup };
      emit(ctx.format, out, () => [
        `legacy jobs in ${source}: ${jobs.length} (${pending.length} pending)  ticker: ${ticker ? "installed" : "not installed"}`,
        ...plan.map((p) => `  ${p.job}  ${p.action}  ${p.cron ?? `once ${p.nextAt ?? ""}`}${p.schedule ? ` → ${p.schedule}` : ""}${p.target ? `  ${p.target}` : ""}${p.reason ? `  (${p.reason})` : ""}${p.note ? `  [${p.note}]` : ""}`),
        o.apply ? `created ${created.length} task(s) and ${createdOnce.length} one-shot(s); ticker ${(cleanup.ticker as { installed: boolean }).installed ? "installed" : "not needed"}; legacy file → ${cleanup.legacyFile ?? "(none)"}` : "dry run; re-run with --apply",
      ].join("\n"));
    });

  sched
    .command("tick")
    .description("Fire due one-shots (what the launchd ticker runs every minute). Prints nothing when nothing is due.")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const release = acquireOnceLock();
      if (!release) { process.stderr.write("t3ctl: another tick holds the lock\n"); return; }
      try {
        const due = readOnce().filter((j) => evaluateOnce(j).due);
        if (due.length === 0) { if (g.format === "json") emit("json", []); return; }
        const results = await fireOnce(undefined, g, due);
        emit(pickFormatFor(program), results, () => results.map((r) => `${r.id} ${r.status}${r.threadId ? " thread " + r.threadId : ""}${r.reason ? " — " + r.reason : ""}`).join("\n"));
      } finally { release(); }
    });

  sched.command("install").description("Install the launchd ticker for one-shots (runs `schedule tick` every minute while you are logged in)").action(() => {
    const r = launchd.install();
    emit(pickFormatFor(program), { ...r, label: launchd.LAUNCHD_LABEL, log: ONCE_LOG_PATH }, () => `installed ${launchd.LAUNCHD_LABEL}\nplist ${r.plist}\nnode  ${r.node}\nlog   ${ONCE_LOG_PATH}`);
  });
  sched.command("uninstall").description("Remove the launchd ticker (one-shot jobs stay in the file and will not fire)").action(() => {
    const r = launchd.uninstall();
    const pending = readOnce().filter((j) => j.status === "pending").length;
    emit(pickFormatFor(program), { ...r, pendingOnce: pending }, () => `${r.removed ? "uninstalled" : "was not installed"}${pending ? `\nWARNING: ${pending} pending one-shot(s) will not fire until \`schedule install\`` : ""}`);
  });
}

// ---- one-shots (client-side) ----

interface OnceTarget { projectId: string; threadId: string | null }

function addOnceJob(a: { at: string; graceSec: number; title: string; text: string; target: OnceTarget; shell: { projects: ShellProject[] }; o: TargetOpts & { title?: string } }): OnceJob {
  const { o, target } = a;
  const job: OnceJob = { id: newOnceId(), createdAt: nowIso(), at: a.at, graceSec: a.graceSec, title: a.title, status: "pending" };
  if (target.threadId) job.send = { thread: target.threadId, text: a.text, model: o.model, effort: o.effort };
  else job.new = { project: target.projectId, projectTitle: a.shell.projects.find((p) => p.id === target.projectId)?.title, text: a.text, model: o.model, effort: o.effort, title: o.title, env: o.env, base: o.base, branch: o.branch, runtimeMode: o.runtimeMode, interactionMode: o.interactionMode };
  const jobs = readOnce(); jobs.push(job); writeOnce(pruneOnce(jobs));
  return job;
}

/** Make sure the ticker runs whenever a pending one-shot exists; never throws (the job is saved either way). */
function ensureTicker(): { installed: boolean; error?: string } {
  if (launchd.isLoaded()) return { installed: true };
  try { return { installed: launchd.install().installed }; } catch (e) { return { installed: false, error: e instanceof Error ? e.message : String(e) }; }
}

function onceView(job: OnceJob, ticker?: { installed: boolean; error?: string }): Record<string, unknown> {
  return { kind: "once", ...job, schedule: describeOnce(job), ...(ticker ? { tickerInstalled: ticker.installed, ...(ticker.error ? { tickerError: ticker.error } : {}) } : {}) };
}

interface OnceResult { id: string; status: OnceJob["status"]; at: string; firedAt: string; threadId?: string; sequence?: number; reason?: string }

/**
 * Fire one-shots: claim each job in the file first (a crash cannot double-fire), then start the thread / queue the
 * message. Past grace → `missed`. Thread-bound jobs queue after an active run instead of being dropped.
 */
async function fireOnce(ctx: Ctx | undefined, g: GlobalOpts, due: OnceJob[], { force = false }: { force?: boolean } = {}): Promise<OnceResult[]> {
  const now = new Date();
  const results: OnceResult[] = [];
  let shell: Awaited<ReturnType<typeof api.shell>> | undefined;
  for (const job of due) {
    const jobs = readOnce();
    const live = jobs.find((j) => j.id === job.id);
    if (!live || live.status !== "pending") continue;
    const ev = evaluateOnce(live, now);
    const settle = (patch: Partial<OnceJob>) => {
      Object.assign(live, patch, { firedAt: nowIso() });
      writeOnce(pruneOnce(jobs));
      const r: OnceResult = { id: live.id, status: live.status, at: live.at, firedAt: live.firedAt!, threadId: live.threadId, sequence: live.sequence, reason: live.reason };
      results.push(r);
      process.stderr.write(`${r.firedAt} ${r.id} at ${r.at} ${r.status}${r.threadId ? " thread " + r.threadId : ""}${r.reason ? " — " + r.reason : ""}\n`);
    };
    if (!force && ev.due && !ev.withinGrace) { settle({ status: "missed", reason: `late by ${fmtSec(ev.lateSec)} (grace ${fmtSec(live.graceSec)})` }); continue; }
    // Claim before dispatching.
    live.status = "fired"; live.reason = undefined; writeOnce(pruneOnce(jobs));
    try {
      ctx ??= await connect(g, { write: true });
      shell ??= await withAuthRetry(ctx, g, api.shell);
      if (live.new) {
        const s = await createThread(ctx, g, { ...live.new, title: live.new.title ?? live.title });
        settle({ status: "fired", threadId: s.threadId, sequence: s.sequence ?? undefined });
      } else if (live.send) {
        const t = matchThread([...shell.threads, ...(shell.archivedThreads ?? [])], live.send.thread);
        const r = await startTurn(ctx, g, t, { ...live.send, whenRunning: "queue" });
        settle({ status: "fired", threadId: t.id, sequence: r.sequence, reason: r.dispatchMode === "queue_after_active" ? "queued after the active run" : undefined });
      } else {
        settle({ status: "failed", reason: "job has neither new nor send" });
      }
    } catch (e) {
      settle({ status: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

function fmtSec(s: number): string { return s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; }
function pickFormatFor(program: Command) { return pickFormat(program.opts<GlobalOpts>().format); }

type Found = { kind: "task"; task: ScheduledTask } | { kind: "once"; job: OnceJob };

/** `<ref>` may name a server task or a local one-shot (id, prefix or exact title); one-shots are checked first. */
async function findAny(ctx: Ctx, g: GlobalOpts, ref: string): Promise<Found> {
  const once = matchOnce(readOnce(), ref);
  if (once) return { kind: "once", job: once };
  const { tasks } = await withAuthRetry(ctx, g, (c) => rpc<{ tasks: ScheduledTask[] }>(c, "scheduledTasks.list", {}));
  try { return { kind: "task", task: matchTask(tasks, ref) }; } catch (e) {
    if (e instanceof CliError && e.code === "task_not_found") throw new CliError("task_not_found", `scheduled task not found: ${ref}`, { ref, known: tasks.map((x) => ({ id: x.id, title: x.title })), once: readOnce().filter((j) => j.status === "pending").map((j) => ({ id: j.id, title: j.title })) });
    throw e;
  }
}

/** A task targets the same place as a resolved target: the same thread, or (thread-less) the same project. */
function sameTarget(t: ScheduledTask, target: { projectId: string; threadId: string | null }): boolean {
  return target.threadId ? t.threadId === target.threadId : (!t.threadId && t.projectId === target.projectId);
}

interface TargetOpts { project?: string; thread?: string; model?: string; effort?: string; env?: string; base?: string; branch?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }
interface ScheduleOpts { every?: string; at?: string; days?: string; cron?: string; webhook?: boolean; once?: string; grace?: string }
type AddOpts = TargetOpts & ScheduleOpts & { title?: string; disabled: boolean };
type UpdateOpts = Omit<TargetOpts, "project" | "thread"> & ScheduleOpts & { title?: string };

function scheduleFromFlags(o: ScheduleOpts): Schedule | undefined {
  const picked = [o.every !== undefined, o.at !== undefined, o.cron !== undefined, o.webhook === true, o.once !== undefined].filter(Boolean).length;
  if (picked > 1) throw new CliError("invalid_option", "pass only one of --every, --at, --cron, --webhook, --once", { option: "schedule" });
  if (o.once !== undefined) return undefined;   // client-side one-shot; handled by the caller
  if (o.days !== undefined && o.at === undefined) throw new CliError("invalid_option", "--days needs --at HH:MM", { option: "days" });
  if (o.every !== undefined) return intervalSchedule(o.every);
  if (o.at !== undefined) return fixedTimeSchedule(o.at, o.days);
  if (o.cron !== undefined) return cronToSchedule(o.cron);
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

async function findTask(ctx: Ctx, g: GlobalOpts, ref: string): Promise<ScheduledTask> {
  const { tasks } = await withAuthRetry(ctx, g, (c) => rpc<{ tasks: ScheduledTask[] }>(c, "scheduledTasks.list", {}));
  return matchTask(tasks, ref);
}

function legacyState(): { pendingJobs: number; file: string } | undefined {
  const jobs = readLegacyJobs();
  if (jobs.length === 0) return undefined;
  return { pendingJobs: jobs.filter((j) => j.nextAt).length, file: LEGACY_SCHEDULE_PATH };
}

export { pickFormat };
