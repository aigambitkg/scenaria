/**
 * Context fidelity: how well is a node still "in context" — measured along its path.
 *
 * Deterministic and offline (no LLM, no tokens). Per node, four signals:
 *   anchor     — "Luftlinie" to the goal: overlap with the main goal + the current task goal,
 *                or an explicit `servesGoal` (the agent stated the link).
 *   continuity — does the node connect to what came before on its path (recent steps, task goal),
 *                or to explicit references (`basedOn`)? A sharp drop = context broke off.
 *   integrity  — does the node still match what Scenaria wrote (ledger)? Edited outside → manipulated.
 *   epistemic  — how reliable: verification verdict, stated confidence, rationale present.
 * Events on the line: main goal changed, branch/rewind, low signal (too little text to judge).
 *
 * Lexical overlap is a heuristic: it catches drift and breaks well within one language;
 * a decision written in another language than the goal should state `servesGoal`.
 */
import type { ScenariaNode } from "./types.js";
import type { IntegrityState } from "./ledger.js";
import { nodeText, tokenize } from "./recall.js";
import { effectiveStatus } from "./verdict.js";
import { compact, derive, fidelityCombine, FIDELITY_WEIGHTS, type CompactDerivation } from "./derivation.js";

export type FidelityFlag = "break" | "drift" | "goalChanged" | "branch" | "tampered" | "builtOnTampered" | "lowSignal" | "noGoal" | "task" | "failed" | "canonBroken" | "canonRespected";

export interface FidelityPoint {
  id: string;
  type: string;
  title: string;
  /** 0..100 */
  score: number;
  /** 0..1 or null when no goal exists */
  anchor: number | null;
  continuity: number;
  integrity: IntegrityState | "inherited";
  epistemic: number;
  flags: FidelityFlag[];
  /** How the score was computed (E1), in the short form (`expand()` adds texts): `score` is its value. */
  why: CompactDerivation;
}

const W = FIDELITY_WEIGHTS;

/** Word stems: compounds split at - _ . / ("Launch-Marketing" → launch, market), 6-char prefix (Spiele ~ Spiel). */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    for (const part of [t, ...t.split(/[-_./]+/)]) if (part.length > 2 && !/^\d+$/.test(part)) out.add(part.slice(0, 6));
  }
  return out;
}

/** Ochiai overlap of two token sets (0..1). */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.sqrt(a.size * b.size);
}

const norm = (x: number, full: number) => Math.max(0, Math.min(1, x / full));

function epistemicOf(n: ScenariaNode, confirmed?: Set<string>): number {
  // Only a pass from the person or a registered audit agent raises reliability; a self-report never does (rule 11).
  // With `confirmed` (from the engine's integrity check) a pass also has to be authentic.
  let v = effectiveStatus(n.verification);
  if (v === "passed" && confirmed && !confirmed.has(n.id)) v = "unverified";
  if (v === "passed") return 1;
  if (v === "warning") return 0.6;
  if (v === "failed") return 0.15;
  if (n.type === "decision") return Math.max(0, Math.min(1, (n.confidence ?? 0.7) - (n.chosen && !n.rationale ? 0.2 : 0)));
  const conf = (n.factInfo ?? []).map((f) => f?.confidence).filter((c): c is number => typeof c === "number");
  return conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0.8;
}

export interface StepInput {
  toks: Set<string>;
  type: string;
  isRoot: boolean;
  automatic: boolean;
  mainGoal: Set<string>;
  taskGoal: Set<string>;
  /** Stems of the last 6 steps on the path + the task goal. */
  window: Set<string>;
  ancIds: Set<string>;
  servesGoal?: boolean;
  respectsCanon?: boolean;
  /** Explicit references (basedOn) — a reference to the path keeps continuity. */
  refs: string[];
  parent: { anchor: number | null; continuity: number } | null;
}

/**
 * The content part of one step's fidelity: anchor (closeness to the goals) and continuity (connection to
 * the path). Shared by the measurement (fidelityAll) and the forecast (core/predict.ts), so a prediction
 * and the later measurement are the same quantity.
 */
export function stepComponents(i: StepInput): { anchor: number | null; continuity: number; signal: boolean; lowSignal: boolean; task: boolean } {
  const hasGoal = i.mainGoal.size > 0;
  const signal = i.toks.size >= 4 && !i.automatic;
  if (i.isRoot) return { anchor: 1, continuity: 1, signal, lowSignal: false, task: false };
  if (i.type === "goal") {
    // A task is a legitimate new start; what matters is how close it is to the main goal.
    return { anchor: hasGoal ? norm(overlap(i.toks, i.mainGoal), 0.2) : null, continuity: 1, signal, lowSignal: false, task: true };
  }
  if (!signal && i.parent) {
    // Too little text to judge (e.g. "Auto-save: a.ts"): carry the line on, slightly decayed.
    const anchor = i.parent.anchor === null || (!hasGoal && !i.taskGoal.size) ? null : i.parent.anchor * 0.98;
    return { anchor, continuity: i.parent.continuity * 0.98, signal, lowSignal: true, task: false };
  }
  const goalSet = new Set([...i.mainGoal, ...i.taskGoal]);
  let anchor = hasGoal || i.taskGoal.size ? norm(overlap(i.toks, goalSet), 0.18) : null;
  if (i.servesGoal) anchor = Math.max(anchor ?? 0, 0.8);
  // Checked against the project's fixed points: anchored even when the wording differs.
  if (i.respectsCanon) anchor = Math.max(anchor ?? 0, 0.7);
  let continuity = norm(overlap(i.toks, i.window), 0.15);
  if (i.refs.some((r) => i.ancIds.has(r.split(".")[0]))) continuity = Math.max(continuity, 0.95);
  return { anchor, continuity, signal, lowSignal: false, task: false };
}

/** The weighted fidelity score 0..100 (without a goal the anchor weight is spread over the rest). */
export function combine(anchor: number | null, continuity: number, integScore: number, epistemic: number): number {
  return fidelityCombine(anchor, continuity, integScore, epistemic);
}
export { FIDELITY_WEIGHTS };

/** The break rule (shared): neither connected to the path nor to the goal, or a sharp fall. */
export function isBreak(anchor: number | null, continuity: number, score: number, parentScore: number | null): boolean {
  return (continuity < 0.12 && (anchor ?? 0) < 0.4) || (parentScore !== null && parentScore - score >= 30);
}
export function isDrift(anchor: number | null, type: string): boolean {
  return anchor !== null && ((type === "decision" && anchor < 0.25) || (type === "goal" && anchor < 0.2));
}
export { epistemicOf };

/**
 * What a decision contributes to the context of the line below it: its question, the option THIS line
 * took and the rationale — not the alternatives that were not taken (they are not this line's context).
 */
export function decisionContext(d: ScenariaNode, child: ScenariaNode): Set<string> {
  const via = child.viaOption ?? d.chosen;
  const opt = (d.options ?? []).find((o) => o.id === via);
  return stems(nodeText({ ...d, options: opt ? [opt] : [] }));
}

/** Fidelity of every node, computed in one pass over the tree (each node only sees its own path). */
export function fidelityAll(nodes: ScenariaNode[], opts: { integrity?: Map<string, IntegrityState>; goalChanges?: string[]; confirmed?: Set<string> } = {}): Map<string, FidelityPoint> {
  const out = new Map<string, FidelityPoint>();
  const kids = new Map<string, ScenariaNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const l of kids.values()) l.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const ids = new Set(nodes.map((n) => n.id));
  const roots = nodes.filter((n) => !n.parentId || !ids.has(n.parentId));
  const goalChanges = (opts.goalChanges ?? []).slice().sort();

  type Frame = { n: ScenariaNode; anc: { n: ScenariaNode; toks: Set<string> }[]; mainGoal: Set<string>; taskGoal: Set<string>; parent: FidelityPoint | null; tampered: boolean };
  const stack: Frame[] = roots.map((r) => ({ n: r, anc: [], mainGoal: stems(r.goal ?? ""), taskGoal: new Set(), parent: null, tampered: false }));
  const guard = new Set<string>();
  while (stack.length) {
    const f = stack.pop()!;
    const n = f.n;
    if (guard.has(n.id)) continue;
    guard.add(n.id);
    const toks = stems(nodeText(n));
    const flags: FidelityFlag[] = [];
    const integ = opts.integrity?.get(n.id) ?? "unsealed";
    const integrity: FidelityPoint["integrity"] = integ === "tampered" ? "tampered" : f.tampered ? "inherited" : integ;
    if (integrity === "tampered") flags.push("tampered");
    if (integrity === "inherited") flags.push("builtOnTampered");
    const hasGoal = f.mainGoal.size > 0;
    // Automatic saves (watcher, autosave) carry file names, not meaning: they never count as a break.
    const automatic = n.type === "autosave" || n.source === "watch" || /^auto-save/i.test(n.title);
    const window = new Set<string>([...f.taskGoal]);
    for (const a of f.anc.slice(-6)) for (const t of a.toks) window.add(t);
    const c = stepComponents({
      toks,
      type: n.type,
      isRoot: !n.parentId || n.type === "mission",
      automatic,
      mainGoal: f.mainGoal,
      taskGoal: f.taskGoal,
      window,
      ancIds: new Set(f.anc.map((a) => a.n.id)),
      servesGoal: Boolean(n.servesGoal),
      respectsCanon: Boolean(n.respectsCanon?.length),
      refs: [...(n.basedOn ?? []), ...(n.factInfo ?? []).flatMap((x) => x?.basedOn ?? [])],
      parent: f.parent,
    });
    const anchor = c.anchor;
    const continuity = c.continuity;
    const signal = c.signal;
    if (c.task) flags.push("task");
    if (c.lowSignal) flags.push("lowSignal");
    if (!hasGoal && n.parentId) flags.push("noGoal");
    if (n.forkedFrom) flags.push("branch");
    if (effectiveStatus(n.verification) === "failed") flags.push("failed");
    if (f.parent && n.parentId) {
      const from = f.anc[f.anc.length - 1]?.n.createdAt ?? "";
      if (goalChanges.some((t) => t > from && t <= n.createdAt)) flags.push("goalChanged");
    }
    const epistemic = epistemicOf(n, opts.confirmed);
    const integScore = integrity === "tampered" ? 0 : integrity === "inherited" ? 0.5 : 1;
    if (n.breaksCanon?.length) flags.push("canonBroken");
    else if (n.respectsCanon?.length) flags.push("canonRespected");
    // The score IS the derivation's value (E1): one formula, the exact inputs kept for recomputing.
    const why = derive("fidelity.score", "fidelity/1", {
      anchor,
      continuity,
      integrity: integScore,
      epistemic,
      tampered: integrity === "tampered",
      canonBroken: Boolean(n.breaksCanon?.length),
      root: !n.parentId,
    });
    const score = why.value;
    const whyShort = compact(why);
    // A break: the step neither connects to its path nor to the goal, or fidelity falls sharply.
    if (n.type !== "goal" && n.parentId && signal && isBreak(anchor, continuity, score, f.parent ? f.parent.score : null)) flags.push("break");
    if (isDrift(anchor, n.type)) flags.push("drift");
    const point: FidelityPoint = { id: n.id, type: n.type, title: n.type === "decision" ? n.question ?? n.title : n.title, score, anchor: anchor === null ? null : Math.round(anchor * 100) / 100, continuity: Math.round(continuity * 100) / 100, integrity, epistemic: Math.round(epistemic * 100) / 100, flags, why: whyShort };
    out.set(n.id, point);
    const nextTask = n.type === "goal" ? stems(`${n.title} ${n.goal ?? ""}`) : f.taskGoal;
    const nextMain = n.type === "mission" ? stems(n.goal ?? "") : f.mainGoal;
    for (const k of [...(kids.get(n.id) ?? [])].reverse()) {
      stack.push({ n: k, anc: [...f.anc.slice(-8), { n, toks: n.type === "decision" ? decisionContext(n, k) : toks }], mainGoal: nextMain, taskGoal: nextTask, parent: point, tampered: f.tampered || integrity === "tampered" });
    }
  }
  return out;
}
