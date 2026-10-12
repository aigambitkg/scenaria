/**
 * The traceable oracle (multiverse v2): three model roles with separate context — archivist (PAST),
 * craftsman (PRESENT), oracle (FUTURE) — that may only CORRECT the deterministic core (core/predict.ts),
 * never replace it with a free number:
 *
 *   own' = own + γ·c·Δown      ctx' = ctx + γ·c·Δctx      (Δ ∈ [−20, +20], c = the oracle's confidence)
 *   P    = L + α·(own' − L) + β·(ctx' − L) − risk          (the same formula as the core)
 *   cap  : a hard fixed point the oracle shows at risk (with evidence) caps P at 40
 *
 * Every correction needs a reason AND evidence ids that exist in the material it was given (nodes,
 * fixed points); a correction without them counts 0 and is shown as "unbacked". γ — how much the
 * oracle's corrections are trusted — is learned from how corrected forecasts really went (shrunk
 * towards 1 with the weight of 5 cases); if the oracle makes forecasts worse, γ goes towards 0.
 *
 * The context the roles see is built from a View (core/predict.ts) — for a backtest the view of the
 * decision's own time — so the oracle can be backtested without knowledge of the future.
 */
import type { Scenaria } from "./engine.js";
import type { ScenariaNode } from "./types.js";
import { callLlm, type LlmRequest } from "./analysis.js";
import { effectiveLlm, upstreams, type LlmRole } from "./settings.js";
import { nearestGoal } from "./context.js";
import { overlap, stems } from "./fidelity.js";
import { predictLinear, type Explain, type View } from "./predict.js";

export const MAX_DELTA = 20;
export const DEFAULT_GAMMA = 1;
const GAMMA_SHRINK = 5;
export const CANON_CAP = 40;
type Lang = "de" | "en";

const one = (x: unknown, max = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const strs = (x: unknown, max = 8, len = 240) => (Array.isArray(x) ? x.map((v) => one(v, len)).filter(Boolean).slice(0, max) : []);
const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export interface OracleAdjust {
  /** What the oracle proposed (−20..+20 points on the part). */
  proposed: number;
  /** What counts: proposed × confidence × γ, 0 without reason or valid evidence. */
  applied: number;
  why: string;
  refs: string[];
  /** Reason and at least one existing evidence id given. */
  backed: boolean;
  /** Evidence ids the oracle gave that do not exist in its material (dropped). */
  dropped: string[];
  /** Existing but too general ids (the project root, the task, the decision itself): not evidence. */
  ignored?: string[];
}

export interface OracleOption {
  key: string;
  past: string;
  pastRefs: string[];
  present: string;
  trajectory: string[];
  keeps: string[];
  loses: string[];
  outcome: string;
  risks: { text: string; refs: string[] }[];
  canonRisks: string[];
  confidence: number;
  own: OracleAdjust;
  ctx: OracleAdjust;
  /** The derivation after the corrections. */
  ownAfter: number;
  ctxAfter: number;
  /** P before (core) and after the oracle; capped by a hard fixed point at risk. */
  core: number;
  predicted: number;
  capped: boolean;
  gamma: number;
  /** The core flagged the option's own words; the oracle raised them with evidence → resolved. */
  flagResolved: boolean;
}

export interface MultiverseResult {
  options: OracleOption[];
  /** The text behind every cited id AS THE ROLES SAW IT — kept with the forecast (signed), so the
   * auditor later checks against what was cited, not against a text edited afterwards. */
  evidence: Record<string, string>;
  recommended?: { key: string; why: string };
  models: Partial<Record<LlmRole, string>>;
  warnings: string[];
}

// ------------------------------------------------------------------ the material, from a view

function pathOf(v: View, id: string): ScenariaNode[] {
  const out: ScenariaNode[] = [];
  const seen = new Set<string>();
  let cur = v.nodes.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? v.nodes.get(cur.parentId) : undefined;
  }
  return out;
}

function stepLine(n: ScenariaNode): string {
  if (n.type === "decision") {
    const opt = (n.options ?? []).find((o) => o.id === n.chosen);
    return `- ${n.id} [decision] ${one(n.question ?? n.title, 200)}${opt ? ` → ${one(opt.label, 120)}` : " (open)"}${n.rationale ? ` — because: ${one(n.rationale, 200)}` : ""}`;
  }
  return `- ${n.id} [${n.type}] ${one(n.title, 160)}${n.summary ? ` — ${one(n.summary, 200)}` : ""}${n.goal && n.type === "goal" ? ` (goal: ${one(n.goal, 160)})` : ""}`;
}

export interface Material {
  goal: string;
  task: string;
  past: string;
  present: string;
  future: string;
  hardPast: string;
  /** Every id the roles may cite. */
  ids: Set<string>;
  /** Text behind each id (for the auditor and the relevance check). */
  texts: Map<string, string>;
  /** Ids that exist but say nothing specific (root, task, the decision itself): never evidence alone. */
  generic: Set<string>;
}

/** What the three roles may see — from a view, so a backtest sees only its own time. */
export function material(v: View, at: string | null, opts: { excludeDecisionOptions?: string } = {}): Material {
  const path = at ? pathOf(v, at).map((n) => (n.id === opts.excludeDecisionOptions ? { ...n, chosen: undefined, rationale: undefined } : n)) : [];
  const task = nearestGoal(path);
  const generic = new Set<string>([...path.filter((n) => !n.parentId || n.type === "mission" || n.type === "goal").map((n) => n.id), ...(opts.excludeDecisionOptions ? [opts.excludeDecisionOptions] : [])]);
  const onPath = new Set(path.map((n) => n.id));
  const earlierDecisions = [...v.nodes.values()]
    .filter((n) => n.type === "decision" && n.chosen && !onPath.has(n.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-12);
  const ids = new Set<string>();
  const texts = new Map<string, string>();
  const note = (n: ScenariaNode) => {
    ids.add(n.id);
    texts.set(n.id, stepLine(n).replace(/^- /, ""));
  };
  path.slice(-10).forEach(note);
  earlierDecisions.forEach(note);
  const lessons = v.lessons.slice(-12);
  for (const l of lessons) {
    ids.add(l.node);
    texts.set(l.node, `${texts.get(l.node) ?? ""} · lesson: ${l.text}`.replace(/^ · /, ""));
  }
  for (const e of v.canon) {
    ids.add(e.id);
    texts.set(e.id, `${e.kind}${e.hard ? ", hard" : ", soft"}${e.due ? `, by ${e.due}` : ""}: ${e.text}`);
  }
  const canonOf = (kind: "past" | "future") => v.canon.filter((e) => e.kind === kind).map((e) => `- ${e.id} (${e.hard ? "hard" : "soft"}${e.due ? `, by ${e.due}` : ""}): ${one(e.text, 200)}`).join("\n") || "(none)";
  return {
    goal: v.mainGoal || "(not set)",
    task: task ? `${task.title}${task.goal ? ` — ${task.goal}` : ""}` : "(none)",
    past: [
      `EARLIER DECISIONS:\n${earlierDecisions.map(stepLine).join("\n") || "(none)"}`,
      `LESSONS (rewinds, failed checks):\n${lessons.map((l) => `- ${l.node}: ${one(l.text, 200)}`).join("\n") || "(none)"}`,
      `PAST FIXED POINTS:\n${canonOf("past")}`,
    ].join("\n\n"),
    present: path.slice(-10).map(stepLine).join("\n") || "(no history yet)",
    future: canonOf("future"),
    hardPast: v.canon.filter((e) => e.kind === "past" && e.hard).map((e) => `- ${e.id}: ${one(e.text, 200)}`).join("\n") || "(none)",
    ids,
    texts,
    generic,
  };
}

// ------------------------------------------------------------------ the three roles

const langLine = (lang: Lang) => `Write all text values in ${lang === "de" ? "German" : "English"}.`;
export const ROLE_PROMPTS = {
  archivist: (lang: Lang) => `You are the ARCHIVIST of a multiverse forecast. You only know the PAST of the project (earlier decisions, lessons, past fixed points). For EACH option, say briefly what the history implies for it: which earlier decisions, constraints or lessons it continues or contradicts. Cite ids (n12, k3) from the material only. No predictions.
Answer ONLY with JSON: {"options": [{"key": "<key>", "past": "…", "refs": ["n7"]}]}
${langLine(lang)}`,
  craftsman: (lang: Lang) => `You are the CRAFTSMAN of a multiverse forecast. You work in the PRESENT: the current line of work, the task and the main goal. For EACH option, predict the concrete next 3 steps an agent would take, which context it would carry along (keeps) and which it would likely DROP (forget, ignore, overwrite). Cite ids from the material.
Answer ONLY with JSON: {"options": [{"key": "<key>", "present": "…", "trajectory": ["step 1", "step 2", "step 3"], "keeps": ["…"], "loses": ["…"], "refs": ["n12"]}]}
${langLine(lang)}`,
  oracle: (lang: Lang) => `You are the ORACLE of a multiverse forecast. You look at the FUTURE: the main goal, the future fixed points and what the archivist and the craftsman found.
A deterministic CORE has already computed, per option, two word-based parts (0-100): OWN = how the option's own words connect to the goal and the line; CONTEXT = the full next step in context. The core cannot see meaning: synonyms, another language, new technical terms that clearly serve the goal, or an option that keeps the words but would drop the substance.
Your job: correct the core ONLY where its word-based view is wrong, by at most ±${MAX_DELTA} points per part, each correction with a short reason and at least one evidence id from the material (n12, k3). If unsure, 0. Also give the outcome, risks (with ids), hard fixed points at risk (ids), and your confidence (0-1). Then recommend one option.
Answer ONLY with JSON: {"options": [{"key": "<key>", "outcome": "…", "ownAdjust": {"delta": 0, "why": "…", "refs": ["n3"]}, "ctxAdjust": {"delta": 0, "why": "…", "refs": []}, "risks": [{"text": "…", "refs": ["n5"]}], "canonRisks": ["k2"], "confidence": 0.0}], "recommendation": {"key": "<key>", "why": "…"}}
${langLine(lang)}`,
};

const normKey = (x: unknown) => one(x, 200).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Which answer entry belongs to which option — each entry to at most one option, each option at most one
 * entry: exact key, then key ignoring case/punctuation, then the full label, then a shortened label that
 * fits exactly one option ("Passkey" ~ "Passkeys"). The order is used only if NO entry names anything.
 */
export function assignEntries(list: any[], options: { key: string; label: string }[]): Map<string, any> {
  const out = new Map<string, any>();
  const used = new Set<number>();
  const name = (x: any) => x?.key ?? x?.label ?? x?.option ?? x?.name;
  const pass = (match: (x: any, o: { key: string; label: string }) => boolean) => {
    for (const opt of options) {
      if (out.has(opt.key)) continue;
      const hits = list.map((x, i) => ({ x, i })).filter(({ x, i }) => !used.has(i) && match(x, opt));
      if (hits.length !== 1) continue;
      // The entry must not fit another unassigned option just as well.
      const rivals = options.filter((o2) => o2 !== opt && !out.has(o2.key) && match(hits[0].x, o2));
      if (rivals.length) continue;
      out.set(opt.key, hits[0].x);
      used.add(hits[0].i);
    }
  };
  pass((x, o) => one(x?.key, 40) === o.key);
  pass((x, o) => normKey(x?.key) !== "" && normKey(x?.key) === normKey(o.key));
  // Numbered answers ("1", "2", …) when EVERY entry is numbered exactly 1…n.
  const numbered = list.length === options.length && list.every((x, i) => String(x?.key ?? "").trim() === String(i + 1));
  if (numbered) pass((x, o) => String(x?.key ?? "").trim() === String(options.indexOf(o) + 1));
  pass((x, o) => normKey(name(x)) !== "" && normKey(name(x)) === normKey(o.label));
  pass((x, o) => {
    const n = normKey(name(x));
    const l = normKey(o.label);
    return n.length >= 4 && l.length >= 4 && (l.startsWith(n) || n.startsWith(l));
  });
  if (!out.size && list.length === options.length && list.every((x) => !normKey(name(x)))) options.forEach((o, i) => out.set(o.key, list[i]));
  return out;
}

/** The per-option list of a role's answer: "options", another array field, or the array itself. */
export function listOf(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== "object") return [];
  if (Array.isArray(x.options)) return x.options;
  return (Object.values(x).find((v) => Array.isArray(v) && v.some((e) => e && typeof e === "object")) as any[]) ?? [];
}

export type MultiverseStep = "archivist" | "craftsman" | "oracle" | "done";
const ROLE_NAME = {
  de: { archivist: "Archivar", craftsman: "Handwerker", oracle: "Orakel" },
  en: { archivist: "Archivist", craftsman: "Craftsman", oracle: "Oracle" },
};

export function parseJson(text: string): any {
  const cands = [text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of cands) {
    if (!c?.trim()) continue;
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object") return v;
    } catch {}
  }
  throw new Error("The model did not return the expected JSON.");
}

export interface MvOptionInput {
  key: string;
  label: string;
  text?: string;
  explain: Explain;
}

/** Validate one correction: bounded, backed by a reason and existing evidence; applied = Δ·c·γ. */
export function adjustOf(raw: any, mat: Pick<Material, "ids" | "generic">, confidence: number, gamma: number): OracleAdjust {
  // "+8", "8 points", 8 — all the same.
  const proposed = clamp(Math.round(parseFloat(String(raw?.delta ?? "").replace(",", ".")) || 0), -MAX_DELTA, MAX_DELTA);
  const why = one(raw?.why, 300);
  const all = strs(raw?.refs, 8, 12);
  const refs = all.filter((r) => mat.ids.has(r) && !mat.generic.has(r));
  const ignored = all.filter((r) => mat.ids.has(r) && mat.generic.has(r));
  const backed = Boolean(proposed && why && refs.length);
  // The bound holds for what counts, too: γ (up to 1.5) never pushes a correction past ±20.
  const applied = backed ? clamp(Math.round(proposed * confidence * gamma), -MAX_DELTA, MAX_DELTA) : 0;
  return { proposed, applied, why, refs, backed, dropped: all.filter((r) => !mat.ids.has(r)), ...(ignored.length ? { ignored } : {}) };
}

/** The final number of one option from the core derivation and the oracle's corrections. */
export function applyOracle(e: Explain, own: OracleAdjust, ctx: OracleAdjust, hardAtRisk: boolean) {
  const ownAfter = clamp(e.own.score + own.applied);
  const ctxAfter = clamp(e.inContext.score + ctx.applied);
  let predicted = predictLinear({ own: ownAfter, inContext: ctxAfter, line: e.line, risk: e.risk.lessons + e.risk.canon }, { alpha: e.alpha, beta: e.beta });
  const capped = hardAtRisk && predicted > CANON_CAP;
  if (capped) predicted = CANON_CAP;
  return { ownAfter, ctxAfter, predicted, capped };
}

/** Run the three roles on a view (now, or the past for a backtest). */
export async function runMultiverse(
  s: Scenaria,
  v: View,
  subject: { kind: "decision"; node: string; question: string } | { kind: "prompt"; text: string; at: string | null },
  options: MvOptionInput[],
  opts: { lang?: Lang; llm?: Partial<LlmRequest>; globalOnly?: boolean; gamma?: number; onStep?: (step: MultiverseStep) => void; signal?: AbortSignal } = {},
): Promise<MultiverseResult> {
  const lang: Lang = opts.lang === "en" ? "en" : "de";
  const gamma = opts.gamma ?? DEFAULT_GAMMA;
  const at = subject.kind === "decision" ? subject.node : subject.at;
  const mat = material(v, at, subject.kind === "decision" ? { excludeDecisionOptions: subject.node } : {});
  const ups = upstreams(s);
  const models: MultiverseResult["models"] = {};
  const warnings: string[] = [];
  const failed = new Set<string>();
  const ask = async (role: "archivist" | "craftsman" | "oracle", user: string) => {
    opts.onStep?.(role);
    const cfg = effectiveLlm(s, role, opts.llm, { globalOnly: opts.globalOnly });
    if (!cfg) throw new Error(lang === "de" ? "Kein Modell eingestellt – wähle eines in den Einstellungen (⚙)." : "No model configured — choose one in Settings (⚙).");
    // Errors of the connection (no model, no key, HTTP) are shown as they are; an answer that is not
    // the expected JSON is asked again once, then the forecast continues without that role.
    const out = await callLlm(cfg, ups, ROLE_PROMPTS[role](lang), user, undefined, { json: true, signal: opts.signal });
    models[role] = out.model;
    try {
      return parseJson(out.text);
    } catch {
      const again = await callLlm(cfg, ups, ROLE_PROMPTS[role](lang), `${user}\n\nYour previous answer was not valid JSON. Answer ONLY with the JSON object described above, nothing else.`, undefined, { json: true, signal: opts.signal });
      try {
        return parseJson(again.text);
      } catch {
        failed.add(role);
        warnings.push(lang === "de" ? `${ROLE_NAME.de[role]}: Antwort des Modells (${out.model}) war zweimal kein gültiges JSON – ohne diese Rolle weitergerechnet.` : `${ROLE_NAME.en[role]}: the model's answer (${out.model}) was not valid JSON twice — continued without this role.`);
        return {};
      }
    }
  };
  const optionList = options.map((o) => `- key "${o.key}": ${o.label}${o.text ? ` — ${one(o.text, 500)}` : ""}`).join("\n");
  const question = subject.kind === "decision" ? `DECISION: ${subject.question}` : `PROMPT TO EVALUATE (what happens if an agent gets this on the current line?):`;

  // 1. Archivist — the past only.
  const a = await ask("archivist", `${question}\nOPTIONS:\n${optionList}\n\n--- PAST ---\n${mat.past}`);
  const archNotes = listOf(a).map((x: any) => `- ${one(x?.key, 10)}: ${one(x?.past, 400)}${strs(x?.refs, 6, 12).length ? ` (${strs(x?.refs, 6, 12).join(", ")})` : ""}`).join("\n");
  // 2. Craftsman — the present only.
  const c = await ask("craftsman", `MAIN GOAL: ${mat.goal}\nTASK: ${mat.task}\n${question}\nOPTIONS:\n${optionList}\n\nWHAT THE PAST SAYS (archivist):\n${archNotes || "(nothing)"}\n\n--- CURRENT LINE ---\n${mat.present}`);
  const craftNotes = listOf(c)
    .map((x: any) => `- ${one(x?.key, 10)}: ${one(x?.present, 300)} | steps: ${strs(x?.trajectory, 3, 120).join(" → ")} | keeps: ${strs(x?.keeps, 4, 120).join("; ") || "-"} | would drop: ${strs(x?.loses, 4, 120).join("; ") || "-"}`)
    .join("\n");
  // 3. Oracle — the future, and the core's numbers it may correct.
  const coreTable = options
    .map((o) => {
      const e = o.explain;
      const pc = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
      return `- ${o.key}: OWN ${e.own.score} (goal ${pc(e.own.anchor)}, connection ${pc(e.own.continuity)})${e.breakRisk ? " ⚠ no word connection" : ""} · CONTEXT ${e.inContext.score} · line level ${e.line} · core forecast ${e.predicted}`;
    })
    .join("\n");
  const o = await ask(
    "oracle",
    `MAIN GOAL: ${mat.goal}\n${question}\nOPTIONS:\n${optionList}\n\nCORE (word-based, to correct where wrong):\n${coreTable}\n\nFUTURE FIXED POINTS:\n${mat.future}\nHARD PAST CONSTRAINTS:\n${mat.hardPast}\n\nARCHIVIST:\n${archNotes || "(nothing)"}\nCRAFTSMAN:\n${craftNotes || "(nothing)"}\n\nToday: ${(v.asOf ?? new Date().toISOString()).slice(0, 10)}`,
  );

  // Models write keys differently ("A", "a)", the full or a shortened label, or only the order). Each
  // answer entry goes to AT MOST one option; the order is used only when no entry names any option.
  const pa_ = assignEntries(listOf(a), options);
  const pr_ = assignEntries(listOf(c), options);
  const fu_ = assignEntries(listOf(o), options);
  if (failed.has("oracle") || (listOf(o).length > 0 && fu_.size === 0) || listOf(o).length === 0)
    // Without a usable oracle answer the multiverse adds nothing: do not dress the core up as a result.
    throw new Error(lang === "de" ? `Das Modell hat keine brauchbare Antwort des Orakels geliefert (${models.oracle ?? "?"}) – kein Ergebnis gespeichert. Ein größeres Modell wählen oder erneut versuchen.` : `The model gave no usable oracle answer (${models.oracle ?? "?"}) — nothing saved. Choose a larger model or try again.`);
  const unmatched = (m: Map<string, any>, list: any[], role: "archivist" | "craftsman" | "oracle") => {
    if (list.length && m.size < Math.min(list.length, options.length)) warnings.push(lang === "de" ? `${ROLE_NAME.de[role]}: ${list.length - m.size} Antwort(en) ließen sich keiner Option sicher zuordnen – nicht verwendet.` : `${ROLE_NAME.en[role]}: ${list.length - m.size} answer(s) could not be matched to an option for sure — not used.`);
  };
  unmatched(pa_, listOf(a), "archivist");
  unmatched(pr_, listOf(c), "craftsman");
  unmatched(fu_, listOf(o), "oracle");
  const hard = new Set(v.canon.filter((e) => e.hard).map((e) => e.id));
  const out: OracleOption[] = [];
  for (const opt of options) {
    const pa = pa_.get(opt.key);
    const pr = pr_.get(opt.key);
    const fu = fu_.get(opt.key);
    if (!fu) warnings.push(`${opt.key}: ${lang === "de" ? "vom Orakel nicht bewertet – Kern-Prognose bleibt" : "not assessed by the oracle — core forecast kept"}`);
    const c0 = parseFloat(String(fu?.confidence ?? ""));
    const conf = c0 > 1 && c0 <= 100 ? c0 / 100 : c0;
    // Rounded to 2 decimals and computed with exactly that value: what is shown can be recomputed.
    const confidence = Number.isFinite(conf) ? Math.round(clamp(conf, 0, 1) * 100) / 100 : 0.5;
    const own = adjustOf(fu?.ownAdjust, mat, confidence, gamma);
    const ctx = adjustOf(fu?.ctxAdjust, mat, confidence, gamma);
    const canonRisks = strs(fu?.canonRisks, 6, 10).filter((k) => mat.ids.has(k) && v.canon.some((e) => e.id === k));
    const hardAtRisk = canonRisks.some((k) => hard.has(k));
    const r = applyOracle(opt.explain, own, ctx, hardAtRisk);
    out.push({
      key: opt.key,
      past: one(pa?.past, 600),
      pastRefs: strs(pa?.refs, 6, 12).filter((x) => mat.ids.has(x)),
      present: one(pr?.present, 600),
      trajectory: strs(pr?.trajectory, 4, 200),
      keeps: strs(pr?.keeps, 5, 200),
      loses: strs(pr?.loses, 5, 200),
      outcome: one(fu?.outcome, 600),
      risks: (Array.isArray(fu?.risks) ? fu.risks : []).slice(0, 5).map((x: any) => (typeof x === "string" ? { text: one(x, 240), refs: [] } : { text: one(x?.text, 240), refs: strs(x?.refs, 4, 12).filter((y) => mat.ids.has(y)) })).filter((x: { text: string }) => x.text),
      canonRisks,
      confidence,
      own,
      ctx,
      ownAfter: r.ownAfter,
      ctxAfter: r.ctxAfter,
      core: opt.explain.predicted,
      predicted: r.predicted,
      capped: r.capped,
      gamma,
      // Only a CANDIDATE: the oracle raised flagged own words with specific evidence (synonyms, another
      // language …). The auditor counts the warning as resolved only once the skeptic confirms the evidence.
      flagResolved: opt.explain.breakRisk && own.backed && own.applied > 0,
    });
  }
  opts.onStep?.("done");
  const recRaw = o.recommendation?.key ?? o.recommendation?.option ?? o.recommendation;
  const recOpt = typeof recRaw === "string" || typeof recRaw === "number" ? options.find((x) => x.key === one(recRaw, 20)) ?? options.find((x) => normKey(x.key) === normKey(recRaw) || normKey(x.label) === normKey(recRaw)) : undefined;
  const rec = recOpt ? { key: recOpt.key, why: one(o.recommendation?.why, 600) } : undefined;
  const best = [...out].sort((x, y) => y.predicted - x.predicted)[0];
  if (rec && best && rec.key !== best.key) warnings.push(lang === "de" ? `Das Orakel empfiehlt ${rec.key}, die korrigierte Prognose spricht für ${best.key}.` : `The oracle recommends ${rec.key}; the corrected forecast favours ${best.key}.`);
  const unbacked = out.flatMap((x) => [x.own, x.ctx]).filter((a) => a.proposed && !a.backed).length;
  if (unbacked) warnings.push(lang === "de" ? `${unbacked} Korrektur(en) des Orakels ohne Grund oder gültige Belege – nicht gewertet.` : `${unbacked} oracle correction(s) without a reason or valid evidence — not counted.`);
  const cited = new Set(out.flatMap((x) => [...x.own.refs, ...x.ctx.refs, ...x.risks.flatMap((r) => r.refs), ...x.pastRefs, ...x.canonRisks]));
  const evidence = Object.fromEntries([...cited].map((id) => [id, mat.texts.get(id) ?? ""]));
  return { options: out, recommended: rec, models, warnings, evidence };
}

// ------------------------------------------------------------------ trust in the oracle (γ)

export interface OracleCase {
  /** Core parts and the oracle's raw corrections (Δ·c, before γ). */
  own: number;
  inContext: number;
  line: number;
  risk: number;
  alpha: number;
  beta: number;
  rawOwn: number;
  rawCtx: number;
  capped: boolean;
  actual: number;
}

/** γ by least squares (0 ≤ γ ≤ 1.5), shrunk towards 1 with the weight of 5 cases. */
export function fitGamma(cases: OracleCase[]): { gamma: number; n: number } {
  let n = 0;
  let num = 0;
  let den = 0;
  for (const c of cases) {
    if (c.capped) continue;
    // P(γ) = L + α(own + γ·rawOwn − L) + β(ctx + γ·rawCtx − L) − risk = P0 + γ·g
    const p0 = c.line + c.alpha * (c.own - c.line) + c.beta * (c.inContext - c.line) - c.risk;
    const g = c.alpha * c.rawOwn + c.beta * c.rawCtx;
    // Only cases where the oracle actually corrected something say anything about γ.
    if (Math.abs(g) < 1e-9) continue;
    n++;
    num += g * (c.actual - p0);
    den += g * g;
  }
  if (!n) return { gamma: DEFAULT_GAMMA, n: 0 };
  const raw = den > 1e-9 ? clamp(num / den, 0, 1.5) : DEFAULT_GAMMA;
  return { gamma: Math.round(((n * raw + GAMMA_SHRINK * DEFAULT_GAMMA) / (n + GAMMA_SHRINK)) * 100) / 100, n };
}

/** Does a reason talk about what its evidence says? (word stems; a weak, deterministic check) */
export function reasonFitsEvidence(why: string, refs: string[], mat: Pick<Material, "texts">): boolean {
  const w = stems(why);
  return refs.some((r) => overlap(w, stems(mat.texts.get(r) ?? "")) > 0);
}
