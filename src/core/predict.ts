/**
 * The forecast core (model v2): predict, before a choice, how well the line keeps its context — as the
 * SAME quantity that is measured afterwards, so every forecast can be checked against reality.
 *
 * Target (measured afterwards), per option o of a decision d:
 *   M(o) = mean context fidelity of the first H = 5 steps WITH CONTENT on the line that took o, within
 *          the same task (automatic saves without content are skipped — they only echo the step before;
 *          a new task is a new start and ends the measurement).
 *
 * Prediction (before the choice), from what was known at that moment only — on the line BEFORE the
 * choice, where the decision counts with its question only (its option list would make every option
 * look connected), all with exactly the fidelity formula of core/fidelity.ts:
 *     fidelity = 0.35·anchor + 0.35·continuity + 0.15·integrity + 0.15·reliability
 *   own  = fidelity of the option's OWN words (label + description): do they connect to the goals and
 *          the line? This is what tells options apart.
 *   ctx  = fidelity of the full next step "question + option": the level such a step usually reaches.
 *   L    = mean fidelity of the last H steps with content before the decision (lines tend to keep
 *          their level: "persistence", the naive forecast every forecast must beat)
 *   P(o) = L + α·(own − L) + β·(ctx − L) − risk
 *          α, β = learned from this project's own past decisions (least squares, 0 ≤ α, β, α + β ≤ 1,
 *                 shrunk towards α = β = 0.25 with the weight of 8 cases)
 *          risk = 6 points per earlier lesson the option resembles (max 18) + 6 per hard fixed point
 *                 with a date it touches (max 12)
 *   band = ±80th percentile of the leave-one-out errors of past cases (≥ 8 cases), otherwise ±20
 *          ("not calibrated yet")
 *   flag = the option's own words neither connect to the line nor to the goal (fidelity break rule):
 *          a warning to check (multiverse), not a verdict.
 *
 * Quality (honest): backtest of every past decision as of its own time (no knowledge of later
 * events: later lessons, approvals, checks, goal changes and the decision's own rationale are
 * removed), compared with the naive forecast "the line keeps its level" (L). A forecast is only
 * worth something if it beats that baseline (skill > 0).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenaria } from "./engine.js";
import type { ScenariaEvent, ScenariaNode } from "./types.js";
import { canonState, type CanonEvent } from "./canon.js";
import { nearestGoal } from "./context.js";
import { effectiveStatus } from "./verdict.js";
import { combine, epistemicOf, fidelityAll, isBreak, overlap, stems, stepComponents, type FidelityPoint } from "./fidelity.js";
import { nodeText } from "./recall.js";

export const MODEL_VERSION = 2;
export const HORIZON = 5;
export const DEFAULT_LAMBDA = 0.5;
const SHRINK = 8;
const DEFAULT_BAND = 20;
const MIN_CASES = 10;
/** A branch is evaluated once it has at least this many steps with content. */
export const MIN_STEPS = 2;
export const RISK = { lesson: 6, lessonMax: 18, canon: 6, canonMax: 12 };

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const one = (x: unknown, max = 160) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ------------------------------------------------------------------ a time-consistent view

export interface View {
  nodes: Map<string, ScenariaNode>;
  children: Map<string, ScenariaNode[]>;
  fid: Map<string, FidelityPoint>;
  mainGoal: string;
  lessons: { node: string; text: string; toks: Set<string> }[];
  canon: CanonEvent[];
  head: string | null;
  /** Set for a backtest view: the moment it reconstructs. */
  asOf?: string;
}

function childrenOf(nodes: ScenariaNode[]) {
  const kids = new Map<string, ScenariaNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const l of kids.values()) l.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return kids;
}

function lessonsOf(nodes: ScenariaNode[], known: (n: ScenariaNode, lesson: string) => boolean) {
  return nodes.flatMap((n) => [
    ...(n.lessons ?? []).filter((l) => known(n, l)).map((l) => ({ node: n.id, text: l })),
    ...(effectiveStatus(n.verification) === "failed" && known(n, "") ? [{ node: n.id, text: `${n.title}: ${n.verification?.notes ?? "failed verification"}` }] : []),
  ]).map((l) => ({ ...l, toks: stems(l.text) }));
}

/** The project as it is now. */
export function viewNow(s: Scenaria): View {
  const nodes = s.store.listNodes();
  const fid = new Map(Object.entries(s.fidelity().points)) as Map<string, FidelityPoint>;
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    children: childrenOf(nodes),
    fid,
    mainGoal: s.project()?.goal ?? "",
    lessons: lessonsOf(nodes, () => true),
    canon: canonState(s.store).events.filter((e) => e.status === "active"),
    head: s.store.readState().head,
  };
}

/** Everything the backtest needs about the project's history, read once. */
export interface History {
  events: ScenariaEvent[];
  nodes: ScenariaNode[];
  integrity: Map<string, any>;
  canon: CanonEvent[];
  rootId: string | null;
  rootGoal: string;
  goalHistory: { goal?: string; until?: string }[];
}

export function readHistory(s: Scenaria): History {
  const root = s.project();
  return {
    events: s.store.readEvents(),
    nodes: s.store.listNodes(),
    integrity: s.integrity().state,
    canon: canonState(s.store).events,
    rootId: root?.id ?? null,
    rootGoal: root?.goal ?? "",
    goalHistory: Array.isArray(root?.meta?.goalHistory) ? (root!.meta!.goalHistory as { goal?: string; until?: string }[]).filter((g) => g && typeof g === "object") : [],
  };
}

/**
 * Main goal at a moment. Unknown before the first "main goal set" → no goal; afterwards the goal history
 * (each entry: a goal and when it was replaced). If the history was truncated and t lies before its
 * oldest entry, the goal of that time is unknown → no goal (never a later one).
 */
export function goalAt(h: History, t: string): string {
  const firstSet = h.events.find((e) => e.type === "update" && e.nodeId === h.rootId && /main goal set/.test(String(e.data?.message ?? "")));
  if (firstSet && firstSet.ts > t) return "";
  const hist = h.goalHistory.filter((g) => typeof g.until === "string").sort((a, b) => a.until!.localeCompare(b.until!));
  const changes = h.events.filter((e) => e.type === "update" && e.nodeId === h.rootId && /main goal changed/.test(String(e.data?.message ?? ""))).length;
  if (hist.length < changes && hist.length && t < hist[0].until!) return ""; // truncated history: unknown
  for (const g of hist) if (g.until! > t) return g.goal ?? "";
  return h.rootGoal;
}

/** Fields of each node that were written AFTER t (they did not exist yet at t). */
function laterFields(h: History, t: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, fs: string[]) => out.set(id, new Set([...(out.get(id) ?? []), ...fs]));
  for (const e of h.events) {
    if (e.ts <= t || !e.nodeId) continue;
    if (e.type === "update" && Array.isArray(e.data?.fields)) add(e.nodeId, (e.data!.fields as unknown[]).map(String));
    else if (e.type === "choose") add(e.nodeId, ["chosen", "rationale"]);
    else if (e.type === "verify") add(e.nodeId, ["verification"]);
  }
  return out;
}

const STRIPPABLE = new Set(["title", "goal", "brief", "summary", "facts", "outputs", "openQuestions", "irreversible", "tags", "lessons", "status", "rationale", "context", "servesGoal", "expectedOutcome", "chosen", "verification"]);

/**
 * The project as it was at moment t (for the backtest): only nodes created until t; every field written
 * later (task summaries, edits, choices, check results, lessons) is removed; fixed points approved later
 * are left out; the main goal of that time. With `focus`, fidelity is computed for the path to that node
 * only (all a forecast needs — fidelity of a node depends on its own path only).
 */
export function viewAsOf(s: Scenaria, t: string, h: History = readHistory(s), focus?: string): View {
  const late = laterFields(h, t);
  const lessonKnown = new Map<string, { lesson: string; ts: string }[]>();
  for (const e of h.events) if (e.type === "rewind" && e.nodeId && typeof e.data?.lesson === "string" && e.data.lesson.trim()) lessonKnown.set(e.nodeId, [...(lessonKnown.get(e.nodeId) ?? []), { lesson: e.data.lesson.trim(), ts: e.ts }]);
  const knownLesson = (n: ScenariaNode, l: string) => {
    if (n.type === "branch") return true; // a fork's lesson exists from its creation (≤ t)
    return (lessonKnown.get(n.id) ?? []).some((x) => l.startsWith(x.lesson) && x.ts <= t);
  };
  const nodes = h.nodes
    .filter((n) => n.createdAt <= t)
    .map((n) => {
      const c: ScenariaNode = { ...n };
      // Exact: restore the values a field had at t from the node's field history (newest change first).
      const restored = new Set<string>();
      const hist = ((n.meta?.fieldHistory as { at?: string; before?: Record<string, unknown> }[] | undefined) ?? []).filter((x) => typeof x?.at === "string" && x.at > t && x.before && typeof x.before === "object");
      for (const hEntry of [...hist].sort((a, b) => b.at!.localeCompare(a.at!))) {
        for (const [f, val] of Object.entries(hEntry.before!)) {
          if (!STRIPPABLE.has(f) && f !== "factInfo") continue;
          (c as any)[f] = val === null ? (f === "title" ? "" : undefined) : val;
          restored.add(f);
        }
      }
      // Older projects without a field history: whatever was written after t is removed (conservative).
      for (const f of late.get(n.id) ?? []) {
        if (!STRIPPABLE.has(f) || restored.has(f)) continue;
        if (f === "title") c.title = "";
        else (c as any)[f] = undefined;
        if (f === "facts") c.factInfo = undefined;
      }
      if (c.verification && (!c.verification.at || c.verification.at > t)) c.verification = undefined;
      if (c.lessons?.length) c.lessons = c.lessons.filter((l) => knownLesson(c, l));
      return c;
    });
  // A decision without any step below it by then cannot have been decided (older projects without events).
  const hasKidBy = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId!));
  for (const n of nodes)
    if (n.type === "decision" && !hasKidBy.has(n.id)) {
      n.chosen = undefined;
      n.rationale = undefined;
    }
  const goal = goalAt(h, t);
  const withGoal = nodes.map((n) => (n.id === h.rootId ? { ...n, goal: goal || undefined } : n));
  const byId = new Map(withGoal.map((n) => [n.id, n]));
  let fidNodes = withGoal;
  if (focus && byId.has(focus)) {
    const path: ScenariaNode[] = [];
    let cur = byId.get(focus);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    fidNodes = path;
  }
  const goalChanges = h.goalHistory.map((g) => g.until).filter((x): x is string => typeof x === "string" && x <= t);
  const fid = fidelityAll(fidNodes, { integrity: h.integrity, goalChanges });
  // Fixed points in force at t, from the canon log: approved by t and not retired/rejected by t.
  const state = new Map<string, string>();
  for (const e of h.events) if (e.type === "canon" && e.ts <= t && typeof e.data?.id === "string" && typeof e.data?.status === "string") state.set(e.data.id, e.data.status);
  const canon = h.canon.filter((e) => state.get(e.id) === "active" || (!h.events.some((x) => x.type === "canon" && x.data?.id === e.id) && e.status === "active" && typeof e.decidedAt === "string" && e.decidedAt <= t));
  return {
    nodes: byId,
    children: childrenOf(withGoal),
    fid,
    mainGoal: goal,
    lessons: lessonsOf(withGoal, () => true),
    canon,
    head: null,
    asOf: t,
  };
}

function pathTo(v: View, id: string): ScenariaNode[] {
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

const hasContent = (p: FidelityPoint | undefined) => Boolean(p && !p.flags.includes("lowSignal"));

/** The line's level before a node: mean fidelity of the last H steps with content (root excluded). */
function lineLevel(v: View, path: ScenariaNode[]) {
  const pts = path
    .filter((n) => n.parentId)
    .map((n) => v.fid.get(n.id))
    .filter(hasContent)
    .slice(-HORIZON) as FidelityPoint[];
  return { level: pts.length ? mean(pts.map((p) => p.score)) : 75, n: pts.length };
}

// ------------------------------------------------------------------ the prediction

export interface StepParts {
  /** 0..1, anchor null without any goal. */
  anchor: number | null;
  continuity: number;
  /** Fidelity 0..100 of the hypothetical step (integrity 1, reliability of the line). */
  score: number;
}

export interface Explain {
  model: 2;
  /** The option's own words: do THEY connect to the goal and the line? (discriminates options) */
  own: StepParts;
  /** The full next step (question + option): its expected fidelity level. */
  inContext: StepParts;
  /** Mean reliability (checks, confidence) of the line's recent steps, 0..1. */
  reliability: number;
  /** s1 = μ·own + (1 − μ)·inContext — the predicted fidelity of the next step. */
  step: number;
  mu: number;
  /** The line's level before the decision (0..100) and how many steps it rests on. */
  line: number;
  lineN: number;
  /** P = λ·s1 + (1 − λ)·line − risk; λ and μ learned from this project's past cases (n). */
  lambda: number;
  alpha: number;
  beta: number;
  learnedFrom: number;
  /** Points taken off for risks. */
  risk: { lessons: number; canon: number };
  /** Final forecast 0..100 and its uncertainty band (± points). */
  predicted: number;
  band: number;
  bandN: number;
  calibrated: boolean;
  /** What "goal" means here: the main goal (+ task), only the task (no main goal yet) or nothing. */
  goalKind: "main" | "task" | "none";
  /** The option's own words would count as a context break / goal drift. */
  breakRisk: boolean;
  driftRisk: boolean;
  signal: "ok" | "low";
}

/** Linear form: P = L + α·(own − L) + β·(inContext − L) − risk  (λ = α + β, μ = α / (α + β)). */
export interface Calibration {
  alpha: number;
  beta: number;
  n: number;
  band: number;
  bandN: number;
  calibrated: boolean;
}

export const DEFAULT_ALPHA = DEFAULT_LAMBDA / 2;
export const DEFAULT_BETA = DEFAULT_LAMBDA / 2;
export const UNCALIBRATED: Calibration = { alpha: DEFAULT_ALPHA, beta: DEFAULT_BETA, n: 0, band: DEFAULT_BAND, bandN: 0, calibrated: false };

export interface StepPrediction {
  explain: Explain;
  warnings: string[];
  canonTouched: string[];
  canonHints: string[];
}

/**
 * Predict the line after a hypothetical next step placed under node `at` (a decision → one option;
 * a prompt → under HEAD). `own`: the option's own words; `full`: the whole next step (question + option).
 */
export function predictStep(v: View, at: string, own: string, full: string, cal: Calibration, opts: { refs?: string[] } = {}): StepPrediction {
  let path = pathTo(v, at);
  // Before the choice: the decision counts with its question only. Its list of options contains every
  // option and would make each of them look connected; its choice and rationale do not exist yet.
  path = path.map((n) => (n.id === at && n.type === "decision" ? { ...n, chosen: undefined, rationale: undefined, options: undefined } : n));
  const task = nearestGoal(path);
  const taskGoal = stems(task ? `${task.title} ${task.goal ?? ""}` : "");
  const window = new Set<string>([...taskGoal]);
  for (const n of path.slice(-6)) for (const t of stems(nodeText(n))) window.add(t);
  const parentPt = v.fid.get(at) ?? null;
  const recent = path.filter((n) => n.parentId).slice(-HORIZON);
  const reliability = recent.length ? mean(recent.map((n) => epistemicOf(n))) : 0.8;
  const parts = (text: string): StepParts & { signal: boolean } => {
    const c = stepComponents({
      toks: stems(text),
      type: "checkpoint",
      isRoot: false,
      automatic: false,
      mainGoal: stems(v.mainGoal),
      taskGoal,
      window,
      ancIds: new Set(path.map((n) => n.id)),
      refs: opts.refs ?? [],
      parent: parentPt ? { anchor: parentPt.anchor, continuity: parentPt.continuity } : null,
    });
    return { anchor: c.anchor === null ? null : Math.round(c.anchor * 100) / 100, continuity: Math.round(c.continuity * 100) / 100, score: combine(c.anchor, c.continuity, 1, reliability), signal: c.signal };
  };
  const ownP = parts(own);
  const fullP = parts(full);
  const { level, n: lineN } = lineLevel(v, path);

  // Risks on record: earlier lessons the option resembles, hard dated fixed points it touches.
  const toks = stems(own);
  const warnings = v.lessons
    .map((l) => ({ l, o: overlap(toks, l.toks) }))
    .filter((x) => x.o >= 0.22)
    .sort((a, b) => b.o - a.o)
    .slice(0, 3)
    .map((x) => `${x.l.node}: ${one(x.l.text)}`);
  const touched = v.canon.filter((e) => overlap(toks, stems(e.text)) >= 0.25);
  const atStake = touched.filter((e) => e.hard && (e.kind === "future" || e.due)).length;
  const risk = { lessons: Math.min(RISK.lessonMax, warnings.length * RISK.lesson), canon: Math.min(RISK.canonMax, atStake * RISK.canon) };

  const lambda = cal.alpha + cal.beta;
  const mu = lambda > 1e-9 ? cal.alpha / lambda : 0.5;
  const step = Math.round(mu * ownP.score + (1 - mu) * fullP.score);
  // Computed from exactly the rounded numbers that are shown, so the formula reproduces the result.
  const shown = { alpha: round2(cal.alpha), beta: round2(cal.beta), line: Math.round(level) };
  const predicted = predictLinear({ own: ownP.score, inContext: fullP.score, line: shown.line, risk: risk.lessons + risk.canon }, shown);
  const lowSignal = toks.size < 3 || !ownP.signal;
  const explain: Explain = {
    model: 2,
    own: { anchor: ownP.anchor, continuity: ownP.continuity, score: ownP.score },
    inContext: { anchor: fullP.anchor, continuity: fullP.continuity, score: fullP.score },
    reliability: Math.round(reliability * 100) / 100,
    step,
    mu: Math.round(mu * 100) / 100,
    line: Math.round(level),
    lineN,
    lambda: Math.round(lambda * 100) / 100,
    alpha: shown.alpha,
    beta: shown.beta,
    learnedFrom: cal.n,
    risk,
    predicted,
    band: cal.band,
    bandN: cal.bandN,
    calibrated: cal.calibrated,
    // Very short options ("yes/no") say too little: no break/drift claim from their words.
    goalKind: stems(v.mainGoal).size ? "main" : taskGoal.size ? "task" : "none",
    breakRisk: !lowSignal && isBreak(ownP.anchor, ownP.continuity, ownP.score, null),
    driftRisk: !lowSignal && ownP.anchor !== null && ownP.anchor < 0.25,
    signal: lowSignal ? "low" : "ok",
  };
  return {
    explain,
    warnings,
    canonTouched: touched.map((e) => e.id),
    canonHints: touched.map((e) => `${e.id}${e.hard ? " (hard" : " (soft"}${e.kind === "future" ? `, future${e.due ? `, by ${e.due}` : ""}` : ""}): ${one(e.text, 120)}`),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function predictLinear(x: { own: number; inContext: number; line: number; risk: number }, cal: Pick<Calibration, "alpha" | "beta">): number {
  return clamp(x.line + cal.alpha * (x.own - x.line) + cal.beta * (x.inContext - x.line) - x.risk);
}

/** The derivation in one line, with every number (CLI, agents, chat). */
export function explainText(e: Explain, lang: "de" | "en" = "en"): string {
  const de = lang === "de";
  const r = e.risk.lessons + e.risk.canon;
  const goalWord = e.goalKind === "task" ? (de ? "Teilziel" : "task goal") : de ? "Ziel" : "goal";
  const parts = (x: StepParts) => `${goalWord} ${x.anchor === null ? "–" : Math.round(x.anchor * 100) + "%"}, ${de ? "Anschluss" : "connection"} ${Math.round(x.continuity * 100)}%`;
  return [
    `P = L + α·(own − L) + β·(context − L) − risk = ${e.line} + ${e.alpha}·(${e.own.score} − ${e.line}) + ${e.beta}·(${e.inContext.score} − ${e.line}) − ${r} = ${e.predicted} ± ${e.band}${e.calibrated ? "" : de ? " (noch nicht kalibriert)" : " (not calibrated yet)"}`,
    `${de ? "eigene Worte" : "own words"} ${e.own.score} (${parts(e.own)}) · ${de ? "im Kontext" : "in context"} ${e.inContext.score} (${parts(e.inContext)}) · ${de ? "Linie" : "line"} L ${e.line} (${e.lineN} ${de ? "Schritte" : "steps"}) · ${de ? "Belastbarkeit" : "reliability"} ${Math.round(e.reliability * 100)}%`,
    `α, β ${de ? "gelernt aus" : "learned from"} ${e.learnedFrom} ${de ? "Entscheidungen" : "decisions"}${r ? ` · ${de ? "Risiko" : "risk"}: ${de ? "Lektionen" : "lessons"} −${e.risk.lessons}, ${de ? "Fixpunkte" : "fixed points"} −${e.risk.canon}` : ""}${e.breakRisk ? ` · ${de ? "⚠ eigene Worte ohne Bezug zum Kontext (prüfen)" : "⚠ own words without connection to the context (check)"}` : ""}`,
  ].join("\n");
}

/** One option of a decision: its own words, and the full next step "question + option". */
export function predictOption(v: View, d: ScenariaNode, o: { id: string; label: string; description?: string }, cal: Calibration): StepPrediction {
  const own = `${o.label} ${o.description ?? ""}`;
  return predictStep(v, d.id, own, `${d.question ?? d.title} ${own}`, cal);
}

/** A prompt under HEAD: own = full (references to the line, e.g. n12, count as connection). */
export function predictPrompt(v: View, at: string, text: string, cal: Calibration): StepPrediction {
  const refs = text.match(/\bn\d+\b/g) ?? [];
  return predictStep(v, at, text, text, cal, { refs });
}

// ------------------------------------------------------------------ the measurement

/** The line that continued after a node: towards HEAD if it lies there, else the largest sub-line. */
function continuation(v: View, start: string): string[] {
  const size = new Map<string, number>();
  const count = (id: string): number => {
    if (size.has(id)) return size.get(id)!;
    size.set(id, 1);
    const n = 1 + (v.children.get(id) ?? []).reduce((a, k) => a + count(k.id), 0);
    size.set(id, n);
    return n;
  };
  const onHead = new Set(v.head ? pathTo(v, v.head).map((n) => n.id) : []);
  const out: string[] = [];
  let cur: string | undefined = start;
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && out.length < 60) {
    seen.add(cur);
    out.push(cur);
    const kids: ScenariaNode[] = v.children.get(cur) ?? [];
    if (!kids.length) break;
    const next: ScenariaNode = kids.find((k) => onHead.has(k.id)) ?? [...kids].sort((a, b) => count(b.id) - count(a.id) || b.createdAt.localeCompare(a.createdAt))[0];
    // A new task is a new start: the consequence of a decision is measured within its task.
    if (next.type === "goal" || next.type === "mission") break;
    cur = next.id;
  }
  return out;
}

export interface Measured {
  measured: number;
  nodes: number;
  ids: string[];
  /** A context break or a goal drift happened on these steps. */
  broke: boolean;
}

/** M: mean fidelity of the first H steps with content on the line from `start` on. */
export function measureLine(v: View, start: string): Measured | null {
  const ids = continuation(v, start)
    .filter((id) => hasContent(v.fid.get(id)))
    .slice(0, HORIZON);
  if (!ids.length) return null;
  const pts = ids.map((id) => v.fid.get(id)!);
  return { measured: Math.round(mean(pts.map((p) => p.score))), nodes: ids.length, ids, broke: pts.some((p) => p.flags.includes("break") || p.flags.includes("drift")) };
}

/** The branch that took option o of decision d (explored with fork, or the chosen one). */
export function branchOf(v: View, d: ScenariaNode, optionId: string): ScenariaNode | undefined {
  const kids = v.children.get(d.id) ?? [];
  return kids.find((k) => k.viaOption === optionId) ?? (d.chosen === optionId ? kids.find((k) => !k.viaOption) : undefined);
}

// ------------------------------------------------------------------ backtest, calibration, quality

export interface Case {
  decision: string;
  question: string;
  option: string;
  label: string;
  at: string;
  own: number;
  inContext: number;
  line: number;
  risk: number;
  predictedBreak: boolean;
  actual: number;
  actualNodes: number;
  broke: boolean;
  signal: "ok" | "low";
}

/** Forecasts as of a decision's own time never change (later data is stripped): computed once. */
const pastCache = new Map<string, Map<string, { key: string; preds: Map<string, StepPrediction> }>>();

/** Every past decision, forecast as of its own time, compared with how its branches really went. */
export function backtestCases(s: Scenaria, hist?: History): { cases: Case[]; excluded: number } {
  const now = viewNow(s);
  let h = hist ?? null;
  const history = () => (h ??= readHistory(s));
  // Nodes created by a time (for the cache key): sorted once.
  const created = [...now.nodes.values()].map((n) => n.createdAt).sort();
  const countBy = (t: string) => {
    let lo = 0, hi = created.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (created[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const cases: Case[] = [];
  let excluded = 0;
  const cache = pastCache.get(s.root) ?? new Map();
  pastCache.set(s.root, cache);
  for (const d of [...now.nodes.values()].filter((n) => n.type === "decision" && (n.options?.length ?? 0) > 1)) {
    const measured = (d.options ?? [])
      .map((o) => {
        const b = branchOf(now, d, o.id);
        return { o, m: b ? measureLine(now, b.id) : null };
      })
      .filter((x) => x.m && x.m.nodes >= MIN_STEPS); // one step alone is too noisy to judge a forecast
    if (!measured.length) continue;
    // Tampered history (or work built on it) does not teach the model anything — left out, and counted.
    const path = pathTo(now, d.id).map((n) => n.id);
    const touched = [...path, ...measured.flatMap((x) => x.m!.ids)].some((id) => {
      const f = now.fid.get(id);
      return f && (f.integrity === "tampered" || f.integrity === "inherited");
    });
    if (touched) {
      excluded += measured.length;
      continue;
    }
    const key = `${d.createdAt}|${countBy(d.createdAt)}`;
    let hit = cache.get(d.id);
    if (!hit || hit.key !== key) {
      const past = viewAsOf(s, d.createdAt, history(), d.id);
      const pd = past.nodes.get(d.id);
      const preds = new Map<string, StepPrediction>();
      if (pd) for (const o of d.options ?? []) preds.set(o.id, predictOption(past, pd, o, UNCALIBRATED));
      hit = { key, preds };
      cache.set(d.id, hit);
    }
    for (const { o, m } of measured) {
      const p = hit.preds.get(o.id);
      if (!p) continue;
      cases.push({
        decision: d.id,
        question: one(d.question ?? d.title, 120),
        option: o.id,
        label: one(o.label, 80),
        at: d.createdAt,
        own: p.explain.own.score,
        inContext: p.explain.inContext.score,
        line: p.explain.line,
        risk: p.explain.risk.lessons + p.explain.risk.canon,
        predictedBreak: p.explain.breakRisk,
        actual: m!.measured,
        actualNodes: m!.nodes,
        broke: m!.broke,
        signal: p.explain.signal,
      });
    }
  }
  return { cases: cases.sort((a, b) => a.at.localeCompare(b.at)), excluded };
}

/**
 * α, β by least squares on the cases (P − L + risk = α·(own − L) + β·(inContext − L)), kept in the
 * valid range (α, β ≥ 0, α + β ≤ 1) and shrunk towards the defaults with the weight of SHRINK cases.
 */
export function fit(cases: Pick<Case, "own" | "inContext" | "line" | "risk" | "actual">[]): { alpha: number; beta: number } {
  const n = cases.length;
  if (!n) return { alpha: DEFAULT_ALPHA, beta: DEFAULT_BETA };
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (const c of cases) {
    const x = c.own - c.line;
    const y = c.inContext - c.line;
    const z = c.actual - c.line + c.risk;
    sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
  }
  const sse = (a: number, b: number) => a * a * sxx + 2 * a * b * sxy + b * b * syy - 2 * a * sxz - 2 * b * syz;
  // Exact optimum on the constrained set: interior solution, else the best point on the edges.
  const cands: { a: number; b: number }[] = [];
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) > 1e-9) cands.push({ a: (sxz * syy - syz * sxy) / det, b: (syz * sxx - sxz * sxy) / det });
  if (sxx > 1e-9) cands.push({ a: sxz / sxx, b: 0 });
  if (syy > 1e-9) cands.push({ a: 0, b: syz / syy });
  const dd = sxx - 2 * sxy + syy; // edge a + b = 1
  if (dd > 1e-9) {
    const a = (sxz - syz - sxy + syy) / dd;
    cands.push({ a, b: 1 - a });
  }
  cands.push({ a: 0, b: 0 }, { a: 1, b: 0 }, { a: 0, b: 1 }, { a: DEFAULT_ALPHA, b: DEFAULT_BETA });
  const ok = cands
    .map((c) => ({ a: Math.max(0, Math.min(1, c.a)), b: Math.max(0, Math.min(1, c.b)) }))
    .map((c) => (c.a + c.b > 1 ? { a: c.a / (c.a + c.b), b: c.b / (c.a + c.b) } : c));
  const best = ok.sort((p, q) => sse(p.a, p.b) - sse(q.a, q.b))[0];
  return { alpha: (n * best.a + SHRINK * DEFAULT_ALPHA) / (n + SHRINK), beta: (n * best.b + SHRINK * DEFAULT_BETA) / (n + SHRINK) };
}

function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export interface Quality {
  model: 2;
  cases: (Case & { predicted: number; error: number; baselineError: number; band: number })[];
  /** Decisions with at least one evaluated branch — the unit that counts. */
  decisions: number;
  /** Evaluated options (cases). */
  n: number;
  /** Cases left out because their history was tampered with (or built on tampered work). */
  excluded: number;
  enough: boolean;
  minDecisions: number;
  /** Mean absolute error of the forecast and of the naive "line keeps its level" forecast. */
  mae: number | null;
  maeBaseline: number | null;
  /** 1 − mae/maeBaseline: > 0 = better than the naive forecast. */
  skill: number | null;
  /** Mean signed error (forecast − reality): > 0 = too optimistic. */
  bias: number | null;
  /** Share of real outcomes inside a band that was learned WITHOUT that decision (honest, not by construction). */
  coverage: number | null;
  breaks: { actual: number; predicted: number; hits: number; precision: number | null; recall: number | null };
  ranking: { pairs: number; concordant: number; accuracy: number | null };
  calibration: Calibration;
}

const MIN_DECISIONS = 10;
const BAND_FROM = 8;

/**
 * Honest quality on this project. Leave-one-DECISION-out: for each decision, α, β and the band are
 * learned from the OTHER decisions only (options of the same decision share their line and context).
 */
export function forecastQuality(s: Scenaria, input?: { cases: Case[]; excluded: number }): Quality {
  const { cases, excluded } = input ?? backtestCases(s);
  const groups = [...new Set(cases.map((c) => c.decision))];
  const predOf = new Map<Case, number>();
  for (const g of groups) {
    const others = cases.filter((c) => c.decision !== g);
    const w = fit(others);
    const shown = { alpha: round2(w.alpha), beta: round2(w.beta) };
    for (const c of cases.filter((x) => x.decision === g)) predOf.set(c, predictLinear(c, shown));
  }
  const errOf = (c: Case) => Math.abs(predOf.get(c)! - c.actual);
  const evaluated = cases.map((c) => {
    // The band for this decision, from the leave-one-out errors of the other decisions only.
    const otherErrs = cases.filter((x) => x.decision !== c.decision).map(errOf);
    const otherDecisions = new Set(cases.filter((x) => x.decision !== c.decision).map((x) => x.decision)).size;
    const band = otherDecisions >= BAND_FROM ? Math.max(3, Math.round(quantile(otherErrs, 0.8))) : DEFAULT_BAND;
    const predicted = predOf.get(c)!;
    return { ...c, predicted, error: Math.abs(predicted - c.actual), baselineError: Math.abs(c.line - c.actual), band };
  });
  const n = evaluated.length;
  const decisions = groups.length;
  const mae = n ? mean(evaluated.map((c) => c.error)) : null;
  const maeBaseline = n ? mean(evaluated.map((c) => c.baselineError)) : null;
  const all = fit(cases);
  const bandAll = decisions >= BAND_FROM ? Math.max(3, Math.round(quantile(evaluated.map((c) => c.error), 0.8))) : DEFAULT_BAND;
  const calibration: Calibration = { alpha: round2(all.alpha), beta: round2(all.beta), n: decisions, band: bandAll, bandN: decisions >= BAND_FROM ? decisions : 0, calibrated: decisions >= BAND_FROM };
  const actualBreaks = evaluated.filter((c) => c.broke).length;
  const predictedBreaks = evaluated.filter((c) => c.predictedBreak).length;
  const hits = evaluated.filter((c) => c.broke && c.predictedBreak).length;
  let pairs = 0;
  let concordant = 0;
  for (const g of groups) {
    const list = evaluated.filter((c) => c.decision === g);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const da = list[i].actual - list[j].actual;
        if (Math.abs(da) < 3) continue;
        pairs++;
        if (Math.sign(list[i].predicted - list[j].predicted) === Math.sign(da)) concordant++;
      }
  }
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    model: 2,
    cases: evaluated,
    decisions,
    n,
    excluded,
    enough: decisions >= MIN_DECISIONS,
    minDecisions: MIN_DECISIONS,
    mae: r1(mae),
    maeBaseline: r1(maeBaseline),
    skill: mae !== null && maeBaseline ? Math.round((1 - mae / maeBaseline) * 100) / 100 : null,
    bias: n ? r1(mean(evaluated.map((c) => c.predicted - c.actual))) : null,
    coverage: n ? Math.round((evaluated.filter((c) => c.error <= c.band).length / n) * 100) / 100 : null,
    breaks: { actual: actualBreaks, predicted: predictedBreaks, hits, precision: predictedBreaks ? Math.round((hits / predictedBreaks) * 100) / 100 : null, recall: actualBreaks ? Math.round((hits / actualBreaks) * 100) / 100 : null },
    ranking: { pairs, concordant, accuracy: pairs ? Math.round((concordant / pairs) * 100) / 100 : null },
    calibration,
  };
}

/** Calibration for live forecasts, cached per project version (cheap, deterministic, never stored). */
const calCache = new Map<string, { v: string; cal: Calibration }>();
export function calibrationFor(s: Scenaria): Calibration {
  const key = s.root;
  const v = String(s.store.version());
  const hit = calCache.get(key);
  if (hit && hit.v === v) return hit.cal;
  // Small projects (and every later call — decisions are cached): compute now. A large project's first
  // backtest in a fresh process runs in the background; meanwhile the defaults are used (shown as such).
  if (!hit && s.store.listNodes().length > COLD_LIMIT) {
    calCache.set(key, { v, cal: UNCALIBRATED });
    setImmediate(() => {
      try {
        calCache.set(key, { v, cal: forecastQuality(s).calibration });
      } catch {
        /* keep the defaults */
      }
    });
    return UNCALIBRATED;
  }
  let cal = UNCALIBRATED;
  try {
    cal = forecastQuality(s).calibration;
  } catch {
    /* never block a forecast */
  }
  calCache.set(key, { v, cal });
  return cal;
}
const COLD_LIMIT = 800;

// ------------------------------------------------------------------ the test bench (synthetic)

interface BenchScenario {
  id: string;
  /** clear: one option stays on the goal, the other drifts away · neutral: both stay on track (no false
   *  alarm allowed) · limit: a known limit of word-based forecasting (reported, not required). */
  kind?: "clear" | "neutral" | "limit";
  lang: "de" | "en";
  goal: string;
  steps: string[];
  question: string;
  on: { label: string; description: string; follow: string[] };
  off: { label: string; description: string; follow: string[] };
  /** A known limit of word-based forecasting (synonyms, other language): reported, not required. */
  limit?: string;
}

const BENCH: BenchScenario[] = [
  { id: "quests", lang: "en", goal: "Gamer app that brings players back every day with daily quests and streaks", steps: ["Daily quest backend: quest table and streak counter", "Streak counter resets at midnight for daily quests"], question: "What next for the daily quests?", on: { label: "Streak reminder push", description: "push notification before a daily quest streak resets", follow: ["Streak reminder push for daily quests", "Daily quest streak reminder opt-out setting", "Players return daily: streak reminder metrics"] }, off: { label: "NFT marketplace", description: "sell skins as blockchain tokens with a wallet", follow: ["Wallet SDK integration", "Smart contract for token minting", "Marketplace listing page for skins"] } },
  { id: "portal", lang: "de", goal: "Kundenportal mit Self-Service für Rechnungen und Login per Magic Link", steps: ["Login mit Magic Link für das Kundenportal", "Rechnungsliste im Kundenportal mit Filter"], question: "Was kommt als Nächstes im Kundenportal?", on: { label: "Rechnungen als PDF", description: "Rechnungen im Kundenportal als PDF herunterladen", follow: ["PDF-Export der Rechnungen im Kundenportal", "Rechnungsdownload mit Magic-Link-Login geschützt", "Self-Service: Rechnungsadresse im Portal ändern"] }, off: { label: "Chatbot für Marketing", description: "Social-Media-Kampagne mit Gewinnspiel", follow: ["Gewinnspiel-Landingpage", "Instagram-Kampagne planen", "Influencer-Kooperation anfragen"] } },
  { id: "api", lang: "en", goal: "Public REST API for invoices with authentication and rate limiting", steps: ["Invoice REST API: list and get endpoints", "API key authentication for the invoice API"], question: "Next step for the invoice API?", on: { label: "Rate limiting", description: "per API key rate limiting for the invoice REST API", follow: ["Rate limiting middleware per API key", "Invoice API returns 429 with retry header", "Rate limit docs for the invoice REST API"] }, off: { label: "Dark mode", description: "dark theme for the marketing website", follow: ["Dark theme colour tokens", "Website header in dark mode", "Toggle for dark mode in footer"] } },
  { id: "shop", lang: "de", goal: "Onlineshop für Kaffee mit Abo-Lieferung und Bezahlung per Rechnung", steps: ["Produktkatalog Kaffee mit Röstgrad", "Warenkorb und Checkout für Kaffee"], question: "Wie geht es im Shop weiter?", on: { label: "Kaffee-Abo", description: "Abo-Lieferung für Kaffee im Checkout wählbar", follow: ["Abo-Lieferung: Intervall im Checkout", "Kaffee-Abo pausieren und kündigen", "Bezahlung per Rechnung für Abo-Kunden"] }, off: { label: "Podcast", description: "eigenen Firmen-Podcast mit Interviews starten", follow: ["Podcast-Equipment kaufen", "Interviewgäste einladen", "Podcast-Hosting einrichten"] } },
  { id: "ml", lang: "en", goal: "Churn prediction model for subscription customers with weekly retraining", steps: ["Feature table for subscription churn prediction", "Baseline churn model with logistic regression"], question: "Next for the churn model?", on: { label: "Weekly retraining", description: "scheduled weekly retraining of the churn prediction model", follow: ["Weekly retraining job for the churn model", "Churn model metrics after retraining", "Alert when churn prediction quality drops"] }, off: { label: "Office party", description: "plan the summer office party and catering", follow: ["Book catering for party", "Send party invitations", "Choose music playlist"] } },
  { id: "kurs", lang: "de", goal: "Online-Kurs Prozessautomatisierung mit 16 Modulen, Quiz und Zertifikat", steps: ["Modulplan Prozessautomatisierung mit 16 Modulen", "Modul 1 Prozessautomatisierung: Grundlagen und Quiz"], question: "Wie geht es mit dem Kurs weiter?", on: { label: "Zertifikat", description: "Zertifikat nach bestandenem Quiz aller Module", follow: ["Zertifikatsvorlage für den Kurs Prozessautomatisierung", "Quiz-Auswertung je Modul für das Zertifikat", "Modul 2 Prozessautomatisierung mit Quiz"] }, off: { label: "Firmenwagen", description: "Leasingangebote für einen Firmenwagen vergleichen", follow: ["Leasingangebote einholen", "Probefahrt vereinbaren", "Versicherung für den Wagen"] } },
  { id: "game", lang: "en", goal: "Co-op open world game with crafting and base building", steps: ["Crafting system with recipes for the co-op game", "Base building placement grid"], question: "What next for the game?", on: { label: "Co-op crafting", description: "shared crafting stations in co-op bases", follow: ["Shared crafting station for co-op players", "Base building upgrades unlock crafting recipes", "Co-op sync for base building"] }, off: { label: "Tax return", description: "prepare the yearly tax return documents", follow: ["Collect receipts for tax", "Fill in tax forms", "Send tax documents to accountant"] } },
  { id: "infra", lang: "de", goal: "Selbst gehostete Infrastruktur mit Docker, Backups und Monitoring", steps: ["Docker-Compose für alle Dienste", "Nächtliche Backups der Datenbank"], question: "Was als Nächstes an der Infrastruktur?", on: { label: "Monitoring", description: "Monitoring der Docker-Dienste und Backups mit Alarmen", follow: ["Monitoring für Docker-Dienste einrichten", "Alarm bei fehlgeschlagenem Backup", "Dashboard für Monitoring und Backups"] }, off: { label: "Urlaub", description: "Sommerurlaub in Spanien buchen", follow: ["Flüge nach Spanien vergleichen", "Hotel am Strand buchen", "Mietwagen reservieren"] } },
  // Neutral: two technical options, both lines stay on track — no option may be flagged.
  { id: "storage", kind: "neutral", lang: "de", goal: "Gamer-App mit täglichen Quests und Streak-Zählern", steps: ["Quest-Tabelle und Streak-Zähler angelegt", "Streak-Zähler wird um Mitternacht zurückgesetzt"], question: "Wo speichern wir die Streak-Zähler?", on: { label: "Postgres-Tabelle", description: "Zähler in der Quest-Tabelle mit Index", follow: ["Streak-Zähler in Postgres mit Index", "Migration für Streak-Zähler in der Quest-Tabelle", "Test: Streak-Zähler Reset um Mitternacht"] }, off: { label: "Redis-Cache", description: "Zähler im Redis mit täglichem Ablauf", follow: ["Streak-Zähler in Redis mit Ablauf um Mitternacht", "Redis-Persistenz für Streak-Zähler aktiviert", "Test: Streak-Zähler übersteht Neustart"] } },
  { id: "auth", kind: "neutral", lang: "en", goal: "Customer portal with self-service invoices and secure login", steps: ["Customer portal login page", "Invoice list in the customer portal"], question: "How do customers log in?", on: { label: "Magic link", description: "email login link valid for 15 minutes", follow: ["Magic link email for portal login", "Magic link expiry after 15 minutes", "Login audit log for the customer portal"] }, off: { label: "Passkeys", description: "WebAuthn passkeys with email fallback", follow: ["Passkey registration in the customer portal", "Passkey login with email fallback", "Login audit log for passkeys"] } },
  { id: "export", kind: "neutral", lang: "de", goal: "Reporting-Tool für Vertriebszahlen mit Export", steps: ["Vertriebszahlen pro Monat als Tabelle", "Filter nach Region im Reporting"], question: "Welches Exportformat zuerst?", on: { label: "CSV", description: "CSV-Export der gefilterten Vertriebszahlen", follow: ["CSV-Export der Vertriebszahlen", "Export übernimmt Regionsfilter", "Test: Export mit Umlauten"] }, off: { label: "Excel", description: "XLSX-Export mit Formatierung", follow: ["XLSX-Export der Vertriebszahlen", "Export übernimmt Regionsfilter", "Test: Excel-Export mit Zahlenformat"] } },
  // Known limits: same meaning in other words / another language.
  { id: "synonym", lang: "en", goal: "Reduce customer churn for the subscription service", steps: ["Churn analysis by cohort", "Exit survey for cancelled subscriptions"], question: "Next?", on: { label: "Win-back offer", description: "discount for people who cancelled", follow: ["Discount email for people who cancelled", "Measure how many come back", "Offer pause instead of cancel"] }, off: { label: "Logo redesign", description: "new logo and colours", follow: ["Logo sketches", "Colour palette", "Brand guide"] }, kind: "limit", limit: "same meaning in other words" },
  { id: "language", lang: "de", goal: "Mobile app for hikers with offline maps", steps: ["Offline maps download for hikers", "Trail list with difficulty"], question: "Wie weiter?", on: { label: "Karten offline", description: "Wanderkarten ohne Netz speichern", follow: ["Kartenkacheln ohne Netz speichern", "Wanderwege offline anzeigen", "Speicherplatz für Karten verwalten"] }, off: { label: "Newsletter", description: "Newsletter-Anmeldung auf der Website", follow: ["Newsletter-Formular", "Double-Opt-in Mail", "Erster Newsletter"] }, kind: "limit", limit: "goal in English, work in German" },
];

export interface BenchResult {
  id: string;
  kind: "clear" | "neutral" | "limit";
  lang: string;
  limit?: string;
  predicted: { on: number; off: number };
  measured: { on: number; off: number };
  band: number;
  /** clear: the on-goal option is ranked higher, as in reality · neutral: no option flagged and both
   *  forecasts within the band. */
  passed: boolean;
  /** clear: the drifting option was flagged as a risk before the choice. */
  flaggedOff: boolean;
  /** neutral: an option was flagged although its line stayed on track. */
  falseAlarm: boolean;
  errors: number[];
}

export interface BenchSummary {
  results: BenchResult[];
  clear: { n: number; ranking: number; flagged: number };
  neutral: { n: number; passed: number; falseAlarms: number };
  mae: number;
  limits: BenchResult[];
}

/** Synthetic test bench: clear cases with a known outcome, in throw-away projects (nothing else is touched). */
export async function benchmark(cal: Calibration = UNCALIBRATED): Promise<BenchSummary> {
  const { Scenaria } = await import("./engine.js");
  const results: BenchResult[] = [];
  for (const sc of BENCH) {
    const dir = mkdtempSync(join(tmpdir(), "scenaria-bench-"));
    try {
      writeFileSync(join(dir, "README.md"), sc.goal);
      const s = Scenaria.init(dir, { projectName: `bench-${sc.id}` });
      s.startMission({ projectGoal: sc.goal, title: sc.steps[0], goal: sc.goal });
      for (const st of sc.steps) s.checkpoint({ title: st });
      const d = s.decide({ question: sc.question, options: [{ label: sc.on.label, description: sc.on.description }, { label: sc.off.label, description: sc.off.description }] });
      const pre = viewNow(s);
      const dd0 = pre.nodes.get(d.id)!;
      const pOn = predictOption(pre, dd0, dd0.options![0], cal).explain;
      const pOff = predictOption(pre, dd0, dd0.options![1], cal).explain;
      // Reality: both options really taken, each line continues in its own way.
      s.choose(d.id, d.options![0].id, "bench");
      for (const f of sc.on.follow) s.checkpoint({ title: f });
      s.fork(d.id, d.options![1].id, { restoreFiles: false });
      for (const f of sc.off.follow) s.checkpoint({ title: f });
      const post = viewNow(s);
      const dd = post.nodes.get(d.id)!;
      const mOn = measureLine(post, branchOf(post, dd, dd.options![0].id)!.id)!;
      const mOff = measureLine(post, branchOf(post, dd, dd.options![1].id)!.id)!;
      const kind = sc.kind ?? "clear";
      const errors = [Math.abs(pOn.predicted - mOn.measured), Math.abs(pOff.predicted - mOff.measured)];
      const falseAlarm = kind === "neutral" && (pOn.breakRisk || pOff.breakRisk);
      results.push({
        id: sc.id,
        kind,
        lang: sc.lang,
        limit: sc.limit,
        predicted: { on: pOn.predicted, off: pOff.predicted },
        measured: { on: mOn.measured, off: mOff.measured },
        band: cal.band,
        passed: kind === "neutral" ? !falseAlarm && errors.every((e) => e <= cal.band) : pOn.predicted > pOff.predicted && mOn.measured > mOff.measured,
        flaggedOff: kind === "clear" && pOff.breakRisk,
        falseAlarm,
        errors,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const clear = results.filter((r) => r.kind === "clear");
  const neutral = results.filter((r) => r.kind === "neutral");
  return {
    results,
    clear: { n: clear.length, ranking: clear.filter((r) => r.passed).length, flagged: clear.filter((r) => r.flaggedOff).length },
    neutral: { n: neutral.length, passed: neutral.filter((r) => r.passed).length, falseAlarms: neutral.filter((r) => r.falseAlarm).length },
    mae: Math.round(mean([...clear, ...neutral].flatMap((r) => r.errors)) * 10) / 10,
    limits: results.filter((r) => r.kind === "limit"),
  };
}

/** The test bench in a worker thread (the server stays responsive while it runs). */
export function benchmarkInWorker(cal: Calibration = UNCALIBRATED, timeoutMs = 120_000): Promise<BenchSummary> {
  return import("node:worker_threads").then(
    ({ Worker }) =>
      new Promise<BenchSummary>((resolve, reject) => {
        const w = new Worker(new URL("./bench-worker.js", import.meta.url), { workerData: { cal } });
        const timer = setTimeout(() => {
          void w.terminate();
          reject(new Error("test bench timed out"));
        }, timeoutMs);
        w.once("message", (m: { ok: boolean; r?: BenchSummary; error?: string }) => {
          clearTimeout(timer);
          void w.terminate();
          if (m.ok && m.r) resolve(m.r);
          else reject(new Error(m.error ?? "test bench failed"));
        });
        w.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }),
  );
}
