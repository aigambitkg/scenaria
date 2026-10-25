/**
 * Batch E3b-1: the person's values for the context-window rule (Kev 2026-10-17, answer 2: start values v1.0 from the
 * concept, adjustable only by the person — a signed setting like the audit file's read setting, versioned, every
 * change logged; every number's derivation names the values in force).
 *
 * - What the person can set, per project: the zone lines (yellow, red, emergency), the P95 start value and the margin
 *   (in % of C_eff), A_model (the upper limit for good work, in tokens), and the window size of models the provider
 *   does not document for Scenaria's table (local models such as Ollama: the size depends on the machine). A
 *   documented size is never overridden by an entry.
 * - Only the person sets it: the caller makes sure a person acts (approval session in the dashboard, or an interactive
 *   terminal with a typed confirmation). Agents never change it; no tool takes these values.
 * - Kept OUTSIDE the project (~/.config/scenaria/context-settings.json), bound to the project's id AND its real folder,
 *   signed with the person's approver key; the highest revision this machine has seen is kept apart (an older signed
 *   setting put back does not count). Anything that does not verify falls back to the start values v1.0 and says so.
 * - The values in force become the rule string every derivation carries: `v1.0` for the start values, `v1.0-p<rev>`
 *   for the person's revision <rev>. A number computed under another revision can always be recomputed from its own
 *   derivation (the rule is one of its inputs).
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic, type Store } from "./store.js";
import { globalConfigPath } from "./global.js";
import { projectIdentity, publicKeyId, signRecord, verifyRecord } from "./canon.js";
import { CONTEXT_RULE, parseContextRule, parseWindowProgressRule, WINDOW_PROGRESS_RULE } from "./derivation.js";
import { A_MODEL_DEFAULT, lookupModel, MODEL_TABLE, normaliseModel, type ModelEntry } from "./models.js";

export interface ContextValues {
  yellow: number;
  red: number;
  emergency: number;
  p95start: number;
  margin: number;
  aModel: number;
}

/** The start values of rule version 1.0 (Kev n75–n79). */
export const CONTEXT_DEFAULTS: ContextValues = (() => {
  const r = parseContextRule(CONTEXT_RULE);
  return { yellow: r.yellow, red: r.red, emergency: r.emergency, p95start: r.p95start, margin: r.margin, aModel: A_MODEL_DEFAULT };
})();

/**
 * Batch E4: the person's values for progress per window and the handover check (Kev 2026-10-17, answer 2: at least
 * 10 points per window, 5 points tolerance). Stored in the same signed revision as the zone values (since E4 the
 * signed parts are "context-settings/v2"; a revision signed before E4 carries the start values for these two).
 */
export interface ProgressValues {
  /** At least this many points of progress per window (else the window had no progress). */
  minProgress: number;
  /** At most this many points lost at a handover (else the handover is improved). */
  tolerance: number;
}
export const PROGRESS_DEFAULTS: ProgressValues = (() => {
  const r = parseWindowProgressRule(WINDOW_PROGRESS_RULE);
  return { minProgress: r.min, tolerance: r.tolerance };
})();
export const PROGRESS_BOUNDS: Record<keyof ProgressValues, [number, number]> = { minProgress: [1, 50], tolerance: [0, 50] };
const PROGRESS_KEYS: (keyof ProgressValues)[] = ["minProgress", "tolerance"];

/** What a value may be (inclusive); plus yellow < red < emergency. */
export const CONTEXT_BOUNDS: Record<keyof ContextValues, [number, number]> = {
  yellow: [10, 90],
  red: [20, 95],
  emergency: [30, 99],
  p95start: [0, 30],
  margin: [0, 20],
  aModel: [8_000, 10_000_000],
};

export interface LocalModel {
  /** The model id as the provider reports it (e.g. "qwen3.5:9b"), normalised. */
  id: string;
  /** The window size the person entered, in tokens (e.g. Ollama's CONTEXT column of `ollama ps`). */
  cMax: number;
}

interface Entry extends ContextValues {
  /** Since E4 (signed as context-settings/v2); absent in a revision signed before: the start values. */
  minProgress?: number;
  tolerance?: number;
  models: LocalModel[];
  /** Set when this revision starts the history again after a setting that did not verify (signed with it). */
  restart?: { after: number; why: InvalidWhy } | null;
  rev: number;
  at: string;
  by: string;
  via: "dashboard" | "terminal";
  keyId?: string;
  pub?: string;
  sig?: string;
}

/** Why a stored setting does not count (the start values apply). */
export type InvalidWhy = "signature" | "history" | "older" | "values" | "missing" | "unreadable";

export interface ContextSettings {
  /** What applies now (the start values unless a verified setting of the person says otherwise). */
  values: ContextValues;
  /** Progress per window and the handover check (E4). */
  progress: ProgressValues;
  models: LocalModel[];
  /** The rule string every derivation carries ("v1.0 …" or "v1.0-p<rev> …"). */
  rule: string;
  /** The same for window-progress/1 and handover-loss/1 ("v1.0 min=10 tolerance=5 k=3" or "v1.0-p<rev> …"). */
  progressRule: string;
  /** "default": never set for this folder; "verified": the person's, every revision signed; "invalid": does not count. */
  trust: "default" | "verified" | "invalid";
  /** With "invalid": why. */
  why?: InvalidWhy;
  set: { rev: number; at: string; by: string; via: string; keyId?: string } | null;
  /** Every signed revision, oldest first (kept outside the project: which values were in force when, and who set them). */
  history: { rev: number; at: string; by: string; via: string; rule: string; progressRule: string; aModel: number; keyId?: string }[];
  /** The history started again at `from` because the earlier one did not verify (`why`); revisions before it cannot be vouched for (kept apart, unverified). */
  restarted: { from: number; after: number; why: InvalidWhy; earlier: number }[];
  /** Entered local models that the documented table now covers: the provider's size applies to them. */
  dropped: string[];
  /** Values looser than the start values (lines higher, A_model larger, no buffer): said plainly to people. */
  looser: (keyof ContextValues | keyof ProgressValues | "buffer")[];
  /** With "default": the same project has a setting in another folder (moved or copied); it is not carried over. */
  elsewhere?: string;
  /** Rows for lookupModel: the person's local models. */
  modelRows: ModelEntry[];
}

const cfg = () => dirname(globalConfigPath());
const settingsFile = () => join(cfg(), "context-settings.json");
const marksFile = () => join(cfg(), "context-settings.marks.json");

function folderOf(store: Store): string {
  try {
    return realpathSync(store.root);
  } catch {
    return store.root;
  }
}

function readJson(file: string, key: string): Record<string, any> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const v = raw?.[key];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function entryKey(store: Store, create: boolean): string {
  const pid = projectIdentity(store, create);
  return pid ? `${pid}:${folderOf(store)}` : "";
}

const VALUE_KEYS: (keyof ContextValues)[] = ["yellow", "red", "emergency", "p95start", "margin", "aModel"];
const parts = (folder: string, e: Omit<Entry, "keyId" | "pub" | "sig">) => [
  // A revision with the E4 values is signed with them (v2); one signed before E4 keeps its v1 parts.
  e.minProgress !== undefined || e.tolerance !== undefined ? "context-settings/v2" : "context-settings/v1",
  folder,
  ...VALUE_KEYS.map((k) => e[k]),
  ...(e.minProgress !== undefined || e.tolerance !== undefined ? [e.minProgress ?? null, e.tolerance ?? null] : []),
  e.models.map((m) => [m.id, m.cMax]),
  e.restart ? [e.restart.after, e.restart.why] : null,
  e.rev,
  e.at,
  e.by,
  e.via,
];

/** The rule string for a set of values (exactly CONTEXT_RULE for the start values without a revision). */
export function ruleOf(v: ContextValues, rev?: number): string {
  const base = parseContextRule(CONTEXT_RULE);
  const version = rev ? `${base.version}-p${rev}` : base.version;
  return `${version} yellow=${v.yellow} red=${v.red} emergency=${v.emergency} floor=${v.yellow} p95start=${v.p95start} margin=${v.margin} minSteps=${base.minSteps}`;
}

/** The rule string of progress per window for a set of values (exactly WINDOW_PROGRESS_RULE for the start values). */
export function progressRuleOf(p: ProgressValues, rev?: number): string {
  const base = parseWindowProgressRule(WINDOW_PROGRESS_RULE);
  return `${rev ? `${base.version}-p${rev}` : base.version} min=${p.minProgress} tolerance=${p.tolerance} k=${base.k}`;
}

/** Why the E4 values are refused (null: fine): whole points within the bounds. */
export function checkProgress(p: Partial<Record<keyof ProgressValues, unknown>>): { code: string; key?: string; message: string } | null {
  for (const k of PROGRESS_KEYS) {
    const x = p[k];
    if (typeof x !== "number" || !Number.isFinite(x)) return { code: "not_a_number", key: k, message: `${k} must be a number` };
    const [lo, hi] = PROGRESS_BOUNDS[k];
    if (x < lo || x > hi) return { code: "out_of_range", key: k, message: `${k} must be between ${lo} and ${hi}` };
    if (!Number.isInteger(x)) return { code: "precision", key: k, message: `${k} must be a whole number of points` };
  }
  return null;
}

/** Why a set of values is refused (null: fine). English, for the API; the dashboard translates the codes. */
export function checkValues(v: Partial<Record<keyof ContextValues, unknown>>): { code: string; key?: string; message: string } | null {
  for (const k of VALUE_KEYS) {
    const x = v[k];
    if (typeof x !== "number" || !Number.isFinite(x)) return { code: "not_a_number", key: k, message: `${k} must be a number` };
    const [lo, hi] = CONTEXT_BOUNDS[k];
    if (x < lo || x > hi) return { code: "out_of_range", key: k, message: `${k} must be between ${lo} and ${hi}` };
    if (k === "aModel" ? !Number.isInteger(x) : Math.round(x * 10) !== x * 10) return { code: "precision", key: k, message: k === "aModel" ? "aModel must be a whole number of tokens" : `${k} has at most one decimal` };
  }
  if (!((v.yellow as number) < (v.red as number) && (v.red as number) < (v.emergency as number))) return { code: "order", message: "the lines must rise: yellow < red < emergency" };
  return null;
}

/** Model ids compared without dots or separators ("claude-opus-5.5" = "claude-opus-5-5"). */
const canon = (x: string) => normaliseModel(x).replace(/[._]/g, "-");

/**
 * A documented model, also under another name built on its id ("us.anthropic.claude-opus-5-5-v1:0", "azure/gpt-5",
 * "claude-opus-5.5", "gpt-5-mini"). Strict on purpose: hand entries are for local models; a provider's model gets its
 * size from the documented table.
 */
export function documentedModel(id: string): boolean {
  if (lookupModel(normaliseModel(id))) return true;
  const m = canon(id);
  return MODEL_TABLE.some((row) => row.ids.some((x) => new RegExp(`(?:^|[^a-z0-9])${canon(x)}(?:$|[^a-z0-9])`).test(m)));
}

export function checkModels(models: unknown): { code: string; message: string } | null {
  if (!Array.isArray(models)) return { code: "models", message: "models must be a list" };
  if (models.length > 50) return { code: "models", message: "at most 50 local models" };
  const seen = new Set<string>();
  for (const m of models as any[]) {
    const id = typeof m?.id === "string" ? normaliseModel(m.id) : "";
    if (!id || id.length > 80 || /[\u0000-\u001f\u007f]/.test(id)) return { code: "model_id", message: "each model needs an id (at most 80 characters)" };
    if (seen.has(id)) return { code: "model_twice", message: `${id} is listed twice` };
    seen.add(id);
    if (documentedModel(id)) return { code: "model_documented", message: `${id} is (or names) a model of the documented table; its size is not entered by hand` };
    if (!Number.isInteger(m.cMax) || m.cMax < 1000 || m.cMax > 10_000_000) return { code: "model_size", message: `the window size of ${id} must be a whole number of tokens between 1,000 and 10,000,000` };
  }
  return null;
}

const asRows = (models: LocalModel[], at: string, rule: string): ModelEntry[] =>
  models.map((m) => ({ ids: [m.id], provider: "person" as const, cMax: m.cMax, source: `entered by the person (${rule.split(" ")[0]})`, read: at.slice(0, 10) }));

/** Which values are looser than the start values: the person sees them named (an AI manager, an auditor). */
function looserOf(v: ContextValues, p: ProgressValues = PROGRESS_DEFAULTS): ContextSettings["looser"] {
  const d = CONTEXT_DEFAULTS;
  const out: ContextSettings["looser"] = [];
  for (const k of ["yellow", "red", "emergency", "aModel"] as const) if (v[k] > d[k]) out.push(k);
  if (v.p95start === 0 && v.margin === 0) out.push("buffer");
  // Fewer points per window, or more loss at a handover, lets more through (E4).
  if (p.minProgress < PROGRESS_DEFAULTS.minProgress) out.push("minProgress");
  if (p.tolerance > PROGRESS_DEFAULTS.tolerance) out.push("tolerance");
  return out;
}

function fallback(trust: ContextSettings["trust"], extra: Partial<ContextSettings> = {}): ContextSettings {
  return { values: { ...CONTEXT_DEFAULTS }, progress: { ...PROGRESS_DEFAULTS }, models: [], rule: CONTEXT_RULE, progressRule: WINDOW_PROGRESS_RULE, trust, set: null, history: [], restarted: [], dropped: [], looser: [], modelRows: [], ...extra };
}

const shapeOk = (e: any): e is Entry =>
  e &&
  typeof e === "object" &&
  VALUE_KEYS.every((k) => typeof e[k] === "number" && Number.isFinite(e[k])) &&
  Array.isArray(e.models) &&
  e.models.every((m: any) => m && typeof m.id === "string" && Number.isInteger(m.cMax)) &&
  PROGRESS_KEYS.every((k) => e[k] === undefined || (typeof e[k] === "number" && Number.isFinite(e[k]))) &&
  (e.restart === undefined || e.restart === null || (Number.isInteger(e.restart.after) && typeof e.restart.why === "string")) &&
  Number.isInteger(e.rev) &&
  typeof e.at === "string" &&
  typeof e.by === "string" &&
  (e.via === "dashboard" || e.via === "terminal");

/** The values in force for this project, as this machine can vouch for them. Never throws. */
export function readContextSettings(store: Store): ContextSettings {
  try {
    const pid = projectIdentity(store, false);
    const key = pid ? `${pid}:${folderOf(store)}` : "";
    const all = readJson(settingsFile(), "projects");
    const rec = key ? all[key] : undefined;
    const m = key ? markOf(readJson(marksFile(), "marks")[key]) : { rev: 0, first: 1 };
    const mark = m.rev;
    if (!rec) {
      if (mark > 0) return fallback("invalid", { why: "missing" });
      const other = pid ? Object.keys(all).find((k) => k.startsWith(`${pid}:`)) : undefined;
      return fallback("default", other ? { elsewhere: other.slice(pid!.length + 1) } : {});
    }
    const revs: unknown = rec.revisions;
    if (!Array.isArray(revs) || !revs.length || !revs.every(shapeOk)) return fallback("invalid", { why: "unreadable" });
    const list = revs as Entry[];
    // Every revision from the history's first one on (1, or where the person started again after an invalid setting),
    // in order, each signed: removing or rewriting one shows (the history is the evidence).
    const folder = folderOf(store);
    if (!list.every((e) => verifyRecord(store, parts(folder, e), e.pub, e.sig))) return fallback("invalid", { why: "signature" });
    if (!list.every((e, i) => e.rev === m.first + i)) return fallback("invalid", { why: "history" });
    const e = list[list.length - 1];
    if (e.rev < mark) return fallback("invalid", { why: "older" });
    // Bounds of this version for the values in force (a later, tighter version would say so, not crash).
    if (checkValues(e) !== null) return fallback("invalid", { why: "values" });
    const progress = progressOf(e);
    if (checkProgress(progress) !== null) return fallback("invalid", { why: "values" });
    const values = Object.fromEntries(VALUE_KEYS.map((k) => [k, e[k]])) as unknown as ContextValues;
    const entered = e.models.map((m) => ({ id: normaliseModel(m.id), cMax: m.cMax }));
    // A model the documented table covers now: the provider's size applies; the person's other values stay.
    const models = entered.filter((m) => !documentedModel(m.id));
    const rule = ruleOf(values, e.rev);
    return {
      values,
      progress,
      models,
      rule,
      progressRule: progressRuleOf(progress, e.rev),
      trust: "verified",
      set: { rev: e.rev, at: e.at, by: e.by, via: e.via, keyId: e.pub ? publicKeyId(e.pub) : undefined },
      restarted: list
        .filter((x) => x.restart)
        .map((x) => ({ from: x.rev, after: x.restart!.after, why: x.restart!.why, earlier: Array.isArray(rec.earlier) ? rec.earlier.reduce((n: number, g: any) => n + (Array.isArray(g?.revisions) ? g.revisions.length : 0), 0) : 0 })),
      history: list.map((x) => ({
        rev: x.rev,
        at: x.at,
        by: x.by,
        via: x.via,
        ...(x.pub ? { keyId: publicKeyId(x.pub) } : {}),
        rule: ruleOf(Object.fromEntries(VALUE_KEYS.map((k) => [k, x[k]])) as unknown as ContextValues, x.rev),
        // E4: which values were in force when (a window is judged by the values in force when it ended — review M7).
        progressRule: progressRuleOf(progressOf(x), x.rev),
        aModel: x.aModel,
      })),
      dropped: entered.filter((m) => documentedModel(m.id)).map((m) => m.id),
      looser: looserOf(values, progress),
      modelRows: asRows(models, e.at, rule),
    };
  } catch {
    return fallback("invalid", { why: "unreadable" });
  }
}

/** The E4 values of a revision (one signed before E4: the start values). */
const progressOf = (e: Partial<ProgressValues>): ProgressValues => ({ minProgress: e.minProgress ?? PROGRESS_DEFAULTS.minProgress, tolerance: e.tolerance ?? PROGRESS_DEFAULTS.tolerance });

/** The revision mark of a project: the highest revision seen here and where its history starts. */
function markOf(x: unknown): { rev: number; first: number } {
  if (typeof x === "number") return { rev: Number.isInteger(x) && x > 0 ? x : 0, first: 1 };
  const o = x as any;
  const rev = Number.isInteger(o?.rev) && o.rev > 0 ? o.rev : 0;
  const first = Number.isInteger(o?.first) && o.first > 0 && o.first <= Math.max(rev, 1) ? o.first : 1;
  return { rev, first };
}

/** The values a request names, and only those (anything else is never stored). */
function pickValues(v: unknown): Partial<ContextValues> {
  const out: Partial<ContextValues> = {};
  if (v && typeof v === "object") for (const k of VALUE_KEYS) if (k in (v as any)) (out as any)[k] = (v as any)[k];
  return out;
}
function pickProgress(v: unknown): Partial<ProgressValues> {
  const out: Partial<ProgressValues> = {};
  if (v && typeof v === "object") for (const k of PROGRESS_KEYS) if (k in (v as any)) (out as any)[k] = (v as any)[k];
  return out;
}

/**
 * The PERSON sets the values (all of them, as shown) and the local models. Callers make sure a person acts. `reset`
 * returns to the start values v1.0, as a new signed revision. Every revision is kept, signed, outside the project.
 * A request that changes nothing is refused (no empty revisions).
 */
export function setContextSettings(
  store: Store,
  input: { values?: Partial<ContextValues>; progress?: Partial<ProgressValues>; models?: LocalModel[]; reset?: boolean },
  who: { by: string; via: "dashboard" | "terminal" },
): ContextSettings {
  const cur = readContextSettings(store);
  const values = input.reset ? { ...CONTEXT_DEFAULTS } : { ...cur.values, ...pickValues(input.values) };
  const progress = input.reset ? { ...PROGRESS_DEFAULTS } : { ...cur.progress, ...pickProgress(input.progress) };
  // Sorted by id: the same models in another order are no change (review 2, N4).
  const models = (input.reset ? [] : (input.models ?? cur.models))
    .map((m) => ({ id: typeof m?.id === "string" ? normaliseModel(m.id) : "", cMax: m?.cMax as number }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const bad = checkValues(values) ?? checkProgress(progress) ?? checkModels(models);
  if (bad) throw Object.assign(new Error(bad.message), { code: bad.code, key: (bad as { key?: string }).key });
  const same = cur.trust !== "invalid" && VALUE_KEYS.every((k) => values[k] === cur.values[k]) && PROGRESS_KEYS.every((k) => progress[k] === cur.progress[k]) && JSON.stringify(models) === JSON.stringify([...cur.models].sort((a, b) => a.id.localeCompare(b.id)));
  if (same) throw Object.assign(new Error("nothing changes: these values are already in force"), { code: "unchanged" });
  const by = String(who.by ?? "person").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "person";
  const key = entryKey(store, true);
  const all = readJson(settingsFile(), "projects");
  const marks = readJson(marksFile(), "marks");
  const m = markOf(marks[key]);
  const rec = all[key] && typeof all[key] === "object" ? all[key] : {};
  const stored0: any[] = Array.isArray(rec.revisions) ? rec.revisions : [];
  const earlier: any[] = Array.isArray(rec.earlier) ? rec.earlier : [];
  // The revision number never goes back and is never used twice: above the mark AND above every number in the file,
  // verified or not (review 2, N2) — a rule name like "v1.0-p3" always means one set of values.
  const seen = [m.rev, ...stored0.map((e) => (Number.isInteger(e?.rev) ? e.rev : 0)), ...earlier.flatMap((g) => (Array.isArray(g?.revisions) ? g.revisions.map((e: any) => (Number.isInteger(e?.rev) ? e.rev : 0)) : []))];
  const rev = Math.max(0, ...seen) + 1;
  // A history that does not verify is not continued — and not thrown away either: it is kept apart, unverified, and the
  // new revision says (signed) that the history starts again after it, and why (review 2, N1).
  const restart = cur.trust === "invalid";
  const prev: Entry[] = restart ? [] : stored0;
  const nextEarlier = restart && (stored0.length || cur.why) ? [...earlier, { why: cur.why ?? "unreadable", at: new Date().toISOString(), revisions: stored0 }].slice(-20) : earlier;
  const entry: Omit<Entry, "keyId" | "pub" | "sig"> = {
    ...(values as ContextValues),
    minProgress: progress.minProgress,
    tolerance: progress.tolerance,
    models,
    ...(restart ? { restart: { after: rev - 1, why: cur.why ?? "unreadable" } } : {}),
    rev,
    at: new Date().toISOString(),
    by,
    via: who.via,
  };
  const signed = signRecord(store, parts(folderOf(store), entry));
  const stored = { ...entry, keyId: publicKeyId(signed.pub), pub: signed.pub, sig: signed.sig };
  const revisions = [...prev, stored];
  all[key] = { revisions, ...(nextEarlier.length ? { earlier: nextEarlier } : {}) };
  writeJsonAtomic(settingsFile(), { version: 2, projects: all });
  writeJsonAtomic(marksFile(), { version: 2, marks: { ...marks, [key]: { rev, first: revisions[0].rev } } });
  const rule = ruleOf(values as ContextValues, stored.rev);
  const pRule = progressRuleOf(progress, stored.rev);
  store.appendEvent({
    type: "update",
    data: {
      message: `context-window rule set to ${rule.split(" ")[0]} (min=${progress.minProgress} tolerance=${progress.tolerance}) by ${by} via ${who.via}${input.reset ? " (back to the start values)" : ""}${restart ? ` (the earlier stored setting did not verify: ${cur.why}; the history starts again at p${rev}, the earlier revisions are kept apart, unverified)` : ""}`,
      contextSettings: { rev: stored.rev, rule, progressRule: pRule, models: models.map((m) => `${m.id}=${m.cMax}`), by, via: who.via, ...(restart ? { restart: cur.why } : {}) },
    },
  });
  return readContextSettings(store);
}

const WHY_TEXT: Record<InvalidWhy, { de: string; en: string }> = {
  signature: { de: "eine Signatur passt nicht – die Datei wurde außerhalb von Scenaria geändert oder stammt von einem anderen Schlüssel", en: "a signature does not match – the file was changed outside Scenaria or comes from another key" },
  history: { de: "im Verlauf fehlt eine Änderung oder sie wurde umgestellt", en: "a change is missing from the history or was reordered" },
  older: { de: "ein älterer Stand wurde zurückgespielt (dieser Rechner kennt einen neueren)", en: "an older state was put back (this machine has seen a newer one)" },
  values: { de: "die gespeicherten Werte liegen außerhalb der erlaubten Grenzen", en: "the stored values are outside the allowed bounds" },
  missing: { de: "die gespeicherte Einstellung fehlt, obwohl dieser Rechner eine kennt", en: "the stored setting is missing although this machine has seen one" },
  unreadable: { de: "die gespeicherte Einstellung ist nicht lesbar", en: "the stored setting cannot be read" },
};

const NAME: Record<keyof ContextValues | keyof ProgressValues | "buffer", { de: string; en: string }> = {
  minProgress: { de: "Mindestfortschritt je Fenster", en: "minimum progress per window" },
  tolerance: { de: "Toleranz bei der Übergabe", en: "handover tolerance" },
  yellow: { de: "Gelb ab", en: "yellow from" },
  red: { de: "Rot ab", en: "red from" },
  emergency: { de: "Notsicherung ab", en: "emergency from" },
  p95start: { de: "P95-Startwert", en: "P95 start value" },
  margin: { de: "Marge", en: "margin" },
  aModel: { de: "A_modell", en: "A_model" },
  buffer: { de: "kein Puffer (P95-Startwert und Marge 0)", en: "no buffer (P95 start value and margin 0)" },
};

/** What applies and what changes compared with the start values, for people (both languages). */
export function describeSettings(cs: ContextSettings): { de: string; en: string } {
  type K = keyof ContextValues | keyof ProgressValues;
  const isP = (k: K): k is keyof ProgressValues => (PROGRESS_KEYS as string[]).includes(k);
  const cur = (k: K) => (isP(k) ? cs.progress[k] : cs.values[k]);
  const def = (k: K) => (isP(k) ? PROGRESS_DEFAULTS[k] : CONTEXT_DEFAULTS[k]);
  const val = (k: K, x: number, lang: "de" | "en") => {
    if (isP(k)) return `${x} ${lang === "de" ? (x === 1 ? "Punkt" : "Punkte") : x === 1 ? "point" : "points"}`;
    if (k === "aModel") return `${String(x).replace(/\B(?=(\d{3})+(?!\d))/g, lang === "de" ? "." : ",")} ${lang === "de" ? "Tokens" : "tokens"}`;
    return `${lang === "de" ? String(x).replace(".", ",") : x} %`;
  };
  const ver = cs.rule.split(" ")[0];
  if (cs.trust === "invalid") {
    const w = WHY_TEXT[cs.why ?? "unreadable"];
    return { de: `Die Einstellung der Person zählt nicht: ${w.de}. Es gelten die Startwerte v1.0.`, en: `The person's setting does not count: ${w.en}. The start values v1.0 apply.` };
  }
  if (cs.trust === "default")
    return cs.elsewhere
      ? {
          de: `Für dieses Projekt gibt es eine Einstellung in einem anderen Ordner (${cs.elsewhere}); sie wird hier nicht übernommen. Es gelten die Startwerte (Regel ${ver}).`,
          en: `This project has a setting in another folder (${cs.elsewhere}); it is not carried over here. The start values apply (rule ${ver}).`,
        }
      : { de: `Startwerte (Regel ${ver}).`, en: `Start values (rule ${ver}).` };
  const diff = ([...VALUE_KEYS, ...PROGRESS_KEYS] as K[]).filter((k) => cur(k) !== def(k));
  const list = (lang: "de" | "en") => (diff.length ? `: ${diff.map((k) => `${NAME[k][lang]} ${val(k, cur(k), lang)}`).join(", ")}` : "");
  const models = (lang: "de" | "en") => (cs.models.length ? `; ${lang === "de" ? "lokale Modelle" : "local models"}: ${cs.models.map((m) => m.id).join(", ")}` : "");
  const dropped = (lang: "de" | "en") =>
    cs.dropped.length ? (lang === "de" ? ` Jetzt in der Modelltabelle belegt (es gilt die Größe des Anbieters): ${cs.dropped.join(", ")}.` : ` Now documented in the model table (the provider's size applies): ${cs.dropped.join(", ")}.`) : "";
  const looser = (lang: "de" | "en") =>
    cs.looser.length
      ? lang === "de"
        ? ` Lockerer als die Startwerte: ${cs.looser.map((k) => (k === "buffer" ? NAME.buffer.de : `${NAME[k].de} ${val(k, cur(k), "de")} (Start ${val(k, def(k), "de")})`)).join(", ")}.`
        : ` Looser than the start values: ${cs.looser.map((k) => (k === "buffer" ? NAME.buffer.en : `${NAME[k].en} ${val(k, cur(k), "en")} (start ${val(k, def(k), "en")})`)).join(", ")}.`
      : "";
  const r = cs.restarted[cs.restarted.length - 1];
  const restarted = (lang: "de" | "en") =>
    r
      ? lang === "de"
        ? ` Verlauf neu begonnen bei p${r.from}, weil der frühere nicht prüfbar war (${WHY_TEXT[r.why]?.de ?? r.why}); p1–p${r.after} sind nicht belegt.`
        : ` History started again at p${r.from} because the earlier one could not be verified (${WHY_TEXT[r.why]?.en ?? r.why}); p1–p${r.after} cannot be vouched for.`
      : "";
  return {
    de: `Regel ${ver}, von ${cs.set?.by} gesetzt${list("de")}${models("de")}.${looser("de")}${dropped("de")}${restarted("de")}`,
    en: `Rule ${ver}, set by ${cs.set?.by}${list("en")}${models("en")}.${looser("en")}${dropped("en")}${restarted("en")}`,
  };
}
