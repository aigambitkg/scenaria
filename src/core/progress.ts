/**
 * Batch E2: progress — "how far along am I?" in percent, per task and for the project (Kev 2026-10-17, n64–n66).
 *
 * Computed only from evidence, by fixed versioned rules (`progress/1`, `progress-project/1` in derivation.ts):
 *   - A task's completion criteria are its approved future fixed points (canon events with `task`, `weight` and an
 *     optional `artifact`). Agents propose them; the person approves (signed, canon/v3).
 *   - Each criterion gets a level from evidence: 0 open · 0.25 started (its file exists, or a step names it) ·
 *     0.5 implemented (a step claims it with `fulfills` AND there is evidence: its file changed after it was set,
 *     or — without a file — the claiming step changed files) · 0.75 checked (its check command passed on saved
 *     files, not stale) · 1 confirmed (the person confirmed it, or the person / an audit agent verified the
 *     claiming step). A failed check that is not stale caps the criterion at 0.5 (Kev: "höchstens 0,5").
 *   - Gates cap the task (10 … 100). 90 needs every criterion confirmed, 100 the person's own verdict on the task's
 *     last step: an agent can never compute itself "done" (security rule 11 — only `integrity().confirmed` counts).
 *
 * Only the task's current line counts (the path from the task to its newest step): steps of an abandoned attempt
 * and steps changed outside Scenaria are never evidence.
 */
import type { Scenaria } from "./engine.js";
import type { CanonEvent } from "./canon.js";
import { artifactMatches, criterionAnchors } from "./canon.js";
import { compact, derive, PROGRESS_GATES, type CompactDerivation, type Derivation, type Lang2 } from "./derivation.js";
import type { ScenariaNode } from "./types.js";

export type CriterionLevel = 0 | 0.25 | 0.5 | 0.75 | 1;
/** How a criterion reached its level (the evidence, as a code). */
export type CriterionHow = "open" | "file" | "referenced" | "claimed" | "implemented" | "check-failed" | "checked" | "confirmed" | "verdict";

export interface CriterionProgress {
  id: string;
  text: string;
  /** The approved weight; null = no weight yet (counts 1 until the person sets one; gate 20 stays open). */
  weight: number | null;
  artifact?: string;
  /** The file exists and changed on the task's line after the criterion was set (a new result, not an old file). */
  fileChanged: boolean;
  level: CriterionLevel;
  how: CriterionHow;
  /** Steps that carry the evidence (claim, file change, verdict). */
  evidence: string[];
  /** What else is known, in plain words (a stale or failed check, a claim without evidence …). */
  notes: Lang2[];
}

export interface GateState {
  cap: number;
  met: boolean;
  name: Lang2;
}

export interface TaskProgress {
  task: string;
  title: string;
  /** "missing": criteria name this task, but its node is gone or no longer a task (review 2, M-1) — counts as 0 %. */
  status: "active" | "done" | "abandoned" | "missing";
  hasGoal: boolean;
  /** HEAD is on another branch: the task is shown as its newest step left it. */
  offLine: boolean;
  /** The newest step of the task's current line (what "the task's state" means). */
  tip: string;
  criteria: CriterionProgress[];
  /**
   * Criteria that do not count: proposals awaiting the person, ones changed outside Scenaria or signed by an unknown
   * key, and ones this machine saw approved for this task that are gone or moved ("missing", review H1).
   */
  unsettled: { id: string; text: string; status: CanonEvent["status"] | "missing" }[];
  gates: GateState[];
  value: number;
  derivation: Derivation;
  /** What is missing for the next gate (null at 100 %), for people: plain words, naming who acts. */
  next: Lang2 | null;
  /** The same for agents (English, with the tool words). */
  nextAgent: string | null;
}

export interface ProjectProgress {
  value: number;
  derivation: Derivation;
  tasks: TaskProgress[];
  /** Tasks without criteria: no progress can be measured for them. */
  without: { task: string; title: string }[];
  /** Abandoned tasks with criteria: they still count (an agent can mark a task abandoned — review M2); the person retires their criteria. */
  abandoned: string[];
}

const LEVEL_WORD: Record<CriterionLevel, Lang2> = {
  0: { de: "offen", en: "open" },
  0.25: { de: "begonnen", en: "started" },
  0.5: { de: "umgesetzt", en: "implemented" },
  0.75: { de: "geprüft", en: "checked" },
  1: { de: "bestätigt", en: "confirmed" },
};
export const levelWord = (l: CriterionLevel, lang: "de" | "en") => LEVEL_WORD[l][lang];

/** "+ src/a.ts" / "~ src/a.ts" / plain path → the path; deletions ("- …") are no evidence of work. */
function changedPaths(n: ScenariaNode): string[] {
  const out: string[] = [];
  for (const c of Array.isArray(n.changedFiles) ? n.changedFiles : []) {
    if (typeof c !== "string") continue;
    if (c.startsWith("- ")) continue;
    out.push(c.startsWith("+ ") || c.startsWith("~ ") ? c.slice(2) : c);
  }
  return out;
}

const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);

interface Ctx {
  s: Scenaria;
  byId: Map<string, ScenariaNode>;
  kids: Map<string, ScenariaNode[]>;
  all: ScenariaNode[];
  head: string | null;
  headPath: Set<string>;
  /** Steps that are never positive evidence: changed outside Scenaria, or written in ledger lines this machine did not write. */
  untrusted: Set<string>;
  tampered: Set<string>;
  confirmed: Set<string>;
  canon: CanonEvent[];
  anchors: Record<string, { task: string; status: string; text?: string }>;
  files: Map<string, string[] | null>;
}

function context(s: Scenaria): Ctx {
  const all = s.store.listNodes();
  const byId = new Map(all.map((n) => [n.id, n]));
  const kids = new Map<string, ScenariaNode[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const l = kids.get(n.parentId) ?? [];
    l.push(n);
    kids.set(n.parentId, l);
  }
  const head = s.store.readState().head;
  // The path to HEAD, loop-safe (a hand-edited parent can form a cycle; analysis reports it).
  const headPath = new Set<string>();
  for (let cur = head ? byId.get(head) : undefined; cur && !headPath.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) headPath.add(cur.id);
  const integ = s.integrity();
  const tampered = new Set([...integ.state].filter(([, v]) => v === "tampered").map(([id]) => id));
  const untrusted = new Set([...tampered, ...(integ.unseenWrites ?? [])]);
  return { s, byId, kids, all, head, headPath, untrusted, tampered, confirmed: integ.confirmed, canon: s.canonState().events, anchors: criterionAnchors(s.store), files: new Map() };
}

/** The nodes of a task: its descendants up to (not including) the next tasks (one child map for all tasks). */
function nodesOf(c: Ctx, taskId: string): ScenariaNode[] {
  const out: ScenariaNode[] = [];
  const seen = new Set<string>([taskId]);
  const stack = [...(c.kids.get(taskId) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "goal" || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    stack.push(...(c.kids.get(n.id) ?? []));
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * The task's current line: from the task to its newest step. HEAD in the task → up to HEAD; HEAD on the task itself
 * or before it (rewound to its start or earlier) → the task alone (review 2, H-1: an abandoned attempt never counts);
 * HEAD past the task → the task's last step on the way to HEAD. Only when HEAD is on another branch altogether is
 * the task's newest step taken (`offLine`).
 */
function currentLine(c: Ctx, task: ScenariaNode, nodes: ScenariaNode[]): { line: ScenariaNode[]; offLine: boolean } {
  const inTask = new Set(nodes.map((n) => n.id));
  if (!c.head || c.head === task.id || isAncestor(c, c.head, task.id)) return { line: [task], offLine: false };
  let tip: ScenariaNode | undefined = inTask.has(c.head) ? c.byId.get(c.head) : undefined;
  let offLine = false;
  if (!tip) {
    // HEAD went on after this task: the task's last step on the way to HEAD.
    const onWay = nodes.filter((n) => c.headPath.has(n.id));
    tip = onWay.length ? onWay.sort((a, b) => (a.version ?? 0) - (b.version ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)))[onWay.length - 1] : undefined;
    if (!tip && c.headPath.has(task.id)) return { line: [task], offLine: false };
  }
  if (!tip) {
    tip = nodes.filter((n) => n.type !== "autosave").pop() ?? nodes[nodes.length - 1];
    offLine = true;
  }
  if (!tip) return { line: [task], offLine };
  const line: ScenariaNode[] = [];
  const seen = new Set<string>();
  for (let cur: ScenariaNode | undefined = tip; cur && !seen.has(cur.id); cur = cur.parentId ? c.byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    line.unshift(cur);
    if (cur.id === task.id) break;
  }
  return { line: line[0]?.id === task.id ? line : [task], offLine };
}

/**
 * Scenaria's own cut before a window change that saved nothing new: a snapshot with no changed file, nothing
 * irreversible, no claim, no verdict on it (a verdict on it counts as usual), and trusted (unchanged since written).
 */
function quietCut(c: Ctx, n: ScenariaNode): boolean {
  const m = (n.meta as any)?.contextCut;
  return Boolean(
    m && typeof m === "object" && n.tags?.includes("context-cut") && n.snapshot && !n.changedFiles?.length && !n.irreversible?.length && !n.fulfills?.length && !n.verification && !c.untrusted.has(n.id),
  );
}

/** Is `ancestor` on the way from `id` to the root (loop-safe)? */
function isAncestor(c: Ctx, ancestor: string, id: string): boolean {
  const seen = new Set<string>();
  for (let cur = c.byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? c.byId.get(cur.parentId) : undefined) {
    if (cur.id === ancestor) return true;
    seen.add(cur.id);
  }
  return false;
}

/** The files of the newest trustworthy snapshot on the line (cached per commit; null = no snapshots available). */
function filesAt(c: Ctx, line: ScenariaNode[]): string[] | null {
  const repo = c.s.repo;
  if (!repo) return null;
  for (let i = line.length - 1; i >= 0; i--) {
    const commit = line[i].snapshot?.commit;
    if (typeof commit !== "string" || !commit) continue;
    // The newest state was changed outside Scenaria: no file counts as there (review M4) — never an older state instead.
    if (c.untrusted.has(line[i].id)) return [];
    if (!c.files.has(commit)) {
      try {
        c.files.set(commit, repo.listFiles(commit));
      } catch {
        c.files.set(commit, null);
      }
    }
    return c.files.get(commit) ?? null;
  }
  return null;
}

function criterionProgress(c: Ctx, ev: CanonEvent, line: ScenariaNode[], files: string[] | null, inTask: Set<string>): CriterionProgress {
  const notes: Lang2[] = [];
  const evidence = new Set<string>();
  const art = ev.artifact;
  const ok = (n: ScenariaNode) => !c.untrusted.has(n.id);
  const touches = (n: ScenariaNode) => Boolean(art) && changedPaths(n).some((f) => artifactMatches(art!, f));
  const exists = Boolean(art) && files !== null && files.some((f) => artifactMatches(art!, f));
  const tip = line[line.length - 1];
  const at = (id: string | null | undefined) => (id ? line.findIndex((n) => n.id === id) : -1);
  // Changes AFTER a point on the line make what was said there stale — by the order of the steps, not by clocks
  // (review M1); every step counts here, also one changed outside Scenaria (never in the evidence's favour).
  const changedAfter = (i: number) => Boolean(art) && line.slice(i + 1).some(touches);
  // Evidence counts from the person's approval on (review M3).
  const since = ev.approvedAt ?? "";
  const touchedSince = (upTo: number) => line.slice(0, upTo + 1).filter((n) => ok(n) && String(n.createdAt) >= since && touches(n));
  const fileChanged = exists && touchedSince(line.length - 1).length > 0;
  const noRepo = Boolean(art) && files === null;
  if (noRepo) notes.push({ de: "ohne Datei-Stände (kein git): ob die Ergebnis-Datei existiert, ist nicht prüfbar", en: "no file snapshots (no git): whether the result file exists cannot be checked" });

  let level: CriterionLevel = 0;
  let how: CriterionHow = "open";
  const raise = (l: CriterionLevel, h: CriterionHow) => {
    if (l > level) {
      level = l;
      how = h;
    }
  };

  if (exists) raise(0.25, "file");
  const refs = line.filter((n) => ok(n) && (list(n.respectsCanon).includes(ev.id) || list(n.fulfills).includes(ev.id)));
  if (refs.length) {
    raise(0.25, "referenced");
    refs.forEach((n) => evidence.add(n.id));
  }
  const claims = line.filter((n) => ok(n) && list(n.fulfills).includes(ev.id));
  for (const cl of claims) {
    const idx = at(cl.id);
    const backing = art ? (exists ? touchedSince(idx) : []) : changedPaths(cl).length ? [cl] : [];
    if (backing.length) {
      raise(0.5, "implemented");
      backing.forEach((n) => evidence.add(n.id));
    }
  }
  if (claims.length && level < 0.5) {
    how = "claimed";
    const ids = claims.map((n) => n.id).join(", ");
    notes.push(
      art
        ? exists
          ? { de: `als umgesetzt gemeldet (${ids}), aber ${art} wurde seit der Freigabe nicht geändert`, en: `reported as implemented (${ids}), but ${art} did not change since the approval` }
          : noRepo
            ? { de: `als umgesetzt gemeldet (${ids}), aber ohne Datei-Stände nicht belegbar`, en: `reported as implemented (${ids}), but without file snapshots it cannot be backed` }
            : { de: `als umgesetzt gemeldet (${ids}), aber ${art} fehlt`, en: `reported as implemented (${ids}), but ${art} is missing` }
        : { de: `als umgesetzt gemeldet (${ids}), aber der Schritt hat keine Datei geändert`, en: `reported as implemented (${ids}), but the step changed no file` },
    );
  }

  let cap: CriterionLevel = 1;
  const lc = ev.lastCheck;
  if (lc) {
    // A check result or confirmation belongs to the line it was made on (review H3): on this task's current line, or
    // after the task (HEAD had moved on to a later task). One made on an abandoned attempt of this task does not count.
    const i = at(lc.node);
    // After the task: on HEAD's own line (review 2, H-2 — not on a branch a rewind left), past the task's tip.
    const later = i < 0 && typeof lc.node === "string" && !inTask.has(lc.node) && lc.node !== line[0].id && c.headPath.has(lc.node) && isAncestor(c, tip.id, lc.node);
    const day = String(lc.at).slice(0, 10);
    const what = lc.how === "manual" ? { de: "Bestätigung", en: "confirmation" } : { de: "Prüfergebnis", en: "check result" };
    if (i < 0 && !later) notes.push({ de: `${what.de} vom ${day} gehört zu einem anderen Stand (${lc.node ?? "–"}): zählt nicht`, en: `the ${what.en} of ${day} belongs to another line (${lc.node ?? "–"}): does not count` });
    else if (i >= 0 && changedAfter(i)) notes.push({ de: `${what.de} vom ${day} ist veraltet: ${art} wurde danach geändert`, en: `the ${what.en} of ${day} is stale: ${art} changed afterwards` });
    // Without git there are no file states to look at: the person's word and passed checks count (review 2, M-3).
    else if (art && !exists && !noRepo && lc.status === "passed") notes.push({ de: `${what.de} vom ${day} zählt nicht: ${art} fehlt im aktuellen Stand`, en: `the ${what.en} of ${day} does not count: ${art} is missing in the current state` });
    else if (lc.how === "manual") raise(1, "confirmed");
    else if (lc.status === "failed") {
      cap = 0.5;
      notes.push({ de: "Prüfbefehl ist fehlgeschlagen: höchstens „umgesetzt“", en: "the check command failed: at most “implemented”" });
    } else if (lc.status === "passed" && lc.clean) raise(0.75, "checked");
    else if (lc.status === "passed") notes.push({ de: "Prüfbefehl lief auf ungespeicherten Dateien: zählt nicht", en: "the check command ran on unsaved files: does not count" });
  }
  // The person's or an audit agent's verdict on the step that reports the criterion (rule 11: integrity().confirmed).
  for (const cl of claims) {
    if (c.confirmed.has(cl.id) && !changedAfter(at(cl.id)) && (!art || exists || noRepo)) {
      raise(1, "verdict");
      evidence.add(cl.id);
    }
  }
  if (level > cap) {
    level = cap;
    how = "check-failed";
  }
  return { id: ev.id, text: ev.text, weight: ev.weight ?? null, artifact: art, fileChanged, level, how, evidence: [...evidence], notes };
}

const tx = (de: string, en: string): Lang2 => ({ de, en });

/**
 * What is missing for the first open gate. `person`: for the dashboard, in plain words, naming who acts ("du" /
 * "you", "die KI" / "the AI"); `agent`: for agents (English, with the tool words: fulfills, checkpoint).
 */
function nextStep(t: { hasGoal: boolean; criteria: CriterionProgress[]; unsettled: TaskProgress["unsettled"]; decided: boolean; tip: string }, blocked: number | null): { person: Lang2; agent: string } | null {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(", ");
  const both = (de: string, en: string, agent: string) => ({ person: { de, en }, agent });
  switch (blocked) {
    case null:
      return null;
    case 10:
      if (!t.hasGoal) return both("Lege das Ziel der Aufgabe fest.", "Set the task's goal.", "Set the task's goal.");
      return both(
        "Lege fest, wann die Aufgabe fertig ist: Die KI schlägt Fertig-Kriterien vor (Meilensteine mit Aufgabe und Gewicht), du gibst sie unter „Regeln & Meilensteine“ frei.",
        "Set when the task is done: the AI proposes completion criteria (milestones with a task and a weight); you approve them under “Rules & milestones”.",
        "Propose a completion criterion (future fixed point with this task and a weight); the person approves it.",
      );
    case 20: {
      const person: Lang2[] = [];
      const agent: string[] = [];
      if (t.unsettled.length) {
        person.push(tx(`Entscheide unter „Regeln & Meilensteine“ über ${ids(t.unsettled)}.`, `Decide on ${ids(t.unsettled)} under “Rules & milestones”.`));
        agent.push(`The person decides on ${ids(t.unsettled)}.`);
      }
      const nw = t.criteria.filter((x) => x.weight === null);
      if (nw.length) {
        person.push(tx(`Lege das Gewicht von ${ids(nw)} fest.`, `Set the weight of ${ids(nw)}.`));
        agent.push(`Set a weight for ${ids(nw)} (the person).`);
      }
      if (!t.decided) {
        person.push(tx("Die KI entscheidet den Lösungsweg (eine Entscheidung mit gewählter Option).", "The AI decides the approach (a decision with a chosen option)."));
        agent.push("Decide the approach (a decision with a chosen option in the task).");
      }
      return { person: { de: person.map((x) => x.de).join(" "), en: person.map((x) => x.en).join(" ") }, agent: agent.join(" ") };
    }
    case 40: {
      const withFile = t.criteria.filter((x) => x.artifact);
      const files = withFile.map((x) => `${x.id} ${x.artifact}`).join(", ");
      return withFile.length
        ? both(`Die KI legt die erste Ergebnis-Datei an: ${files}.`, `The AI creates the first result file: ${files}.`, `Create a first result file: ${files}.`)
        : both("Die KI setzt ein Kriterium um und meldet es; der Schritt muss Dateien ändern.", "The AI implements a criterion and reports it; the step must change files.", "Implement a criterion and report it with fulfills in the checkpoint (the step must change files).");
    }
    case 60: {
      const low = ids(t.criteria.filter((x) => x.level < 0.5));
      return both(`Die KI setzt um und meldet es, mit einer geänderten Datei als Nachweis: ${low}.`, `The AI implements and reports it, with a changed file as evidence: ${low}.`, `Implement and report with fulfills, with a changed file as evidence: ${low}.`);
    }
    case 80: {
      const low = ids(t.criteria.filter((x) => x.level < 0.75));
      return both(`Starte die Prüfungen (der Prüfbefehl muss bestehen) oder bestätige als erfüllt: ${low}.`, `Run the checks (the check command must pass) or confirm as met: ${low}.`, `Get the check command to pass (the person starts it): ${low}.`);
    }
    case 90: {
      const low = ids(t.criteria.filter((x) => x.level < 1));
      return both(
        `Bestätige als erfüllt (unter „Regeln & Meilensteine“) oder prüfe den Schritt, der es meldet: ${low}.`,
        `Confirm as met (under “Rules & milestones”) or verify the step that reports it: ${low}.`,
        `Confirmation by the person, or a confirmed verdict on the reporting step: ${low}.`,
      );
    }
    default:
      return both(`Prüfe den letzten Schritt der Aufgabe (${t.tip}) und gib „bestanden“.`, `Review the task's last step (${t.tip}) and give “passed”.`, `The person reviews the task's last step (${t.tip}) and gives "passed".`);
  }
}

function computeTask(c: Ctx, task: ScenariaNode): TaskProgress | null {
  const mine = c.canon.filter((e) => e.kind === "future" && e.task === task.id);
  const active = mine.filter((e) => e.status === "active");
  const unsettled: TaskProgress["unsettled"] = mine.filter((e) => e.status === "proposed" || e.status === "tampered" || e.status === "untrusted").map((e) => ({ id: e.id, text: e.text, status: e.status }));
  // A criterion this machine saw approved for this task that is gone, moved or no longer counts (review H1): it holds
  // the task back until the person decides — removing an open criterion by hand never raises progress.
  for (const [id, a] of Object.entries(c.anchors)) {
    if (a.task !== task.id || a.status !== "active" || active.some((e) => e.id === id) || unsettled.some((u) => u.id === id)) continue;
    const ev = c.canon.find((e) => e.id === id);
    unsettled.push({ id, text: ev?.text ?? a.text ?? "", status: ev && ev.status !== "active" ? ev.status : "missing" });
  }
  if (!active.length && !unsettled.length) return null;
  const nodes = nodesOf(c, task.id);
  const inTask = new Set(nodes.map((n) => n.id));
  const { line: fullLine, offLine } = currentLine(c, task, nodes);
  // A quiet automatic save (E3a-2: Scenaria's cut before a window change that saved no file change) is no step of
  // the work: the person's acceptance of the step before it stays the acceptance (review E3a-2 H2).
  const line = fullLine.slice();
  while (line.length > 1 && quietCut(c, line[line.length - 1])) line.pop();
  const tip = line[line.length - 1];
  const files = filesAt(c, line);
  const criteria = active.map((e) => criterionProgress(c, e, line, files, inTask));
  // A task node changed outside Scenaria: its goal does not count.
  const hasGoal = typeof task.goal === "string" && task.goal.trim().length > 0 && !c.tampered.has(task.id);
  const decided = line.some((n) => n.type === "decision" && typeof n.chosen === "string" && n.chosen !== "" && !c.untrusted.has(n.id));
  const all = (min: number) => criteria.length > 0 && criteria.every((x) => x.level >= min);
  // First results: a criterion's file was created or changed since the criterion was set (an old file is no result);
  // or a criterion implemented with evidence.
  const firstResults = criteria.some((x) => x.fileChanged || x.level >= 0.5);
  // 100: the person's own verdict on the newest step of the current line (rule 11; an audit agent's is not the person's),
  // given after every step of the task (any line; automatic saves aside). A verdict on an earlier step the agent
  // rewinds to was not the acceptance of the task: work went on after it (re-check 2026-10-18, review E2a H2).
  const verdictAt = String(tip.verification?.at ?? "");
  const newestStep = nodes.filter((n) => n.type !== "autosave" && !quietCut(c, n)).reduce((m, n) => (String(n.createdAt) > m ? String(n.createdAt) : m), "");
  const personAccepted = c.confirmed.has(tip.id) && tip.verification?.origin === "person" && verdictAt !== "" && verdictAt >= newestStep;
  const met: Record<number, boolean> = {
    10: hasGoal && active.length > 0,
    20: !unsettled.length && criteria.every((x) => x.weight !== null) && decided,
    40: firstResults,
    60: all(0.5),
    80: all(0.75),
    90: all(1),
    100: personAccepted,
  };
  const gates: GateState[] = PROGRESS_GATES.map((g) => ({ cap: g.cap, met: Boolean(met[g.cap]), name: g.name }));
  const derivation = derive(`progress.${task.id}`, "progress/1", {
    criteria: criteria.map((x) => `${x.id} w=${x.weight ?? 1} s=${x.level} ${x.how}${x.weight === null ? " (no weight)" : ""}`),
    gates: gates.map((g) => `${g.cap} ${g.met ? "met" : "open"}`),
  });
  let blocked: number | null = null;
  for (const g of gates)
    if (!g.met) {
      blocked = g.cap;
      break;
    }
  const nx = nextStep({ hasGoal, criteria, unsettled, decided, tip: tip.id }, blocked);
  return {
    task: task.id,
    title: task.title,
    status: task.status === "done" || task.status === "abandoned" ? task.status : "active",
    hasGoal,
    offLine,
    tip: tip.id,
    criteria,
    unsettled,
    gates,
    value: derivation.value,
    derivation,
    next: nx?.person ?? null,
    nextAgent: nx?.agent ?? null,
  };
}

/** Progress of one task (null when it has no criteria at all). */
export function taskProgress(s: Scenaria, taskId: string): TaskProgress | null {
  const c = context(s);
  const t = c.byId.get(taskId);
  if (!t || t.type !== "goal") throw new Error(`${taskId} is not a task`);
  return computeTask(c, t);
}

/** Progress of every task with criteria and of the project (mean over them, abandoned ones included — review M2). */
export function projectProgress(s: Scenaria): ProjectProgress {
  const c = context(s);
  const goals = c.all.filter((n) => n.type === "goal").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const tasks: TaskProgress[] = [];
  const without: ProjectProgress["without"] = [];
  for (const g of goals) {
    const t = computeTask(c, g);
    if (t) tasks.push(t);
    else without.push({ task: g.id, title: g.title });
  }
  // Criteria that name a task whose node is gone or no longer a task (deleted or changed by hand): that task counts
  // as 0 % — removing a task's node never lifts the project (review 2, M-1).
  const known = new Set(goals.map((g) => g.id));
  const orphan = new Map<string, TaskProgress["unsettled"]>();
  const add = (task: string | undefined, u: TaskProgress["unsettled"][number]) => {
    if (!task || known.has(task)) return;
    const l = orphan.get(task) ?? [];
    if (!l.some((x) => x.id === u.id)) l.push(u);
    orphan.set(task, l);
  };
  for (const e of c.canon) if (e.kind === "future" && e.task && ["active", "proposed", "tampered", "untrusted"].includes(e.status)) add(e.task, { id: e.id, text: e.text, status: e.status === "active" ? "missing" : e.status });
  for (const [id, a] of Object.entries(c.anchors)) if (a.status === "active") add(a.task, { id, text: c.canon.find((e) => e.id === id)?.text ?? a.text ?? "", status: "missing" });
  for (const [id, unsettled] of orphan) {
    const derivation = derive(`progress.${id}`, "progress/1", { criteria: [], gates: PROGRESS_GATES.map((g) => `${g.cap} open`) });
    tasks.push({
      task: id,
      title: "",
      status: "missing",
      hasGoal: false,
      offLine: false,
      tip: id,
      criteria: [],
      unsettled,
      gates: PROGRESS_GATES.map((g) => ({ cap: g.cap, met: false, name: g.name })),
      value: 0,
      derivation,
      next: tx(`Die Aufgabe ${id} fehlt oder wurde außerhalb von Scenaria geändert. Mustere ihre Kriterien aus (${unsettled.map((u) => u.id).join(", ")}).`, `Task ${id} is missing or was changed outside Scenaria. Retire its criteria (${unsettled.map((u) => u.id).join(", ")}).`),
      nextAgent: `Task ${id} is missing or was changed outside Scenaria; the person retires its criteria (${unsettled.map((u) => u.id).join(", ")}).`,
    });
  }
  const derivation = derive("progress.project", "progress-project/1", {
    tasks: tasks.map((t) => `${t.task} p=${t.value}`),
    without: without.map((w) => w.task),
  });
  return { value: derivation.value, derivation, tasks, without, abandoned: tasks.filter((t) => t.status === "abandoned").map((t) => t.task) };
}

/**
 * Batch E4: the progress at one moment, as recorded at a window change (windows.jsonl). Only the inputs of each task's
 * progress/1 are kept — the value is computed again from them whenever it is read (never a bare number). `focus` is
 * the task of HEAD (the task the work is on).
 */
export interface ProgressSnapshot {
  /** Only tasks with approved criteria (others have no progress to measure). `waiting`: the next step is the person's. */
  tasks: { task: string; criteria: string[]; gates: string[]; waiting?: boolean }[];
  focus: string | null;
}

/**
 * Is the task's next step the person's (E4a review M5)? Gate 20 while an approved criterion waits for its weight;
 * gates 80, 90 and 100 (the person starts the checks, confirms, accepts). A window then cannot show progress by
 * itself. A proposal of the agent's own does not count: the agent could otherwise switch the rule off (review 2, H3).
 */
export function waitsForPerson(t: TaskProgress): boolean {
  const blocked = t.gates.find((g) => !g.met)?.cap ?? null;
  if (blocked === 20) return t.criteria.some((c) => c.weight === null);
  return blocked === 80 || blocked === 90 || blocked === 100;
}

export function progressSnapshot(s: Scenaria): ProgressSnapshot {
  const p = projectProgress(s);
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  const tasks = p.tasks
    .filter((t) => t.criteria.length > 0)
    .map((t) => {
      const inp = Object.fromEntries(t.derivation.inputs.map((i) => [i.name, i.value]));
      return { task: t.task, criteria: list(inp.criteria), gates: list(inp.gates), ...(waitsForPerson(t) ? { waiting: true } : {}) };
    });
  let focus: string | null = null;
  try {
    const head = s.head();
    focus = head ? (s.currentTask(head.id)?.id ?? null) : null;
  } catch {
    focus = null;
  }
  return { tasks, focus };
}

/** For agents and the API: the derivations in the short form. */
export function progressForAgents(p: ProjectProgress): { value: number; why: CompactDerivation; tasks: (Omit<TaskProgress, "derivation"> & { why: CompactDerivation })[]; without: ProjectProgress["without"] } {
  return {
    value: p.value,
    why: compact(p.derivation),
    tasks: p.tasks.map(({ derivation, ...t }) => ({ ...t, why: compact(derivation) })),
    without: p.without,
  };
}

/** Plain text (CLI, agent tool). */
export function renderProgress(p: ProjectProgress, lang: "de" | "en" = "en", only?: string): string {
  const out: string[] = [];
  const ts = only ? p.tasks.filter((t) => t.task === only) : p.tasks;
  if (!only) out.push(`${lang === "de" ? "Projekt" : "Project"}: ${p.value} % — ${p.derivation.sentence[lang]}`);
  for (const t of ts) {
    out.push(`${t.task} ${t.title || (lang === "de" ? "(Aufgabe fehlt)" : "(task missing)")}: ${t.value} %${t.offLine ? (lang === "de" ? " (nicht auf dem aktuellen Weg)" : " (not on the current line)") : ""}${t.status === "abandoned" ? (lang === "de" ? " (aufgegeben – zählt mit, bis die Person die Kriterien ausmustert)" : " (abandoned — counts until the person retires its criteria)") : ""} — ${t.derivation.sentence[lang]}`);
    for (const x of t.criteria)
      out.push(`  - ${x.id} [${levelWord(x.level, lang)}, ${x.how}] w=${x.weight ?? "–"}${x.artifact ? ` ${x.artifact}` : ""}: ${x.text}${x.notes.length ? ` (${x.notes.map((n) => n[lang]).join("; ")})` : ""}`);
    for (const u of t.unsettled) out.push(`  - ${u.id} [${u.status}${lang === "de" ? ", zählt nicht" : ", not counted"}]: ${u.text}`);
    // The CLI in German is read by the person; in English by agents and people alike: the agents' wording.
    const nx = lang === "de" ? t.next?.de : t.nextAgent;
    if (nx) out.push(`  ${lang === "de" ? "Als Nächstes" : "Next"}: ${nx}`);
  }
  if (only && !ts.length) out.push(lang === "de" ? `${only} hat keine Kriterien – Fortschritt ist nicht messbar.` : `${only} has no criteria — progress cannot be measured.`);
  if (!only && p.without.length) out.push(`${lang === "de" ? "Ohne Kriterien (nicht messbar)" : "Without criteria (not measurable)"}: ${p.without.map((w) => w.task).join(", ")}`);
  return out.join("\n");
}
