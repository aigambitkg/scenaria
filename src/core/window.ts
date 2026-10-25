/**
 * Batch E3a-1: measuring how full an agent's context window is (Kev 2026-10-18, n75–n79). This module only measures;
 * acting on the value (automatic checkpoints, notices, the prepared handover) lives in windowact.ts (E3a-2).
 *
 * Where the numbers come from — only from the provider's token counts, never from an agent's tool call:
 *   - Claude Code transcripts: every main-line answer carries `message.usage`; fill = input + cache write + cache read
 *     of the last answer. Sub-agents (`isSidechain`) have their own window and are skipped. A compaction writes a
 *     `compact_boundary` line: the next answer is in a NEW window (start reason "compact").
 *   - The LLM proxy: the `usage` of each answer (JSON and streams). A fill that falls below half of the last one in the
 *     same conversation starts a new window (start reason "drop": the client most likely compacted).
 *   - MCP alone (Claude Desktop, other clients): no tokens → no window, no number ("not measurable here").
 *
 * Records: `.scenaria/windows.jsonl`, append-only lines, each with a chain hash over the previous line. Changes made
 * outside Scenaria show in three ways, and a window with a line that is not confirmed shows no number:
 *   1. the chain: a changed line breaks it (the line before the break is distrusted too: its own hash may be redone);
 *   2. the anchor outside the project (~/.config/scenaria/anchors/<project>.windows.json): after every append Scenaria
 *      notes the number of lines and the last chain hash. A rewritten file, a deleted file and lines added by someone
 *      else show; records without an anchor on this machine (anchor deleted, file brought in) are not confirmed;
 *   3. the end-of-turn checkpoint of the Claude Code hook stores the same in its `meta.windows`; that checkpoint is in
 *      the integrity ledger, so a rewrite shows even when the outside anchor was rewritten too.
 * When Scenaria appends and finds (1) or (2), it first writes a "reset" line: everything before it stays "changed
 * outside" for good, the measurement starts again after it. A checkpoint anchor from before a reset is passed over only
 * once a later, fitting checkpoint names that reset (a reset line written by hand hides nothing). Not detected: a
 * changed Claude Code transcript (outside the project, read as the provider wrote it). Numbers from a proxy upstream
 * the client names itself (`x-scenaria-upstream`) are not recorded.
 *
 * Values: `context-fill/1` and `context-soft/1` in derivation.ts; model sizes in models.ts.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import type { Scenaria } from "./engine.js";
import { windowAnchor } from "./canon.js";
import { compact, CONTEXT_ZONES, contextNextLimit, contextZone, derive, formulaValue, type ContextZone, type Derivation } from "./derivation.js";
import { lookupModel, MODEL_TABLE_VERSION, normaliseModel } from "./models.js";
import { describeSettings, readContextSettings, type ContextSettings } from "./contextsettings.js";
import { progressSnapshot, type ProgressSnapshot } from "./progress.js";

export type WindowSource = "transcript" | "proxy";
export type StartReason = "new-session" | "clear" | "resume" | "compact" | "drop" | "restart";

/** What a reader of a transcript or a proxy answer hands in. */
export type WindowEvent =
  | { kind: "sample"; at: string; tokens: number; model?: string; ref: string }
  | { kind: "boundary"; at: string; ref: string; trigger?: string; preTokens?: number };

type OpenLine = { t: "open"; w: string; at: string; source: WindowSource; key: string; agent: string; start: StartReason; trigger?: string; preTokens?: number; ref?: string };
type SampleLine = { t: "sample"; w: string; at: string; tokens: number; model?: string; ref: string };
/** Scenaria found the records changed outside and starts the measurement again after this line. */
type ResetLine = { t: "reset"; at: string; why: "rewritten" | "chain" | "foreign"; lines: number };
/**
 * Batch E4: the progress at a window change — written when a session starts (before its first answer) and when a
 * window is opened (`w`/`ws`: that window). Only the inputs of progress/1 are kept; the value is computed on reading.
 */
type ProgressLine = { t: "progress"; at: string; by: "session-start" | "open"; w?: string; ws?: string; key?: string } & ProgressSnapshot;
type Bare = OpenLine | SampleLine | ResetLine | ProgressLine;
type Line = Bare & { c: string };

const FILE = "windows.jsonl";
/** At most this many step sizes go into P95 (the newest). */
const MAX_STEPS = 200;

function chainOf(prev: string, l: Bare): string {
  return createHash("sha256").update(`${prev}|${JSON.stringify(l)}`).digest("hex").slice(0, 32);
}

interface Parsed {
  lines: Line[];
  /** 0-based index of the newest line whose chain does not fit the line before it. */
  lastBreak: number | null;
  /** The file exists but cannot be read as a file (e.g. a folder). */
  unreadable: boolean;
  /** Byte offset after the last complete line read; chain hash of the last line read. */
  offset: number;
  prev: string;
}

const CACHE = new Map<string, { ino: number; size: number; mtimeMs: number; at: number; p: Parsed }>();
const empty = (): Parsed => ({ lines: [], lastBreak: null, unreadable: false, offset: 0, prev: "" });

function parseInto(p: Parsed, text: string) {
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let l: Line | null = null;
    try {
      l = JSON.parse(raw);
    } catch {
      l = null;
    }
    // An unreadable line (half written when a process was killed) carries no data and is skipped; removing or
    // changing a real line breaks the chain of the next one.
    if (!l || typeof l !== "object" || (l.t !== "open" && l.t !== "sample" && l.t !== "reset" && l.t !== "progress") || typeof l.c !== "string") continue;
    const { c, ...rest } = l;
    if (chainOf(p.prev, rest as Bare) !== c) p.lastBreak = p.lines.length;
    p.prev = c;
    p.lines.push(l);
  }
}

/**
 * The parsed records. The append path reads only new bytes while the file only grew (a full read at least every
 * 30 s, like the ledger: an edit that keeps the size is found then); `fresh` always reads everything.
 */
function readLines(s: Scenaria, fresh = false): Parsed {
  const f = s.store.path(FILE);
  let st;
  try {
    st = statSync(f);
  } catch {
    CACHE.delete(f);
    return empty();
  }
  if (!st.isFile()) return { ...empty(), unreadable: true };
  const hit = CACHE.get(f);
  let p: Parsed;
  let from = 0;
  const incremental = !fresh && hit && hit.ino === st.ino && st.size >= hit.size && Date.now() - hit.at < 30_000;
  if (incremental) {
    if (st.size === hit!.size && st.mtimeMs === hit!.mtimeMs) return hit!.p;
    p = hit!.p;
    from = p.offset;
  } else p = empty();
  const len = st.size - from;
  const buf = Buffer.alloc(Math.max(0, len));
  if (len > 0) {
    const fd = openSync(f, "r");
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
  }
  const lastNl = buf.lastIndexOf(10);
  if (lastNl >= 0) {
    parseInto(p, buf.subarray(0, lastNl + 1).toString("utf8"));
    p.offset = from + lastNl + 1;
  }
  CACHE.set(f, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, at: incremental ? hit!.at : Date.now(), p });
  return p;
}

/**
 * Where the chain stands: stored in the end-of-turn checkpoint (meta.windows) so a rewrite shows later. `reset` is the
 * index of the newest reset line Scenaria wrote (-1: none): a reset is trusted only once such a checkpoint names it.
 */
export function windowsHead(s: Scenaria): { lines: number; head: string; reset: number } | null {
  const { lines } = readLines(s);
  return lines.length ? { lines: lines.length, head: lines[lines.length - 1].c, reset: lastResetOf(lines) } : null;
}

const lastResetOf = (lines: Line[]) => {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].t === "reset") return i;
  return -1;
};

/** What the outside anchor says about the records: fits, rewritten (or deleted), or lines were added by someone else. */
function anchorCheck(lines: Line[], a: { lines: number; head: string } | null): "none" | "missing" | "fits" | "rewritten" | "foreign" {
  // Records without an anchor on this machine were not confirmed here (the anchor deleted, or the file brought in).
  if (!a) return lines.length ? "missing" : "none";
  if (lines.length < a.lines || (a.lines > 0 && lines[a.lines - 1]?.c !== a.head)) return "rewritten";
  return lines.length > a.lines ? "foreign" : "fits";
}

/**
 * Record what a transcript or the proxy reported. Idempotent: an answer or boundary already recorded for this
 * conversation (same `ref`) is skipped, so re-reading a transcript from the start adds nothing. `continues` names the
 * ref of an earlier answer this request builds on (OpenAI `previous_response_id`): the answer joins that conversation.
 */
export function recordWindowEvents(
  s: Scenaria,
  who: { source: WindowSource; key: string; agent: string; startReason?: StartReason; continues?: string },
  events: WindowEvent[],
): number {
  if (!events.length) return 0;
  return s.store.withLock(() => {
    const p = readLines(s);
    if (p.unreadable) throw new Error("windows.jsonl is not a file");
    const anchor = windowAnchor(s.store).read();
    const lines = p.lines;
    const out: Bare[] = [];
    // Changed outside since the last append (or a break after the last reset): start again after a reset line.
    const reset = resetDue(p, anchor);
    if (reset) out.push(reset);

    const key = resolveKey(lines, who);
    const seen = new Set<string>();
    let cur: OpenLine | null = null;
    let lastTokens: number | null = null;
    let opened = 0;
    const keyOf = new Map<string, string>();
    for (const l of lines) {
      if (l.t === "reset") {
        cur = null;
        lastTokens = null;
      } else if (l.t === "open") {
        opened++;
        keyOf.set(l.w, l.key);
        if (l.key === key) {
          cur = l;
          lastTokens = null;
          if (l.ref) seen.add(l.ref);
        }
      } else if (l.t === "sample" && keyOf.get(l.w) === key) {
        seen.add(l.ref);
        if (cur && l.w === cur.w) lastTokens = l.tokens;
      }
    }
    const restarted = out.length > 0;
    if (restarted) cur = null;
    const open = (at: string, start: StartReason, extra: Partial<OpenLine> = {}) => {
      opened++;
      const l: OpenLine = { t: "open", w: `w${opened}`, at, source: who.source, key, agent: who.agent, start, ...extra };
      out.push(l);
      cur = l;
      lastTokens = null;
    };
    let samples = 0;
    for (const e of events) {
      if (!e || typeof e.ref !== "string" || !e.ref || seen.has(e.ref)) continue;
      const at = typeof e.at === "string" && e.at ? e.at : new Date().toISOString();
      if (e.kind === "boundary") {
        seen.add(e.ref);
        open(at, "compact", {
          ref: e.ref,
          ...(e.trigger ? { trigger: String(e.trigger).slice(0, 20) } : {}),
          ...(Number.isFinite(e.preTokens) ? { preTokens: Math.round(Number(e.preTokens)) } : {}),
        });
        continue;
      }
      const tokens = Math.round(Number(e.tokens));
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      seen.add(e.ref);
      if (!cur) open(at, restarted ? "restart" : (who.startReason ?? "new-session"));
      else if (who.source === "proxy" && lastTokens !== null && tokens < lastTokens / 2) open(at, "drop");
      out.push({ t: "sample", w: cur!.w, at, tokens, ...(e.model ? { model: String(e.model).slice(0, 80) } : {}), ref: e.ref.slice(0, 120) });
      lastTokens = tokens;
      samples++;
    }
    if (!samples && !out.some((l) => l.t === "open")) return 0;
    // E4: a window opened — the progress at its start (the start of a session records it earlier, before any work).
    const newest = [...out].reverse().find((l): l is OpenLine => l.t === "open");
    // Not twice for one change: a session start recorded the progress and nothing was answered since (review L11).
    let lastSample = -1;
    let lastSnap = -1;
    lines.forEach((l, i) => {
      if (l.t === "sample") lastSample = i;
      else if (l.t === "progress") lastSnap = i;
    });
    if (newest && !(reset === null && lastSnap > lastSample)) {
      const snap = snapshotLine(s, "open", newest);
      if (snap) out.push(snap);
    }
    appendLines(s, p, anchor, out);
    return samples;
  });
}

/** A progress line for now (null when progress cannot be computed: measuring never fails because of it). */
function snapshotLine(s: Scenaria, by: ProgressLine["by"], w?: OpenLine, key?: string): ProgressLine | null {
  try {
    return { t: "progress", at: new Date().toISOString(), by, ...(w ? { w: w.w, ws: w.at } : {}), ...(key ? { key: key.slice(0, 200) } : {}), ...progressSnapshot(s) };
  } catch {
    return null;
  }
}

/** The reset line due before appending (the records were changed outside since the last append), or null. */
function resetDue(p: Parsed, anchor: { lines: number; head: string } | null): ResetLine | null {
  const check = anchorCheck(p.lines, anchor);
  const lastReset = lastResetOf(p.lines);
  if (check === "rewritten" || check === "missing" || check === "foreign" || (p.lastBreak !== null && p.lastBreak > lastReset))
    return { t: "reset", at: new Date().toISOString(), why: check === "foreign" ? "foreign" : check === "rewritten" || check === "missing" ? "rewritten" : "chain", lines: anchor?.lines ?? p.lines.length };
  return null;
}

/** Append lines to the chain and raise the outside anchor (under the caller's lock). */
function appendLines(s: Scenaria, p: Parsed, anchor: { count: number; lines: number; head: string } | null, out: Bare[]) {
  let prev = p.prev;
  const text = out.map((l) => {
    const c = chainOf(prev, l);
    prev = c;
    return JSON.stringify({ ...l, c });
  });
  const f = s.store.path(FILE);
  appendFileSync(f, (endsWithoutNewline(f) ? "\n" : "") + text.join("\n") + "\n", "utf8");
  windowAnchor(s.store).raise((anchor?.count ?? 0) + 1, p.lines.length + out.length, prev);
}

/**
 * E4: record the progress now, at the start of a session (Claude Code SessionStart: before the new window's first
 * answer, so the window's start is measured before it did any work). Never throws.
 */
export function recordProgressSnapshot(s: Scenaria, key?: string): boolean {
  try {
    return s.store.withLock(() => {
      const p = readLines(s);
      if (p.unreadable) return false;
      const snap = snapshotLine(s, "session-start", undefined, key);
      if (!snap) return false;
      const anchor = windowAnchor(s.store).read();
      const reset = resetDue(p, anchor);
      appendLines(s, p, anchor, reset ? [reset, snap] : [snap]);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * E4: did this conversation's newest window just start (at most 3 answers)? Then a window has just ended, and the stop
 * is computed (windowprogress.ts evaluateStop) — rarely, not on every tool call.
 */
export function windowJustStarted(s: Scenaria, key: string): boolean {
  const n = windowSamples(s, key);
  return n !== null && n > 0 && n <= 3;
}

/** How many answers the conversation's newest window has (counted up to 4), null without a window. */
export function windowSamples(s: Scenaria, key: string): number | null {
  try {
    const p = readLines(s);
    if (p.unreadable) return null;
    let w: string | null = null;
    let samples = 0;
    for (let i = p.lines.length - 1; i >= 0; i--) {
      const l = p.lines[i];
      if (l.t === "open" && l.key === key) {
        w = l.w;
        break;
      }
    }
    if (!w) return null;
    for (let i = p.lines.length - 1; i >= 0 && samples <= 3; i--) {
      const l = p.lines[i];
      if (l.t === "sample" && l.w === w) samples++;
      if (l.t === "open" && l.w === w) break;
    }
    return samples;
  } catch {
    return null;
  }
}

/** The conversation an answer belongs to: its own key, or the conversation of the earlier answer it continues. */
function resolveKey(lines: Line[], who: { source: WindowSource; key: string; agent: string; continues?: string }): string {
  if (!who.continues) return who.key;
  const sample = lines.find((l): l is Line & SampleLine => l.t === "sample" && l.ref === who.continues);
  const o = sample && lines.find((l): l is Line & OpenLine => l.t === "open" && l.w === sample.w);
  // Only the same agent can continue a conversation (another client naming someone's response id cannot join it).
  return o && o.source === who.source && o.agent === who.agent ? o.key : who.key;
}

/** The key under which recordWindowEvents files this conversation (E3a-2: the proxy asks for the same window). */
export function windowKeyFor(s: Scenaria, who: { source: WindowSource; key: string; agent: string; continues?: string }): string {
  if (!who.continues) return who.key;
  try {
    const p = readLines(s);
    return p.unreadable ? who.key : resolveKey(p.lines, who);
  } catch {
    return who.key;
  }
}

function endsWithoutNewline(f: string): boolean {
  try {
    const size = statSync(f).size;
    if (!size) return false;
    const fd = openSync(f, "r");
    try {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      return b[0] !== 10;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * A cheap first look for the hooks and the proxy (E3a-2): the raw fill of the newest window of one conversation,
 * from the cached records, without the checks of windowStatus. Never shown and never acted on by itself — it only
 * decides whether the full, checked measurement is worth computing (below the yellow line nothing can be due).
 */
export function quickFill(s: Scenaria, key: string, cs: ContextSettings = readContextSettings(s.store)): { w: string; tokens: number; fill: number } | null {
  let lines: Line[];
  try {
    const p = readLines(s);
    if (p.unreadable) return null;
    lines = p.lines;
  } catch {
    return null;
  }
  let w: string | null = null;
  for (let i = lines.length - 1; i >= 0 && !w; i--) {
    const l = lines[i];
    if (l.t === "reset") return null;
    if (l.t === "open" && l.key === key) w = l.w;
  }
  if (!w) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.t === "sample" && l.w === w) {
      const row = lookupModel(l.model, cs.modelRows);
      if (!row) return null;
      // The same formula as the checked measurement (the soft threshold plays no part in the value).
      const fill = derive("context.fill", "context-fill/1", { tokens: l.tokens, cMax: row.cMax, aModel: cs.values.aModel, soft: 0, rule: cs.rule }).value;
      return { w, tokens: l.tokens, fill };
    }
    if (l.t === "open" && l.w === w) break;
  }
  return null;
}

// ------------------------------------------------------------------ reading the measurement

/** Why a window shows no number. */
export type NotMeasurable = "model-unknown" | "changed-outside" | "no-sample";

export interface WindowInfo {
  id: string;
  source: WindowSource;
  agent: string;
  key: string;
  start: StartReason;
  /** Compaction: "auto" or "manual" and the size before it, as Claude Code reported. */
  trigger?: string;
  preTokens?: number;
  startedAt: string;
  /** The window's first and last answer. */
  firstAt: string | null;
  lastAt: string | null;
  /** Why the window ended (the start reason of the next window of the same conversation), if known. */
  end?: StartReason;
  model: string | null;
  samples: number;
  tokens: number | null;
  maxTokens: number | null;
  measurable: boolean;
  why?: NotMeasurable;
  cMax?: number;
  cEff?: number;
  modelSource?: { source: string; read: string; table: string };
  fill?: Derivation;
  soft?: Derivation;
  /** E4: the highest fill the window reached, in % (context-fill/1 of its largest answer). */
  peak?: number;
  zone?: ContextZone;
  next?: { at: number; zone: ContextZone } | null;
  /** The rule (version and values) this window's numbers are computed with. */
  rule: string;
  /** Checkpoints Scenaria set because of this window's fill (E3a-2), oldest first. */
  cuts: WindowCut[];
}

/** What a checkpoint set because of the fill records about it (`meta.contextCut`, written only by Scenaria). */
export interface ContextCutMeta {
  window: string;
  /** The conversation the measurement came from (a Claude Code session, a proxy conversation). */
  key?: string;
  /** The window's start: a window id alone is not unique once the records start again. */
  startedAt: string;
  zone: ContextZone;
  fill: number;
  tokens: number;
  rule: string;
  /** Where it was set: at a turn's end, at once (mid-turn), or after a proxy answer. */
  moment: "turn-end" | "now" | "answer";
}
export interface WindowCut {
  node: string;
  zone: ContextZone;
  fill: number;
  at: string;
  moment: ContextCutMeta["moment"];
  /** The rule (version and values) the cut was made under. */
  rule: string;
  /** On the current line of work (the way from the root to HEAD); after a rewind a cut can lie on an abandoned branch. */
  onLine: boolean;
}

/** A node Scenaria marked as a cut (meta and tag), whatever its state. */
export function isCutNode(n: { meta?: unknown; tags?: string[] }): boolean {
  const m = (n.meta as any)?.contextCut;
  return Boolean(m && typeof m === "object" && Array.isArray(n.tags) && n.tags.includes("context-cut"));
}

/**
 * The cut checkpoints per window (key: window id + start). Only nodes Scenaria wrote as cuts (meta and tag) and that
 * are unchanged since (integrity): a cut written into a node file by hand would otherwise suppress later cuts.
 */
function cutsByWindow(nodes: { id: string; createdAt: string; meta?: unknown; tags?: string[] }[], integ: () => Map<string, string>, line: Set<string>): Map<string, WindowCut[]> {
  const out = new Map<string, WindowCut[]>();
  for (const n of nodes) {
    if (!isCutNode(n)) continue;
    const m = (n.meta as any).contextCut;
    if (typeof m.window !== "string" || typeof m.startedAt !== "string" || !Object.prototype.hasOwnProperty.call(CONTEXT_ZONES, m.zone)) continue;
    if (integ().get(n.id) === "tampered") continue;
    const k = `${m.window}@${m.startedAt}`;
    const list = out.get(k) ?? [];
    list.push({ node: n.id, zone: m.zone, fill: Number(m.fill) || 0, at: String(n.createdAt), moment: m.moment === "now" || m.moment === "answer" ? m.moment : "turn-end", rule: typeof m.rule === "string" ? m.rule.slice(0, 200) : "", onLine: line.has(n.id) });
    out.set(k, list);
  }
  for (const l of out.values()) l.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/** A recorded progress measurement (E4). `tasks[].value` is computed from the inputs with progress/1 on reading. */
export interface ProgressSnapInfo {
  at: string;
  by: "session-start" | "open";
  /** The window it was recorded for (by "open"), with its start. */
  w?: string;
  ws?: string;
  /** The conversation whose session start it was (by "session-start"). */
  key?: string;
  tasks: { task: string; value: number; criteria: string[]; gates: string[]; waiting: boolean }[];
  focus: string | null;
}

export interface WindowStatus {
  table: string;
  rule: string;
  /** Newest first (by the last answer). */
  windows: WindowInfo[];
  /** The window with the newest answer (of the conversation `key`, when asked for one). */
  current: WindowInfo | null;
  /** The values in force (the person's signed setting or the start values) and what they change, in plain words. */
  settings: { trust: ContextSettings["trust"]; why?: ContextSettings["why"]; elsewhere?: string; looser: ContextSettings["looser"]; rule: string; rev: number | null; at: string | null; by: string | null; text: { de: string; en: string } };
  /** E4: the progress recorded at window changes (confirmed lines only), oldest first; values computed from the inputs. */
  snapshots: ProgressSnapInfo[];
  /** The records were changed outside Scenaria: what showed it. Windows with unconfirmed lines show no number. */
  changed: { by: "chain" | "anchor" | "checkpoint" | "unreadable" | "restarted"; node?: string; line?: number } | null;
}

/** A progress line as read: every task's value computed again from its progress/1 inputs (the value only — cheap). */
function snapInfo(l: ProgressLine): ProgressSnapInfo {
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string").slice(0, 200) : []);
  const tasks = (Array.isArray(l.tasks) ? l.tasks : [])
    .filter((t) => t && typeof t === "object" && typeof t.task === "string")
    .slice(0, 500)
    .map((t) => {
      const criteria = strs(t.criteria);
      const gates = strs(t.gates);
      return { task: t.task, criteria, gates, waiting: t.waiting === true, value: formulaValue("progress/1", { criteria, gates }) };
    });
  return {
    at: typeof l.at === "string" ? l.at : "",
    by: l.by === "open" ? "open" : "session-start",
    ...(typeof l.w === "string" ? { w: l.w } : {}),
    ...(typeof l.ws === "string" ? { ws: l.ws } : {}),
    ...(typeof l.key === "string" ? { key: l.key } : {}),
    tasks,
    focus: typeof l.focus === "string" ? l.focus : null,
  };
}

/** The index of the newest sample at or before time t. */
function sampleAt(samples: SampleLine[], t: string): number {
  let v = -1;
  for (let i = 0; i < samples.length; i++) if (samples[i].at <= t) v = i;
  return v;
}

export function windowStatus(s: Scenaria, opts: { limit?: number; key?: string; settings?: ContextSettings } = {}): WindowStatus {
  const cs = opts.settings ?? readContextSettings(s.store);
  // File and outside anchor read together under the lock: an append in progress is never half seen.
  const { p, anchor } = s.store.withLock(() => ({ p: readLines(s, true), anchor: windowAnchor(s.store).read() }));
  const lines = p.lines;
  const nodes = s.store.listNodes();
  let changed: WindowStatus["changed"] = null;
  // The confirmed lines: after the last reset and the last break, up to what the outside anchor confirms.
  const lastReset = lastResetOf(lines);
  const from = Math.max(lastReset + 1, p.lastBreak === null ? 0 : p.lastBreak + 1);
  let to = lines.length;
  if (p.unreadable) changed = { by: "unreadable" };
  if (p.lastBreak !== null && p.lastBreak > lastReset) changed = { by: "chain", line: p.lastBreak + 1 };
  const a = anchorCheck(lines, anchor);
  if (a === "rewritten" || a === "missing") {
    to = from;
    changed = { by: "anchor" };
  } else if (a === "foreign" || a === "fits") {
    to = Math.min(to, anchor!.lines);
    if (a === "foreign") changed ??= { by: "anchor", line: anchor!.lines + 1 };
  }
  // Checkpoints that recorded the chain (in the integrity ledger): each must still fit, and must be unchanged itself.
  // Anchors before a reset are passed over only when a later, fitting checkpoint names that reset: a reset line
  // anyone wrote by hand hides nothing (E3a-1 review 2, N2).
  const anchored = nodes
    .map((n) => ({ n, m: (n.meta as any)?.windows }))
    .filter(({ m }) => m && typeof m === "object" && Number.isInteger(m.lines) && m.lines > 0 && typeof m.head === "string");
  let integCache: Map<string, string> | null = null;
  const integOf = (): Map<string, string> => {
    if (!integCache) {
      try {
        integCache = s.integrity().state as Map<string, string>;
      } catch {
        integCache = new Map<string, string>();
      }
    }
    return integCache;
  };
  if (anchored.length) {
    const integ = integOf();
    const fits = (x: { n: any; m: any }) => lines[x.m.lines - 1]?.c === x.m.head && integ.get(x.n.id) !== "tampered";
    const trustedReset = anchored.filter(fits).reduce((r, x) => (Number.isInteger(x.m.reset) && lines[x.m.reset]?.t === "reset" && x.m.reset > r ? x.m.reset : r), -1);
    for (const x of anchored) {
      if (x.m.lines - 1 <= trustedReset || fits(x)) continue;
      to = from;
      changed = { by: "checkpoint", node: x.n.id };
    }
  }
  if (!changed && lastReset >= 0) changed = { by: "restarted", line: lastReset + 1 };
  const trusted = (idx: number) => idx >= from && idx < to;

  const opens: (OpenLine & { idx: number })[] = [];
  const samplesOf = new Map<string, (SampleLine & { idx: number })[]>();
  // Lines come from a file anyone can write: a line whose fields are not what Scenaria writes is no record (E4a review H1).
  const str = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 300;
  lines.forEach((l, idx) => {
    if (l.t === "open" && !(str(l.w) && str(l.at) && str(l.key) && str(l.agent) && (l.source === "transcript" || l.source === "proxy") && str(l.start))) return;
    if (l.t === "sample" && !(str(l.w) && str(l.at) && typeof l.tokens === "number" && Number.isFinite(l.tokens) && (l.model === undefined || typeof l.model === "string"))) return;
    if (l.t === "open") {
      opens.push({ ...l, idx });
      samplesOf.set(l.w, []);
    } else if (l.t === "sample") samplesOf.get(l.w)?.push({ ...l, idx });
  });
  const cutsOf = (agent: string) =>
    nodes
      .filter((n) => (n.type === "checkpoint" || n.type === "decision") && n.agent === agent)
      .map((n) => String(n.createdAt))
      .sort();

  // Step sizes per model: growth of the fill between two checkpoints of the window's agent inside one window. Two
  // checkpoints without a new answer between them are one cut (a burst of checkpoints is no row of empty steps).
  const stepsByModel = new Map<string, number[]>();
  for (const o of opens) {
    const ss = samplesOf.get(o.w) ?? [];
    if (!ss.length || !trusted(o.idx) || ss.some((x) => !trusted(x.idx))) continue;
    const model = normaliseModel(ss[ss.length - 1].model ?? "");
    const first = ss[0].at;
    const last = ss[ss.length - 1].at;
    const list = stepsByModel.get(model) ?? [];
    let prevIdx = -1;
    for (const t of cutsOf(o.agent).filter((t) => t >= first && t <= last)) {
      const i = sampleAt(ss, t);
      if (i < 0 || i === prevIdx) continue;
      if (prevIdx >= 0 && ss[i].tokens >= ss[prevIdx].tokens) list.push(ss[i].tokens - ss[prevIdx].tokens);
      prevIdx = i;
    }
    stepsByModel.set(model, list);
  }
  let handover = 0;
  try {
    handover = s.head() ? s.context().tokens : 0;
  } catch {
    handover = 0;
  }

  const ends = new Map<string, StartReason>();
  const lastOfKey = new Map<string, string>();
  for (const o of opens) {
    const prev = lastOfKey.get(o.key);
    if (prev) ends.set(prev, o.start);
    lastOfKey.set(o.key, o.w);
  }

  let line = new Set<string>();
  try {
    const head = s.head();
    if (head) line = new Set(s.path(head.id).map((n) => n.id));
  } catch {
    line = new Set<string>();
  }
  const cuts = cutsByWindow(nodes, integOf, line);
  const windows: WindowInfo[] = opens.map((o) => {
    const ss = samplesOf.get(o.w) ?? [];
    const last = ss[ss.length - 1];
    const info: WindowInfo = {
      id: o.w,
      source: o.source,
      agent: o.agent,
      key: o.key,
      start: o.start,
      ...(o.trigger ? { trigger: o.trigger } : {}),
      ...(o.preTokens !== undefined ? { preTokens: o.preTokens } : {}),
      startedAt: o.at,
      firstAt: ss[0]?.at ?? null,
      lastAt: last?.at ?? null,
      ...(ends.has(o.w) ? { end: ends.get(o.w) } : {}),
      model: last?.model ?? null,
      samples: ss.length,
      tokens: last?.tokens ?? null,
      maxTokens: ss.length ? ss.reduce((m, x) => (x.tokens > m ? x.tokens : m), 0) : null,
      measurable: false,
      rule: cs.rule,
      cuts: cuts.get(`${o.w}@${o.at}`) ?? [],
    };
    if (!trusted(o.idx) || ss.some((x) => !trusted(x.idx))) return { ...info, tokens: null, maxTokens: null, why: "changed-outside" };
    if (!last) return { ...info, why: "no-sample" };
    const row = lookupModel(last.model, cs.modelRows);
    if (!row) return { ...info, why: "model-unknown" };
    const aModel = cs.values.aModel;
    const cEff = Math.min(row.cMax, aModel);
    const steps = (stepsByModel.get(normaliseModel(last.model ?? "")) ?? []).slice(-MAX_STEPS).map(String);
    // Where C_max comes from goes into the derivation itself (exports carry it, not only the console line).
    const cMaxSource = row.provider === "person" ? `entered by the person (rule ${cs.rule.split(" ")[0]}, ${row.read})` : `${row.source} (read ${row.read})`;
    const soft = derive("context.soft", "context-soft/1", { cMax: row.cMax, cMaxSource, aModel, steps, handover, rule: cs.rule });
    const fill = derive("context.fill", "context-fill/1", { tokens: last.tokens, cMax: row.cMax, cMaxSource, aModel, soft: soft.value, rule: cs.rule });
    return {
      ...info,
      measurable: true,
      cMax: row.cMax,
      cEff,
      modelSource: { source: row.source, read: row.read, table: MODEL_TABLE_VERSION },
      fill,
      soft,
      peak: info.maxTokens !== null ? formulaValue("context-fill/1", { tokens: info.maxTokens, cMax: row.cMax, aModel, soft: soft.value, rule: cs.rule }) : fill.value,
      zone: contextZone(fill.value, soft.value, cs.rule),
      next: contextNextLimit(fill.value, soft.value, cs.rule),
    };
  });
  windows.sort((a, b) => String(b.lastAt ?? b.startedAt).localeCompare(String(a.lastAt ?? a.startedAt)) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  return {
    table: MODEL_TABLE_VERSION,
    rule: cs.rule,
    settings: { trust: cs.trust, ...(cs.why ? { why: cs.why } : {}), ...(cs.elsewhere ? { elsewhere: cs.elsewhere } : {}), looser: cs.looser, rule: cs.rule, rev: cs.set?.rev ?? null, at: cs.set?.at ?? null, by: cs.set?.by ?? null, text: describeSettings(cs) },
    windows: windows.slice(0, opts.limit ?? 50),
    snapshots: lines.flatMap((l, idx): ProgressSnapInfo[] => (l.t === "progress" && trusted(idx) ? [snapInfo(l)] : [])).sort((a, b) => a.at.localeCompare(b.at)),
    current: (opts.key ? windows.find((w) => w.key === opts.key) : windows[0]) ?? null,
    changed,
  };
}

// ------------------------------------------------------------------ reading the sources

/** Usage samples and compaction boundaries of Claude Code transcript lines (main line only). */
export function claudeCodeWindowEvents(entries: any[]): WindowEvent[] {
  const out: WindowEvent[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || e.isSidechain) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      const m = e.compactMetadata ?? {};
      out.push({ kind: "boundary", at: String(e.timestamp ?? ""), ref: `b:${String(e.uuid ?? e.timestamp ?? "")}`, trigger: typeof m.trigger === "string" ? m.trigger : undefined, preTokens: Number.isFinite(m.preTokens) ? m.preTokens : undefined });
      continue;
    }
    if (e.type !== "assistant") continue;
    const msg = e.message ?? {};
    const u = msg.usage;
    if (!u || typeof u !== "object" || msg.model === "<synthetic>") continue;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
    const tokens = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    // One answer is written as several lines (thinking, text, tool use) with the same message id and the same usage.
    const id = typeof msg.id === "string" && msg.id ? msg.id : typeof e.requestId === "string" ? e.requestId : String(e.uuid ?? "");
    if (!id || !tokens) continue;
    out.push({ kind: "sample", at: String(e.timestamp ?? ""), tokens, model: typeof msg.model === "string" ? msg.model : undefined, ref: `m:${id}` });
  }
  return out;
}

// ------------------------------------------------------------------ text

const WHY_TEXT: Record<NotMeasurable, { de: string; en: string }> = {
  "model-unknown": { de: "Modell nicht in der Modelltabelle – die Regel greift nicht", en: "model not in the model table – the rule does not apply" },
  "changed-outside": { de: "Messdaten außerhalb von Scenaria geändert – keine Zahl", en: "measurement changed outside Scenaria – no number" },
  "no-sample": { de: "noch keine Antwort mit Token-Zahlen", en: "no answer with token counts yet" },
};
const START_TEXT: Record<StartReason, { de: string; en: string }> = {
  "new-session": { de: "neue Sitzung", en: "new session" },
  clear: { de: "/clear", en: "/clear" },
  resume: { de: "fortgesetzt", en: "resumed" },
  compact: { de: "Komprimierung", en: "compaction" },
  drop: { de: "Füllung stark gefallen (vermutlich komprimiert)", en: "fill fell sharply (most likely compacted)" },
  restart: { de: "Messung neu begonnen", en: "measurement started again" },
};
/** What a zone means, in plain words. */
const ZONE_MEANS: Record<ContextZone, { de: string; en: string }> = {
  green: { de: "genug Platz", en: "enough room" },
  yellow: { de: "keine neue große Teilaufgabe mehr beginnen", en: "do not start a new large part of the work" },
  orange: { de: "den aktuellen Schritt abschließen und sichern", en: "finish and save the current step" },
  red: { de: "Übergabe an ein neues Fenster fällig", en: "hand over to a new window now" },
  emergency: { de: "sofort sichern – weit über der Grenze für gute Arbeit", en: "save now – far past the limit for good work" },
};
const tokDe = (x: number) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const tokEn = (x: number) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Plain text for the console and agents. */
export function renderWindows(ws: WindowStatus, lang: "de" | "en" = "en", only?: string): string {
  const de = lang === "de";
  const L = (x: { de: string; en: string }) => x[lang];
  const list = only ? ws.windows.filter((w) => w.id === only) : ws.windows.slice(0, 10);
  const out: string[] = [];
  if (!ws.windows.length)
    out.push(
      de
        ? "Hier nicht messbar: Scenaria hat noch keine Token-Zahlen gesehen. Gemessen wird nur über das Claude-Code-Protokoll und den LLM-Proxy, nicht über MCP allein (z. B. Claude Desktop)."
        : "Not measurable here: Scenaria has not seen any token counts yet. Only Claude Code transcripts and the LLM proxy are measured, not MCP alone (e.g. Claude Desktop).",
    );
  const c = ws.changed;
  if (c && c.by !== "restarted")
    out.push(
      de
        ? `Achtung: Die Fenster-Daten sind nicht so, wie Scenaria sie auf diesem Rechner geschrieben hat – außerhalb geändert oder von anderswo${c.by === "checkpoint" ? ` (passt nicht mehr zu Schritt ${c.node})` : c.by === "unreadable" ? " (Datei nicht lesbar)" : ""}. Betroffene Fenster zeigen keine Zahl.`
        : `Warning: the window data is not as Scenaria wrote it on this machine – changed outside, or from elsewhere${c.by === "checkpoint" ? ` (no longer matches step ${c.node})` : c.by === "unreadable" ? " (file not readable)" : ""}. Affected windows show no number.`,
    );
  else if (c) out.push(de ? "Hinweis: Die Messung wurde neu begonnen, weil frühere Fenster-Daten nicht bestätigt werden konnten; ältere Fenster zeigen keine Zahl." : "Note: the measurement started again because earlier window data could not be confirmed; older windows show no number.");
  // The values in force: the person's setting, or the start values; an invalid stored setting is said plainly.
  if (ws.settings.trust === "invalid") out.push(de ? `Achtung: ${ws.settings.text.de}` : `Warning: ${ws.settings.text.en}`);
  else if (ws.settings.trust === "verified" || ws.settings.elsewhere) out.push(ws.settings.text[lang]);
  for (const w of list) {
    const head = `${w.id} · ${w.agent} · ${w.model ?? "?"} · ${de ? "Beginn" : "start"}: ${L(START_TEXT[w.start])}${w.end ? ` · ${de ? "Ende" : "end"}: ${L(START_TEXT[w.end])}` : ""}`;
    if (!w.measurable || !w.fill) {
      const t = w.tokens !== null && w.why === "model-unknown" ? ` (${de ? `${tokDe(w.tokens)} Tokens` : `${tokEn(w.tokens)} tokens`})` : "";
      out.push(`${head}\n  ${L(WHY_TEXT[w.why ?? "no-sample"])}${t}`);
      continue;
    }
    const plainLine = de
      ? `Das Kontextfenster ist zu ${String(w.fill.value).replace(".", ",")} % gefüllt – ${CONTEXT_ZONES[w.zone!].de}: ${ZONE_MEANS[w.zone!].de}.`
      : `The context window is ${w.fill.value} % full – ${CONTEXT_ZONES[w.zone!].en}: ${ZONE_MEANS[w.zone!].en}.`;
    const byPerson = Boolean(w.modelSource?.source.startsWith("entered by the person"));
    const src = !w.modelSource
      ? ""
      : byPerson
        ? de
          ? `Fenstergröße von der Person eingetragen (${w.modelSource.read})`
          : `window size entered by the person (${w.modelSource.read})`
        : de
          ? `Fenstergröße laut ${w.modelSource.source} (abgerufen ${w.modelSource.read})`
          : `window size per ${w.modelSource.source} (read ${w.modelSource.read})`;
    const cutLine = w.cuts.length
      ? `\n  ${de ? "Gesichert" : "Saved"}: ${w.cuts.map((c) => `${c.node} (${CONTEXT_ZONES[c.zone][lang]}, ${de ? String(c.fill).replace(".", ",") : c.fill} %)`).join(", ")}`
      : "";
    out.push(`${head}\n  ${plainLine}\n  ${L(w.fill.sentence)}\n  ${de ? "Weiche Schwelle" : "Soft threshold"} ${L(w.soft!.sentence)}${src ? `\n  ${src}` : ""}${cutLine}`);
  }
  const ver = /^v[\d.]+(?:-p\d+)?/.exec(ws.rule)?.[0] ?? ws.rule;
  out.push(de ? `Modelltabelle ${ws.table}, Regel ${ver}. Ab Orange sichert Scenaria automatisch einen Schritt (orange am Zugende, ab Rot sofort); ein neues Fenster öffnen kann es nicht erzwingen.` : `Model table ${ws.table}, rule ${ver}. From orange on Scenaria saves a step automatically (orange at the end of a turn, from red at once); it cannot force a new window.`);
  return out.join("\n");
}

/** For agents: the numbers without the long derivations. */
export function windowsForAgents(ws: WindowStatus) {
  const slim = (w: WindowInfo) => ({
    id: w.id,
    source: w.source,
    agent: w.agent,
    model: w.model,
    start: w.start,
    end: w.end,
    tokens: w.tokens,
    measurable: w.measurable,
    why: w.why,
    cEff: w.cEff,
    fill: w.fill ? compact(w.fill) : undefined,
    soft: w.soft ? compact(w.soft) : undefined,
    zone: w.zone,
    next: w.next,
    cuts: w.cuts.map((c) => ({ node: c.node, zone: c.zone, fill: c.fill, onLine: c.onLine })),
  });
  return { table: ws.table, rule: ws.rule, settings: { trust: ws.settings.trust, rule: ws.settings.rule, rev: ws.settings.rev }, current: ws.current ? slim(ws.current) : null, windows: ws.windows.map(slim), changed: ws.changed };
}
