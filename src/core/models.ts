/**
 * Batch E3: the model table for the context-window rule (Kev 2026-10-18, n75 and n79).
 *
 * C_max is the window size the provider documents, with the source and the date it was read. A model that is not
 * in the table gets no fill and no zone ("the rule does not apply"): nothing is filled in from memory.
 * A_model is not a measurement but a setting (start value of rule version 1.0): the absolute upper limit for good
 * work, so a 1M window still turns red at 140,000 tokens (70 % of 200,000).
 *
 * Changing a value means a new table version; every derivation names the version it was computed with.
 * No imports: shared with the dashboard.
 */

export const MODEL_TABLE_VERSION = "models/1";

/** A_model of rule version 1.0 (Kev n79): 200,000 tokens. */
export const A_MODEL_DEFAULT = 200_000;

export interface ModelEntry {
  /** The model ids this row covers (exact, after normalising; a dated snapshot "-YYYYMMDD" / "-YYYY-MM-DD" counts too). */
  ids: string[];
  /** "person": a local model whose window size the person entered (E3b; Ollama and the like). */
  provider: "anthropic" | "openai" | "google" | "person";
  /** Window size the provider documents, in tokens. */
  cMax: number;
  source: string;
  /** When the source was read. */
  read: string;
}

export const MODEL_TABLE: ModelEntry[] = [
  {
    ids: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5"],
    provider: "anthropic",
    cMax: 1_000_000,
    source: "https://platform.claude.com/docs/de/models/sonnet-5/overview.md",
    read: "2026-10-18",
  },
  { ids: ["claude-opus-5"], provider: "anthropic", cMax: 1_000_000, source: "https://platform.claude.com/docs/zh-CN/models/opus-5/overview.md", read: "2026-10-18" },
  { ids: ["gpt-5"], provider: "openai", cMax: 400_000, source: "https://developers.openai.com/api/docs/models/gpt-5", read: "2026-10-18" },
  { ids: ["gemini-4-argon"], provider: "google", cMax: 1_000_000, source: "https://ai.google.dev/models", read: "2026-10-18" },
];

/** Lower case, without a provider prefix ("anthropic/", "models/") or a context-size tag ("[1m]"). */
export function normaliseModel(model: string): string {
  const m = String(model)
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:anthropic|openai|google|models)\//, "")
    // Amazon Bedrock ("us.anthropic.claude-sonnet-5-5-v1:0") and Google Vertex ("claude-sonnet-5-5@20261001") name the
    // same model with a region/vendor prefix and a version suffix (E5 review, M5).
    .replace(/^(?:(?:us|eu|apac|global|us-gov|jp|au)\.)?anthropic\./, "");
  // The version suffixes only on Claude names: "deepseek-v2" and "deepseek-v3" stay two models (E5 re-check N5).
  return m.startsWith("claude-") ? m.replace(/-v\d+(?::\d+)?$/, "").replace(/@[\w.-]+$/, "") : m;
}

/**
 * The row for a model: the documented table first, then the rows the person entered (`extra`, E3b) — a person's
 * entry never overrides a documented size. Person rows match their id exactly (after normalising).
 */
export function lookupModel(model: string | null | undefined, extra: ModelEntry[] = []): ModelEntry | null {
  if (!model) return null;
  const m = normaliseModel(model);
  const doc = lookupDocumented(m);
  if (doc) return doc;
  for (const row of extra) if (row.ids.some((id) => normaliseModel(id) === m)) return row;
  return null;
}

function lookupDocumented(m: string): ModelEntry | null {
  for (const row of MODEL_TABLE)
    for (const id of row.ids) if (m === id || new RegExp(`^${id.replace(/[.]/g, "\\.")}-(?:\\d{8}|\\d{4}-\\d{2}-\\d{2})$`).test(m)) return row;
  return null;
}
