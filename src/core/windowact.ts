/**
 * Batch E3a-2: acting on the measured fill of a context window (Kev 2026-10-18, n75–n79; design in docs/intern).
 *
 * What Scenaria does, by zone (thresholds from CONTEXT_RULE, the fill only as windowStatus measured and checked it):
 *   green      nothing
 *   yellow     a notice to the agent (do not start a new large part of the work; a handover is ready)
 *   orange     a notice; at the END of the turn an automatic checkpoint (a clean cut before the window change)
 *   red        at ONCE an automatic checkpoint (also mid-turn, from PostToolUse — Kev n77), a notice to the agent AND
 *              the person; the handover is ready
 *   emergency  the same at once; the agent's notice repeats on every turn
 * Each zone is cut at most once per window and line of work: a cut of a higher zone counts for the lower ones; a cut
 * left on an abandoned branch (after a rewind) does not count. Check and write happen under the project lock, so
 * parallel hooks (parallel tool calls) cut once.
 *
 * What it never does: block the agent, open a new window, change progress or give a verdict. The automatic
 * checkpoints carry `meta.contextCut` and the tag "context-cut" (only Scenaria writes them: the tools' schemas have
 * neither); they claim no completion criteria. A cut that saved no file change ("quiet") is passed over by progress
 * (core/progress.ts), so a task the person accepted stays accepted.
 *
 * Cost: the hooks call this after every tool. `quickFill` (cached, unchecked) first rules out everything below the
 * yellow line; only above it is the full, checked measurement computed. Nothing is ever shown or done from quickFill.
 */
import type { Scenaria, TaskHint } from "./engine.js";
import type { ScenariaNode } from "./types.js";
import { CONTEXT_RULE, CONTEXT_ZONES, parseContextRule, type ContextZone } from "./derivation.js";
import { quickFill, windowStatus, type ContextCutMeta, type WindowInfo } from "./window.js";
import { projectProgress, renderProgress } from "./progress.js";

export const ZONE_RANK: Record<ContextZone, number> = { green: 0, yellow: 1, orange: 2, red: 3, emergency: 4 };
export type CutMoment = ContextCutMeta["moment"];

export interface ContextAdvice {
  window: WindowInfo;
  zone: ContextZone;
  fill: number;
  /** The highest zone already cut in this window on the current line (green: none yet). */
  cut: ContextZone;
  /** The newest cut checkpoint of this window on the current line, if any. */
  cutNode: string | null;
}

/**
 * The checked state of one conversation's newest window, or null when nothing can be due: no window, below the
 * yellow line, not measurable (unknown model, changed outside), or another conversation's window. Never throws.
 */
export function contextAdvice(s: Scenaria, key: string): ContextAdvice | null {
  try {
    const q = quickFill(s, key);
    if (!q || q.fill < parseContextRule(CONTEXT_RULE).yellow) return null;
    const w = windowStatus(s, { key }).current;
    if (!w || w.key !== key || !w.measurable || !w.fill || !w.zone || w.zone === "green") return null;
    const mine = w.cuts.filter((c) => c.onLine);
    const top = mine.reduce<ContextZone>((z, c) => (ZONE_RANK[c.zone] > ZONE_RANK[z] ? c.zone : z), "green");
    return { window: w, zone: w.zone, fill: w.fill.value, cut: top, cutNode: mine.length ? mine[mine.length - 1].node : null };
  } catch {
    return null;
  }
}

/**
 * Is an automatic checkpoint due? `turn-end` (end of a turn, a new prompt, a proxy answer: `answer`) cuts from orange
 * on; `now` (mid-turn, after a tool) only from red on. Never twice for the same zone in one window.
 */
export function cutDue(a: ContextAdvice | null, moment: CutMoment): boolean {
  if (!a) return false;
  const min = moment === "now" ? ZONE_RANK.red : ZONE_RANK.orange;
  return ZONE_RANK[a.zone] >= min && ZONE_RANK[a.zone] > ZONE_RANK[a.cut];
}

/** Does the person get a message? From red on (Kev n77: red = a notice to agent and person). */
export const tellsPerson = (a: ContextAdvice) => ZONE_RANK[a.zone] >= ZONE_RANK.red;

/** What a cut checkpoint records about itself. */
export function cutMeta(a: ContextAdvice, moment: CutMoment): ContextCutMeta {
  return { window: a.window.id, key: a.window.key, startedAt: a.window.startedAt, zone: a.zone, fill: a.fill, tokens: a.window.tokens ?? 0, rule: CONTEXT_RULE, moment };
}

const pct = (x: number, lang: "de" | "en") => (lang === "de" ? String(x).replace(".", ",") : String(x));

/** The output bullet of a cut checkpoint (English, like every node text the hooks write). */
export function cutBullet(a: ContextAdvice): string {
  return `Context window ${a.window.id} ${a.fill} % full (${CONTEXT_ZONES[a.zone].en}): Scenaria saved this step before the window change (rule ${parseContextRule(CONTEXT_RULE).version}; how computed: scenaria_window)`;
}

/**
 * Check and, if due, write under the project lock: parallel hooks see each other's cut and cut once. `write` gets the
 * advice and writes the node (a cut by itself, or a turn's own checkpoint that carries the cut).
 */
export function cutOnce<T extends ScenariaNode | null>(
  s: Scenaria,
  key: string,
  moment: CutMoment,
  write: (a: ContextAdvice | null, due: boolean) => T,
): { advice: ContextAdvice | null; node: T; cut: boolean } {
  return s.store.withLock(() => {
    const a = contextAdvice(s, key);
    const due = cutDue(a, moment);
    const node = write(a, due);
    if (due && node && a) noteCut(s, a, node.id);
    return { advice: a, node, cut: due && Boolean(node) };
  });
}

/**
 * A cut checkpoint by itself (mid-turn, at a new prompt, after a proxy answer), as Scenaria: a restore point with the
 * files as they are, even when nothing changed since the last step. Null when nothing was due or it could not be
 * written.
 */
export function cutIfDue(s: Scenaria, key: string, moment: CutMoment, opts: { task?: TaskHint; source: "hook" | "api" }): { advice: ContextAdvice | null; node: ScenariaNode | null } {
  try {
    const r = cutOnce(s, key, moment, (a, due) => {
      if (!due || !a) return null;
      return s.checkpoint({
        title: `Saved before the window change: context window ${a.fill} % full (${CONTEXT_ZONES[a.zone].en})`,
        outputs: [cutBullet(a)],
        onlyIfChanged: false,
        agent: "scenaria",
        source: opts.source,
        tags: ["context-cut"],
        meta: { contextCut: cutMeta(a, moment) },
        task: opts.task,
      });
    });
    return { advice: r.advice, node: r.node };
  } catch {
    return { advice: null, node: null };
  }
}

/** The person's protocol: one line per cut (the dashboard shows it in E3b). */
export function noteCut(s: Scenaria, a: ContextAdvice, node: string) {
  try {
    s.store.appendEvent({
      type: "update",
      nodeId: node,
      data: { message: `context window ${a.window.id} ${a.fill} % full (${a.zone}): saved as ${node}`, context: { window: a.window.id, zone: a.zone, fill: a.fill, agent: a.window.agent } },
    });
  } catch {
    /* the protocol line must never cost the checkpoint */
  }
}

/** The notice for the agent (English: agents read the reminder and the hook context in English). */
export function agentNotice(a: ContextAdvice, saved?: string | null): string {
  const z = CONTEXT_ZONES[a.zone].en;
  const next = a.window.next ? `, next line ${a.window.next.at} % (${CONTEXT_ZONES[a.window.next.zone].en})` : "";
  const head = `[Scenaria context] window ${a.window.id} is ${a.fill} % full (${z}${next}; how computed: scenaria_window).`;
  const node = saved ?? a.cutNode;
  const savedText = node ? ` Scenaria saved step ${node} as a restore point.` : "";
  switch (a.zone) {
    case "yellow":
      return `${head} Do not start a new large part of the work in this window; a handover is ready (scenaria_handover).`;
    case "orange":
      return node
        ? `${head} Finish the current step and hand over soon.${savedText} The handover is ready (scenaria_handover).`
        : `${head} Finish and save the current step; Scenaria saves a checkpoint at the end of this turn. Then hand over: scenaria_handover.`;
    case "red":
      return `${head} Hand over to a new window now.${savedText} The handover is ready (scenaria_handover); tell the person to open a new window (Claude Code: /clear or a new session) — it continues from the current state.`;
    case "emergency":
      return `${head} Save now — the window is far past the limit for good work.${savedText} Do not start new work; hand over (scenaria_handover) and ask the person for a new window.`;
    default:
      return "";
  }
}

/** The notice for the person (shown by Claude Code as a system message; from red on — tellsPerson). */
export function personNotice(a: ContextAdvice, node: string | null, lang: "de" | "en"): string {
  const z = CONTEXT_ZONES[a.zone][lang];
  // Above 100 % of the limit for good work a percentage confuses more than it says.
  const how = a.fill > 100 ? (lang === "de" ? "mehr als voll" : "more than full") : lang === "de" ? `zu ${pct(a.fill, "de")} % gefüllt` : `${a.fill} % full`;
  if (lang === "de") {
    const saved = node ? ` Gesichert als Schritt ${node}.` : "";
    return `Scenaria: Das Gedächtnis der KI (Kontextfenster) ist ${how} (${z}).${saved} Bitte jetzt ein neues Fenster öffnen (Claude Code: /clear) – die Übergabe liegt bereit (scenaria handover).`;
  }
  const saved = node ? ` Saved as step ${node}.` : "";
  return `Scenaria: the AI's memory (context window) is ${how} (${z}).${saved} Please open a new window now (Claude Code: /clear) – the handover is ready (scenaria handover).`;
}

// ------------------------------------------------------------------ the prepared handover

export interface Handover {
  /** The window it hands over from (null: no measured window — the handover is the plain resume capsule). */
  window: { id: string; agent: string; model: string | null; fill: number | null; zone: ContextZone | null; measurable: boolean } | null;
  /** The newest automatic save of that window on the current line (null: none). */
  lastSave: string | null;
  /** Where the new window continues: always the current state (HEAD). */
  from: string;
  /** Other windows that are yellow or fuller (another agent or session may need a handover too). */
  others: { id: string; agent: string; fill: number; zone: ContextZone }[];
  markdown: string;
  tokens: number;
}

/**
 * The handover to a new window, computed from the records when asked (nothing stored that could drift): whose window
 * it is and how full, the last automatic save, the task's progress and the resume capsule of the current state.
 * Which window: the one named; else the newest window of the asking agent; else the newest window. Read-only.
 */
export function prepareHandover(s: Scenaria, opts: { window?: string; agent?: string } = {}): Handover {
  const head = s.head();
  if (!head) throw new Error("No HEAD yet — nothing to hand over.");
  const ws = windowStatus(s);
  let w: WindowInfo | null;
  if (opts.window) {
    w = ws.windows.find((x) => x.id === opts.window) ?? null;
    if (!w) throw new Error(`${opts.window} is not a window`);
  } else w = (opts.agent ? ws.windows.find((x) => x.agent === opts.agent) : undefined) ?? ws.current;
  const save = w ? [...w.cuts].reverse().find((c) => c.onLine) : undefined;
  const parts: string[] = ["# Handover to a new window"];
  if (w) {
    parts.push(
      w.measurable && w.fill
        ? `Window ${w.id} of ${w.agent} (${w.model ?? "?"}): ${w.fill.value} % full (${CONTEXT_ZONES[w.zone!].en}). ${w.fill.sentence.en}`
        : `Window ${w.id} of ${w.agent}: no number (${w.why ?? "not measurable"}).`,
    );
  } else parts.push("No measured window (Scenaria sees token counts only through Claude Code transcripts and the LLM proxy).");
  parts.push(
    save
      ? `Last automatic save: step ${save.node} at ${save.fill} % (${CONTEXT_ZONES[save.zone].en}). Continue from the current state, step ${head.id} "${head.title}" — do not go back to the save unless something went wrong.`
      : `Continue from the current state, step ${head.id} "${head.title}".`,
  );
  const others = ws.windows
    .filter((x) => x !== w && x.measurable && x.fill && x.zone && ZONE_RANK[x.zone] >= ZONE_RANK.yellow)
    .map((x) => ({ id: x.id, agent: x.agent, fill: x.fill!.value, zone: x.zone! }));
  if (others.length) parts.push(`Other windows that are yellow or fuller: ${others.map((o) => `${o.id} of ${o.agent} ${o.fill} % (${CONTEXT_ZONES[o.zone].en})`).join("; ")}.`);
  try {
    const task = s.currentTask(head.id);
    if (task) {
      const pr = projectProgress(s);
      if (pr.tasks.some((t) => t.task === task.id)) parts.push("## Progress", renderProgress(pr, "en", task.id));
    }
  } catch {
    /* progress is a help here, never a reason to fail the handover */
  }
  parts.push("## Resume capsule", s.context(head.id).markdown);
  parts.push(
    "## How to continue",
    "1. Open a new window (Claude Code: /clear or a new session; other clients: a new conversation).",
    "2. Start it with this handover — Claude Code injects the resume capsule at session start by itself.",
    "3. State what you assume with scenaria_expect and continue from the deviations; details: scenaria_recall.",
  );
  const markdown = parts.join("\n\n");
  return {
    window: w ? { id: w.id, agent: w.agent, model: w.model, fill: w.fill?.value ?? null, zone: w.zone ?? null, measurable: w.measurable } : null,
    lastSave: save?.node ?? null,
    from: head.id,
    others,
    markdown,
    tokens: Math.ceil(markdown.length / 4),
  };
}

/**
 * One line for the start of a new window: the agent's previous window (its newest one with answers) and its last
 * automatic save on the current line — nothing when that window had none.
 */
export function sessionStartLine(s: Scenaria, agent: string): string | null {
  try {
    const w = windowStatus(s).windows.find((x) => x.agent === agent && x.samples > 0);
    const c = w ? [...w.cuts].reverse().find((x) => x.onLine) : undefined;
    if (!w || !c) return null;
    return `(Handover: the previous window ${w.id} was ${c.fill} % full (${CONTEXT_ZONES[c.zone].en}) when Scenaria saved step ${c.node}. This capsule continues from the current state; the full handover: scenaria_handover.)`;
  } catch {
    return null;
  }
}
