/**
 * Batch E4: progress per window and the handover check (Kev's table C, 2026-10-17; his answers of 2026-10-24).
 *
 *   ≥ min points in a window                     normal handover
 *   < min points in one full window              a warning; the handover carries a problem note
 *   < min points in two full windows in a row    STOP (the same task): rewind, or the person decides
 *   first window of a task at red, gate 20 open  escalation: planning eats the window — split the task
 *
 * How it is measured — only from Scenaria's own records, deterministic:
 *   - A window is an agent's context window (window.ts). Windows of one agent and source form a line: a window's
 *     successor is the first window of the same line that starts after its last answer. Rows, warnings and stops are
 *     per line (E4a review M6). Known limits: parallel sessions of one agent can be taken for one another's
 *     successors; progress is the project's, so a window is credited with what other agents did meanwhile.
 *   - At every window change Scenaria records the progress (windows.jsonl, `progress` lines: only the inputs of each
 *     task's progress/1). The progress at a change is the newest record between the old window's last answer and the
 *     new window's first answer (Claude Code's session start records it there, before any work), else the record
 *     written when the new window was opened, if the new window answered after it.
 *   - window-progress/1: Σ over the tasks with criteria at the end (end − max(start, best so far with the same
 *     criteria)): going back and doing the same work again is no progress (review H4). A window with at least `min`
 *     points made progress — always. Below it only a FULL window (highest fill at or above yellow, or compacted), on a
 *     task WITH criteria whose next step is NOT the person's counts as "no progress" (Kev 2026-10-24; review M5).
 *     Everything else is not assessed and does not break a row. Each window is judged by the person's values in force
 *     when it ended (review M7).
 *   - handover-loss/1: context fidelity (line to the goal + connection) of the old window's last step against the
 *     mean of the new window's first k steps in the same task (Kev: k = 3; over the tolerance: a notice).
 *
 * A stop, once found, is noted outside the project (~/.config/scenaria/window-stops.json) and stays until the person
 * lifts it (signed): changing or deleting the window records does not end it (review H2). Windows that ended before
 * the newest lift no longer count. Enforcement (the PreToolUse hook) and the notices live in hooks.ts. The limit, said
 * plainly: the stop holds up an agent that is stuck, not one that changes Scenaria's configuration folder or hooks
 * outside its tools.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scenaria } from "./engine.js";
import { writeJsonAtomic, type Store } from "./store.js";
import { globalConfigPath } from "./global.js";
import { projectIdentity, publicKeyId, signRecord, verifyRecord } from "./canon.js";
import { compact, derive, formulaValue, gateLabel, progressParts, parseContextRule, parseWindowProgressRule, windowFull, windowVerdict, type CompactDerivation, type Derivation, type Lang2 } from "./derivation.js";
import { readContextSettings, settingsAt, type ContextSettings } from "./contextsettings.js";
import { windowStatus, type ProgressSnapInfo, type WindowInfo, type WindowStatus } from "./window.js";
import { progressSnapshot } from "./progress.js";
import type { FidelityPoint } from "./fidelity.js";
import type { ScenariaNode } from "./types.js";

export type AssessState = "running" | "progress" | "none" | "skipped";
/** Why a window is not assessed. */
export type SkipWhy = "not-full" | "no-fill" | "no-criteria" | "waiting" | "no-measure" | "changed-outside" | "no-work" | "capped";

export interface WindowAssessment {
  window: string;
  startedAt: string;
  key: string;
  agent: string;
  source: WindowInfo["source"];
  /** The line of windows it belongs to (source and agent). */
  line: string;
  state: AssessState;
  why?: SkipWhy;
  /** The points (window-progress/1; for a running window: so far). Null: not measurable. */
  value: number | null;
  /** The derivation of `value`. */
  points: Derivation | null;
  /** The task the window worked on last (with criteria), or null. */
  focus: string | null;
  /** Full (yellow or fuller, or compacted); null: the fill cannot be measured. */
  full: boolean | null;
  /** When it ended (its successor's start) and the successor. */
  endedAt: string | null;
  next: string | null;
  /** Ended before the person's newest lift of a stop: does not count for a new stop. */
  lifted: boolean;
  /** E5: the open gate that held the task's value (cap in %), when the window is not assessed because of it. */
  gate?: number;
  /** E5: how much the task rose without the cap (points), with `gate`. */
  rise?: number;
}

export interface HandoverCheck {
  from: string;
  fromStartedAt: string;
  to: string;
  toStartedAt: string;
  /** handover-loss/1 (null: no step to compare on one side, or the work moved to another task). */
  loss: Derivation | null;
  /** All k first steps are there (or the new window has ended): the result no longer changes. */
  final: boolean;
  ok: boolean | null;
}

export interface StopLift {
  at: string;
  by: string;
  via: "dashboard" | "terminal";
  why: string;
  windows: string[];
  task: string | null;
  keyId?: string;
}

export interface WindowStop {
  /** The two windows without progress, oldest first ("w3@<start>"). */
  windows: string[];
  task: string;
  /** The task's title when the stop was found (E5 review L8: people recognise a task by its title). */
  title?: string;
  /** When the stop began (the second window's end). */
  since: string;
  /** The line of windows (source and agent). */
  line: string;
  /** Only the note outside the project holds it now (the window records no longer show it, e.g. changed outside). */
  recorded?: boolean;
  /** One of its windows went on answering after another window of its line began: most likely two sessions at once — a hint to the person (review 3, M1). */
  likelyParallel?: boolean;
}

export interface WindowProgressStatus {
  rule: string;
  min: number;
  tolerance: number;
  k: number;
  /** Newest first. */
  windows: WindowAssessment[];
  stop: WindowStop | null;
  /** The newest ended window of a line had no progress (and there is no stop): the handover carries a problem note. */
  warning: WindowAssessment | null;
  /** E5: the newest ended window of a line was held at a gate (no stop, no warning): the agent hears which gate. */
  capped: WindowAssessment | null;
  /** Kev's row 4: the first window of a task is red or fuller and gate 20 is still open. */
  escalation: { window: string; task: string; fill: number } | null;
  /** A running window at red or fuller works on a task without criteria: progress cannot be measured. */
  noCriteria: { window: string; task: string | null } | null;
  /** The newest valid lift of a stop by the person. */
  lift: StopLift | null;
  /** Newest first (empty when not asked for). */
  handovers: HandoverCheck[];
  /** The records were changed outside: affected windows are not assessed. */
  changed: WindowStatus["changed"];
  /** E5 review L11 (set by the server): is the hook before every tool wired? Without it a stop is not enforced. */
  hookWired?: boolean;
}

const ref = (w: { id: string; startedAt: string }) => `${w.id}@${w.startedAt}`;
const lineOf = (w: { source: string; agent: string }) => `${w.source}|${w.agent}`;
const pText = (t: { task: string; value: number }) => `${t.task} p=${t.value}`;
/** The criteria a task's progress was computed with (id and weight): a new set makes a new scale. */
const critKey = (t: { criteria: string[] }) =>
  t.criteria
    .map((c) => c.split(" ").slice(0, 2).join(" "))
    .sort()
    .join("|");

// ------------------------------------------------------------------ outside the project: lifts (signed) and noted stops

const stopsFile = () => join(dirname(globalConfigPath()), "window-stops.json");
function folderOf(store: Store): string {
  try {
    return realpathSync(store.root);
  } catch {
    return store.root;
  }
}
const projectKey = (store: Store, create: boolean) => {
  const pid = projectIdentity(store, create);
  return pid ? `${pid}:${folderOf(store)}` : "";
};
const liftParts = (folder: string, l: StopLift) => ["window-stop-lift/v1", folder, l.at, l.by, l.via, l.why, l.windows, l.task];
function readAll(): Record<string, any> {
  try {
    const raw = JSON.parse(readFileSync(stopsFile(), "utf8"));
    return raw?.projects && typeof raw.projects === "object" && !Array.isArray(raw.projects) ? raw.projects : {};
  } catch {
    return {};
  }
}
function writeRecord(store: Store, fn: (rec: { lifts: any[]; stops: any[] }) => void) {
  const key = projectKey(store, true);
  if (!key) return;
  const all = readAll();
  const cur = all[key] && typeof all[key] === "object" ? all[key] : {};
  const rec = { lifts: Array.isArray(cur.lifts) ? cur.lifts : [], stops: Array.isArray(cur.stops) ? cur.stops : [] };
  fn(rec);
  all[key] = { lifts: rec.lifts.slice(-200), stops: rec.stops.slice(-200) };
  writeJsonAtomic(stopsFile(), { version: 1, projects: all });
}

/** The person's lifts of this project that verify, oldest first. A lift that does not verify does not count. */
export function readLifts(store: Store): StopLift[] {
  try {
    const key = projectKey(store, false);
    const rec = key ? readAll()[key] : undefined;
    const list: any[] = Array.isArray(rec?.lifts) ? rec.lifts : [];
    const folder = folderOf(store);
    return list
      .filter(
        (l) =>
          l &&
          typeof l.at === "string" &&
          typeof l.by === "string" &&
          (l.via === "dashboard" || l.via === "terminal") &&
          typeof l.why === "string" &&
          Array.isArray(l.windows) &&
          l.windows.every((w: unknown) => typeof w === "string") &&
          (l.task === null || typeof l.task === "string"),
      )
      .map((l) => ({ at: l.at, by: l.by, via: l.via, why: l.why, windows: l.windows, task: l.task, pub: l.pub, sig: l.sig }))
      .filter((l) => verifyRecord(store, liftParts(folder, l), l.pub, l.sig))
      .map(({ pub, ...l }) => ({ at: l.at, by: l.by, via: l.via, why: l.why, windows: l.windows, task: l.task, keyId: publicKeyId(pub) }))
      .sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

/** Stops noted outside the project (Scenaria's note, not signed: it only ever holds the work up). */
function readNoted(store: Store): (WindowStop & { noted: string })[] {
  try {
    const key = projectKey(store, false);
    const rec = key ? readAll()[key] : undefined;
    const list: any[] = Array.isArray(rec?.stops) ? rec.stops : [];
    return list
      .filter((x) => x && Array.isArray(x.windows) && x.windows.every((w: unknown) => typeof w === "string") && typeof x.task === "string" && typeof x.since === "string" && typeof x.noted === "string")
      .map((x) => ({ windows: x.windows, task: x.task, ...(typeof x.title === "string" && x.title ? { title: clean(x.title, 80) } : {}), since: x.since, line: typeof x.line === "string" ? x.line : "", noted: x.noted }));
  } catch {
    return [];
  }
}
function noteStop(store: Store, st: WindowStop) {
  try {
    if (readNoted(store).some((x) => x.windows.join(" ") === st.windows.join(" "))) return;
    writeRecord(store, (rec) => rec.stops.push({ windows: st.windows, task: st.task, ...(st.title ? { title: st.title } : {}), since: st.since, line: st.line, noted: new Date().toISOString() }));
  } catch {
    /* noting must never cost the reading */
  }
}
/** The noted stop still in force (noted after the newest lift), or null. Scenaria never takes one back by itself. */
function notedInForce(store: Store, lift: StopLift | null): WindowStop | null {
  const n = readNoted(store).filter((x) => !lift || x.noted > lift.at);
  const x = n[0];
  return x ? { windows: x.windows, task: x.task, ...(x.title ? { title: x.title } : {}), since: x.since, line: x.line, recorded: true } : null;
}

const clean = (x: unknown, max: number) => String(x ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The PERSON lifts the current stop (callers make sure a person acts: the approval session or an interactive
 * terminal). Refused without a stop (code "not_stopped") and without a reason (code "why"). Signed and kept outside
 * the project; logged as an event. It lifts every stop noted until now.
 */
export function liftStop(s: Scenaria, input: { why: string }, who: { by: string; via: "dashboard" | "terminal" }): WindowProgressStatus {
  return s.store.withLock(() => {
    const cur = windowProgress(s, { handovers: false });
    if (!cur.stop) throw Object.assign(new Error("there is no stop to lift"), { code: "not_stopped" });
    const why = clean(input?.why, 300);
    if (!why) throw Object.assign(new Error("say why the stop is lifted (e.g. the task was cut smaller)"), { code: "why" });
    const lift: StopLift = { at: new Date().toISOString(), by: clean(who.by, 80) || "person", via: who.via, why, windows: cur.stop.windows, task: cur.stop.task };
    const signed = signRecord(s.store, liftParts(folderOf(s.store), lift));
    writeRecord(s.store, (rec) => rec.lifts.push({ ...lift, keyId: publicKeyId(signed.pub), pub: signed.pub, sig: signed.sig }));
    s.store.appendEvent({
      type: "update",
      data: { message: `stop after two windows without progress (${cur.stop.windows.map((w) => w.split("@")[0]).join(", ")}, task ${cur.stop.task}) lifted by ${lift.by} via ${who.via}: ${why}`, windowStop: { lifted: cur.stop, by: lift.by, via: who.via, why } },
    });
    return windowProgress(s);
  });
}

// ------------------------------------------------------------------ the assessment

/** The line of windows of one agent and source, oldest first, with each window's successor and predecessor. */
function lines(ws: WindowInfo[]): { w: WindowInfo; prev: WindowInfo | null; next: WindowInfo | null }[] {
  const groups = new Map<string, WindowInfo[]>();
  for (const w of ws) {
    if (typeof w.firstAt !== "string" || typeof w.lastAt !== "string" || typeof w.startedAt !== "string") continue;
    const k = lineOf(w);
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  const out: { w: WindowInfo; prev: WindowInfo | null; next: WindowInfo | null }[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));
    // The successor: the first window that starts after this one's last answer (g is sorted by start). Through the
    // proxy only within one conversation (a compaction): another conversation of the same agent may run in parallel
    // (a second chat) and is no window change (review 2, H5). Claude Code's sessions follow one another (/clear, a
    // new session); two Claude Code sessions at once in one project can be taken for a window change (a known limit).
    const next = new Map<WindowInfo, WindowInfo | null>();
    for (let i = 0; i < g.length; i++) {
      const w = g[i];
      let n: WindowInfo | null = null;
      for (let j = i + 1; j < g.length && !n; j++) if (g[j].startedAt >= w.lastAt! && g[j].firstAt! > w.lastAt! && (w.source !== "proxy" || g[j].key === w.key)) n = g[j];
      next.set(w, n);
    }
    const prev = new Map<WindowInfo, WindowInfo>();
    for (const w of g) {
      const n = next.get(w);
      if (n) prev.set(n, w);
    }
    for (const w of g) out.push({ w, prev: prev.get(w) ?? null, next: next.get(w) ?? null });
  }
  return out;
}

/** The index of the last element with at ≤ t (snapshots sorted by time), -1 if none. */
function lastAtOrBefore(snaps: ProgressSnapInfo[], t: string): number {
  let lo = 0;
  let hi = snaps.length - 1;
  let r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (snaps[m].at <= t) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}
const minus15 = (t: string) => {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms - 15 * 60_000).toISOString() : t;
};

const withCriteria = (snap: ProgressSnapInfo) => snap.tasks.filter((t) => Array.isArray(t.criteria) && t.criteria.length > 0);

/**
 * Progress per window, the stop, the warning, the escalation and the handover checks. A stop found is noted outside
 * the project (it stays until the person lifts it). Never throws.
 */
export function windowProgress(s: Scenaria, opts: { settings?: ContextSettings; handovers?: boolean; pending?: { source: WindowInfo["source"]; agent: string } } = {}): WindowProgressStatus {
  const cs = opts.settings ?? readContextSettings(s.store);
  const r = parseWindowProgressRule(cs.progressRule);
  const lifts = readLifts(s.store);
  const lift = lifts.length ? lifts[lifts.length - 1] : null;
  const empty: WindowProgressStatus = { rule: cs.progressRule, min: r.min, tolerance: r.tolerance, k: r.k, windows: [], stop: null, warning: null, capped: null, escalation: null, noCriteria: null, lift, handovers: [], changed: null };
  let ws: WindowStatus;
  try {
    ws = windowStatus(s, { settings: cs, limit: Number.MAX_SAFE_INTEGER });
  } catch {
    return { ...empty, stop: notedInForce(s.store, lift) };
  }
  // At a session start (E4b): the agent's newest window ends now — a new one is about to begin (a stand-in, not shown).
  if (opts.pending) {
    const now = new Date().toISOString();
    ws = { ...ws, windows: [...ws.windows, { id: "w-new", source: opts.pending.source, agent: opts.pending.agent, key: "(new)", start: "new-session", startedAt: now, firstAt: now, lastAt: now, model: null, samples: 1, tokens: null, maxTokens: null, measurable: false, rule: cs.rule, cuts: [] }] };
  }
  try {
    const r = assessAll(s, ws, cs, lift, opts, empty);
    return opts.pending ? { ...r, windows: r.windows.filter((a) => a.window !== "w-new") } : r;
  } catch {
    // Records from outside must never make the reading fail (review H1): what holds is the noted stop.
    return { ...empty, changed: ws.changed, stop: notedInForce(s.store, lift) };
  }
}

function assessAll(s: Scenaria, ws: WindowStatus, cs: ContextSettings, lift: StopLift | null, opts: { handovers?: boolean; pending?: unknown }, empty: WindowProgressStatus): WindowProgressStatus {
  const snaps = ws.snapshots.filter((x) => typeof x.at === "string" && x.at).sort((a, b) => a.at.localeCompare(b.at));
  const tagged = new Map<string, ProgressSnapInfo[]>();
  const byKey = new Map<string, ProgressSnapInfo[]>();
  for (const x of snaps) {
    if (x.w && x.ws) tagged.set(`${x.w}@${x.ws}`, [...(tagged.get(`${x.w}@${x.ws}`) ?? []), x]);
    if (x.by === "session-start" && x.key) byKey.set(x.key, [...(byKey.get(x.key) ?? []), x]);
  }
  const boundary = (p: WindowInfo | null, n: WindowInfo): ProgressSnapInfo | null => {
    // The start of the new window's own session (Claude Code: recorded before any work, review 2, L12).
    if (n.firstAt) {
      const own = (byKey.get(n.key) ?? []).filter((x) => x.at <= n.firstAt! && (!p?.lastAt || x.at >= p.lastAt));
      if (own.length) return own[own.length - 1];
    }
    // Else, without a window before it in its line: a record from shortly before, not one of days ago.
    const after = p?.lastAt ?? minus15(n.startedAt);
    if (n.firstAt) {
      const i = lastAtOrBefore(snaps, n.firstAt);
      if (i >= 0 && snaps[i].at >= after) return snaps[i];
    }
    return (tagged.get(`${n.id}@${n.startedAt}`) ?? []).find((x) => x.at >= after && n.lastAt !== null && x.at <= n.lastAt) ?? null;
  };
  const chain = lines(ws.windows);
  const now = new Date().toISOString();
  let live: ProgressSnapInfo | null | undefined;
  const liveSnap = (): ProgressSnapInfo | null => {
    if (live !== undefined) return live;
    try {
      const p = progressSnapshot(s);
      live = { at: now, by: "open", tasks: p.tasks.map((t) => ({ ...t, waiting: t.waiting === true, value: formulaValue("progress/1", { criteria: t.criteria, gates: t.gates }) })), focus: p.focus };
    } catch {
      live = null;
    }
    return live;
  };

  // The boundaries first, then the best level of every task before each start (one pass over the records).
  const plan = chain.map((c) => ({ c, start: c.w.why === "changed-outside" ? null : boundary(c.prev, c.w), end: c.next ? (c.next.why === "changed-outside" ? null : boundary(c.w, c.next)) : null }));
  const need = new Set(plan.map((x) => x.start).filter((x): x is ProgressSnapInfo => x !== null));
  const bestAt = new Map<ProgressSnapInfo, Map<string, number>>();
  const run = new Map<string, number>();
  for (const x of snaps) {
    // After the person's lift the bar starts again: redoing work after the rewind the stop advised counts (review 2, M7).
    if (lift && x.at <= lift.at) {
      if (need.has(x)) bestAt.set(x, new Map());
      continue;
    }
    for (const t of withCriteria(x)) {
      const k = `${t.task}|${critKey(t)}`;
      run.set(k, Math.max(run.get(k) ?? 0, t.value));
    }
    if (need.has(x)) bestAt.set(x, new Map(run));
  }

  // E5: the agent's recorded steps per window (decisions, checkpoints, saves, branches) — not clarifying questions and
  // plans (captured as the person's), not Scenaria's own records.
  let workAt: string[] | null = null;
  const stepsIn = (from: string, to: string): number | null => {
    if (workAt === null) {
      try {
        workAt = s.store
          .listNodes()
          .filter((n) => ["decision", "checkpoint", "autosave", "branch"].includes(n.type) && n.agent !== "scenaria" && n.agent !== "user" && typeof n.createdAt === "string")
          .map((n) => n.createdAt)
          .sort();
      } catch {
        return null;
      }
    }
    return workAt.filter((t) => t >= from && t < to).length;
  };
  const assess = ({ c: { w, next }, start, end: endRec }: (typeof plan)[number]): WindowAssessment => {
    // The values in force at the window's last answer — the same time point the window list measures it at, so both
    // show one fill (E5 re-check N2).
    const at = settingsAt(cs, w.lastAt ?? now, !next);
    const yellow = parseContextRule(at.rule).yellow;
    const compacted = w.end === "compact" || w.end === "drop";
    const peak = typeof w.peak === "number" ? w.peak : typeof w.maxTokens === "number" && typeof w.cMax === "number" ? formulaValue("context-fill/1", { tokens: w.maxTokens, cMax: w.cMax, aModel: at.aModel, soft: 0, rule: at.rule }) : null;
    const full = windowFull({ peak, yellow, compacted });
    const base = { window: w.id, startedAt: w.startedAt, key: w.key, agent: w.agent, source: w.source, line: lineOf(w), endedAt: next?.startedAt ?? null, next: next?.id ?? null, full };
    const lifted = Boolean(lift && next && next.startedAt <= lift.at);
    const skip = (why: SkipWhy, value: number | null = null, points: Derivation | null = null, focus: string | null = null): WindowAssessment => ({ ...base, state: "skipped", why, value, points, focus, lifted });
    if (w.why === "changed-outside" || next?.why === "changed-outside") return skip("changed-outside");
    const end = next ? endRec : liveSnap();
    if (!start || !end) return next ? skip("no-measure") : { ...base, state: "running", value: null, points: null, focus: null, lifted: false };
    const tasks = withCriteria(end);
    const ft = end.focus ? tasks.find((t) => t.task === end.focus) : undefined;
    const best = bestAt.get(start) ?? new Map<string, number>();
    // E5: the focus task without the gates' cap — a window held at a gate is not assessed (Kev 2026-10-25).
    const st = ft ? withCriteria(start).find((t) => t.task === ft.task) : undefined;
    const pe = ft ? progressParts(ft.criteria, ft.gates) : null;
    const held = pe && pe.blocked !== null && pe.raw > pe.cap ? pe.blocked : null;
    // A work step: an answer that used a tool, or a step the agent recorded. Unknown for older records: assessed.
    const nodesIn = next ? stepsIn(w.startedAt, next.startedAt) : null;
    const steps = nodesIn === null || typeof w.toolAnswers !== "number" ? (nodesIn ? nodesIn : null) : nodesIn + w.toolAnswers;
    const values = {
      start: start.tasks.map(pText),
      best: tasks.flatMap((t) => (best.has(`${t.task}|${critKey(t)}`) ? [`${t.task} p=${best.get(`${t.task}|${critKey(t)}`)}`] : [])),
      end: tasks.map(pText),
      focus: ft?.task ?? "",
      waiting: ft?.waiting === true,
      peak,
      yellow,
      compacted,
      rule: next ? at.progressRule : cs.progressRule,
      ...(next ? {} : { running: true }),
      ...(steps !== null ? { steps } : {}),
      ...(held !== null && ft ? { rawStart: st ? `${ft.task} r=${progressParts(st.criteria, st.gates).raw}` : "", rawEnd: `${ft.task} r=${pe!.raw}`, gate: held } : {}),
    };
    const value = formulaValue("window-progress/1", values);
    const points = derive("window.progress", "window-progress/1", values);
    const focus = ft?.task ?? null;
    if (!next) return { ...base, state: "running", value, points, focus, lifted: false };
    const v = windowVerdict(values, value);
    if (v === "progress") return { ...base, state: "progress", value, points, focus, lifted };
    if (v === "none") return { ...base, state: "none", value, points, focus, lifted };
    if (v === "capped") {
      const rise = pe!.raw - (st ? progressParts(st.criteria, st.gates).raw : 0);
      return { ...skip(v, value, points, focus), gate: held!, rise };
    }
    return skip(v, value, points, focus);
  };
  const all = plan.map((x) => ({ c: x.c, a: assess(x) }));

  // Rows of windows without progress, per line (review M6), in the order they ended; windows not assessed do not
  // break a row; the two windows of a stop worked on the same task.
  let stop: WindowStop | null = null;
  let warning: WindowAssessment | null = null;
  let capped: WindowAssessment | null = null;
  const byLine = new Map<string, WindowAssessment[]>();
  for (const { a } of all) if (a.endedAt && !a.lifted) byLine.set(a.line, [...(byLine.get(a.line) ?? []), a]);
  for (const list of byLine.values()) {
    list.sort((x, y) => String(x.endedAt).localeCompare(String(y.endedAt)));
    let row: WindowAssessment[] = [];
    let found: WindowStop | null = null;
    let newest: WindowAssessment | null = null;
    let newestHeld: WindowAssessment | null = null;
    for (const a of list) {
      if (a.state === "skipped") {
        newestHeld = a.why === "capped" ? a : a.why === "no-work" ? newestHeld : null;
        continue;
      }
      newest = a;
      newestHeld = null;
      if (found) continue;
      if (a.state === "progress") row = [];
      else if (a.state === "none") {
        row = row.length && row[0].focus === a.focus ? [...row, a] : [a];
        if (row.length >= 2) found = { windows: row.slice(-2).map((x) => ref({ id: x.window, startedAt: x.startedAt })), task: a.focus!, ...titleOf(s, a.focus!), since: a.endedAt!, line: a.line };
      }
    }
    if (found && (!stop || found.since < stop.since)) stop = found;
    if (!found && !newestHeld && newest?.state === "none" && (!warning || String(newest.endedAt) > String(warning.endedAt))) warning = newest;
    if (!found && newestHeld && (!capped || String(newestHeld.endedAt) > String(capped.endedAt))) capped = newestHeld;
  }
  // Noted outside the project — not from the stand-in view at a session start (review 2, H5): only when the new window
  // has answered. A noted stop stays until the person lifts it, whatever the records show later (review H2; Scenaria
  // never takes a stop back by itself — review 2, H4).
  if (stop && !opts.pending) noteStop(s.store, stop);
  stop ??= notedInForce(s.store, lift);
  if (stop) {
    warning = null;
    // A window of the stop that answered again after another window of its line began: two sessions at once, most likely.
    const byRef = new Map(ws.windows.map((w) => [`${w.id}@${w.startedAt}`, w]));
    const parallel = stop.windows.some((r) => {
      const w = byRef.get(r);
      return Boolean(w && w.lastAt && ws.windows.some((x) => x !== w && lineOf(x) === lineOf(w) && x.startedAt > w.startedAt && x.startedAt < w.lastAt!));
    });
    if (parallel) stop = { ...stop, likelyParallel: true };
  }

  // Row 4 and the hint without criteria: the running windows at red or fuller.
  let escalation: WindowProgressStatus["escalation"] = null;
  let noCriteria: WindowProgressStatus["noCriteria"] = null;
  {
    const red = parseContextRule(cs.rule).red;
    for (const { c, a } of all) {
      if (a.state !== "running" || !c.w.fill || c.w.fill.value < red) continue;
      const now = liveSnap();
      if (!now) continue;
      const task = now.focus;
      const t = task ? now.tasks.find((x) => x.task === task && x.criteria.length > 0) : undefined;
      if (!t) {
        noCriteria ??= { window: c.w.id, task };
        continue;
      }
      const gate20 = t.gates.some((g) => /^20 met\b/.test(g));
      const earlier = all.some((x) => x.a !== a && x.a.endedAt && x.a.focus === task);
      if (!gate20 && !earlier) escalation ??= { window: c.w.id, task: task!, fill: c.w.fill.value };
    }
  }

  return {
    ...empty,
    windows: all.map((x) => x.a).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    stop,
    warning,
    capped: stop ? null : capped,
    escalation,
    noCriteria,
    handovers: opts.handovers === false ? [] : handoverChecks(s, chain, cs),
    changed: ws.changed,
  };
}

/** The handover checks of every window change (newest first). */
function handoverChecks(s: Scenaria, chain: ReturnType<typeof lines>, cs: ContextSettings): HandoverCheck[] {
  const pairs = chain.filter((c) => c.next).map((c) => ({ from: c.w, to: c.next!, after: chain.find((x) => x.w === c.next)?.next ?? null }));
  if (!pairs.length) return [];
  let points: Record<string, FidelityPoint>;
  let nodes: ScenariaNode[];
  try {
    points = s.fidelity().points as Record<string, FidelityPoint>;
    nodes = s.store.listNodes();
  } catch {
    return [];
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const taskOf = (n: ScenariaNode): string | null => {
    const seen = new Set<string>();
    for (let cur: ScenariaNode | undefined = n; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      seen.add(cur.id);
      if (cur.type === "goal") return cur.id;
    }
    return null;
  };
  // Steps of the work: no tasks (a new task is a new start), no automatic saves, nothing Scenaria wrote itself, no
  // step too short to judge, nothing changed outside Scenaria.
  const steps = nodes
    .filter((n) => n.parentId && n.type !== "goal" && n.type !== "mission" && n.type !== "autosave" && n.agent !== "scenaria")
    .filter((n) => {
      const p = points[n.id];
      return p && !p.flags.includes("lowSignal") && !p.flags.includes("tampered") && !p.flags.includes("builtOnTampered");
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const asInput = (id: string) => {
    const p = points[id];
    return `${id} a=${p.anchor === null ? "-" : p.anchor} c=${p.continuity}`;
  };
  const out: HandoverCheck[] = pairs.map(({ from, to, after }) => {
    // The values in force at the window change: a tolerance set later never changes an earlier check (E5 review L9).
    const rule = settingsAt(cs, to.startedAt).progressRule;
    const { tolerance: tol, k } = parseWindowProgressRule(rule);
    const before = steps.filter((n) => String(n.createdAt) >= from.startedAt && String(n.createdAt) < to.startedAt).pop();
    // Only the same task: work that moved on to another task is a new start, not a handover (review, note).
    const task = before ? taskOf(before) : null;
    const next = steps.filter((n) => String(n.createdAt) >= to.startedAt && (!after || String(n.createdAt) < after.startedAt) && taskOf(n) === task).slice(0, k);
    const final = next.length >= k || Boolean(after);
    if (!before || !next.length) return { from: from.id, fromStartedAt: from.startedAt, to: to.id, toStartedAt: to.startedAt, loss: null, final, ok: null };
    const loss = derive("window.handover", "handover-loss/1", { before: [asInput(before.id)], after: next.map((n) => asInput(n.id)), rule });
    return { from: from.id, fromStartedAt: from.startedAt, to: to.id, toStartedAt: to.startedAt, loss, final, ok: loss.value <= tol };
  });
  return out.sort((a, b) => b.toStartedAt.localeCompare(a.toStartedAt));
}

/**
 * The stop in force, for the PreToolUse hook (every tool call): only the note outside the project and the person's
 * lifts are read — cheap, whatever the length of the records (E4a review H3). The note is written when the stop is
 * computed: when a window starts (`evaluateStop`, called after recording its first answers) and whenever progress
 * per window is shown.
 */
export function stopState(s: { store: Store }): WindowStop | null {
  try {
    const lifts = readLifts(s.store);
    return notedInForce(s.store, lifts.length ? lifts[lifts.length - 1] : null);
  } catch {
    return null;
  }
}

/** Compute progress per window now and note a stop (after a window's first answers were recorded). Never throws. */
export function evaluateStop(s: Scenaria): WindowStop | null {
  try {
    return windowProgress(s, { handovers: false }).stop;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ text

const WHY_TEXT: Record<SkipWhy, Lang2> = {
  "not-full": { de: "nicht voll – wird nicht bewertet", en: "not full – not assessed" },
  "no-fill": { de: "Füllung nicht messbar – wird nicht bewertet", en: "fill not measurable – not assessed" },
  "no-criteria": { de: "Aufgabe ohne Fertig-Kriterien – wird nicht bewertet", en: "task without completion criteria – not assessed" },
  waiting: { de: "der nächste Schritt liegt bei der Person – wird nicht bewertet", en: "the next step is the person's – not assessed" },
  "no-measure": { de: "kein Fortschritt beim Wechsel gemessen", en: "no progress measured at the change" },
  "changed-outside": { de: "Messdaten außerhalb geändert – wird nicht bewertet", en: "measurement changed outside – not assessed" },
  "no-work": { de: "kein Arbeitsschritt im Fenster – wird nicht bewertet", en: "no work step in the window – not assessed" },
  capped: { de: "von einem offenen Tor gedeckelt – wird nicht bewertet", en: "held by an open gate – not assessed" },
};
export const skipText = (why: SkipWhy, lang: "de" | "en") => WHY_TEXT[why][lang];
const ids = (st: WindowStop) => st.windows.map((w) => w.split("@")[0]).join(", ");
const when = (t: string) => t.slice(0, 16).replace("T", " ");

/** The agent's notice during a stop (English: agents read hook output in English). */
/** A task's title for the texts (never throws). */
function titleOf(s: Scenaria, id: string): { title?: string } {
  try {
    const t = s.store.hasNode(id) ? s.store.readNode(id).title : undefined;
    return typeof t === "string" && t.trim() ? { title: t.trim().slice(0, 80) } : {};
  } catch {
    return {};
  }
}
const named = (st: WindowStop, lang: "de" | "en" = "en") => {
  const t = typeof st.title === "string" && st.title ? st.title.replace(/["“”„]/g, "'") : "";
  return `${st.task}${t ? (lang === "de" ? ` „${t}“` : ` "${t}"`) : ""}`;
};
export function stopAgentText(st: WindowStop): string {
  return `[Scenaria stop] Two full context windows in a row (${ids(st)}) made less than the minimum progress on task ${named(st)} (how computed: scenaria_window). Until the person lifts the stop, only reading and the Scenaria tools are allowed. Do not keep trying: rewind to the last good step (scenaria_last_good, scenaria_rewind) or ask the person — the task is most likely too large or cut wrong.`;
}
/** The person's notice during a stop. */
export function stopPersonText(st: WindowStop, lang: "de" | "en"): string {
  return lang === "de"
    ? `Scenaria: Stopp. Zwei volle Kontextfenster hintereinander (${ids(st)}) haben an der Aufgabe ${named(st, "de")} zu wenig Fortschritt gebracht. Die KI darf jetzt nur noch lesen und Scenaria nutzen. Bitte schneide die Aufgabe kleiner oder lass die KI zu einem guten Stand zurückspringen. Danach hebst du den Stopp auf (Dashboard → Kontextfenster, oder: scenaria window stop lift). Ist die Aufgabe gar nicht mehr die Arbeit, schließe sie im Dashboard (entsperrt: erledigt oder verworfen).${st.likelyParallel ? " Hinweis: Das sieht nach zwei gleichzeitigen Sitzungen aus – dann ist der Stopp wohl falsch; hebe ihn einfach auf." : ""}`
    : `Scenaria: stop. Two full context windows in a row (${ids(st)}) made too little progress on task ${named(st)}. The AI may now only read and use Scenaria. Please cut the task smaller or have the AI rewind to a good state, then lift the stop (dashboard → context window, or: scenaria window stop lift). If the task is no longer the work at all, close it in the dashboard (unlocked: done or abandoned).${st.likelyParallel ? " Note: this looks like two sessions at once — then the stop is most likely wrong; just lift it." : ""}`;
}
/** E5: a window held at a gate — the agent hears which gate holds the work (English, for agents). */
export function cappedAgentText(a: WindowAssessment): string {
  return `Note: in the previous window ${a.window} task ${a.focus} rose by ${a.rise ?? 0} points, but the open gate "${gateLabel(a.gate ?? 0, "en")}" (${a.gate} %) holds its progress — that work only counts once the gate is met (scenaria_progress shows what the gate needs).`;
}
/** The problem note for the next window (warning), the escalation and the hint without criteria — for agents. */
export function noteAgentText(wp: WindowProgressStatus): string | null {
  const parts: string[] = [];
  if (wp.warning)
    parts.push(
      `Problem note: the previous window ${wp.warning.window} made ${wp.warning.value ?? 0} points of progress in total (minimum ${wp.min}; it worked last on task ${wp.warning.focus}). Check why before going on (scenaria_progress shows what is missing); if the next full window makes too little progress on this task as well, Scenaria stops the work.`,
    );
  if (wp.capped) parts.push(cappedAgentText(wp.capped));
  if (wp.escalation) parts.push(`Escalation: window ${wp.escalation.window} is ${wp.escalation.fill} % full and task ${wp.escalation.task} has not passed the 20 % gate (criteria weighted and approach decided) — planning eats the window. Ask the person to split the task.`);
  if (wp.noCriteria) parts.push(`Task ${wp.noCriteria.task ?? "(none)"} has no completion criteria: Scenaria cannot measure its progress per window. Propose criteria (future fixed points with this task and a weight).`);
  return parts.length ? parts.join(" ") : null;
}
export function notePersonText(wp: WindowProgressStatus, lang: "de" | "en"): string | null {
  const de = lang === "de";
  if (wp.escalation)
    return de
      ? `Scenaria: Das erste Fenster der Aufgabe ${wp.escalation.task} ist zu ${String(wp.escalation.fill).replace(".", ",")} % voll, und der Lösungsweg steht noch nicht fest (Tor 20 %). Die Planung frisst das Fenster – bitte zerlege die Aufgabe.`
      : `Scenaria: the first window of task ${wp.escalation.task} is ${wp.escalation.fill} % full and the approach is not settled yet (gate 20 %). Planning eats the window – please split the task.`;
  return null;
}

/** The handover's problem note (prepareHandover), English. */
export function handoverNote(wp: WindowProgressStatus): string | null {
  if (wp.stop) return stopAgentText(wp.stop);
  return noteAgentText(wp);
}

const sign = (x: number, lang: "de" | "en") => `${x > 0 ? `+${x}` : x} ${lang === "de" ? (Math.abs(x) === 1 ? "Punkt" : "Punkte") : Math.abs(x) === 1 ? "point" : "points"}`;

/** Plain text for the console and agents. */
export function renderWindowProgress(wp: WindowProgressStatus, lang: "de" | "en" = "en"): string {
  const de = lang === "de";
  const out: string[] = [];
  out.push(
    de
      ? `Fortschritt pro Fenster (Regel ${wp.rule.split(" ")[0]}: mindestens ${wp.min} Punkte je vollem Fenster, Übergabe-Toleranz ${wp.tolerance} Punkte, erste ${wp.k} Schritte):`
      : `Progress per window (rule ${wp.rule.split(" ")[0]}: at least ${wp.min} points per full window, handover tolerance ${wp.tolerance} points, first ${wp.k} steps):`,
  );
  if (wp.stop)
    out.push(
      de
        ? `STOPP seit ${when(wp.stop.since)}: ${ids(wp.stop)} ohne Fortschritt an ${wp.stop.task}.${wp.stop.recorded ? " Die Fenster-Daten zeigen das nicht mehr (geändert?); der Stopp bleibt trotzdem." : ""}${wp.stop.likelyParallel ? " Sieht nach zwei gleichzeitigen Sitzungen aus – dann ist der Stopp wohl falsch." : ""} Nur die Person hebt ihn auf (scenaria window stop lift).`
        : `STOP since ${when(wp.stop.since)}: ${ids(wp.stop)} without progress on ${wp.stop.task}.${wp.stop.recorded ? " The window data no longer shows it (changed?); the stop stays all the same." : ""}${wp.stop.likelyParallel ? " This looks like two sessions at once — then the stop is most likely wrong." : ""} Only the person lifts it (scenaria window stop lift).`,
    );
  else if (wp.warning)
    out.push(de ? `Warnung: ${wp.warning.window} ohne Fortschritt an ${wp.warning.focus}; ein zweites volles Fenster ohne Fortschritt führt zum Stopp.` : `Warning: ${wp.warning.window} without progress on ${wp.warning.focus}; a second full window without progress leads to a stop.`);
  if (wp.changed && wp.changed.by !== "restarted")
    out.push(de ? "Achtung: Die Fenster-Daten wurden außerhalb von Scenaria geändert; betroffene Fenster werden nicht bewertet. Ein Stopp bleibt bestehen." : "Warning: the window data was changed outside Scenaria; affected windows are not assessed. A stop stays in force.");
  else if (wp.changed) out.push(de ? "Hinweis: Die Messung wurde neu begonnen; ältere Fenster werden nicht bewertet." : "Note: the measurement started again; older windows are not assessed.");
  if (wp.escalation)
    out.push(de ? `Eskalation: ${wp.escalation.window} ist zu ${String(wp.escalation.fill).replace(".", ",")} % voll, Tor 20 % von ${wp.escalation.task} offen – Aufgabe zerlegen.` : `Escalation: ${wp.escalation.window} is ${wp.escalation.fill} % full, gate 20 % of ${wp.escalation.task} open – split the task.`);
  if (wp.lift) out.push(de ? `Zuletzt aufgehoben: ${when(wp.lift.at)} von ${wp.lift.by} (${wp.lift.why}).` : `Last lifted: ${when(wp.lift.at)} by ${wp.lift.by} (${wp.lift.why}).`);
  for (const a of wp.windows.slice(0, 10)) {
    const p = a.value !== null ? sign(a.value, lang) : de ? "keine Zahl" : "no number";
    const state =
      a.state === "running" ? (de ? "läuft (bisher)" : "running (so far)") : a.state === "progress" ? (de ? "Fortschritt" : "progress") : a.state === "none" ? (de ? "ohne Fortschritt" : "no progress") : `${skipText(a.why!, lang)}${a.why === "capped" && a.gate ? (de ? ` (Tor „${gateLabel(a.gate, "de")}“, ${a.gate} %)` : ` (gate "${gateLabel(a.gate, "en")}", ${a.gate} %)`) : ""}`;
    out.push(`  ${a.window} · ${a.agent}: ${p} – ${state}${a.lifted ? (de ? " (vor dem Aufheben)" : " (before the lift)") : ""}${a.points ? `\n    ${a.points.sentence[lang]}` : ""}`);
  }
  for (const h of wp.handovers.slice(0, 5)) {
    if (!h.loss) continue;
    out.push(`  ${de ? "Übergabe" : "Handover"} ${h.from} → ${h.to}${h.final ? "" : de ? " (vorläufig)" : " (provisional)"}: ${h.loss.sentence[lang]}`);
  }
  return out.join("\n");
}

/** For agents and the API: the derivations in the short form. */
export function windowProgressForAgents(wp: WindowProgressStatus) {
  const c = (d: Derivation | null): CompactDerivation | null => (d ? compact(d) : null);
  return {
    rule: wp.rule,
    min: wp.min,
    tolerance: wp.tolerance,
    k: wp.k,
    stop: wp.stop,
    warning: wp.warning ? { window: wp.warning.window, focus: wp.warning.focus, points: wp.warning.value } : null,
    capped: wp.capped ? { window: wp.capped.window, focus: wp.capped.focus, gate: wp.capped.gate, rise: wp.capped.rise } : null,
    escalation: wp.escalation,
    noCriteria: wp.noCriteria,
    lift: wp.lift,
    windows: wp.windows.slice(0, 20).map((a) => ({ window: a.window, agent: a.agent, state: a.state, why: a.why, ...(a.gate ? { gate: a.gate } : {}), focus: a.focus, full: a.full, endedAt: a.endedAt, lifted: a.lifted, points: c(a.points) })),
    handovers: wp.handovers.slice(0, 10).map((h) => ({ from: h.from, to: h.to, final: h.final, ok: h.ok, loss: c(h.loss) })),
    changed: wp.changed,
  };
}
