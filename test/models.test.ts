import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModelSelection, normalizeModelRef, resolveModel, type ProviderInstance } from "../src/models.js";

const providers = JSON.parse(readFileSync(new URL("./fixtures/providers.json", import.meta.url), "utf8")) as ProviderInstance[];
const claude = providers.find((p) => p.instanceId === "claudeAgent")!;
const slugs = claude.models.map((m) => m.slug);

test("fixture sanity", () => {
  assert.ok(claude.enabled);
  assert.ok(slugs.includes("claude-opus-4-8"), `fixture lacks claude-opus-4-8: ${slugs.join(", ")}`);
});

test("normalizeModelRef", () => {
  assert.equal(normalizeModelRef("Fable 5.0"), "fable-5-0");
  assert.equal(normalizeModelRef("claude-opus-4.8"), "claude-opus-4-8");
  assert.equal(normalizeModelRef("  opus__4 8 "), "opus-4-8");
});

test("builtin aliases pin the previous generation", () => {
  assert.equal(resolveModel(providers, "opus").model.slug, "claude-opus-4-8");
  assert.equal(resolveModel(providers, "sonnet").model.slug, "claude-sonnet-4-6");
  assert.equal(resolveModel(providers, "fable").model.slug, "claude-fable-5-1");
});

test("exact slug, fuzzy version forms, instance pin", () => {
  assert.equal(resolveModel(providers, "claude-opus-4-8").model.slug, "claude-opus-4-8");
  assert.equal(resolveModel(providers, "Opus 4.8").model.slug, "claude-opus-4-8");
  assert.equal(resolveModel(providers, "claudeAgent/opus").instance.instanceId, "claudeAgent");
  assert.throws(() => resolveModel(providers, "codex/opus"), /unknown model/);   // disabled instance
  assert.throws(() => resolveModel(providers, "gpt-9"), /unknown model/);
});

test("buildModelSelection validates option values against descriptors", () => {
  const r = resolveModel(providers, "sonnet");
  const ok = buildModelSelection(r, { effort: "low" });
  assert.deepEqual(ok, { instanceId: "claudeAgent", model: "claude-sonnet-4-6", options: [{ id: "effort", value: "low" }] });
  assert.throws(() => buildModelSelection(r, { effort: "ludicrous" }), /invalid effort/);
  assert.deepEqual(buildModelSelection(r, {}), { instanceId: "claudeAgent", model: "claude-sonnet-4-6" });
});
