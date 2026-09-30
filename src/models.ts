import type { Server } from "./discover.js";
import { modelAliases } from "./config.js";
import { RpcSocket } from "./ws.js";
import { CliError } from "./errors.js";

export interface ModelOptionDescriptor { id: string; label: string; type: string; options?: Array<{ id: string; label: string; isDefault?: boolean }> }
export interface ProviderModel { slug: string; name: string; aliases?: string[]; isLegacy?: boolean; isCustom?: boolean; capabilities?: { optionDescriptors?: ModelOptionDescriptor[] } }
export interface ProviderInstance { instanceId: string; driver: string; displayName: string; enabled: boolean; installed?: boolean; status?: string; models: ProviderModel[]; [k: string]: unknown }

export interface ModelSelection { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> }

export interface ServerConfig { providers: ProviderInstance[]; settings: Record<string, unknown> }

/** `server.getConfig`: provider catalog + server settings in one RPC. */
export async function fetchConfig(server: Server, token: string): Promise<ServerConfig> {
  const sock = new RpcSocket(server, token);
  try {
    const cfg = await sock.request<{ providers: ProviderInstance[]; settings?: Record<string, unknown> }>("server.getConfig", {});
    return { providers: cfg.providers, settings: cfg.settings ?? {} };
  } finally { sock.close(); }
}

export async function fetchProviders(server: Server, token: string): Promise<ProviderInstance[]> {
  return (await fetchConfig(server, token)).providers;
}

export interface ResolvedModel { instance: ProviderInstance; model: ProviderModel }

/** "Fable 5.0" → "fable-5-0"; "claude-opus-4.8" → "claude-opus-4-8". */
export function normalizeModelRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/[\s._]+/g, "-").replace(/-+/g, "-");
}

/**
 * Resolve a model reference across enabled providers. Order:
 * 1. user/builtin alias (config `modelAliases`, e.g. opus → claude-opus-4-8)
 * 2. exact slug or server alias
 * 3. normalized forms: "fable 5.0" → fable-5-0 → claude-fable-5-0 → claude-fable-5 (trailing -0 dropped)
 * Optional "<instanceId>/<model>" prefix pins the provider instance.
 */
export function resolveModel(providers: ProviderInstance[], ref: string): ResolvedModel {
  const [instPart, modelPart] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
  const candidates = providers.filter((p) => p.enabled && (!instPart || p.instanceId === instPart));
  const aliases = modelAliases();
  const norm = normalizeModelRef(modelPart);
  const wanted = new Set<string>();
  const aliased = aliases[norm] ?? aliases[modelPart.toLowerCase()];
  if (aliased) wanted.add(normalizeModelRef(aliased));
  wanted.add(norm);
  if (!norm.startsWith("claude-")) wanted.add(`claude-${norm}`);
  for (const w of [...wanted]) { if (w.endsWith("-0")) wanted.add(w.slice(0, -2)); }
  const find = (pred: (m: ProviderModel) => boolean) => { for (const p of candidates) { const m = p.models.find(pred); if (m) return { instance: p, model: m }; } return undefined; };
  for (const w of wanted) {
    const hit = find((m) => normalizeModelRef(m.slug) === w || (m.aliases ?? []).some((a) => normalizeModelRef(a) === w));
    if (hit) return hit;
  }
  const all = candidates.flatMap((p) => p.models.map((m) => `${p.instanceId}/${m.slug}`));
  throw new CliError("model_unknown", `unknown model "${ref}". Aliases: ${Object.entries(aliases).map(([k, v]) => `${k}→${v}`).join(", ")}. Known: ${all.join(", ")}`, { ref, aliases, known: all });
}

/** Build a ModelSelection, validating option values (e.g. effort) against the model's descriptors. */
export function buildModelSelection(r: ResolvedModel, opts: { effort?: string; contextWindow?: string; fast?: boolean }): ModelSelection {
  const descriptors = r.model.capabilities?.optionDescriptors ?? [];
  const options: ModelSelection["options"] = [];
  const pick = (id: string, value: string | undefined) => {
    if (value === undefined) return;
    const d = descriptors.find((x) => x.id === id);
    if (!d) throw new CliError("invalid_option", `model ${r.model.slug} has no option "${id}"`, { option: id, model: r.model.slug });
    if (d.options && !d.options.some((o) => o.id === value)) throw new CliError("invalid_option", `invalid ${id} "${value}" for ${r.model.slug}. Allowed: ${d.options.map((o) => o.id).join(", ")}`, { option: id, model: r.model.slug, allowed: d.options.map((o) => o.id) });
    options.push({ id, value });
  };
  pick("effort", opts.effort);
  pick("contextWindow", opts.contextWindow);
  if (opts.fast !== undefined) {
    if (!descriptors.some((x) => x.id === "fastMode")) throw new CliError("invalid_option", `model ${r.model.slug} has no fastMode option`, { option: "fastMode", model: r.model.slug });
    options.push({ id: "fastMode", value: opts.fast });
  }
  return { instanceId: r.instance.instanceId, model: r.model.slug, ...(options.length ? { options } : {}) };
}
