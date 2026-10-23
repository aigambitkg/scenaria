import type { ScenariaNode } from "./types.js";
import { effectiveStatus, isUnconfirmedPass, verdictOrigin } from "./verdict.js";

/** "passed (by the person)", "passed (self-reported — not verified)", "failed (reported by the agent)" … */
function verdictLine(v: { status?: string; origin?: string; by?: string; report?: { status?: string; origin?: string } | null }): string {
  const o = verdictOrigin(v);
  if (isUnconfirmedPass(v)) return `passed (${o === "auto" ? "automatic checks only" : o === "legacy" ? "earlier version, origin not recorded" : "self-reported"} — not verified)`;
  const low = v.report && (v.report.status === "failed" || v.report.status === "warning") ? `; later reported ${v.report.status} by ${v.report.origin}` : "";
  return `${v.status} (by ${o ?? "?"}${low})`;
}

export function estimateTokens(text: string): number {
  // Rough heuristic (~4 chars per token for mixed EN/DE prose + code).
  return Math.ceil(text.length / 4);
}

export function optionLabel(node: ScenariaNode, optId?: string): string | undefined {
  if (!optId) return undefined;
  return node.options?.find((o) => o.id === optId)?.label ?? optId;
}

function bullets(items: string[] | undefined, indent = ""): string[] {
  return (items ?? []).filter(Boolean).map((i) => `${indent}- ${i}`);
}

function short(s: string | undefined, max = 220): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Nearest task (goal node) on a path, from the end; null when the path has none. */
export function nearestGoal(path: ScenariaNode[]): ScenariaNode | null {
  for (let i = path.length - 1; i >= 0; i--) if (path[i].type === "goal") return path[i];
  return null;
}

/** All nodes belonging to a task: its descendants up to (not including) the next tasks. */
export function taskNodes(goalId: string, all: ScenariaNode[]): ScenariaNode[] {
  const kids = new Map<string, ScenariaNode[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const l = kids.get(n.parentId) ?? [];
    l.push(n);
    kids.set(n.parentId, l);
  }
  const out: ScenariaNode[] = [];
  const seen = new Set<string>([goalId]);
  const stack = [...(kids.get(goalId) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "goal" || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    stack.push(...(kids.get(n.id) ?? []));
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Deterministic one-paragraph rollup of a task (no LLM, zero cost).
 * `taken` maps a decision to the option actually followed (on a path that is the next node's viaOption).
 */
export function taskRollup(goal: ScenariaNode, inside: ScenariaNode[], taken?: (d: ScenariaNode) => string | undefined): string {
  const decisions = inside.filter((n) => n.type === "decision");
  const checkpoints = inside.filter((n) => n.type === "checkpoint");
  const parts: string[] = [];
  if (decisions.length) {
    const key = decisions
      .slice(-3)
      .map((d) => `${short(d.question || d.title, 70)} → ${optionLabel(d, taken?.(d) ?? d.chosen) ?? "open"}`)
      .join("; ");
    parts.push(`${decisions.length} decision(s): ${key}`);
  }
  const last = checkpoints[checkpoints.length - 1];
  if (last) parts.push(`result: ${short(last.title, 100)}${last.outputs?.length ? ` (${short(last.outputs[0], 90)})` : ""}`);
  else if (!decisions.length) parts.push("no recorded steps");
  const lessons = inside.flatMap((n) => n.lessons ?? []);
  if (lessons.length) parts.push(`lesson: ${short(lessons[lessons.length - 1], 120)}`);
  const failed = inside.filter((n) => effectiveStatus(n.verification) === "failed").length;
  if (failed) parts.push(`${failed} failed check(s)`);
  return short(parts.join(" · "), 420);
}

export interface CapsuleOptions {
  fullCheckpoints?: number;
  lastGood?: string | null;
  lastUserRequest?: string | null;
  /** Token budget; lower-priority parts are dropped first. Default 1500. */
  budget?: number;
  rules?: { id: string; text: string }[];
  /** Active canon events (fixed points); hard ones are never dropped. */
  canon?: { line: string; hard: boolean }[];
  canonProposals?: number;
  canonTampered?: string[];
  canonUntrusted?: string[];
  /** canon.json could not be read (e.g. merge conflict): the fixed points are unknown. */
  canonError?: string | null;
  /** Approved events that disappeared from canon.json. */
  canonMissing?: string[];
  /** Rollup for an earlier task (default: stored summary or deterministic rollup of its path segment). */
  taskSummary?: (goal: ScenariaNode) => string;
}

type Section = "head" | "canon" | "rules" | "earlier" | "task" | "state" | "facts" | "request" | "foot";
const ORDER: Section[] = ["head", "canon", "rules", "earlier", "task", "state", "facts", "request", "foot"];

interface Item {
  section: Section;
  prio: number;
  seq: number;
  lines: string[];
}

function confNote(c?: number): string {
  if (c === undefined) return "";
  return c < 0.7 ? ` (confidence ${Math.round(c * 100)} % — verify before relying on it)` : ` (${Math.round(c * 100)} %)`;
}

function decisionLine(n: ScenariaNode, next: ScenariaNode | undefined, detail: boolean): string[] {
  const takenId = next?.viaOption ?? n.chosen;
  const taken = optionLabel(n, takenId);
  const alts = (n.options ?? []).filter((o) => o.id !== takenId).map((o) => short(o.label, 60));
  let s = `${n.id} ❖ ${short(n.question || n.title, detail ? 300 : 120)} → ${taken ? `**${taken}**` : "_(open — no option chosen yet)_"}`;
  if (takenId && n.chosen && takenId !== n.chosen) s += ` — alternative branch (originally chosen: ${optionLabel(n, n.chosen)})`;
  else if (n.rationale) s += ` — why: ${short(n.rationale, detail ? 300 : 120)}`;
  if (detail && alts.length) s += ` (alternatives: ${alts.join(" | ")})`;
  const out = [`- ${s}`];
  if (detail) {
    if (n.context) out.push(`  - context: ${short(n.context, 220)}`);
    if (n.servesGoal) out.push(`  - serves goal: ${short(n.servesGoal, 180)}`);
    if (n.expectedOutcome) out.push(`  - expected: ${short(n.expectedOutcome, 180)}`);
    if (n.basedOn?.length) out.push(`  - based on: ${n.basedOn.slice(0, 8).join(", ")}`);
    if (n.breaksCanon?.length) out.push(`  - ⚠ BREAKS canon ${n.breaksCanon.join(", ")}`);
    else if (n.respectsCanon?.length) out.push(`  - respects canon ${n.respectsCanon.join(", ")}`);
    if (n.confidence !== undefined && n.confidence < 0.6) out.push(`  - confidence ${Math.round(n.confidence * 100)} % — verify before building on it`);
    for (const a of n.assumptions ?? []) out.push(`  - assumption: ${short(a, 200)}`);
  }
  return out;
}

/**
 * Build the resume capsule for the path root → target, within a token budget.
 *
 * Non-anticipativity: only nodes ON the path are included. Content of sibling
 * branches (abandoned or alternative futures) is deliberately excluded — the
 * only thing that crosses branches are explicit `lessons` and project rules.
 *
 * Long projects stay cheap: the current task is shown in detail, every earlier task
 * as a one-line rollup, and whatever does not fit is left to scenaria_recall.
 */
export function composeContext(path: ScenariaNode[], opts: CapsuleOptions = {}): { markdown: string; omitted: number } {
  const full = opts.fullCheckpoints ?? 3;
  const budget = Math.max(300, opts.budget ?? 1500);
  const root = path[0];
  const target = path[path.length - 1];
  const items: Item[] = [];
  let seq = 0;
  const add = (section: Section, prio: number, lines: string[]) => {
    if (lines.length) items.push({ section, prio, seq: seq++, lines });
  };

  // ---- always: where am I, what is the goal
  const label = target.scenarioId !== undefined && target.version !== undefined ? ` (${target.scenarioId}/v${target.version})` : "";
  const head = [`# Scenaria resume context — ${target.id}${label}`, "", `Project ${root.id}: **${root.title}**`];
  head.push(root.goal ? `Main goal: ${short(root.goal, 600)}` : "Main goal: _(not set — ask the user and record it with scenaria_start_mission projectGoal)_");
  if (root.brief && root.brief !== root.goal) head.push(`Brief: ${short(root.brief, 600)}`);
  add("head", 0, head);

  const goalIdx = path.map((n, i) => (n.type === "goal" ? i : -1)).filter((i) => i >= 0);
  const cur = goalIdx.length ? goalIdx[goalIdx.length - 1] : 0;

  // Fixed points first: hard canon events are never dropped from the capsule.
  for (const c of opts.canon ?? []) add("canon", c.hard ? 0 : 1, [c.line]);
  if (opts.canonProposals) add("canon", 1, [`- (${opts.canonProposals} proposed canon event(s) await the user's approval — not binding yet)`]);
  if (opts.canonError) add("canon", 0, [`- ⚠ The canon (fixed points) could not be read: ${opts.canonError.slice(0, 200)}. Treat hard constraints as UNKNOWN — do not assume there are none; tell the user.`]);
  if (opts.canonMissing?.length) add("canon", 0, [`- ⚠ ${opts.canonMissing.join(", ")}: approved fixed point(s) missing from canon.json (deleted outside Scenaria) — treat as still binding until the user decides; tell the user.`]);
  if (opts.canonUntrusted?.length) add("canon", 0, [`- ⚠ ${opts.canonUntrusted.join(", ")}: signed by an approver key that is not trusted here — not binding until the user re-approves or trusts that key; tell the user.`]);
  if (opts.canonTampered?.length) add("canon", 0, [`- ⚠ ${opts.canonTampered.join(", ")}: changed outside Scenaria (signature invalid) — not binding until the user re-approves; tell the user.`]);
  for (const r of opts.rules ?? []) add("rules", 1, [`- ${r.id}: ${short(r.text, 240)}`]);

  // ---- earlier tasks on this path: one line each (newest kept longest)
  const nextOnPath = new Map(path.slice(0, -1).map((n, i) => [n.id, path[i + 1]]));
  const onPath = new Set(path.map((n) => n.id));
  // A stored summary only counts when it was written on this path (else it would describe another branch).
  const trusted = (g: ScenariaNode) => g.summary && (typeof g.meta?.summaryFrom !== "string" || onPath.has(g.meta.summaryFrom as string));
  const rollup = (g: ScenariaNode, from: number, to: number) =>
    opts.taskSummary?.(g) ?? (trusted(g) ? g.summary! : taskRollup(g, path.slice(from + 1, to), (d) => nextOnPath.get(d.id)?.viaOption));
  for (let k = 0; k < goalIdx.length - 1; k++) {
    const i = goalIdx[k];
    const g = path[i];
    const dist = goalIdx.length - 1 - k;
    add("earlier", 4 + dist * 0.01, [`- ${g.id} ◉ ${short(g.title, 100)}${g.status ? ` [${g.status}]` : ""} — ${rollup(g, i, goalIdx[k + 1])}`]);
  }
  // Steps before the first task (older data, manual saves): decisions only, briefly.
  const preEnd = goalIdx.length ? goalIdx[0] : 0;
  for (let i = 1; i < preEnd; i++) if (path[i].type === "decision") add("earlier", 7, decisionLine(path[i], path[i + 1], false));

  // ---- current task in detail
  const task = cur > 0 ? path[cur] : null;
  if (task) {
    const t = [`## Current task ${task.id}: ${short(task.title, 160)}`];
    if (task.goal && task.goal !== task.title) t.push(`Task goal: ${short(task.goal, 500)}`);
    add("task", 0, t);
  }
  const cpIdx = path
    .map((n, i) => ({ n, i }))
    .filter(({ n, i }) => i > cur && (n.type === "checkpoint" || n.type === "autosave" || n.type === "branch"))
    .map(({ i }) => i);
  const fullSet = new Set(cpIdx.slice(-full));
  for (let i = cur + 1; i < path.length; i++) {
    const n = path[i];
    if (n === target) continue; // shown under "Current state"
    if (n.type === "decision") add("task", 2, decisionLine(n, path[i + 1], true));
    else {
      const g = n.type === "branch" ? "⑂" : n.type === "autosave" ? "⟲" : n.type === "goal" ? "◉" : "◆";
      const lines = [`- ${n.id} ${g} ${short(n.title, 200)}`];
      if (fullSet.has(i)) lines.push(...bullets(n.outputs?.slice(0, 6).map((o) => short(o, 200)), "  "));
      if (Array.isArray(n.fulfills) && n.fulfills.length) lines.push(`  - reports criteria ${n.fulfills.slice(0, 8).join(", ")} as implemented (counts with evidence only)`);
      if (n.verification && n.verification.status !== "unverified") lines.push(`  - verification: ${verdictLine(n.verification)}${n.verification.notes ? ` — ${short(n.verification.notes, 160)}` : ""}`);
      add("task", fullSet.has(i) ? 5 : 5.5, lines);
    }
  }
  // Lessons and irreversible effects anywhere on the path matter beyond their task.
  for (const n of path) {
    for (const l of n.lessons ?? []) add("task", 3, [`- lesson (${n.id}): ${short(l, 260)}`]);
    for (const x of n.irreversible ?? []) add("task", 1, [`- ⚠ irreversible (${n.id}): ${short(x, 200)}`]);
  }

  // ---- current state
  if (target.type !== "mission") {
    const st = [`## Current state (${target.id}: ${short(target.title, 160)})`];
    if (target.type === "decision") st.push(...decisionLine(target, undefined, true));
    if (target.facts?.length) st.push("Facts:", ...bullets(target.facts.map((f, k) => `${target.id}.f${k + 1}: ${short(f, 220)}${confNote(target.factInfo?.[k]?.confidence)}`)));
    if (target.outputs?.length) st.push("Outputs:", ...bullets(target.outputs.slice(0, 8).map((o) => short(o, 220))));
    if (target.openQuestions?.length) st.push("Open questions:", ...bullets(target.openQuestions.map((q) => short(q, 220))));
    add("state", 0, st);
    if (target.changedFiles?.length) {
      const cf = target.changedFiles.slice(0, 20);
      add("state", 6, [`Changed files vs. previous snapshot (${target.changedFiles.length}):`, ...bullets(cf), ...(target.changedFiles.length > cf.length ? [`- … ${target.changedFiles.length - cf.length} more`] : [])]);
    }
  }
  // Earlier facts with their reference (n12.f2) and confidence; low-confidence facts are marked for checking.
  const seenFacts = new Set<string>();
  const earlier: string[] = [];
  for (const n of path.slice(0, -1)) {
    (n.facts ?? []).forEach((f, k) => {
      if (seenFacts.has(f)) return;
      seenFacts.add(f);
      earlier.push(`- ${n.id}.f${k + 1}: ${short(f, 220)}${confNote(n.factInfo?.[k]?.confidence)}`);
    });
  }
  earlier.slice(-15).reverse().forEach((line, k) => add("facts", 6 + k * 0.01, [line]));

  if (opts.lastUserRequest) add("request", 0, ["## Latest user request on this path", short(opts.lastUserRequest, 600)]);
  const foot: string[] = [];
  if (opts.lastGood) foot.push(`Last verified-good node on this path: ${opts.lastGood}`);
  if (target.snapshot) foot.push(`Files are at snapshot ${target.snapshot.commit.slice(0, 10)} (${target.snapshot.files} files).`);
  add("foot", 0, foot);

  // ---- fit to budget: keep by priority, render in reading order
  const sorted = [...items].sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  let used = 0;
  const keep = new Set<Item>();
  let omitted = 0;
  for (const it of sorted) {
    const cost = estimateTokens(it.lines.join("\n")) + 1;
    if (it.prio === 0 || used + cost <= budget) {
      keep.add(it);
      used += cost;
    } else omitted++;
  }
  const lines: string[] = [];
  const headings: Partial<Record<Section, string>> = {
    canon: "## Canon — fixed points (every decision must respect them; breaking one needs breaksCanon + rationale)",
    rules: "## Project rules (always follow)",
    earlier: "## Earlier tasks on this path",
    task: task ? undefined : "## Path so far (decisions taken)",
    facts: "## Established facts (earlier on this path)",
  };
  for (const sec of ORDER) {
    const its = items.filter((i) => i.section === sec && keep.has(i)).sort((a, b) => a.seq - b.seq);
    if (!its.length) continue;
    if (headings[sec]) lines.push("", headings[sec]!);
    else lines.push("");
    for (const it of its) lines.push(...it.lines);
  }
  if (omitted) lines.push("", `_${omitted} older item(s) left out to stay within ~${budget} tokens — use scenaria_recall "<topic>" or scenaria_get_node <id> for details._`);
  lines.push("", "_Only this path is included. Other branches are intentionally excluded; continue from the current state above._");
  return { markdown: lines.join("\n").replace(/^\n+/, ""), omitted };
}
