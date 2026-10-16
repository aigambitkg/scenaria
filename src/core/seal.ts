/**
 * Who may reset the tamper evidence (security rule 11), and how a reset stays visible.
 *
 * - A reseal (accepting the current state as the new integrity baseline) needs an AUTHORITY: the person
 *   (interactive terminal or approval session — enforced by the caller) or a registered audit agent
 *   (a signed request, verified here). A working agent has neither.
 * - Every reseal leaves a record in .scenaria/reseals/rsN.json: signed with the person's approver key,
 *   or carrying the audit agent's signed request. The old ledger is kept, and its last chain hash is in
 *   the record.
 * - An ANCHOR outside the project (~/.config/scenaria/anchors/ledger-<folder>.json) remembers which ledger
 *   this machine accepted (its first chain hash, the "genesis") and every authorised reseal. So a ledger
 *   that was deleted, replaced by a fresh one, or reset without a record is reported — even when the
 *   marker file .scenaria/ledger.sealed was deleted too.
 *
 * Honest limit: a process with the person's full user rights can also edit the anchor and read the
 * approver key. The anchor protects against an agent that works inside the project; for audits, the
 * audit agent's key lives elsewhere and external anchoring is on the roadmap.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigPath } from "./global.js";
import { projectIdentity, publicKeyId, signRecord, verifyRecord } from "./canon.js";
import { auditorRegistry, requestSignatureValid, type AuditorEnvelope } from "./auditors.js";
import { Ledger, type LedgerState } from "./ledger.js";
import { verdictTrustAll } from "./trust.js";
import type { Store } from "./store.js";
import { writeJsonAtomic } from "./store.js";

export type ResealAuthority = { kind: "person"; via: "terminal" | "dashboard" } | { kind: "auditor"; request: unknown };

export interface ResealRecord {
  id: string;
  at: string;
  kind: "person" | "auditor";
  by: string;
  via: string;
  /** File name of the kept previous ledger (null if it was missing). */
  archived: string | null;
  archivedLines: number;
  archivedHead: string | null;
  /** First chain hash of the new ledger. */
  newGenesis: string | null;
  nodes: number;
  auditor?: { keyId: string; name?: string; request: AuditorEnvelope };
  pid?: string;
  pub?: string;
  sig?: string;
  /** Computed on read: the record is authentic (person: valid signature by a trusted key; auditor: valid request signature bound to the archived ledger). */
  verified?: boolean;
}

// ------------------------------------------------------------------ the anchor outside the project

/** Where the ledger stood after the last write this machine made (and the state just before it). */
export interface HighWater {
  lines: number;
  head: string | null;
  prevLines: number;
  prevHead: string | null;
  at: string;
  /** Set while a write is in flight (raised, not yet confirmed): only then may the ledger still end at prev. */
  pending?: boolean;
  /** The node being written while pending (its file may still be the previous version after a crash). */
  inflight?: { id: string; hash: string };
  /** Writes that were interrupted (never confirmed): tolerated until that node is written again. */
  interrupted?: { id: string; hash: string }[];
}

/** A verdict of the person or an audit agent, as this machine recorded it (outside the project). */
export interface RegisteredVerdict {
  status: string;
  at: string;
  origin: "person" | "auditor";
}

export interface LedgerAnchor {
  v: 1;
  /** The project folder (real path) this anchor belongs to. */
  root: string;
  /** First chain hash of the ledger this machine accepted (null: a new project, not written yet). */
  genesis: string | null;
  since: string;
  reseals: { id: string; at: string; kind: "person" | "auditor"; newGenesis: string | null }[];
  /** High-water mark, raised on every write by Scenaria: catches truncation, rewrite, rollback and hand-appended lines. */
  hw?: HighWater;
  /** The ledger was found not ending where this machine last saw it (kept until the person reseals). */
  diverged?: { at: string; expected: { lines: number; head: string | null }; found: { lines: number; head: string | null } };
  /** Hashes of audit-agent requests already applied (replay protection). */
  used?: string[];
  /** A new project was started in this folder; the previous anchor was archived. */
  previous?: { archivedAs: string; since: string; at: string };
  /**
   * The latest verdict of the person or an audit agent per node. A verdict that vanishes or changes
   * outside Scenaria is reported (high), however the ledger looks.
   */
  verdicts?: Record<string, RegisteredVerdict>;
}

function realRoot(root: string) {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function ledgerAnchorFile(root: string) {
  const h = createHash("sha256").update(realRoot(root)).digest("hex").slice(0, 20);
  return join(dirname(globalConfigPath()), "anchors", `ledger-${h}.json`);
}

export function readLedgerAnchor(root: string): LedgerAnchor | null {
  try {
    const a = JSON.parse(readFileSync(ledgerAnchorFile(root), "utf8"));
    if (a?.v !== 1 || a.root !== realRoot(root)) return null;
    return { ...a, reseals: Array.isArray(a.reseals) ? a.reseals : [], used: Array.isArray(a.used) ? a.used : [] };
  } catch {
    return null;
  }
}

function writeLedgerAnchor(a: LedgerAnchor) {
  const f = ledgerAnchorFile(a.root);
  mkdirSync(dirname(f), { recursive: true });
  writeJsonAtomic(f, a);
  try {
    chmodSync(f, 0o600);
  } catch {}
}

/** When .scenaria/ledger.sealed was written (the ledger's birth or its last authorised reseal), if it exists. */
export function markerTime(store: Store): number | null {
  try {
    const t = Date.parse(readFileSync(store.path("ledger.sealed"), "utf8").trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * A ledger that started AFTER the marker was written cannot be the sealed one: the real ledger's first
 * line is always written before the marker. (Covers a deleted ledger that a later write recreated.)
 */
export function startedAfterMarker(st: LedgerState, marker: number | null): boolean {
  if (marker === null || !st.exists || !st.genesisAt) return false;
  const first = Date.parse(st.genesisAt);
  return Number.isFinite(first) && first > marker + 60_000;
}

const sameAs = (st: { lines: number; head: string | null }, lines: number, head: string | null) => st.lines === lines && (st.head ?? null) === (head ?? null);

/** Does the ledger end where this machine last saw it (or just before, if a write was interrupted)? */
function atHighWater(st: LedgerState, hw: HighWater): boolean {
  return sameAs(st, hw.lines, hw.head) || (Boolean(hw.pending) && sameAs(st, hw.prevLines, hw.prevHead));
}

/**
 * Trust on first use: the first time this machine sees this folder's sealed ledger, it remembers it (and
 * the authentic reseal records already there) — but never a ledger that is evidently a replacement.
 * Call under the store lock.
 */
export function ensureLedgerAnchor(store: Store, st: LedgerState, marker: number | null = null): LedgerAnchor | null {
  const cur = readLedgerAnchor(store.root);
  if (cur && cur.genesis !== null && cur.hw) return cur;
  if (!st.exists || !st.genesis || startedAfterMarker(st, marker)) return cur;
  const now = new Date().toISOString();
  const hw: HighWater = { lines: st.lines, head: st.head, prevLines: st.lines, prevHead: st.head, at: now };
  let a: LedgerAnchor;
  if (cur && cur.genesis === null) a = { ...cur, genesis: st.genesis, hw }; // a new project in this folder: its first ledger
  else if (cur) a = { ...cur, hw }; // an anchor from before high-water marks
  else {
    const adopted = listReseals(store).filter((r) => r.verified).map((r) => ({ id: r.id, at: r.at, kind: r.kind, newGenesis: r.newGenesis }));
    a = { v: 1, root: realRoot(store.root), genesis: st.genesis, since: now, reseals: adopted, hw, used: [], verdicts: authenticVerdicts(store) };
  }
  try {
    writeLedgerAnchor(a);
  } catch {
    return cur;
  }
  return a;
}

/**
 * Before Scenaria appends to the ledger: raise the high-water mark. If the ledger was not where this
 * machine last saw it, the mark is NOT moved and the divergence is kept as evidence. Call under the lock.
 */
export function raiseHighWater(root: string, before: { lines: number; head: string | null }, next: { lines: number; head: string | null }, inflight?: { id: string; hash: string }) {
  const a = readLedgerAnchor(root);
  if (!a || !a.hw) return;
  const ok = sameAs(before, a.hw.lines, a.hw.head) || (Boolean(a.hw.pending) && sameAs(before, a.hw.prevLines, a.hw.prevHead));
  if (!ok || a.diverged) {
    if (!a.diverged) writeLedgerAnchor({ ...a, diverged: { at: new Date().toISOString(), expected: { lines: a.hw.lines, head: a.hw.head }, found: { ...before } } });
    return;
  }
  // A previous write that was never confirmed (crash): keep tolerating that node until it is written again.
  const interrupted = [...(a.hw.interrupted ?? []), ...(a.hw.pending && a.hw.inflight ? [a.hw.inflight] : [])].filter((x) => x.id !== inflight?.id).slice(-20);
  writeLedgerAnchor({ ...a, hw: { lines: next.lines, head: next.head, prevLines: before.lines, prevHead: before.head, at: new Date().toISOString(), pending: true, ...(inflight ? { inflight } : {}), ...(interrupted.length ? { interrupted } : {}) } });
}

/** After the append succeeded: the ledger now really ends at the mark (an interrupted write is no longer expected). */
export function confirmHighWater(root: string, next: { lines: number; head: string | null }) {
  const a = readLedgerAnchor(root);
  if (!a?.hw?.pending || !sameAs(next, a.hw.lines, a.hw.head)) return;
  const { inflight: _done, ...hw } = a.hw;
  writeLedgerAnchor({ ...a, hw: { ...hw, pending: false } });
}

/** The person's and audit agents' verdicts in the project that check out now (adopted on first use and on reseal). */
export function authenticVerdicts(store: Store): Record<string, RegisteredVerdict> {
  const nodes = store.listNodes();
  const trust = verdictTrustAll(store, nodes);
  const out: Record<string, RegisteredVerdict> = {};
  for (const n of nodes) {
    const v = n.verification;
    const tr = trust.get(n.id);
    if (v && (v.origin === "person" || v.origin === "auditor") && v.at && (tr === "ok" || tr === "superseded")) out[n.id] = { status: v.status, at: v.at, origin: v.origin };
  }
  return out;
}

/** Record (or replace) the person's / an audit agent's verdict on a node. Call under the store lock. */
export function registerVerdict(root: string, id: string, v: RegisteredVerdict) {
  const a = readLedgerAnchor(root);
  if (!a) return;
  writeLedgerAnchor({ ...a, verdicts: { ...(a.verdicts ?? {}), [id]: v } });
}

export function recordResealInAnchor(root: string, rec: ResealRecord, st: LedgerState, requestHash?: string, present: string[] = [], verdicts?: Record<string, RegisteredVerdict>) {
  const a = readLedgerAnchor(root) ?? { v: 1 as const, root: realRoot(root), genesis: null, since: rec.at, reseals: [], used: [] };
  a.genesis = rec.newGenesis;
  // An authorised reseal accepts the current state: earlier reseals whose records are not in this project any more are dropped.
  a.reseals = [...a.reseals.filter((r) => r.id !== rec.id && present.includes(r.id)), { id: rec.id, at: rec.at, kind: rec.kind, newGenesis: rec.newGenesis }];
  a.hw = { lines: st.lines, head: st.head, prevLines: st.lines, prevHead: st.head, at: rec.at };
  delete a.diverged;
  if (verdicts) a.verdicts = verdicts; // an authorised reseal accepts the current verdicts too
  if (requestHash) a.used = [...(a.used ?? []), requestHash].slice(-1000);
  writeLedgerAnchor(a);
}

/** Has this machine already applied this audit-agent request (replay)? */
export function requestUsed(root: string, hash: string): boolean {
  return Boolean(readLedgerAnchor(root)?.used?.includes(hash));
}
export function markRequestUsed(root: string, hash: string) {
  const a = readLedgerAnchor(root);
  if (!a) return;
  writeLedgerAnchor({ ...a, used: [...(a.used ?? []), hash].slice(-1000) });
}
export const requestHash = (payload: string) => createHash("sha256").update(payload).digest("hex");

/**
 * A new project is started in a folder whose previous project this machine anchored (e.g. after deleting
 * .scenaria): archive the old anchor so the new project starts clean, and keep a visible note.
 */
export function startNewProjectAnchor(root: string): LedgerAnchor["previous"] | null {
  const old = readLedgerAnchor(root);
  if (!old) return null;
  const f = ledgerAnchorFile(root);
  const archivedAs = f.replace(/\.json$/, `.${new Date().toISOString().replace(/[:.]/g, "-")}.previous.json`);
  renameSync(f, archivedAs);
  const previous = { archivedAs, since: old.since, at: new Date().toISOString() };
  writeLedgerAnchor({ v: 1, root: realRoot(root), genesis: null, since: previous.at, reseals: [], used: [], previous });
  return previous;
}

// ------------------------------------------------------------------ reseal records

function dir(store: Store) {
  return store.path("reseals");
}

function signedParts(r: ResealRecord) {
  return ["reseal/v1", r.id, r.at, r.kind, r.by, r.via, r.archived ?? "", r.archivedLines, r.archivedHead ?? "", r.newGenesis ?? "", r.nodes];
}

/**
 * Authentic? The person's: signed with a trusted approver key. An audit agent's: its request is validly
 * signed, names THIS project and the archived ledger state, and its key is (or was) registered here.
 */
function recordValid(store: Store, r: ResealRecord): boolean {
  if (r.kind === "person") return verifyRecord(store, signedParts(r), r.pub, r.sig);
  if (r.kind === "auditor") {
    const env = r.auditor?.request;
    if (!env || !requestSignatureValid(env)) return false;
    const reg = auditorRegistry();
    const id = publicKeyId(env.pub);
    if (r.auditor?.keyId !== id || ![...reg.keys, ...reg.removed].some((k) => k.id === id && k.pub === env.pub)) return false;
    try {
      const p = JSON.parse(env.payload);
      const pid = projectIdentity(store, false);
      return p?.action === "reseal" && Boolean(pid) && p.project === pid && (p.ledger?.head ?? null) === (r.archivedHead ?? null) && p.ledger?.lines === r.archivedLines;
    } catch {
      return false;
    }
  }
  return false;
}

/** The display name of a record's signer, taken from what was verified (never from the record's own text). */
function signerOf(r: ResealRecord): string {
  if (r.kind !== "auditor" || !r.auditor) return r.by;
  const reg = auditorRegistry();
  const k = [...reg.keys, ...reg.removed].find((x) => x.id === r.auditor!.keyId);
  return `auditor:${k?.name ?? r.auditor.keyId}`;
}

/** Ids of the authentic reseal records in this project. */
export function listResealIds(store: Store): string[] {
  return listReseals(store).filter((r) => r.verified).map((r) => r.id);
}

export function listReseals(store: Store): ResealRecord[] {
  const d = dir(store);
  if (!existsSync(d)) return [];
  const out: ResealRecord[] = [];
  for (const f of readdirSync(d).filter((x) => /^rs\d+\.json$/.test(x))) {
    try {
      const r = JSON.parse(readFileSync(join(d, f), "utf8")) as ResealRecord;
      if (r.id !== f.replace(/\.json$/, "")) continue;
      const verified = recordValid(store, r);
      out.push({ ...r, by: verified ? signerOf(r) : r.by, verified });
    } catch {
      /* unreadable record: not counted */
    }
  }
  return out.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

export function saveReseal(store: Store, body: Omit<ResealRecord, "id" | "pid" | "pub" | "sig" | "verified">): ResealRecord {
  mkdirSync(dir(store), { recursive: true });
  const used = readdirSync(dir(store)).map((f) => /^rs(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  const id = `rs${(used.length ? Math.max(...used) : 0) + 1}`;
  const rec: ResealRecord = { id, ...body };
  if (rec.kind === "person") Object.assign(rec, signRecord(store, signedParts(rec)));
  writeJsonAtomic(join(dir(store), `${id}.json`), rec);
  return { ...rec, verified: recordValid(store, rec) };
}

// ------------------------------------------------------------------ what integrity() reports on top of the ledger

export interface SealFindings {
  /** The anchor says this folder had a sealed ledger (so a missing ledger is a finding, with or without ledger.sealed). */
  anchored: boolean;
  /** The ledger is not the one this machine accepted (deleted and recreated, or reset without authority). */
  ledgerReplaced: boolean;
  /** The ledger does not end where this machine last saw it: truncated, rewritten, rolled back or extended outside Scenaria. */
  ledgerDiverged: {
    expected: { lines: number; head: string | null };
    found: { lines: number; head: string | null };
    /**
     * "extended": the chain still contains the mark and simply goes on — something wrote that this machine's
     * Scenaria did not track (an older version still running, another computer, or a hand-appended line).
     * "rewritten": the mark is gone — the ledger was shortened, rewritten or rolled back.
     */
    kind: "extended" | "rewritten";
    /** Nodes written after the mark (to review). */
    since: string[];
  } | null;
  /** Reseals without an authentic record (missing, edited, forged, or unknown to this machine). */
  resealsUnproven: string[];
  /** Authentic reseals of this project. */
  reseals: { id: string; at: string; kind: "person" | "auditor"; by: string }[];
  /** A new project was started in this folder (the previous one's anchor is archived). */
  restarted: { at: string; since: string } | null;
}

export function sealFindings(store: Store, st: LedgerState): SealFindings {
  const marker = markerTime(store);
  // Reads stay lock-free; only a missing or incomplete anchor is written (under the lock).
  let anchor = readLedgerAnchor(store.root);
  if (!anchor || anchor.genesis === null || !anchor.hw) anchor = store.withLock(() => ensureLedgerAnchor(store, st, marker));
  const records = listReseals(store);
  const authentic = records.filter((r) => r.verified);
  const unproven = new Set<string>();
  // The record's time is not signed for audit agents (C2 review K1): it must match what this machine anchored.
  for (const r of anchor?.reseals ?? []) if (!authentic.some((x) => x.id === r.id && x.newGenesis === r.newGenesis && x.at === r.at)) unproven.add(r.id);
  for (const r of records) if (!r.verified || (anchor && anchor.genesis !== null && !anchor.reseals.some((x) => x.id === r.id && x.at === r.at))) unproven.add(r.id);
  const diverged = anchor?.diverged ?? (anchor?.hw && st.exists && !atHighWater(st, anchor.hw) ? { expected: { lines: anchor.hw.lines, head: anchor.hw.head }, found: { lines: st.lines, head: st.head } } : null);
  let detail: { kind: "extended" | "rewritten"; since: string[] } | null = null;
  if (diverged && st.exists) {
    const lines = new Ledger(store.path("ledger.jsonl")).read().lines;
    const e = diverged.expected;
    const extended = lines.length > e.lines && (e.lines === 0 || lines[e.lines - 1]?.c === e.head);
    detail = { kind: extended ? "extended" : "rewritten", since: extended ? [...new Set(lines.slice(e.lines).map((l) => l.id))] : [] };
  }
  return {
    anchored: Boolean(anchor && anchor.genesis !== null),
    ledgerReplaced: anchor && anchor.genesis !== null ? Boolean(st.exists && st.genesis !== anchor.genesis) : startedAfterMarker(st, marker),
    ledgerDiverged: diverged && detail ? { expected: diverged.expected, found: { lines: st.lines, head: st.head }, ...detail } : null,
    resealsUnproven: [...unproven].sort(),
    reseals: authentic.map((r) => ({ id: r.id, at: r.at, kind: r.kind, by: r.by })),
    restarted: anchor?.previous ? { at: anchor.previous.at, since: anchor.previous.since } : null,
  };
}
