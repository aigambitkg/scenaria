/**
 * Forecasts ("multiverse"): predict, BEFORE a choice is made, how each option of a decision — or a
 * prompt — will play out: does the line keep its context and its main goal, or lose them?
 *
 * Two layers:
 *   quick       — deterministic, instant, no tokens. Per option: closeness to the main goal and the
 *                 task (anchor), connection to the recent path (continuity), lessons from rewinds and
 *                 failed checks that resemble the option, and — if the option was already explored —
 *                 how that branch really went. Always available, also to agents (scenaria_forecast).
 *   multiverse  — three model roles with disjoint context (like the relay):
 *                   archivist (PAST: dossier, rules, past canon, lessons)
 *                   craftsman (PRESENT: the current line, the concrete next steps per option and
 *                              which context each option must carry or would drop)
 *                   oracle    (FUTURE: main goal, future canon → outcome, context retention %,
 *                              goal alignment %, risks, confidence, recommendation)
 *                 One universe per option. Runs on the person's request (dashboard, chat) or
 *                 automatically for open decisions when the person enabled it in Settings.
 *
 * Evaluation: once an option was really taken (chosen or explored), the forecast is compared with
 * the measured context fidelity of that branch → hit rate per forecast and overall calibration.
 * A forecast never chooses: the person decides.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Scenaria } from "./engine.js";
import type { ScenariaNode } from "./types.js";
import { callLlm, dossier, type LlmRequest } from "./analysis.js";
import { canonState, type CanonEvent } from "./canon.js";
import { nearestGoal } from "./context.js";
import { stems, overlap } from "./fidelity.js";
import { nodeText } from "./recall.js";
import { effectiveLlm, upstreams, type LlmRole } from "./settings.js";
import { writeJsonAtomic } from "./store.js";
import { createHash } from "node:crypto";
import { signRecord, verifyRecord } from "./canon.js";

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
  explored?: { node: string; measured: number };
}

export interface Universe {
  past: string;
  present: string;
  future: string;
  /** Predicted next steps on this line. */
  trajectory: string[];
  /** 0..100 */
  context: number;
  /** 0..100 */
  goal: number;
  /** What context this option would drop (prompt/decision loses context). */
  loses: string[];
  canonRisks: string[];
  risks: string[];
  confidence: number;
  outcome: string;
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
  trigger: "person" | "auto" | "chat";
  models: Partial<Record<LlmRole, string>>;
  options: ForecastOption[];
  recommended?: { key: string; why: string };
  warnings: string[];
  actual?: ForecastActual[];
  /** Prompts: the variant the person used (marked later), and how the line went after the forecast. */
  used?: string;
  actualLine?: { measured: number; nodes: number };
  /** Signature by Scenaria (approver key, bound to the project); computed on read: verified or not. */
  sig?: string;
  pub?: string;
  verified?: boolean;
}

type Lang = "de" | "en";
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const norm = (x: number, full: number) => Math.max(0, Math.min(1, x / full));
const one = (x: unknown, max = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const strs = (x: unknown, max = 8, len = 240) => (Array.isArray(x) ? x.map((v) => one(v, len)).filter(Boolean).slice(0, max) : []);
/** Accepts 0..1 or 0..100. */
const pct = (x: unknown) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 50;
  return clamp(n > 0 && n < 1 ? n * 100 : n);
};

// ------------------------------------------------------------------ quick (deterministic)

interface LineContext {
  path: ScenariaNode[];
  mainGoal: Set<string>;
  taskGoal: Set<string>;
  window: Set<string>;
  lessons: { node: string; text: string; toks: Set<string> }[];
  canon: CanonEvent[];
}

function lineContext(s: Scenaria, at: string | null, opts: { excludeLast?: boolean } = {}): LineContext {
  const all = s.store.listNodes();
  const full = at ? s.path(at) : [];
  // For a decision: the line BEFORE it (its own text names every option and would favour none).
  const path = opts.excludeLast ? full.slice(0, -1) : full;
  const root = s.project();
  const task = path.length ? nearestGoal(path) : null;
  const window = new Set<string>();
  for (const n of path.slice(-6)) for (const t of stems(nodeText(n))) window.add(t);
  // Lessons anywhere in the project: rewinds with a lesson, failed verifications.
  const lessons = all.flatMap((n) => [
    ...(n.lessons ?? []).map((l) => ({ node: n.id, text: l })),
    ...(n.verification?.status === "failed" ? [{ node: n.id, text: `${n.title}: ${n.verification.notes ?? "failed verification"}` }] : []),
  ]);
  return {
    path,
    mainGoal: stems(root?.goal ?? ""),
    taskGoal: stems(task ? `${task.title} ${task.goal ?? ""}` : ""),
    window,
    lessons: lessons.map((l) => ({ ...l, toks: stems(l.text) })),
    canon: canonState(s.store).events.filter((e) => e.status === "active"),
  };
}

function quickFor(text: string, lc: LineContext, signal: "ok" | "low" = "ok"): QuickForecast {
  const toks = stems(text);
  const goalSet = new Set([...lc.mainGoal, ...lc.taskGoal]);
  const goal = goalSet.size ? norm(overlap(toks, goalSet), 0.18) : null;
  const cont = new Set([...lc.window, ...lc.taskGoal]);
  const continuity = cont.size ? norm(overlap(toks, cont), 0.15) : 0.5;
  const warnings = lc.lessons
    .map((l) => ({ l, o: overlap(toks, l.toks) }))
    .filter((x) => x.o >= 0.22)
    .sort((a, b) => b.o - a.o)
    .slice(0, 3)
    .map((x) => `${x.l.node}: ${one(x.l.text, 160)}`);
  const touched = lc.canon.filter((e) => overlap(toks, stems(e.text)) >= 0.25);
  const canonTouched = touched.map((e) => e.id);
  // The future enters the quick layer through the fixed points: touching a hard or dated one is a
  // risk the oracle must judge (the wording alone cannot say whether the option keeps or breaks it).
  const canonHints = touched.map((e) => `${e.id}${e.hard ? " (hard" : " (soft"}${e.kind === "future" ? `, future${e.due ? `, by ${e.due}` : ""}` : ""}): ${one(e.text, 120)}`);
  const atStake = touched.filter((e) => e.hard && (e.kind === "future" || e.due)).length;
  const penalty = Math.min(0.4, warnings.length * 0.12 + atStake * 0.08);
  const base = goal === null ? continuity : goal * 0.5 + continuity * 0.5;
  return { score: clamp(base * (1 - penalty) * 100), goal: goal === null ? null : clamp(goal * 100), continuity: clamp(continuity * 100), warnings, canonTouched, canonHints, signal };
}

/** Options of a decision with their quick forecast — instant, no model. */
export function quickDecision(s: Scenaria, nodeId: string): ForecastOption[] {
  const d = s.node(nodeId);
  if (d.type !== "decision") throw new Error(`${nodeId} is not a decision`);
  const lc = lineContext(s, d.id, { excludeLast: true });
  const fid = s.fidelity().points;
  const kids = s.children(d.id);
  return (d.options ?? []).map((o) => {
    const own = `${o.label} ${o.description ?? ""}`;
    // Very short options ("Ja"/"Nein") get the question for meaning — and are marked as low signal.
    const low = stems(own).size < 3;
    const q = quickFor(low ? `${d.question ?? d.title} ${own}` : own, lc, low ? "low" : "ok");
    // Already explored or chosen: the real branch says more than any prediction.
    const branch = kids.find((k) => k.viaOption === o.id) ?? (d.chosen === o.id ? kids.find((k) => !k.viaOption) : undefined);
    if (branch && fid[branch.id]) q.explored = { node: branch.id, measured: measuredAfter(s, branch.id, fid).measured };
    return { key: o.id, label: o.label, text: o.description, quick: q, score: q.score };
  });
}

/** Quick forecast of a prompt (and optional variants) on a line. */
export function quickPrompt(s: Scenaria, text: string, at?: string | null): QuickForecast {
  const head = at ?? s.store.readState().head;
  const lc = lineContext(s, head);
  const q = quickFor(text, lc);
  // Explicit references to the line (n12, k3) keep context; very short prompts lose it.
  const refs = (text.match(/\b[nk]\d+\b/g) ?? []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = q.score + Math.min(15, refs * 5) - (words < 6 ? 15 : 0);
  if (lc.mainGoal.size && !text.trim()) score = 0;
  return { ...q, score: clamp(score) };
}

/** Measured context fidelity of the line starting at `start` (avg of up to 6 nodes). */
function measuredAfter(s: Scenaria, start: string, fid: Record<string, { score: number }>) {
  const scores: number[] = [];
  let cur: string | undefined = start;
  const seen = new Set<string>();
  while (cur && scores.length < 6 && !seen.has(cur)) {
    seen.add(cur);
    if (fid[cur]) scores.push(fid[cur].score);
    const kids: ScenariaNode[] = s.children(cur);
    cur = kids.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id;
  }
  return { measured: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0, nodes: scores.length };
}

// ------------------------------------------------------------------ multiverse (three roles)

const langLine = (lang: Lang) => `Write all text values in ${lang === "de" ? "German" : "English"}.`;
const PROMPTS = {
  archivist: (lang: Lang) => `You are the ARCHIVIST of a multiverse forecast. You only know the PAST of the project (dossier, rules, past fixed points, lessons). For EACH option below, say briefly what the history implies for it: which earlier decisions, constraints or lessons it continues or contradicts. Cite node ids (n12) and canon ids (k3). No predictions about the future.
Answer ONLY with JSON: {"options": [{"key": "<key>", "past": "…", "refs": ["n7"]}]}
${langLine(lang)}`,
  craftsman: (lang: Lang) => `You are the CRAFTSMAN of a multiverse forecast. You work in the PRESENT: the current line of work and the main goal. For EACH option, predict the concrete next 3 steps an agent would take, which context it must carry along to stay on track, and which context it would likely DROP (forget, ignore, overwrite).
Answer ONLY with JSON: {"options": [{"key": "<key>", "present": "…", "trajectory": ["step 1", "step 2", "step 3"], "loses": ["…"]}]}
${langLine(lang)}`,
  oracle: (lang: Lang) => `You are the ORACLE of a multiverse forecast. You only look at the FUTURE: the main goal and the future fixed points (dates, load, legal deadlines), plus what the archivist and craftsman found. For EACH option predict: the outcome, how well the line will keep its context (0-100), how well it serves the main goal (0-100), which canon ids it puts at risk, other risks, and your confidence (0-1). Then recommend one option. Be concrete; with little information, say so and lower the confidence.
Answer ONLY with JSON: {"options": [{"key": "<key>", "future": "…", "outcome": "…", "context": 0-100, "goal": 0-100, "canonRisks": ["k2"], "risks": ["…"], "confidence": 0.0-1.0}], "recommendation": {"key": "<key>", "why": "…"}}
${langLine(lang)}`,
};

function json(text: string): any {
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

function canonText(events: CanonEvent[], kind: "past" | "future") {
  const list = events.filter((e) => e.kind === kind);
  return list.length ? list.map((e) => `- ${e.id} (${e.hard ? "hard" : "soft"}${e.due ? `, by ${e.due}` : ""}): ${e.text}`).join("\n") : "(none)";
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
        // A forecast file written around Scenaria (e.g. by an agent) is shown as unverified and
        // never counts (it cannot suppress or replace a real forecast).
        x.verified = verifyRecord(s.store, ["forecast/v1", x.id, digest(x)], x.pub, x.sig);
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
  const { sig, pub, verified, actual, actualLine, used, ...content } = f;
  void sig, pub, verified, actual, actualLine, used;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function save(s: Scenaria, f: Omit<Forecast, "id">): Forecast {
  mkdirSync(dir(s), { recursive: true });
  const id = `f${listForecasts(s).reduce((m, x) => Math.max(m, parseInt(x.id.slice(1), 10) || 0), 0) + 1}`;
  const out = { id, ...f } as Forecast;
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

  const ups = upstreams(s);
  const models: Forecast["models"] = {};
  const warnings: string[] = [];
  const ask = async (role: "archivist" | "craftsman" | "oracle", user: string) => {
    const cfg = effectiveLlm(s, role, req.llm, { globalOnly: req.globalOnly });
    if (!cfg) throw new Error("No model configured — choose one in Settings.");
    const out = await callLlm(cfg, ups, PROMPTS[role](lang), user);
    models[role] = out.model;
    return json(out.text);
  };
  const cs = canonState(s.store);
  const active = cs.events.filter((e) => e.status === "active");
  const optionList = options.map((o) => `- key "${o.key}": ${o.label}${o.text ? ` — ${one(o.text, 500)}` : ""}`).join("\n");
  const question = subject.kind === "decision" ? `DECISION: ${subject.question}` : `PROMPT TO EVALUATE (what happens if an agent gets this on the current line?):`;
  const root = s.project();
  const goalLine = `MAIN GOAL: ${root?.goal ?? "(not set)"}`;

  // 1. Archivist — past only.
  const lc = lineContext(s, lineAt);
  const lessons = lc.lessons.slice(-12).map((l) => `- ${l.node}: ${l.text}`).join("\n") || "(none)";
  const a = await ask("archivist", `${question}\nOPTIONS:\n${optionList}\n\nPAST FIXED POINTS:\n${canonText(active, "past")}\n\nRULES:\n${s.rules().map((r) => `- ${r.id}: ${r.text}`).join("\n") || "(none)"}\n\nLESSONS:\n${lessons}\n\n--- DOSSIER ---\n${dossier(s, { maxTokens: 4000 }).text}`);
  // 2. Craftsman — present only (the current line, compact).
  // The present only: the capsule without future fixed points (those belong to the oracle).
  const capsule = lineAt ? s.context(lineAt, { budget: 900 }).markdown.split("\n").filter((l) => !/^- k\d+ \(future/.test(l)).join("\n") : "(no history yet)";
  const archNotes = (Array.isArray(a.options) ? a.options : []).map((x: any) => `- ${one(x?.key, 10)}: ${one(x?.past, 400)}`).join("\n");
  const c = await ask("craftsman", `${goalLine}\n${question}\nOPTIONS:\n${optionList}\n\nWHAT THE PAST SAYS (archivist):\n${archNotes || "(nothing)"}\n\nCURRENT LINE:\n${capsule}`);
  // 3. Oracle — future only.
  const craftNotes = (Array.isArray(c.options) ? c.options : []).map((x: any) => `- ${one(x?.key, 10)}: ${one(x?.present, 300)} | steps: ${strs(x?.trajectory, 3, 120).join(" → ")} | would drop: ${strs(x?.loses, 4, 120).join("; ") || "-"}`).join("\n");
  const o = await ask("oracle", `${goalLine}\n${question}\nOPTIONS:\n${optionList}\n\nFUTURE FIXED POINTS:\n${canonText(active, "future")}\nHARD PAST CONSTRAINTS:\n${active.filter((e) => e.kind === "past" && e.hard).map((e) => `- ${e.id}: ${e.text}`).join("\n") || "(none)"}\n\nARCHIVIST:\n${archNotes || "(nothing)"}\nCRAFTSMAN:\n${craftNotes || "(nothing)"}\n\nToday: ${new Date().toISOString().slice(0, 10)}`);

  const known = new Set(active.map((e) => e.id));
  const byKey = (arr: any, key: string) => (Array.isArray(arr) ? arr.find((x: any) => one(x?.key, 20) === key) : undefined);
  for (const opt of options) {
    const pa = byKey(a.options, opt.key);
    const pr = byKey(c.options, opt.key);
    const fu = byKey(o.options, opt.key);
    if (!fu) {
      warnings.push(`${opt.key}: ${lang === "de" ? "vom Orakel nicht bewertet" : "not assessed by the oracle"}`);
      continue;
    }
    const conf = Number(fu.confidence);
    opt.universe = {
      past: one(pa?.past, 600),
      present: one(pr?.present, 600),
      future: one(fu.future, 600),
      trajectory: strs(pr?.trajectory, 4, 200),
      loses: strs(pr?.loses, 5, 200),
      context: pct(fu.context),
      goal: pct(fu.goal),
      canonRisks: strs(fu.canonRisks, 6, 10).filter((k) => known.has(k)),
      risks: strs(fu.risks, 5, 240),
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      outcome: one(fu.outcome, 600),
    };
    // Blend: the model's view weighted by its confidence, the deterministic layer as anchor.
    const w = 0.4 + 0.4 * opt.universe.confidence;
    const model = opt.universe.context * 0.7 + opt.universe.goal * 0.3;
    let score = model * w + opt.quick.score * (1 - w);
    if (opt.universe.canonRisks.some((k) => active.find((e) => e.id === k)?.hard)) score = Math.min(score, 40);
    opt.score = clamp(score);
  }
  const rec = o.recommendation && options.some((x) => x.key === one(o.recommendation.key, 20)) ? { key: one(o.recommendation.key, 20), why: one(o.recommendation.why, 600) } : undefined;
  const best = [...options].sort((x, y) => y.score - x.score)[0];
  if (rec && best && rec.key !== best.key) warnings.push(lang === "de" ? `Das Orakel empfiehlt ${rec.key}, die Kontext-Prognose spricht für ${best.key}.` : `The oracle recommends ${rec.key}; the context forecast favours ${best.key}.`);
  return save(s, { subject, createdAt: new Date().toISOString(), mode: "multiverse", trigger: req.trigger ?? "person", models, options, recommended: rec ?? (best ? { key: best.key, why: lang === "de" ? "höchste Kontext-Prognose" : "highest context forecast" } : undefined), warnings });
}

// ------------------------------------------------------------------ evaluation

/** Compare forecasts with what really happened on the branches that were taken. */
export function evaluateForecasts(s: Scenaria): { forecasts: Forecast[]; calibration: { evaluated: number; meanError: number | null; hits: number } } {
  const fid = s.fidelity().points;
  const all = listForecasts(s);
  const errors: number[] = [];
  const nodes = s.store.listNodes();
  for (const f of all) {
    if (!f.verified) continue;
    if (f.subject.kind === "prompt") {
      // The line after the prompt forecast: first node created afterwards on a line through `at`.
      const at = f.subject.at;
      const after = nodes.filter((n) => n.createdAt >= f.createdAt && (!at || n.parentId === at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (after) {
        const m = measuredAfter(s, after.id, fid);
        if (m.nodes) {
          f.actualLine = m;
          const usedOpt = f.options.find((o) => o.key === f.used);
          if (usedOpt) {
            f.actual = [{ option: usedOpt.key, measured: m.measured, predicted: usedOpt.score, error: Math.abs(m.measured - usedOpt.score), nodes: m.nodes }];
            errors.push(f.actual[0].error);
          }
        }
      }
      continue;
    }
    if (!s.store.hasNode(f.subject.node)) continue;
    const d = s.node(f.subject.node);
    const kids = s.children(d.id);
    const actual: ForecastActual[] = [];
    for (const o of f.options) {
      // Only branches created after the forecast count (otherwise the forecast already saw them).
      const branch = kids.find((k) => (k.viaOption === o.key || (d.chosen === o.key && !k.viaOption)) && k.createdAt >= f.createdAt);
      if (!branch) continue;
      const m = measuredAfter(s, branch.id, fid);
      if (!m.nodes) continue;
      actual.push({ option: o.key, measured: m.measured, predicted: o.score, error: Math.abs(m.measured - o.score), nodes: m.nodes });
      errors.push(Math.abs(m.measured - o.score));
    }
    if (actual.length) f.actual = actual;
  }
  return {
    forecasts: all,
    calibration: { evaluated: errors.length, meanError: errors.length ? Math.round(errors.reduce((a, b) => a + b, 0) / errors.length) : null, hits: errors.filter((e) => e <= 15).length },
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
  writeJsonAtomic(join(dir(s), `${id}.json`), { ...raw, used: key });
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
