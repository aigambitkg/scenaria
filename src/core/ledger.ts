/**
 * Integrity ledger: makes changes to the decision history visible.
 *
 * Every time Scenaria writes a node, the hash of its content is appended to
 * .scenaria/ledger.jsonl. Each ledger line also carries a hash over the previous
 * line, so the ledger itself forms a chain. Consequences:
 *   - a node file edited outside Scenaria no longer matches its last ledger hash → "tampered";
 *   - an edited or deleted ledger line breaks the chain → "ledger broken at line N";
 *   - nodes from before the ledger existed are sealed once on upgrade ("unsealed" = never seen).
 * This is tamper-EVIDENT, not tamper-proof: someone who rewrites node files AND recomputes
 * the whole ledger is not detected locally (mirror refs / exports to another system for that).
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { ScenariaNode } from "./types.js";

/** Every field counts: all legitimate changes (verification, folders, meta) go through Scenaria's save(). */
const VOLATILE = new Set<string>();

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

export function contentHash(n: ScenariaNode): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (!VOLATILE.has(k)) copy[k] = v;
  return createHash("sha256").update(JSON.stringify(stable(copy))).digest("hex").slice(0, 32);
}

/**
 * Hash of the WORK a verdict is about: everything except the verdict itself and bookkeeping that Scenaria
 * adds later (field history, earlier verdicts, snapshot folder, lessons attached by a rewind). If the work changes after a
 * verdict, the verdict no longer applies to it (it is "superseded").
 */
const NOT_WORK = new Set(["verification", "verificationHistory", "meta", "snapshotFolder", "lessons", "status", "summary"]);
export function workHash(n: ScenariaNode): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (!NOT_WORK.has(k)) copy[k] = v;
  return createHash("sha256").update(JSON.stringify(stable(copy))).digest("hex").slice(0, 32);
}

export interface LedgerLine {
  ts: string;
  id: string;
  hash: string;
  op: string;
  /** Chain hash over the previous line's chain hash + this line. */
  c: string;
}

function chain(prev: string, l: Omit<LedgerLine, "c">) {
  return createHash("sha256").update(`${prev}|${l.ts}|${l.id}|${l.hash}|${l.op}`).digest("hex").slice(0, 32);
}

type Parsed = { lines: LedgerLine[]; brokenAt: number | null; torn: number };
const READ_CACHE = new Map<string, { size: number; mtime: number; ino: number; fullAt: number; value: Parsed; prev: string; lineNo: number }>();
// Note: `size` is the byte offset of the last complete line, so a half-written tail is re-read later.

export class Ledger {
  constructor(private file: string) {}

  get exists() {
    return existsSync(this.file);
  }

  read(): { lines: LedgerLine[]; brokenAt: number | null; torn: number } {
    if (!existsSync(this.file)) return { lines: [], brokenAt: null, torn: 0 };
    const st = statSync(this.file);
    // Something else under the ledger's name (a folder) is an unreadable ledger on every system. Without this,
    // a folder reads as "empty" on Windows and as an error elsewhere.
    if (!st.isFile()) throw new Error("the ledger is not a file");
    const hit = READ_CACHE.get(this.file);
    // Same file (inode) that only grew → parse just the new bytes; a replaced file → parse from scratch.
    // An in-place edit of older lines is still caught: a full re-parse at least every 30 s, and whenever
    // the file changed without growing.
    if (hit && hit.ino === st.ino && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
    const grew = hit && hit.ino === st.ino && st.size > hit.size && st.mtimeMs >= hit.mtime && Date.now() - hit.fullAt < 30_000;
    if (grew) {
      const fresh = this.parseFrom(hit.size, hit.value, hit.prev, hit.lineNo);
      READ_CACHE.set(this.file, { mtime: st.mtimeMs, ino: st.ino, fullAt: hit.fullAt, ...fresh });
      return fresh.value;
    }
    const full = this.parseFrom(0, { lines: [], brokenAt: null, torn: 0 }, "", 0);
    READ_CACHE.set(this.file, { mtime: st.mtimeMs, ino: st.ino, fullAt: Date.now(), ...full });
    return full.value;
  }

  private parseFrom(offset: number, base: { lines: LedgerLine[]; brokenAt: number | null; torn: number }, prev0: string, lineNo0: number) {
    const size = statSync(this.file).size;
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    const lines = base.lines.slice();
    let brokenAt = base.brokenAt;
    let torn = base.torn;
    let prev = prev0;
    let lineNo = lineNo0;
    // Only complete lines: a line still being written (no newline yet) is read next time.
    const text = buf.toString("utf8");
    const body = text.slice(0, text.lastIndexOf("\n") + 1);
    const consumed = offset + Buffer.byteLength(body, "utf8");
    for (const raw of body.split("\n").slice(0, -1)) {
      lineNo++;
      if (!raw.trim()) continue;
      let l: LedgerLine;
      try {
        l = JSON.parse(raw);
        if (!l || typeof l.c !== "string") throw new Error("not a ledger line");
      } catch {
        // A line torn by a killed process or a full disk: lost, but not evidence of editing.
        torn++;
        continue;
      }
      if (brokenAt === null && chain(prev, l) !== l.c) brokenAt = lineNo;
      prev = l.c;
      lines.push(l);
    }
    return { value: { lines, brokenAt, torn }, prev, lineNo, size: consumed };
  }

  /** Read the last bytes only (the ledger can grow large). */
  private tail(bytes = 65536): string {
    const size = statSync(this.file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  }

  /** Chain hash of the last complete line. */
  private lastChain(): { c: string; endsWithNewline: boolean } {
    if (!existsSync(this.file) || statSync(this.file).size === 0) return { c: "", endsWithNewline: true };
    const t = this.tail();
    const lines = t.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const l = JSON.parse(lines[i]);
        if (typeof l?.c === "string") return { c: l.c, endsWithNewline: t.endsWith("\n") };
      } catch {
        /* torn or partial first line of the tail window */
      }
    }
    return { c: "", endsWithNewline: t.endsWith("\n") };
  }

  /** Where the chain stands now: does the file exist, how many lines, and the chain hash of the first and last line. */
  state(): LedgerState {
    if (!existsSync(this.file)) return { exists: false, lines: 0, head: null, genesis: null, genesisAt: null };
    const { lines } = this.read();
    return { exists: true, lines: lines.length, head: lines[lines.length - 1]?.c ?? null, genesis: lines[0]?.c ?? null, genesisAt: lines[0]?.ts ?? null };
  }

  /**
   * Append entries. `before` is called with the current and the resulting end of the chain right before
   * the bytes are written (Scenaria raises its high-water mark outside the project there).
   */
  append(entries: { id: string; hash: string; op: string }[], before?: (cur: { lines: number; head: string | null }, next: { lines: number; head: string | null }) => void) {
    if (!entries.length) return;
    const last = this.lastChain();
    let prev = last.c;
    const ts = new Date().toISOString();
    const out = entries.map((e) => {
      const l = { ts, id: e.id, hash: e.hash, op: e.op };
      const c = chain(prev, l);
      prev = c;
      return JSON.stringify({ ...l, c });
    });
    if (before) {
      const cur = this.state();
      try {
        before({ lines: cur.lines, head: cur.head }, { lines: cur.lines + entries.length, head: prev });
      } catch {
        /* the mark is evidence, never a reason to fail a write */
      }
    }
    appendFileSync(this.file, (last.endsWithNewline ? "" : "\n") + out.join("\n") + "\n", "utf8");
  }

  /** Is this node's file different from what Scenaria last wrote for it (same rule as checkIntegrity)? */
  nodeTampered(n: ScenariaNode, inflight?: { id: string; hash: string }[] | null, anchored = false): boolean {
    if (!existsSync(this.file)) return false;
    const { lines } = this.read();
    let h0: string | undefined;
    let h1: string | undefined;
    for (const l of lines) if (l.id === n.id) [h0, h1] = [l.hash, h0];
    if (!h0) return lines.length > 0;
    const c = contentHash(n);
    return !(c === h0 || (c === h1 && ((!anchored && lines[lines.length - 1]?.id === n.id) || Boolean(inflight?.some((x) => x.id === n.id && x.hash === h0)))));
  }
}

export type IntegrityState = "ok" | "tampered" | "unsealed";

export interface LedgerState {
  exists: boolean;
  lines: number;
  /** Chain hash of the last line (null when empty or missing). */
  head: string | null;
  /** Chain hash of the first line: identifies this ledger file. */
  genesis: string | null;
  /** Time of the first line. */
  genesisAt: string | null;
}

/** Compare every node with its last ledger hash. */
export function checkIntegrity(nodes: ScenariaNode[], ledger: Ledger, opts: { expectSealed?: boolean; inflight?: { id: string; hash: string }[] | null; anchored?: boolean } = {}) {
  const missing = Boolean(opts.expectSealed) && !ledger.exists;
  const { lines, brokenAt, torn } = ledger.read();
  // The hash is written BEFORE the node file, so a process killed in between leaves the node
  // at its previous version: the last two hashes of a node both count as consistent.
  // The previous hash only counts while the node's newest entry is the very last ledger line
  // (= a write that was interrupted); otherwise restoring an older file version would go unnoticed.
  const last = new Map<string, [string, string?]>();
  // A node that Scenaria wrote over while its file was already tampered stays tampered (no laundering by a later write).
  const overTampered = new Set<string>();
  for (const l of lines) {
    const cur = last.get(l.id);
    last.set(l.id, [l.hash, cur?.[0]]);
    if (l.op === "write-over-tampered") overTampered.add(l.id);
  }
  // Without an anchor on this machine the last line stands in for an interrupted write. With one, only the
  // anchor's in-flight record does: otherwise the newest step could be deleted or rolled back unnoticed (C5, S-K2).
  const lastLine = opts.anchored ? undefined : lines[lines.length - 1];
  const state = new Map<string, IntegrityState>();
  for (const n of nodes) {
    const h = last.get(n.id);
    // Once a project is sealed, every node must be in the ledger: one that is not was written around Scenaria.
    if (!h) state.set(n.id, missing || opts.expectSealed ? "tampered" : "unsealed");
    else {
      const c = contentHash(n);
      // An interrupted write (ledger written, node file not yet): the node file is still the previous version.
      const interrupted = c === h[1] && (lastLine?.id === n.id || Boolean(opts.inflight?.some((x) => x.id === n.id && x.hash === h[0])));
      state.set(n.id, !overTampered.has(n.id) && (c === h[0] || interrupted) ? "ok" : "tampered");
    }
  }
  // A step that is in the chain but whose file is gone or unreadable was deleted or destroyed outside Scenaria
  // (Scenaria never deletes step files). The last line / an in-flight write is a new step not on disk yet.
  const present = new Set(nodes.map((n) => n.id));
  const stepsMissing = [...last.keys()].filter((id) => !present.has(id) && lastLine?.id !== id && !opts.inflight?.some((x) => x.id === id));
  return { state, ledgerBrokenAt: brokenAt, entries: lines.length, torn, ledgerMissing: missing, stepsMissing };
}
