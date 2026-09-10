import type { Server } from "./discover.js";
import { RpcSocket } from "./ws.js";

export interface ModelOptionDescriptor { id: string; label: string; type: string; options?: Array<{ id: string; label: string; isDefault?: boolean }> }
export interface ProviderModel { slug: string; name: string; aliases?: string[]; isLegacy?: boolean; isCustom?: boolean; capabilities?: { optionDescriptors?: ModelOptionDescriptor[] } }
export interface ProviderInstance { instanceId: string; driver: string; displayName: string; enabled: boolean; installed?: boolean; status?: string; models: ProviderModel[]; [k: string]: unknown }

export interface ModelSelection { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> }

export async function fetchProviders(server: Server, token: string): Promise<ProviderInstance[]> {
  const sock = new RpcSocket(server, token);
  try {
    const cfg = await sock.request<{ providers: ProviderInstance[]; settings?: Record<string, unknown> }>("server.getConfig", {});
    return cfg.providers;
  } finally { sock.close(); }
}

export async function fetchServerSettings(server: Server, token: string): Promise<Record<string, unknown>> {
  const sock = new RpcSocket(server, token);
  try {
    const cfg = await sock.request<{ settings?: Record<string, unknown> }>("server.getConfig", {});
    return cfg.settings ?? {};
  } finally { sock.close(); }
}

export interface ResolvedModel { instance: ProviderInstance; model: ProviderModel }

/** Resolve "<model>" or "<instanceId>/<model>" by slug or alias across enabled providers. */
export function resolveModel(providers: ProviderInstance[], ref: string): ResolvedModel {
  const [instPart, modelPart] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
  const candidates = providers.filter((p) => p.enabled && (!instPart || p.instanceId === instPart));
  const want = modelPart.toLowerCase();
  for (const p of candidates) {
    const m = p.models.find((x) => x.slug.toLowerCase() === want || (x.aliases ?? []).some((a) => a.toLowerCase() === want));
    if (m) return { instance: p, model: m };
  }
  const all = candidates.flatMap((p) => p.models.map((m) => `${p.instanceId}/${m.slug}`));
  throw new Error(`unknown model "${ref}". Known: ${all.join(", ")}`);
}

/** Build a ModelSelection, validating option values (e.g. effort) against the model's descriptors. */
export function buildModelSelection(r: ResolvedModel, opts: { effort?: string; contextWindow?: string; fast?: boolean }): ModelSelection {
  const descriptors = r.model.capabilities?.optionDescriptors ?? [];
  const options: ModelSelection["options"] = [];
  const pick = (id: string, value: string | undefined) => {
    if (value === undefined) return;
    const d = descriptors.find((x) => x.id === id);
    if (!d) throw new Error(`model ${r.model.slug} has no option "${id}"`);
    if (d.options && !d.options.some((o) => o.id === value)) throw new Error(`invalid ${id} "${value}" for ${r.model.slug}. Allowed: ${d.options.map((o) => o.id).join(", ")}`);
    options.push({ id, value });
  };
  pick("effort", opts.effort);
  pick("contextWindow", opts.contextWindow);
  if (opts.fast !== undefined) {
    if (!descriptors.some((x) => x.id === "fastMode")) throw new Error(`model ${r.model.slug} has no fastMode option`);
    options.push({ id: "fastMode", value: opts.fast });
  }
  return { instanceId: r.instance.instanceId, model: r.model.slug, ...(options.length ? { options } : {}) };
}
