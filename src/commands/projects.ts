import type { Command } from "commander";
import { connect, type GlobalOpts } from "../context.js";
import { api, dispatch } from "../http.js";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { withAuthRetry } from "../context.js";
import { buildModelSelection, fetchProviders, resolveModel } from "../models.js";
import { nowIso, uuid } from "../ids.js";
import { emit, renderTable, short } from "../output.js";

export function registerProjects(program: Command) {
  const projects = program.command("projects").alias("project").description("Read projects");

  projects
    .command("list", { isDefault: true })
    .description("List projects with thread counts")
    .action(async () => {
      const { client, format } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const counts = new Map<string, number>();
      for (const t of shell.threads) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
      const rows = shell.projects.map((p) => ({ ...p, threadCount: counts.get(p.id) ?? 0 }));
      emit(format, rows, () =>
        renderTable(rows.map((p) => ({ id: short(p.id), title: p.title, threads: p.threadCount, workspaceRoot: p.workspaceRoot })), ["id", "title", "threads", "workspaceRoot"]));
    });

  projects
    .command("show <idOrTitle>")
    .description("Show one project (full JSON)")
    .action(async (ref: string) => {
      const { client, format } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const p = shell.projects.find((x) => x.id === ref || x.id.startsWith(ref) || x.title === ref);
      if (!p) throw new Error(`project not found: ${ref}`);
      emit(format, p, () => JSON.stringify(p, null, 2));
    });

  projects
    .command("add <path>")
    .description("Register a directory as a project (project.create)")
    .option("-t, --title <title>", "project title (default: directory name)")
    .option("-m, --model <ref>", "default model for new threads in this project")
    .option("-e, --effort <level>", "default effort (with --model)")
    .option("--create-dir", "create the directory if missing", false)
    .action(async (path: string, o: { title?: string; model?: string; effort?: string; createDir: boolean }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const workspaceRoot = resolve(path);
      if (!o.createDir && (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory())) throw new Error(`not a directory: ${workspaceRoot} (use --create-dir)`);
      const shell = await withAuthRetry(ctx, g, api.shell);
      const dup = shell.projects.find((p) => p.workspaceRoot === workspaceRoot);
      if (dup) throw new Error(`already a project: ${dup.title} (${dup.id})`);
      let defaultModelSelection: unknown;
      if (o.model) {
        const providers = await fetchProviders(ctx.server, ctx.client.token);
        defaultModelSelection = buildModelSelection(resolveModel(providers, o.model), { effort: o.effort });
      }
      const projectId = uuid();
      const title = o.title ?? basename(workspaceRoot);
      const res = await dispatch(ctx.client, { type: "project.create", commandId: uuid(), projectId, title, workspaceRoot, ...(o.createDir ? { createWorkspaceRootIfMissing: true } : {}), ...(defaultModelSelection ? { defaultModelSelection } : {}), createdAt: nowIso() });
      emit(ctx.format, { projectId, title, workspaceRoot, defaultModelSelection: defaultModelSelection ?? null, sequence: res.sequence }, () => `created project ${title} (${projectId}) at ${workspaceRoot}`);
    });

  projects
    .command("remove <ref>")
    .description("Remove a project from T3 Code (project.delete). Files on disk are untouched. Refuses if it still has threads unless --force.")
    .option("--force", "delete even if the project has threads", false)
    .action(async (ref: string, o: { force: boolean }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const p = shell.projects.find((x) => x.id === ref || x.id.startsWith(ref) || x.title === ref || x.workspaceRoot === resolve(ref));
      if (!p) throw new Error(`project not found: ${ref}`);
      const n = shell.threads.filter((t) => t.projectId === p.id).length;
      if (n > 0 && !o.force) throw new Error(`project ${p.title} has ${n} active thread(s); pass --force to delete anyway`);
      const res = await dispatch(ctx.client, { type: "project.delete", commandId: uuid(), projectId: p.id, ...(o.force ? { force: true } : {}) });
      emit(ctx.format, { projectId: p.id, title: p.title, sequence: res.sequence }, () => `removed project ${p.title} (${p.id})`);
    });
}
