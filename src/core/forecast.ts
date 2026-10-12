/**
 * Forecasts ("multiverse"): predict, BEFORE a choice is made, how each option of a decision — or a
 * prompt — will play out: does the line keep its context and its main goal, or lose them?
 *
 * Two layers:
 *   quick       — deterministic, instant, no tokens (model v2, see core/predict.ts): the predicted
 *                 context fidelity of the line after the option — the SAME quantity that is measured
 *                 afterwards — from the option's own words and the next step in context (fidelity
 *                 formula), the line's level, lessons and fixed points at stake; learned weights and an
 *                 uncertainty band from this project's backtest. Also available to agents.
 *   multiverse  — three model roles with disjoint context (core/oracle.ts): archivist (PAST),
 *                 craftsman (PRESENT), oracle (FUTURE). The oracle may only CORRECT the core's two
 *                 parts — bounded (±20), each correction with a reason and evidence ids that exist;
 *                 the final number uses the same formula as the core, so it stays traceable.
 *                 Every forecast is checked by the Prüf-Experte (core/auditor.ts).
 *                 Runs on the person's request (dashboard, chat) or automatically for open
 *                 decisions when the person enabled it in Settings.
 *
 * Evaluation: once an option was really taken (chosen or explored), the forecast is compared with
 * the measured fidelity of that branch (mean of its first steps with content, within the task).
 * The overall quality (backtest against the naive "line keeps its level") is in core/predict.ts.
 * A forecast never chooses: the person decides.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Scenaria } from "./engine.js";
import type { LlmRequest } from "./analysis.js";
import { signRecord, verifyRecord } from "./canon.js";
import { MIN_STEPS, MODEL_VERSION, branchOf, calibrationFor, measureLine, predictOption, predictPrompt, viewNow, type Explain } from "./predict.js";
import { runMultiverse, type MultiverseStep, type OracleAdjust } from "./oracle.js";
import { oracleTrust } from "./auditor.js";
import type { LlmRole } from "./settings.js";
import { writeJsonAtomic } from "./store.js";
import { globalConfigPath } from "./global.js";

/** Oracle version of multiverse forecasts (2 = bounded, evidence-backed corrections of the core). */
export const ORACLE_VERSION = 2;

export interface QuickForecast {
  /** 0..100: predicted context retention (combined). */
  score: number;
  /** 0..100 or null without a goal: closeness to the main goal and the task goal. */
  goal: number | null;
  /** 0..100: connection to the recent path. */
  continuity: number;
  /** Lessons / failures on record that resemble this option. */
  warnings: string[];
  /** Canon events the option touches (by wording; the oracle judges respect/break). */
  canonTouched: string[];
  /** Fixed points the option touches, as readable hints (hard / with a date = future at stake). */
  canonHints: string[];
  /** "low": the option says too little to judge it (e.g. "yes"/"no") — use the multiverse. */
  signal: "ok" | "low";
  /** If the option was already explored: how that branch really went. */
  explored?: { node: string; measured: number; nodes?: number };
  /** Model v2: every part of the number, so anyone can retrace it (core/predict.ts). */
  explain?: Explain;
}

export interface Universe {
  past: string;
  present: string;
  future: string;
  /** Predicted next steps on this line. */
  trajectory: string[];
  /** 0..100 — the final (corrected) forecast of this option. */
  context: number;
  /** 0..100 — closeness of the option to the goal (core, for display). */
  goal: number;
  /** What context this option would carry / drop (craftsman). */
  keeps?: string[];
  loses: string[];
  canonRisks: string[];
  risks: string[];
  confidence: number;
  outcome: string;
  /** Oracle v2: the bounded, evidence-backed corrections of the core (see core/oracle.ts). */
  own?: OracleAdjust;
  ctx?: OracleAdjust;
  ownAfter?: number;
  ctxAfter?: number;
  core?: number;
  capped?: boolean;
  gamma?: number;
  pastRefs?: string[];
  flagResolved?: boolean;
}

export interface ForecastOption {
  key: string;
  label: string;
  text?: string;
  quick: QuickForecast;
  universe?: Universe;
  /** 0..100: what the dashboard shows — multiverse blended with quick when available. */
  score: number;
}

export interface ForecastActual {
  option: string;
  /** Measured context fidelity of the branch after the decision (avg of up to 6 nodes). */
  measured: number;
  predicted: number;
  error: number;
  nodes: number;
}

export interface Forecast {
  id: string;
  subject: { kind: "decision"; node: string; question: string } | { kind: "prompt"; text: string; at: string | null };
  createdAt: string;
  mode: "quick" | "multiverse";
  /** Forecast model version (2 = same quantity as the measurement; older ones are kept but not scored). */
  model?: number;
  /** Oracle version of a multiverse forecast (2 = bounded, evidence-backed corrections of the core). */
  oracle?: number;
  /** The text behind every id the oracle cited, as it was when the forecast was made (signed with it). */
  evidence?: Record<string, string>;
  trigger: "person" | "auto" | "chat";
  models: Partial<Record<LlmRole, string>>;
  options: ForecastOption[];
  recommended?: { key: string; why: string };
  warnings: string[];
  actual?: ForecastActual[];
  /** Prompts: the variant the person used (marked later), and how the line went after the forecast. */
  used?: string;
  actualLine?: { measured: number; nodes: number };
  usedSig?: string;
  /** Signature by Scenaria (approver key, bound to the project); computed on read: verified or not. */
  sig?: string;
  pub?: string;
  verified?: boolean;
}

type Lang = "de" | "en";
const one = (x: unknown, max = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ------------------------------------------------------------------ quick (deterministic)

const toQuick = (p: ReturnType<typeof predictOption>): QuickForecast => ({
  score: p.explain.predicted,
  goal: p.explain.own.anchor === null ? null : Math.round(p.explain.own.anchor * 100),
  continuity: Math.round(p.explain.own.continuity * 100),
  warnings: p.warnings,
  canonTouched: p.canonTouched,
  canonHints: p.canonHints,
  signal: p.explain.signal,
  explain: p.explain,
});

/** Options of a decision with their quick forecast — instant, no model (model v2, core/predict.ts). */
export function quickDecision(s: Scenaria, nodeId: string): ForecastOption[] {
  const d = s.node(nodeId);
  if (d.type !== "decision") throw new Error(`${nodeId} is not a decision`);
  const v = viewNow(s);
  const cal = calibrationFor(s);
  return (d.options ?? []).map((o) => {
    const q = toQuick(predictOption(v, d, o, cal));
    // Already explored or chosen: the real branch says more than any prediction.
    const branch = branchOf(v, d, o.id);
    const m = branch ? measureLine(v, branch.id) : null;
    if (branch && m) q.explored = { node: branch.id, measured: m.measured, nodes: m.nodes };
    return { key: o.id, label: o.label, text: o.description, quick: q, score: q.score };
  });
}

/** Quick forecast of a prompt on a line (default: HEAD). */
export function quickPrompt(s: Scenaria, text: string, at?: string | null): QuickForecast {
  const head = at ?? s.store.readState().head;
  const v = viewNow(s);
  if (!head || !v.nodes.has(head)) {
    const q: QuickForecast = { score: 0, goal: null, continuity: 0, warnings: [], canonTouched: [], canonHints: [], signal: "low" };
    return q;
  }
  const q = toQuick(predictPrompt(v, head, text, calibrationFor(s)));
  if (v.mainGoal && !text.trim()) q.score = 0;
  return q;
}

function dir(s: Scenaria) {
  return s.store.path("forecasts");
}

export function listForecasts(s: Scenaria): Forecast[] {
  const d = dir(s);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^f\d+\.json$/.test(f))
    .map((f) => {
      try {
        const x = JSON.parse(readFileSync(join(d, f), "utf8")) as Forecast;
        // Malformed files are skipped (never break the listing).
        if (!x || typeof x !== "object" || typeof x.id !== "string" || `${x.id}.json` !== f || typeof x.createdAt !== "string" || !x.subject || typeof x.subject !== "object" || !Array.isArray(x.options)) return null;
        if (x.options.some((o: any) => !o || typeof o.key !== "string" || typeof o.score !== "number" || !o.quick || typeof o.quick !== "object")) return null;
        x.warnings = Array.isArray(x.warnings) ? x.warnings : [];
        // A forecast file written around Scenaria (e.g. by an agent) is shown as unverified and
        // never counts (it cannot suppress or replace a real forecast).
        x.verified = verifyRecord(s.store, ["forecast/v1", x.id, digest(x)], x.pub, x.sig);
        // The variant the person marked as used is signed on its own.
        if (x.used && !verifyRecord(s.store, ["forecast-used/v1", x.id, x.used], x.pub, x.usedSig)) x.used = undefined;
        return x;
      } catch {
        return null;
      }
    })
    .filter((f): f is Forecast => f !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Content hash of a forecast without the computed / signature fields. */
function digest(f: Forecast): string {
  const { sig, pub, verified, actual, actualLine, used, usedSig, ...content } = f;
  void sig, pub, verified, actual, actualLine, used, usedSig;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function save(s: Scenaria, f: Omit<Forecast, "id">): Forecast {
  mkdirSync(dir(s), { recursive: true });
  // Reserve the number exclusively: the dashboard and agent processes may save at the same time.
  let n = readdirSync(dir(s)).reduce((m, x) => Math.max(m, parseInt(x.match(/^f(\d+)\.json$/)?.[1] ?? "0", 10)), 0) + 1;
  for (;; n++) {
    try {
      closeSync(openSync(join(dir(s), `f${n}.json`), "wx"));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST" || n > 100000) throw err;
    }
  }
  const id = `f${n}`;
  const out = { id, model: MODEL_VERSION, ...f } as Forecast;
  const sg = signRecord(s.store, ["forecast/v1", id, digest(out)]);
  out.sig = sg.sig;
  out.pub = sg.pub;
  writeJsonAtomic(join(dir(s), `${id}.json`), out);
  out.verified = true;
  s.store.appendEvent({ type: "analysis", nodeId: f.subject.kind === "decision" ? f.subject.node : undefined, data: { message: `forecast ${id} (${f.mode}) for ${f.subject.kind === "decision" ? f.subject.node : "a prompt"}${f.recommended ? `, recommends ${f.recommended.key}` : ""}`, id } });
  return out;
}

export interface ForecastRequest {
  /** A decision node (open or decided) … */
  node?: string;
  /** … or a prompt / plan to evaluate on the current line, with optional alternative wordings. */
  prompt?: string;
  variants?: string[];
  /** Quick only (no model). */
  quick?: boolean;
  lang?: Lang;
  llm?: Partial<LlmRequest>;
  trigger?: Forecast["trigger"];
  /** Only the person's global model settings (automatic mode). */
  globalOnly?: boolean;
  /** Progress: which role is working (shown in the dashboard while it runs). */
  onStep?: (step: MultiverseStep) => void;
  /** The person cancelled in the dashboard. */
  signal?: AbortSignal;
}

/** Create a forecast. Multiverse (three roles) unless `quick`; the quick layer is always included. */
export async function forecast(s: Scenaria, req: ForecastRequest): Promise<Forecast> {
  const lang: Lang = req.lang === "en" ? "en" : "de";
  let subject: Forecast["subject"];
  let options: ForecastOption[];
  let lineAt: string | null;
  if (req.node) {
    const d = s.node(req.node);
    if (d.type !== "decision") throw new Error(`${req.node} is not a decision`);
    subject = { kind: "decision", node: d.id, question: d.question ?? d.title };
    options = quickDecision(s, d.id);
    lineAt = d.id;
  } else {
    const text = one(req.prompt, 4000);
    if (text.length < 3) throw new Error("Give a decision node or a prompt to forecast.");
    lineAt = s.store.readState().head;
    subject = { kind: "prompt", text, at: lineAt };
    const all = [text, ...(req.variants ?? []).map((v) => one(v, 4000)).filter((v) => v.length >= 3)].slice(0, 4);
    options = all.map((t, i) => {
      const q = quickPrompt(s, t, lineAt);
      return { key: i === 0 ? "p" : `v${i}`, label: i === 0 ? (lang === "de" ? "Prompt wie geschrieben" : "Prompt as written") : `${lang === "de" ? "Variante" : "Variant"} ${i}`, text: t, quick: q, score: q.score };
    });
  }
  if (!options.length) throw new Error("Nothing to forecast (the decision has no options).");
  if (req.quick) {
    const best = [...options].sort((a, b) => b.score - a.score)[0];
    return save(s, { subject, createdAt: new Date().toISOString(), mode: "quick", trigger: req.trigger ?? "person", models: {}, options, recommended: { key: best.key, why: lang === "de" ? "höchste Kontext-Prognose (ohne Modell)" : "highest context forecast (no model)" }, warnings: [] });
  }

  // The multiverse: three roles correct the core — bounded, with reasons and evidence (core/oracle.ts).
  const v = viewNow(s);
  const gamma = oracleTrust(s).gamma;
  const mv = await runMultiverse(s, v, subject, options.filter((o) => o.quick.explain).map((o) => ({ key: o.key, label: o.label, text: o.text, explain: o.quick.explain! })), { lang, llm: req.llm, globalOnly: req.globalOnly, gamma, onStep: req.onStep, signal: req.signal });
  for (const opt of options) {
    const u = mv.options.find((x) => x.key === opt.key);
    if (!u) continue;
    opt.universe = {
      past: u.past,
      present: u.present,
      future: u.outcome,
      trajectory: u.trajectory,
      context: u.predicted,
      goal: opt.quick.goal ?? 0,
      keeps: u.keeps,
      loses: u.loses,
      canonRisks: u.canonRisks,
      risks: u.risks.map((r) => `${r.text}${r.refs.length ? ` (${r.refs.join(", ")})` : ""}`),
      confidence: u.confidence,
      outcome: u.outcome,
      own: u.own,
      ctx: u.ctx,
      ownAfter: u.ownAfter,
      ctxAfter: u.ctxAfter,
      core: u.core,
      capped: u.capped,
      gamma: u.gamma,
      pastRefs: u.pastRefs,
      flagResolved: u.flagResolved,
    };
    opt.score = u.predicted;
  }
  const best = [...options].sort((x, y) => y.score - x.score)[0];
  return save(s, { subject, createdAt: new Date().toISOString(), mode: "multiverse", oracle: ORACLE_VERSION, evidence: mv.evidence, trigger: req.trigger ?? "person", models: mv.models, options, recommended: mv.recommended ?? (best ? { key: best.key, why: lang === "de" ? "höchste korrigierte Prognose" : "highest corrected forecast" } : undefined), warnings: mv.warnings });
}

// ------------------------------------------------------------------ evaluation

/**
 * Compare forecasts with what really happened on the branches that were taken — the same quantity the
 * forecast predicts (model v2): mean fidelity of the first steps with content within the task.
 * Only forecasts of model v2 are scored; older ones keep their number but are not comparable.
 */
export function evaluateForecasts(s: Scenaria): { forecasts: Forecast[]; calibration: { evaluated: number; meanError: number | null; hits: number; legacy: number; multiverse: { evaluated: number; meanError: number | null } } } {
  const v = viewNow(s);
  const all = listForecasts(s);
  const errors: number[] = [];
  const mvErrors: number[] = [];
  let legacy = 0;
  for (const f of all) {
    if (!f.verified) continue;
    if ((f.model ?? 1) < MODEL_VERSION) {
      legacy++;
      continue;
    }
    if (f.subject.kind === "prompt") {
      // The line after the prompt forecast: the first step created afterwards under `at`.
      const at = f.subject.at;
      const after = [...v.nodes.values()].filter((n) => n.createdAt >= f.createdAt && (!at || n.parentId === at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const m = after ? measureLine(v, after.id) : null;
      if (m) {
        f.actualLine = { measured: m.measured, nodes: m.nodes };
        const usedOpt = f.options.find((o) => o.key === f.used);
        if (usedOpt && m.nodes >= MIN_STEPS) {
          f.actual = [{ option: usedOpt.key, measured: m.measured, predicted: usedOpt.score, error: Math.abs(m.measured - usedOpt.score), nodes: m.nodes }];
          errors.push(f.actual[0].error);
          if (f.mode === "multiverse") mvErrors.push(f.actual[0].error);
        }
      }
      continue;
    }
    const d = v.nodes.get(f.subject.node);
    if (!d) continue;
    const actual: ForecastActual[] = [];
    for (const o of f.options) {
      // Only branches created after the forecast count (otherwise the forecast already saw them).
      const branch = branchOf(v, d, o.key);
      if (!branch || branch.createdAt < f.createdAt) continue;
      const m = measureLine(v, branch.id);
      if (!m || m.nodes < MIN_STEPS) continue;
      actual.push({ option: o.key, measured: m.measured, predicted: o.score, error: Math.abs(m.measured - o.score), nodes: m.nodes });
      errors.push(Math.abs(m.measured - o.score));
      if (f.mode === "multiverse") mvErrors.push(Math.abs(m.measured - o.score));
    }
    if (actual.length) f.actual = actual;
  }
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    forecasts: all,
    calibration: { evaluated: errors.length, meanError: avg(errors), hits: errors.filter((e) => e <= 15).length, legacy, multiverse: { evaluated: mvErrors.length, meanError: avg(mvErrors) } },
  };
}

/**
 * Budget of the automatic mode, kept OUTSIDE the project (an agent must not be able to reset it):
 * every attempt counts, failed ones too.
 */
export function autoBudget(_s?: Scenaria) {
  // One budget for the person across ALL projects (the dashboard can switch between them):
  // the daily limit in Settings is a total, not per project.
  const file = join(dirname(globalConfigPath()), "forecast-budget", "all.json");
  const today = new Date().toISOString().slice(0, 10);
  const read = (): { date: string; used: number } => {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      return v?.date === today && Number.isFinite(v.used) ? v : { date: today, used: 0 };
    } catch {
      return { date: today, used: 0 };
    }
  };
  return {
    used: () => read().used,
    spend: () => {
      const v = read();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ date: today, used: v.used + 1 }));
    },
  };
}

/** Open decisions ON THE CURRENT LINE without a verified multiverse forecast (automatic mode). */
export function openWithoutForecast(s: Scenaria): string[] {
  const done = new Set(listForecasts(s).filter((f) => f.verified && f.mode === "multiverse" && f.subject.kind === "decision").map((f) => (f.subject as { node: string }).node));
  const head = s.store.readState().head;
  if (!head) return [];
  // Abandoned (rewound-away) decisions are not forecast: only the HEAD line and its open decision.
  return s
    .path(head)
    .filter((n) => n.type === "decision" && !n.chosen && (n.options?.length ?? 0) > 1 && !done.has(n.id))
    .map((n) => n.id);
}

/** Mark which prompt variant the person really used (for the evaluation of prompt forecasts). */
export function markUsed(s: Scenaria, id: string, key: string): Forecast {
  const f = listForecasts(s).find((x) => x.id === id);
  if (!f || f.subject.kind !== "prompt") throw new Error(`${id} is not a prompt forecast`);
  if (!f.options.some((o) => o.key === key)) throw new Error(`unknown variant ${key}`);
  const { verified, ...raw } = f;
  void verified;
  const sg = signRecord(s.store, ["forecast-used/v1", id, key]);
  if (sg.pub !== f.pub) throw new Error("this forecast was signed by another approver key");
  writeJsonAtomic(join(dir(s), `${id}.json`), { ...raw, used: key, usedSig: sg.sig });
  return { ...f, used: key };
}

/** Save the quick forecast of a freshly recorded open decision (no model) so it can be evaluated later. */
export function snapshotQuick(s: Scenaria, nodeId: string): Forecast | null {
  try {
    const d = s.node(nodeId);
    if (d.type !== "decision" || d.chosen || (d.options?.length ?? 0) < 2) return null;
    const options = quickDecision(s, nodeId);
    const best = [...options].sort((a, b) => b.score - a.score)[0];
    return save(s, { subject: { kind: "decision", node: d.id, question: d.question ?? d.title }, createdAt: new Date().toISOString(), mode: "quick", trigger: "auto", models: {}, options, recommended: best ? { key: best.key, why: "highest context forecast (no model)" } : undefined, warnings: [] });
  } catch {
    return null;
  }
}

/** One line for agents and the CLI: the forecast per option, and whether it can tell them apart. */
export function quickSummary(options: ForecastOption[], lang: Lang = "en"): string {
  const parts = options.map((o) => `${o.key} ${o.score}%${o.quick.warnings.length ? " ⚠lesson" : ""}${o.quick.canonHints.length ? ` ⚑${o.quick.canonTouched.join(",")}` : ""}${o.quick.signal === "low" ? " (?)" : ""}`);
  const scores = options.map((o) => o.score);
  const close = Math.max(...scores) - Math.min(...scores) < 6;
  const low = options.every((o) => o.quick.signal === "low");
  const note = close || low ? (lang === "de" ? " — nicht unterscheidbar ohne Modell: Multiversum empfohlen" : " — not distinguishable without a model: multiverse recommended") : "";
  return parts.join(" · ") + note;
}
