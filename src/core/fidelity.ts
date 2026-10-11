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

export type FidelityFlag = "break" | "drift" | "goalChanged" | "branch" | "tampered" | "builtOnTampered" | "lowSignal" | "noGoal" | "task" | "failed";

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
}

const W = { anchor: 0.35, continuity: 0.35, integrity: 0.15, epistemic: 0.15 };

/** Word stems: compounds split at - _ . / ("Launch-Marketing" → launch, market), 6-char prefix (Spiele ~ Spiel). */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    for (const part of [t, ...t.split(/[-_./]+/)]) if (part.length > 2 && !/^\d+$/.test(part)) out.add(part.slice(0, 6));
  }
  return out;
}

/** Ochiai overlap of two token sets (0..1). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.sqrt(a.size * b.size);
}

const norm = (x: number, full: number) => Math.max(0, Math.min(1, x / full));

function epistemicOf(n: ScenariaNode): number {
  const v = n.verification?.status;
  if (v === "passed") return 1;
  if (v === "warning") return 0.6;
  if (v === "failed") return 0.15;
  if (n.type === "decision") return Math.max(0, Math.min(1, (n.confidence ?? 0.7) - (n.chosen && !n.rationale ? 0.2 : 0)));
  const conf = (n.factInfo ?? []).map((f) => f?.confidence).filter((c): c is number => typeof c === "number");
  return conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0.8;
}

/** Fidelity of every node, computed in one pass over the tree (each node only sees its own path). */
export function fidelityAll(nodes: ScenariaNode[], opts: { integrity?: Map<string, IntegrityState>; goalChanges?: string[] } = {}): Map<string, FidelityPoint> {
  const out = new Map<string, FidelityPoint>();
  const kids = new Map<string, ScenariaNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const l of kids.values()) l.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    let anchor: number | null;
    let continuity: number;
    // Automatic saves (watcher, autosave) carry file names, not meaning: they never count as a break.
    const automatic = n.type === "autosave" || n.source === "watch" || /^auto-save/i.test(n.title);
    const signal = toks.size >= 4 && !automatic;

    if (!n.parentId || n.type === "mission") {
      anchor = 1;
      continuity = 1;
    } else if (n.type === "goal") {
      // A task is a legitimate new start; what matters is how close it is to the main goal.
      anchor = hasGoal ? norm(overlap(toks, f.mainGoal), 0.2) : null;
      continuity = 1;
      flags.push("task");
    } else if (!signal && f.parent) {
      // Too little text to judge (e.g. "Auto-save: a.ts"): carry the line on, slightly decayed.
      anchor = f.parent.anchor === null || (!hasGoal && !f.taskGoal.size) ? null : f.parent.anchor * 0.98;
      continuity = f.parent.continuity * 0.98;
      flags.push("lowSignal");
    } else {
      const goalSet = new Set([...f.mainGoal, ...f.taskGoal]);
      anchor = hasGoal || f.taskGoal.size ? norm(overlap(toks, goalSet), 0.18) : null;
      if (n.servesGoal) anchor = Math.max(anchor ?? 0, 0.8);
      const window = new Set<string>([...f.taskGoal]);
      for (const a of f.anc.slice(-6)) for (const t of a.toks) window.add(t);
      continuity = norm(overlap(toks, window), 0.15);
      const ancIds = new Set(f.anc.map((a) => a.n.id));
      const refs = [...(n.basedOn ?? []), ...(n.factInfo ?? []).flatMap((x) => x?.basedOn ?? [])];
      if (refs.some((r) => ancIds.has(r.split(".")[0]))) continuity = Math.max(continuity, 0.95);
    }
    if (!hasGoal && n.parentId) flags.push("noGoal");
    if (n.forkedFrom) flags.push("branch");
    if (n.verification?.status === "failed") flags.push("failed");
    if (f.parent && n.parentId) {
      const from = f.anc[f.anc.length - 1]?.n.createdAt ?? "";
      if (goalChanges.some((t) => t > from && t <= n.createdAt)) flags.push("goalChanged");
    }
    const epistemic = epistemicOf(n);
    const integScore = integrity === "tampered" ? 0 : integrity === "inherited" ? 0.5 : 1;
    let score: number;
    if (anchor === null) {
      const rest = W.continuity + W.integrity + W.epistemic;
      score = (continuity * W.continuity + integScore * W.integrity + epistemic * W.epistemic) / rest;
    } else score = anchor * W.anchor + continuity * W.continuity + integScore * W.integrity + epistemic * W.epistemic;
    score = Math.round(score * 100);
    if (integrity === "tampered") score = Math.min(score, 25);
    if (!n.parentId) score = integrity === "tampered" ? 25 : 100;
    // A break: the step neither connects to its path nor to the goal, or fidelity falls sharply.
    if (n.type !== "goal" && n.parentId && signal && ((continuity < 0.12 && (anchor ?? 0) < 0.4) || (f.parent && f.parent.score - score >= 30))) flags.push("break");
    if (anchor !== null && ((n.type === "decision" && anchor < 0.25) || (n.type === "goal" && anchor < 0.2))) flags.push("drift");
    const point: FidelityPoint = { id: n.id, type: n.type, title: n.type === "decision" ? n.question ?? n.title : n.title, score, anchor: anchor === null ? null : Math.round(anchor * 100) / 100, continuity: Math.round(continuity * 100) / 100, integrity, epistemic: Math.round(epistemic * 100) / 100, flags };
    out.set(n.id, point);
    const nextTask = n.type === "goal" ? stems(`${n.title} ${n.goal ?? ""}`) : f.taskGoal;
    const nextMain = n.type === "mission" ? stems(n.goal ?? "") : f.mainGoal;
    for (const k of [...(kids.get(n.id) ?? [])].reverse()) {
      stack.push({ n: k, anc: [...f.anc.slice(-8), { n, toks }], mainGoal: nextMain, taskGoal: nextTask, parent: point, tampered: f.tampered || integrity === "tampered" });
    }
  }
  return out;
}
