/**
 * Batch C3: the organisation's own evidence per ISO/IEC 42001 Annex A control.
 *
 * Most Annex A controls (25 of 38) are the organisation's to evidence: a policy, a process, a role. The
 * person records, per control, which document evidences it: a link (URL) and a hash of the document, who
 * owns it (role and name) and its date. Kev's decisions (2026-10-16):
 *   1. Stored in the project and meant to be committed, like canon.json (`.scenaria/org-evidence.json`).
 *   2. It never raises the status Scenaria computes from its records: it is its own field next to it.
 *   3. Per project; "take over from another project" copies the person's signed entries (organisation-wide
 *      evidence comes with Batch D).
 *   4. A document is referenced by URL and hash (sha256), so a changed document no longer matches.
 *   5. The owner is recorded with role and name.
 *
 * Security (rules 5, 6, 9): only the person records, removes, confirms or copies (approval session or
 * interactive terminal; callers enforce it). Every decision is signed with the approver key over every
 * field shown, bound to the project and a revision; the newest revision per entry is anchored outside the
 * project. Once an entry is anchored, anything but a newer, validly signed revision by a trusted key is
 * "tampered" (an edit, a rollback, a re-signature by another key, a duplicate id). The person never signs
 * content they did not enter or compare: an entry not signed by them is discarded (a signed tombstone without
 * its content), never re-signed by a removal; confirming needs the digest of exactly what was shown and puts
 * the entry in force from the confirmation on. An entry's content never changes after it was recorded: a new
 * document is a new entry. Ids are never reused.
 *
 * Limits: the file is committed, so role, name and a copied project's name are visible to everyone who can
 * read the repository. Scenaria does not fetch the URL; an auditor checks the document against the hash.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { evidenceAnchors, foldersBoundTo, projectIdentity, publicKeyId, signRecord, trustedApproverIdSet, verifyEd25519, type Anchor } from "./canon.js";
import { ANNEX_A_CONTROLS, ANNEX_A_STANDARD, type AnnexAControl } from "./iso42001.js";
import { Store, writeJsonAtomic } from "./store.js";

export const ORG_EVIDENCE_FILE = "org-evidence.json";
export const ORG_EVIDENCE_VERSION = 1;
/** At most this many entries per project (a flood would only bury the real ones). */
export const MAX_ORG_EVIDENCE = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ID = 9_999_999;

export interface OrgEvidence {
  /** e1, e2, … — never reused. */
  id: string;
  /** Annex A control id, e.g. "A.2.2" (on a discarded entry the control it concerned, or empty when unclear). */
  control: string;
  /** Where the document is (http or https, normalised: an international domain shows as punycode). */
  url: string;
  /** "sha256:<64 hex>" of the document. */
  hash: string;
  title?: string;
  owner: { role: string; name: string };
  /** The document's date (YYYY-MM-DD). */
  date: string;
  note?: string;
  /** Fingerprint of the control in the catalogue when it was recorded or last confirmed (see `controlFingerprint`). */
  catalogue: string;
  /** Name of the project it was taken over from (set only by Scenaria's copy; never a folder path). */
  copiedFrom?: string;
  status: "active" | "removed";
  /** An entry the person did not sign, thrown out: content cleared, never counts (kept so its id stays taken). */
  discarded?: boolean;
  /** In force from (the person's recording, or their confirmation of a teammate's entry). */
  activeFrom: string;
  removedAt?: string;
  /** Who recorded it (kept through later decisions, so the audit file shows when it came into force and by whom). */
  recordedBy: string;
  recordedVia: string;
  recordedAt: string;
  rev: number;
  /** The latest decision: recorded, confirmed, removed or discarded. */
  decidedBy: string;
  decidedVia: string;
  decidedAt: string;
  pub?: string;
  keyId?: string;
  sig?: string;
}

export type OrgEvidenceTrust = "verified" | "untrusted" | "unsigned" | "tampered";

export interface OrgEvidenceState {
  entry: OrgEvidence;
  trust: OrgEvidenceTrust;
  /** The control's text in the catalogue changed since the entry was recorded: the person should confirm it. */
  catalogueChanged: boolean;
  /** Digest of exactly what is stored; confirming needs it (what the person saw is what gets signed). */
  digest: string;
  /**
   * The stored values are in their checked, normal form (C4c-2 review R1). An entry that is not (a look-alike link,
   * an upper-case hash, a value that fails the checks) can never be confirmed: discard it and record it again.
   */
  normal: boolean;
}

export interface OrgEvidenceInput {
  control: string;
  url: string;
  hash: string;
  title?: string;
  role: string;
  name: string;
  date: string;
  note?: string;
}

export interface Who {
  by: string;
  via: "dashboard" | "terminal";
}

export class OrgEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ catalogue binding

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/** What an entry is bound to: the control's id, coverage and its texts (a later change shows). */
export function controlFingerprint(c: AnnexAControl): string {
  return sha([c.id, c.coverage, c.title.de, c.title.en, c.organisation.de, c.organisation.en]).slice(0, 16);
}

/** The whole catalogue (for the audit file and, later, the signed export). */
export function catalogueFingerprint(): { standard: string; controls: number; hash: string } {
  return {
    standard: ANNEX_A_STANDARD,
    controls: ANNEX_A_CONTROLS.length,
    hash: sha(ANNEX_A_CONTROLS.map((c) => [c.id, c.coverage, c.required, c.supporting, c.title, c.organisation, c.scenaria])).slice(0, 32),
  };
}

// ------------------------------------------------------------------ text and validation

/** Control and bidirectional characters could make a terminal or page show something else than is signed. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const UNSAFE_ONE = new RegExp(UNSAFE.source);
// Cut, then trim again: normalising twice gives the same text (review C4c-2 K4: a cut right after a space).
const clean = (x: unknown, max: number): string => (typeof x === "string" ? x.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "");
const isDay = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
};

/** Check and normalise what the person entered. Throws OrgEvidenceError with a plain message. */
export function validateInput(x: Partial<OrgEvidenceInput>): OrgEvidenceInput {
  const control = clean(x.control, 12);
  if (!ANNEX_A_CONTROLS.some((c) => c.id === control)) throw new OrgEvidenceError("bad_control", `"${control}" is not an Annex A control (e.g. A.2.2).`);
  const rawUrl = typeof x.url === "string" ? x.url.trim() : "";
  if (UNSAFE_ONE.test(rawUrl)) throw new OrgEvidenceError("bad_url", "The link contains control or direction characters.");
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new OrgEvidenceError("bad_url", "The link must be a full web address (https://…).");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new OrgEvidenceError("bad_url", "Only http and https links: never a file path on a machine.");
  if (u.username || u.password) throw new OrgEvidenceError("bad_url", "The link must not contain a user name or password.");
  const url = u.href; // normalised: an international domain is shown as punycode (no look-alike letters)
  if (url.length > 500) throw new OrgEvidenceError("bad_url", "The link is too long (at most 500 characters).");
  const h = clean(x.hash, 80).toLowerCase().replace(/^sha-?256:/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new OrgEvidenceError("bad_hash", "The hash must be the SHA-256 of the document (64 hex characters).");
  const role = clean(x.role, 120);
  const name = clean(x.name, 120);
  if (!role) throw new OrgEvidenceError("bad_owner", "The owner's role is required (e.g. AI officer).");
  if (!name) throw new OrgEvidenceError("bad_owner", "The owner's name is required.");
  const date = clean(x.date, 10);
  if (!isDay(date)) throw new OrgEvidenceError("bad_date", "The document's date must be a real day: YYYY-MM-DD.");
  if (Date.parse(`${date}T00:00:00Z`) > Date.now() + 36 * 3600_000) throw new OrgEvidenceError("bad_date", "The document's date lies in the future.");
  const title = clean(x.title, 200);
  const note = clean(x.note, 500);
  return { control, url, hash: `sha256:${h}`, role, name, date, ...(title ? { title } : {}), ...(note ? { note } : {}) };
}

/** SHA-256 of a document's bytes, in the stored form. */
export function documentHash(bytes: Buffer | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// ------------------------------------------------------------------ storage

const file = (store: Store) => store.path(ORG_EVIDENCE_FILE);
const realFolder = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const ID = /^e(\d{1,7})$/;
const numId = (id: string) => (ID.test(id) ? Number(id.slice(1)) : 0);

/** Normalise one stored entry: files can be edited by hand or by merges (wrong types never throw; unsafe characters are dropped). */
function normalise(x: any): OrgEvidence | null {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !ID.test(x.id)) return null;
  const s = (v: unknown, max = 600) => clean(v, max);
  const o = x.owner && typeof x.owner === "object" ? x.owner : {};
  return {
    id: x.id,
    control: s(x.control, 12),
    url: s(x.url),
    hash: s(x.hash, 80),
    ...(typeof x.title === "string" ? { title: s(x.title, 200) } : {}),
    owner: { role: s(o.role, 120), name: s(o.name, 120) },
    date: s(x.date, 10),
    ...(typeof x.note === "string" ? { note: s(x.note, 500) } : {}),
    catalogue: s(x.catalogue, 32),
    ...(typeof x.copiedFrom === "string" ? { copiedFrom: s(x.copiedFrom, 120) } : {}),
    status: x.status === "removed" ? "removed" : "active",
    ...(x.discarded === true ? { discarded: true } : {}),
    activeFrom: s(x.activeFrom, 40),
    ...(typeof x.removedAt === "string" ? { removedAt: s(x.removedAt, 40) } : {}),
    recordedBy: s(x.recordedBy, 120),
    recordedVia: s(x.recordedVia, 20),
    recordedAt: s(x.recordedAt, 40),
    rev: Number.isSafeInteger(x.rev) && x.rev > 0 ? x.rev : 0,
    decidedBy: s(x.decidedBy, 120),
    decidedVia: s(x.decidedVia, 20),
    decidedAt: s(x.decidedAt, 40),
    ...(typeof x.pub === "string" ? { pub: x.pub } : {}),
    ...(typeof x.keyId === "string" ? { keyId: x.keyId } : {}),
    ...(typeof x.sig === "string" ? { sig: x.sig } : {}),
  };
}

/** Digest of the file as it is on disk now ("-" when absent or unreadable), to notice a change before writing. */
function fileDigest(store: Store): string {
  try {
    return createHash("sha256").update(readFileSync(file(store))).digest("hex");
  } catch {
    return "-";
  }
}

export interface OrgEvidenceRead {
  entries: OrgEvidence[];
  nextId: number;
  error: string | null;
  /** Digest of the bytes that were read. */
  digest: string;
}

/**
 * Read the file. `error` when it exists but cannot be read (a merge conflict, a hand edit, not a plain file,
 * too large). `nextId` is the first id at or after the stored one that was never signed (not anchored) and is
 * not in the file: a planted entry with a huge id can neither take a signed id nor block new ones (review N2).
 */
export function readOrgEvidence(store: Store): OrgEvidenceRead {
  const f = file(store);
  let entries: OrgEvidence[] = [];
  let nextId = 1;
  let error: string | null = null;
  let digest = "-";
  if (existsSync(f)) {
    try {
      const st = lstatSync(f);
      if (!st.isFile()) throw new Error("not a plain file");
      if (st.size > MAX_FILE_BYTES) throw new Error("larger than 2 MB");
      const bytes = readFileSync(f);
      digest = createHash("sha256").update(bytes).digest("hex");
      const raw = JSON.parse(bytes.toString("utf8"));
      entries = Array.isArray(raw?.entries) ? raw.entries.map(normalise).filter((e: OrgEvidence | null): e is OrgEvidence => e !== null) : [];
      if (Number.isSafeInteger(raw?.nextId) && raw.nextId > 0 && raw.nextId <= MAX_ID) nextId = raw.nextId;
    } catch (err: any) {
      error = `${ORG_EVIDENCE_FILE} cannot be read (${String(err?.message ?? err).replace(UNSAFE, " ").slice(0, 80)})`;
      entries = [];
    }
  }
  // Never reuse an id that was ever signed (the marks outside the project remember them) or that is in the file.
  const taken = new Set([...Object.keys(evidenceAnchors(store).read()).filter((k) => k.startsWith("ev:")).map((k) => k.slice(3)), ...entries.map((e) => e.id)]);
  while (taken.has(`e${nextId}`) && nextId <= MAX_ID) nextId++;
  // A stored nextId pushed to the end (by hand) never blocks: the lowest id that was never signed is just as new.
  if (nextId > MAX_ID) for (nextId = 1; taken.has(`e${nextId}`) && nextId <= MAX_ID; ) nextId++;
  return { entries, nextId, error, digest };
}

/**
 * Write the file first, then raise the marks: a failed write never leaves a mark without its entry (no false
 * "missing"). Refused when the file changed since it was read (`readDigest`): nothing decided on one version is
 * written over another.
 */
function write(store: Store, entries: OrgEvidence[], nextId: number, raise: Record<string, Anchor> = {}, readDigest?: string) {
  if (readDigest !== undefined && fileDigest(store) !== readDigest) throw new OrgEvidenceError("changed", `${ORG_EVIDENCE_FILE} changed while the decision was being made: nothing was written. Look at it again.`);
  writeJsonAtomic(file(store), { v: ORG_EVIDENCE_VERSION, standard: ANNEX_A_STANDARD, entries, nextId: Math.min(nextId, MAX_ID) });
  if (Object.keys(raise).length) evidenceAnchors(store).raise(raise);
}

/** Every signed field (unsigned: none). */
function parts(e: OrgEvidence): unknown[] {
  return [
    "orgevidence/v1",
    e.rev,
    e.id,
    e.control,
    e.url,
    e.hash,
    e.title ?? "",
    e.owner.role,
    e.owner.name,
    e.date,
    e.note ?? "",
    e.catalogue,
    e.copiedFrom ?? "",
    e.status,
    e.discarded === true,
    e.activeFrom,
    e.removedAt ?? "",
    e.recordedBy,
    e.recordedVia,
    e.recordedAt,
    e.decidedBy,
    e.decidedVia,
    e.decidedAt,
  ];
}

/** Digest of exactly what is stored and shown (the person confirms this, nothing else). */
export function entryDigest(e: OrgEvidence): string {
  return sha([e.id, e.control, e.url, e.hash, e.title ?? "", e.owner.role, e.owner.name, e.date, e.note ?? "", e.copiedFrom ?? "", e.status, e.activeFrom, e.rev, e.sig ?? ""]).slice(0, 24);
}

/** Sign the person's decision (sets rev, pub, keyId, sig). Returns the mark to raise after the write. */
function sign(store: Store, e: OrgEvidence, known: number): Record<string, Anchor> {
  e.rev = Math.max(e.rev ?? 0, known, evidenceAnchors(store).read()[`ev:${e.id}`]?.rev ?? 0) + 1;
  const s = signRecord(store, parts(e));
  e.pub = s.pub;
  e.keyId = publicKeyId(s.pub);
  e.sig = s.sig;
  return { [`ev:${e.id}`]: { rev: e.rev, status: e.status, sig: e.sig } };
}

/** Trust of one entry as stored (signature, key, anchored revision, duplicate id). Never throws. */
function trustOf(e: OrgEvidence, pid: string, trusted: Set<string>, a: Anchor | undefined, duplicate: boolean): OrgEvidenceTrust {
  try {
    if (duplicate) return "tampered";
    const signed = Boolean(e.sig && e.pub && pid && verifyEd25519(e.pub, e.sig, JSON.stringify([pid, ...parts(e)])));
    const byTrusted = signed && trusted.has(publicKeyId(e.pub));
    if (a) {
      // Anchored: only a newer (or the same) revision, validly signed by a trusted key, is the person's (review C3-3).
      if (!byTrusted || e.rev < a.rev || (e.rev === a.rev && e.sig !== a.sig)) return "tampered";
      return "verified";
    }
    if (!e.sig || !e.pub) return "unsigned";
    if (!signed) return "tampered";
    return byTrusted ? "verified" : "untrusted";
  } catch {
    return "tampered";
  }
}

/**
 * Every entry with how far this machine can vouch for it, plus entries that were anchored but are gone from
 * the file (`missing`). A newer verified revision (a teammate's, pulled with git) raises this machine's mark.
 */
export function orgEvidenceStates(store: Store): { entries: OrgEvidenceState[]; missing: string[]; error: string | null } {
  return statesOf(store, readOrgEvidence(store));
}

/** States of exactly the entries that were read (one snapshot: what is judged is what gets signed; review N1). */
function statesOf(store: Store, read: Pick<OrgEvidenceRead, "entries" | "error">): { entries: OrgEvidenceState[]; missing: string[]; error: string | null } {
  const { entries, error } = read;
  const pid = projectIdentity(store, false);
  const anchors = evidenceAnchors(store).read();
  const trusted = trustedApproverIdSet();
  const fp = new Map(ANNEX_A_CONTROLS.map((c) => [c.id, controlFingerprint(c)]));
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.id, (count.get(e.id) ?? 0) + 1);
  const raise: Record<string, Anchor> = {};
  const out = entries.map((entry) => {
    const a = anchors[`ev:${entry.id}`];
    const trust = trustOf(entry, pid, trusted, a, (count.get(entry.id) ?? 0) > 1);
    if (trust === "verified" && (!a || entry.rev > a.rev)) raise[`ev:${entry.id}`] = { rev: entry.rev, status: entry.status, sig: entry.sig! };
    return { entry, trust, catalogueChanged: entry.status === "active" && !entry.discarded && fp.get(entry.control) !== entry.catalogue, digest: entryDigest(entry), normal: entry.discarded ? true : isNormal(entry) };
  });
  if (Object.keys(raise).length) evidenceAnchors(store).raise(raise);
  const present = new Set(entries.map((e) => e.id));
  // Every anchored entry must stay in the file: a deleted record (also a removal or a discard) is hidden history.
  const missing = error ? [] : Object.keys(anchors).filter((k) => k.startsWith("ev:") && !present.has(k.slice(3))).map((k) => k.slice(3));
  return { entries: out, missing, error };
}

/** Counts for its control: the person's (verified), active, not discarded. */
export const counts = (x: OrgEvidenceState) => x.trust === "verified" && !x.entry.discarded;

// ------------------------------------------------------------------ the person's actions (callers enforce "person")

function event(store: Store, message: string, data: Record<string, unknown>) {
  store.appendEvent({ type: "update", data: { message, ...data } });
}

function fresh(store: Store): OrgEvidenceRead {
  const r = readOrgEvidence(store);
  if (r.error) throw new OrgEvidenceError("unreadable", `${r.error}: fix the file (merge conflict?) before changing the organisation's evidence.`);
  return r;
}

const person = (who: Who) => ({ by: clean(who.by, 80) || "person", via: who.via === "dashboard" ? "dashboard" : "terminal" });

/** Record a document for a control: active at once, signed by the person. */
export function addOrgEvidence(store: Store, input: Partial<OrgEvidenceInput>, who: Who, opts: { copiedFrom?: string; activeFrom?: string } = {}): OrgEvidence {
  const x = validateInput(input);
  return store.withLock(() => {
    const { entries, nextId, digest } = fresh(store);
    if (entries.length >= MAX_ORG_EVIDENCE) throw new OrgEvidenceError("full", `At most ${MAX_ORG_EVIDENCE} entries per project.`);
    if (nextId > MAX_ID) throw new OrgEvidenceError("full", "No free id left.");
    if (entries.some((e) => e.status === "active" && !e.discarded && e.control === x.control && e.hash === x.hash && e.url === x.url)) {
      throw new OrgEvidenceError("duplicate", `This document is already recorded for ${x.control}.`);
    }
    const control = ANNEX_A_CONTROLS.find((c) => c.id === x.control)!;
    const now = new Date().toISOString();
    const p = person(who);
    const e: OrgEvidence = {
      id: `e${nextId}`,
      control: x.control,
      url: x.url,
      hash: x.hash,
      ...(x.title ? { title: x.title } : {}),
      owner: { role: x.role, name: x.name },
      date: x.date,
      ...(x.note ? { note: x.note } : {}),
      catalogue: controlFingerprint(control),
      ...(opts.copiedFrom ? { copiedFrom: clean(opts.copiedFrom, 120) } : {}),
      status: "active",
      activeFrom: now,
      recordedBy: p.by,
      recordedVia: p.via,
      recordedAt: now,
      rev: 0,
      decidedBy: p.by,
      decidedVia: p.via,
      decidedAt: now,
    };
    const raise = sign(store, e, 0);
    write(store, [...entries, e], nextId + 1, raise, digest);
    event(store, `organisation's evidence ${e.id} recorded for ${e.control}`, { evidence: e.id, control: e.control, by: p.by, via: p.via });
    return e;
  });
}

/**
 * Remove an entry, judged and signed on ONE reading of the file (review N1).
 *   - The person's own copy (signed by a trusted key, matching or newer than this machine's mark) becomes a
 *     signed tombstone with its content and `removedAt`, so teammates and audits see when it stopped; copies
 *     an agent added under the same id are dropped (review N3).
 *   - An entry this machine never saw signed (unsigned, a teammate's untrusted key) is DISCARDED: replaced by a
 *     signed tombstone without its content, which never counts — the person never signs content they did not
 *     enter (review C3-1).
 *   - The person's entry changed outside Scenaria (no genuine copy left): refused, so its history is not lost —
 *     restore the file from git — unless the person explicitly discards it (`discard`).
 */
/** What removing `id` would do, on one reading of the file (the CLI shows this before the person confirms). */
export interface RemovePlan {
  outcome: "remove" | "drop_copies" | "discard" | "restore_first" | "already_removed";
  /** The person's genuine copy (remove / drop_copies / already_removed), otherwise the first copy in the file. */
  entry: OrgEvidence;
  /** Copies added outside Scenaria that are dropped. */
  dropped: number;
}

function decideRemove(store: Store, entries: OrgEvidence[], id: string, discard: boolean): { plan: RemovePlan; genuine?: OrgEvidence; anchorRev: number } {
  const copies = entries.filter((x) => x.id === id);
  if (!copies.length) throw new OrgEvidenceError("not_found", `No entry ${id}.`);
  const pid = projectIdentity(store, false);
  const trusted = trustedApproverIdSet();
  const a = evidenceAnchors(store).read()[`ev:${id}`];
  // Each copy on its own (the duplicate rule aside): which one, if any, is the person's genuine entry?
  const genuine = copies.find((c) => trustOf(c, pid, trusted, a, false) === "verified");
  const dropped = genuine ? copies.length - 1 : copies.length;
  let outcome: RemovePlan["outcome"];
  if (genuine) outcome = genuine.status === "removed" ? (dropped ? "drop_copies" : "already_removed") : "remove";
  else outcome = a && !discard ? "restore_first" : "discard";
  return { plan: { outcome, entry: genuine ?? copies[0], dropped }, genuine, anchorRev: a?.rev ?? 0 };
}

/** What removing would do, without changing anything. */
export function planRemove(store: Store, id: string, opts: { discard?: boolean } = {}): RemovePlan {
  const r = readOrgEvidence(store);
  if (r.error) throw new OrgEvidenceError("unreadable", r.error);
  return decideRemove(store, r.entries, id, Boolean(opts.discard)).plan;
}

/**
 * Remove or discard an entry. `expect` (C4c-2, the dashboard): the outcome and the digest of the entry the person
 * was shown (`planRemove`); decided again under the lock on one reading of the file — anything else is refused
 * ("changed"), so the person never signs a decision on an entry they did not see.
 */
export function removeOrgEvidence(store: Store, id: string, who: Who, opts: { discard?: boolean; expect?: { outcome: string; digest: string } } = {}): { entry: OrgEvidence; discarded: boolean; dropped: number } {
  return store.withLock(() => {
    const read = fresh(store);
    const { entries, nextId, digest } = read;
    const copies = entries.filter((x) => x.id === id);
    const { plan, genuine, anchorRev } = decideRemove(store, entries, id, Boolean(opts.discard));
    if (opts.expect && (opts.expect.outcome !== plan.outcome || opts.expect.digest !== entryDigest(plan.entry))) {
      throw new OrgEvidenceError("changed", `${id} is not what was shown: look at it again.`);
    }
    const a = anchorRev ? { rev: anchorRev } : undefined;
    const now = new Date().toISOString();
    const p = person(who);
    const highest = Math.max(...copies.map((x) => x.rev), a?.rev ?? 0);
    if (genuine) {
      const rest = entries.filter((x) => x.id !== id || x === genuine);
      const dropped = entries.length - rest.length;
      if (genuine.status === "removed") {
        if (!dropped) throw new OrgEvidenceError("removed", `${id} is already removed.`);
        write(store, rest, nextId, {}, digest);
        event(store, `organisation's evidence ${id}: ${dropped} copy(ies) added outside Scenaria dropped`, { evidence: id, by: p.by, via: p.via });
        return { entry: genuine, discarded: false, dropped };
      }
      Object.assign(genuine, { status: "removed", removedAt: now, decidedBy: p.by, decidedVia: p.via, decidedAt: now });
      const raise = sign(store, genuine, highest);
      write(store, rest, nextId, raise, digest);
      event(store, `organisation's evidence ${id} removed`, { evidence: id, control: genuine.control, by: p.by, via: p.via, ...(dropped ? { dropped } : {}) });
      return { entry: genuine, discarded: false, dropped };
    }
    if (plan.outcome === "restore_first") {
      throw new OrgEvidenceError(
        "restore_first",
        `${id} was recorded by you but changed outside Scenaria. To keep its history, restore ${ORG_EVIDENCE_FILE} from git first; or discard it (its content and history in this file are dropped).`,
      );
    }
    // The control stays (C5): an auditor still sees which control the discarded entry concerned. Only when every
    // copy names the same, real Annex A control; its other content is dropped.
    const named = [...new Set(entries.filter((x) => x.id === id).map((x) => x.control))];
    const keepControl = named.length === 1 && ANNEX_A_CONTROLS.some((c) => c.id === named[0]) ? named[0] : "";
    const tomb: OrgEvidence = {
      id,
      control: keepControl,
      url: "",
      hash: "",
      owner: { role: "", name: "" },
      date: "",
      catalogue: "",
      status: "removed",
      discarded: true,
      activeFrom: now,
      removedAt: now,
      recordedBy: p.by,
      recordedVia: p.via,
      recordedAt: now,
      rev: 0,
      decidedBy: p.by,
      decidedVia: p.via,
      decidedAt: now,
    };
    const raise = sign(store, tomb, highest);
    write(store, [...entries.filter((x) => x.id !== id), tomb], nextId, raise, digest);
    event(store, `organisation's evidence ${id} discarded (not the person's signed entry)`, { evidence: id, by: p.by, via: p.via });
    return { entry: tomb, discarded: true, dropped: copies.length };
  });
}

/**
 * Confirm an entry the person has looked at: one without a signature, one signed by a key this machine does
 * not trust (a teammate), or one whose control text changed in the catalogue. `seenDigest` must be the digest
 * of exactly what is stored now (`entryDigest`), so nothing is confirmed unseen. A teammate's or an unsigned
 * entry is in force from the confirmation on and loses any "copied from" claim (review C3-2). A changed entry
 * cannot be confirmed: discard it and record the document again.
 */
export function confirmOrgEvidence(store: Store, id: string, seenDigest: string, who: Who): OrgEvidence {
  return store.withLock(() => {
    const read = fresh(store);
    const { entries, nextId, digest } = read;
    const states = statesOf(store, read).entries.filter((x) => x.entry.id === id);
    if (!states.length) throw new OrgEvidenceError("not_found", `No entry ${id}.`);
    const st = states[0];
    if (states.length > 1 || st.trust === "tampered") throw new OrgEvidenceError("tampered", `${id} was changed outside Scenaria: remove (discard) it and record the document again.`);
    if (st.entry.status !== "active" || st.entry.discarded) throw new OrgEvidenceError("removed", `${id} is removed.`);
    if (st.trust === "verified" && !st.catalogueChanged) throw new OrgEvidenceError("nothing_to_confirm", `${id} is already confirmed.`);
    if (typeof seenDigest !== "string" || seenDigest !== st.digest) throw new OrgEvidenceError("changed", `${id} is not what was shown: look at it again.`);
    const control = ANNEX_A_CONTROLS.find((c) => c.id === st.entry.control);
    if (!control) throw new OrgEvidenceError("bad_control", `"${st.entry.control}" is not an Annex A control.`);
    // The stored values must still pass the same checks as the person's own input, and must not change by it:
    // otherwise the person would sign something else than was shown, e.g. a look-alike link as punycode (review
    // C4c-2 K2). Such an entry is discarded and the document recorded again.
    const x = validateInput({ control: st.entry.control, url: st.entry.url, hash: st.entry.hash, title: st.entry.title, role: st.entry.owner.role, name: st.entry.owner.name, date: st.entry.date, note: st.entry.note });
    if (!isNormal(st.entry)) throw new OrgEvidenceError("not_normal", `${id} would change when signed (for example a look-alike link that is stored as punycode): discard it and record the document again.`);
    const e = st.entry; // the very object that was judged (one snapshot)
    const now = new Date().toISOString();
    const p = person(who);
    const foreign = st.trust !== "verified";
    Object.assign(e, {
      url: x.url,
      hash: x.hash,
      catalogue: controlFingerprint(control),
      decidedBy: p.by,
      decidedVia: p.via,
      decidedAt: now,
      ...(foreign ? { activeFrom: now, recordedBy: p.by, recordedVia: p.via, recordedAt: now } : {}),
    });
    if (foreign) delete e.copiedFrom;
    const raise = sign(store, e, st.entry.rev);
    write(store, entries, nextId, raise, digest);
    event(store, `organisation's evidence ${id} confirmed`, { evidence: id, control: e.control, by: p.by, via: p.via });
    return e;
  });
}

// ------------------------------------------------------------------ take over from another project

export interface CopyPlan {
  from: { name: string; id: string };
  /** Other existing project folders on this machine bound to the same project id (a copy or a second checkout). */
  sameIdElsewhere: number;
  /** What would be copied (the person sees this before confirming). */
  take: { id: string; control: string; url: string; hash: string; title?: string; note?: string; owner: { role: string; name: string }; date: string; digest: string }[];
  skipped: { id: string; reason: string }[];
}

/** What `copyOrgEvidence` would take over from another project, without changing anything. */
export function planCopy(store: Store, fromRoot: string, controls?: string[]): CopyPlan {
  const other = new Store(fromRoot);
  if (!existsSync(other.path("config.json"))) throw new OrgEvidenceError("not_a_project", "That folder is not a Scenaria project.");
  const otherPid = projectIdentity(other, false);
  if (!otherPid) throw new OrgEvidenceError("no_identity", "That project has no signed records yet.");
  if (otherPid === projectIdentity(store, false)) throw new OrgEvidenceError("same_project", "That is this project (or a copy of it).");
  // Other folders bound to the same id (a second checkout, or a copy someone made): shown to the person, not a
  // refusal (a refusal could be forced forever by a throwaway folder; review N4). Gone folders do not count.
  const here = new Store(fromRoot);
  const sameIdElsewhere = foldersBoundTo(otherPid).filter((f) => f !== realFolder(here.root) && existsSync(new Store(f).path("config.json"))).length;
  let name = "";
  try {
    name = clean(other.readConfig().projectName, 120);
  } catch {}
  name ||= clean(basename(fromRoot), 120);
  const src = orgEvidenceStates(other);
  if (src.error) throw new OrgEvidenceError("unreadable", `The other project's ${src.error}.`);
  const mine = readOrgEvidence(store).entries.filter((e) => e.status === "active" && !e.discarded);
  const take: CopyPlan["take"] = [];
  const skipped: CopyPlan["skipped"] = [];
  for (const { entry: e, trust, catalogueChanged } of src.entries) {
    if (e.status !== "active" || e.discarded) continue;
    if (controls?.length && !controls.includes(e.control)) continue;
    if (trust !== "verified") skipped.push({ id: e.id, reason: trust });
    else if (catalogueChanged) skipped.push({ id: e.id, reason: "catalogue_changed" });
    else if (mine.some((h) => h.control === e.control && h.url === e.url && h.hash === e.hash)) skipped.push({ id: e.id, reason: "already_here" });
    else {
      const t = { id: e.id, control: e.control, url: e.url, hash: e.hash, ...(e.title ? { title: e.title } : {}), ...(e.note ? { note: e.note } : {}), owner: { role: e.owner.role, name: e.owner.name }, date: e.date };
      take.push({ ...t, digest: takeDigest(t) });
    }
  }
  return { from: { name, id: otherPid }, sameIdElsewhere, take, skipped };
}

/** The entry's values are exactly what `validateInput` makes of them (nothing would change when signed). */
function isNormal(e: OrgEvidence): boolean {
  try {
    const x = validateInput({ control: e.control, url: e.url, hash: e.hash, title: e.title, role: e.owner?.role, name: e.owner?.name, date: e.date, note: e.note });
    return x.url === e.url && x.hash === e.hash && (x.title ?? "") === (e.title ?? "") && (x.note ?? "") === (e.note ?? "") && x.role === e.owner.role && x.name === e.owner.name && x.date === e.date;
  } catch {
    return false;
  }
}

/** Digest of every value of a planned copy that gets signed (review C4c-2 K1). */
export function takeDigest(t: { id: string; control: string; url: string; hash: string; title?: string; note?: string; owner: { role: string; name: string }; date: string }): string {
  return createHash("sha256")
    .update(JSON.stringify(["orgevidence-take/v1", t.id, t.control, t.url, t.hash, t.title ?? "", t.note ?? "", t.owner.role, t.owner.name, t.date]))
    .digest("hex");
}

/** What the person saw of a copy plan: the project name that gets recorded and every entry's digest. */
export interface CopyExpect {
  name: string;
  entries: { id: string; digest: string }[];
}

/**
 * Take over the organisation's evidence from another of the person's projects: every active entry there that
 * this machine can vouch for (signed by a trusted key, for THAT project, catalogue unchanged) and that is not
 * here yet. Each copy is recorded and signed anew for this project, in force from now, naming the project it
 * came from. Callers show `planCopy` first and pass `expect` (the ids the person saw); anything else is refused.
 */
export function copyOrgEvidence(store: Store, fromRoot: string, who: Who, controls: string[] | undefined, expect: CopyExpect): { copied: OrgEvidence[]; skipped: { id: string; reason: string }[]; from: string } {
  const plan = planCopy(store, fromRoot, controls);
  const changed = () => new OrgEvidenceError("changed", "The other project's documents changed since they were shown: look at them again.");
  // Every signed value the person saw, and the project name recorded as the origin (review C4c-2 K1); required
  // for every caller (R2).
  if (!expect || typeof expect.name !== "string" || !Array.isArray(expect.entries)) throw changed();
  if (expect.name !== plan.from.name || expect.entries.length !== plan.take.length) throw changed();
  if (plan.take.some((t) => !expect.entries.some((x) => x.id === t.id && x.digest === t.digest))) throw changed();
  const copied: OrgEvidence[] = [];
  const skipped = [...plan.skipped];
  for (const t of plan.take) {
    try {
      copied.push(addOrgEvidence(store, { control: t.control, url: t.url, hash: t.hash, title: t.title, note: t.note, role: t.owner.role, name: t.owner.name, date: t.date }, who, { copiedFrom: plan.from.name }));
    } catch (err: any) {
      skipped.push({ id: t.id, reason: err?.code ?? "error" });
    }
  }
  return { copied, skipped, from: plan.from.name };
}
