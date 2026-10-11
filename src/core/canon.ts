/**
 * Canon events: the project's fixed points.
 *
 *   past   — settled facts every later decision must respect ("Must run in AWS eu-central-1",
 *            "TypeScript only", "no cookies without consent"). Usually extracted from decisions.
 *   future — milestones the work must survive ("10k requests/s by 2027-01-01", "GDPR deletion
 *            within 30 days"), optionally with a check command that proves it.
 *
 * Governance (agents propose, a person decides):
 *   - Agents, chat blocks and the archivist can only create PROPOSALS. They cannot set a check
 *     command that will run — a suggested command is stored as text (`suggestedCheck`) and only
 *     becomes the check when a person adopts it explicitly.
 *   - Binding actions (add, approve, reject, retire, confirm, run checks) are signed with the
 *     person's Ed25519 approver key (~/.config/scenaria/approver-key.pem, never in the project).
 *     An event counts only if its signature verifies AND the key is trusted on this machine: your
 *     own key plus teammates' public keys you added with `scenaria canon trust` (stored in
 *     ~/.config/scenaria/trusted-approvers.json, outside the project). Anything else is NOT binding:
 *     "tampered" (signature missing/wrong — canon.json edited by hand, by an agent, by a merge) or
 *     "untrusted" (validly signed by an unknown key). A person can re-approve or reject either.
 *   - Check commands run only when a person starts them, only for approved events, and only the
 *     exact command the person adopted.
 * This is tamper-EVIDENT governance, not tamper-proof: a process with the user's full rights can read
 * the private key and forge an approval. What it guarantees: no approval by accident, none through
 * Scenaria's tools, API tokens or chat capture, and none by editing files in the repository.
 *
 * Stored in .scenaria/canon.json — meant to be committed: the fixed points belong to the project.
 */
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "./store.js";
import { writeJsonAtomic } from "./store.js";
import { optionLabel } from "./context.js";
import { tokenize } from "./recall.js";
import { globalConfigPath } from "./global.js";
import type { ScenariaNode } from "./types.js";

export type CanonKind = "past" | "future";
/**
 * Computed, never stored: "tampered" = signature missing or does not match the content;
 * "untrusted" = validly signed, but by a key you have not chosen to trust.
 */
export type CanonStatus = "proposed" | "active" | "rejected" | "retired" | "tampered" | "untrusted";
export type CanonTrust = "verified" | "untrusted" | "unsigned" | "tampered" | "n/a";

export interface CanonCheck {
  status: "passed" | "failed";
  at: string;
  /** HEAD when the check ran. */
  node: string | null;
  /** Whether the working tree matched HEAD's snapshot (otherwise the result is about unsaved files). */
  clean: boolean;
  detail?: string;
  by?: string;
  /** "command" = check command ran; "manual" = a person confirmed it. */
  how?: "command" | "manual";
  sig?: string;
  /** Public key (base64 SPKI DER) of whoever ran/confirmed the check. */
  pub?: string;
}

export interface CanonEvent {
  id: string; // k1, k2, …
  kind: CanonKind;
  text: string;
  status: CanonStatus;
  /** Hard = breaking it invalidates a line of work; soft = a strong preference. */
  hard: boolean;
  /** Shell command that proves the event holds (exit 0 = passed). Only ever set by a person. */
  check?: string;
  /** A check command an agent suggested — text only, never executed unless a person adopts it. */
  suggestedCheck?: string;
  /** For future events: the date it must hold by (YYYY-MM-DD). */
  due?: string;
  /** Node / item references the event comes from. */
  evidence?: string[];
  source: "user" | "archivist" | "agent";
  proposedBy?: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** How the decision was made (dashboard, cli) — audit trail. */
  decidedVia?: string;
  reason?: string;
  lastCheck?: CanonCheck;
  /** Revision: grows with every signed change, so an older signed copy can be told apart from the current one. */
  rev?: number;
  /** Ed25519 signature of the last binding decision, the signer's public key and its id. */
  sig?: string;
  pub?: string;
  keyId?: string;
  /** Computed on read: can this machine vouch for the decision? */
  trust?: CanonTrust;
  /** Computed on read: a check result was present but its signature does not verify (dropped). */
  checkTampered?: boolean;
}

export interface CanonInput {
  kind: CanonKind;
  text: string;
  hard?: boolean;
  check?: string;
  due?: string;
  evidence?: string[];
}

// ------------------------------------------------------------------ approver keys & signatures
//
// Each person has an Ed25519 key pair in ~/.config/scenaria (never in the project). Binding decisions
// carry the signer's public key and signature. A decision counts only if its signature verifies AND
// the key is trusted on this machine: your own key, plus teammates' keys you explicitly trust
// (~/.config/scenaria/trusted-approvers.json — also outside the project, so an agent editing the
// repository cannot add itself).

function cfgDir() {
  return dirname(globalConfigPath());
}

function loadOwnKey(create: boolean): { priv: KeyObject; pub: string; id: string } | null {
  const f = join(cfgDir(), "approver-key.pem");
  let pem: string | null = existsSync(f) ? readFileSync(f, "utf8") : null;
  if (!pem) {
    if (!create) return null;
    mkdirSync(cfgDir(), { recursive: true });
    const { privateKey } = generateKeyPairSync("ed25519");
    pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(f, pem, { mode: 0o600 });
    try {
      chmodSync(f, 0o600);
    } catch {}
  }
  try {
    const priv = createPrivateKey(pem);
    const pub = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
    return { priv, pub, id: keyIdOf(pub) };
  } catch {
    return null;
  }
}

const keyIdOf = (pub: string) => createHash("sha256").update(pub).digest("hex").slice(0, 12);

interface TrustedKey {
  id: string;
  pub: string;
  name?: string;
  addedAt: string;
}

function trustedFile() {
  return join(cfgDir(), "trusted-approvers.json");
}

export function trustedApprovers(): TrustedKey[] {
  try {
    const raw = JSON.parse(readFileSync(trustedFile(), "utf8"));
    return Array.isArray(raw?.keys) ? raw.keys.filter((k: any) => typeof k?.pub === "string" && typeof k?.id === "string" && keyIdOf(k.pub) === k.id) : [];
  } catch {
    return [];
  }
}

function trustedIds(): Set<string> {
  const own = loadOwnKey(false);
  return new Set([...(own ? [own.id] : []), ...trustedApprovers().map((k) => k.id)]);
}

/** Your own approver identity (created on first use). Share `pub` with teammates who should trust you. */
export function ownApproverKey(): { id: string; pub: string } {
  const k = loadOwnKey(true)!;
  return { id: k.id, pub: k.pub };
}

/** Trust another approver's key on this machine (a person's action — CLI with confirmation only). */
export function trustApprover(pub: string, name?: string): TrustedKey {
  const id = keyIdOf(pub);
  try {
    createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("not a valid public key");
  }
  const keys = trustedApprovers().filter((k) => k.id !== id);
  const k: TrustedKey = { id, pub, name: name?.slice(0, 80), addedAt: new Date().toISOString() };
  mkdirSync(cfgDir(), { recursive: true });
  writeFileSync(trustedFile(), JSON.stringify({ keys: [...keys, k] }, null, 2) + "\n", { mode: 0o600 });
  return k;
}

// Both payloads name the project and the revision: a signed record copied from another project, or an
// older signed version of the same event (from git history, canon.json.bak, …), does not verify as current.
function decisionPayload(pid: string, e: CanonEvent) {
  return JSON.stringify(["canon/v2", pid, e.rev ?? 0, e.id, e.kind, e.text, e.status, e.hard, e.check ?? "", e.due ?? "", e.decidedAt ?? "", e.decidedBy ?? ""]);
}
function checkPayload(pid: string, e: CanonEvent, c: CanonCheck) {
  return JSON.stringify(["check/v2", pid, e.rev ?? 0, e.id, e.check ?? "", c.status, c.at, c.node ?? "", c.clean, c.how ?? "command"]);
}

/** The project's identity for signatures (config.json; created on the first signed change). */
function projectId(store: Store, create: boolean): string {
  const cfg = store.readConfig();
  if (cfg.projectId) return cfg.projectId;
  if (!create) return "";
  cfg.projectId = randomBytes(12).toString("hex");
  store.writeConfig(cfg);
  return cfg.projectId;
}

// ------------------------------------------------------------------ anchors (high-water marks)
//
// Outside the project (~/.config/scenaria/anchors/<project>.json): the newest revision this machine has
// seen per event, with its status. Restoring an older signed version, or deleting an approved event,
// is detected even though every signature in the file is valid.

interface Anchor {
  rev: number;
  status: string;
  sig: string;
}

function anchorFile(pid: string) {
  return join(cfgDir(), "anchors", `${pid.replace(/[^a-z0-9]/gi, "")}.json`);
}
function readAnchors(pid: string): Record<string, Anchor> {
  if (!pid) return {};
  try {
    const raw = JSON.parse(readFileSync(anchorFile(pid), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function raiseAnchors(pid: string, updates: Record<string, Anchor>) {
  if (!pid || !Object.keys(updates).length) return;
  try {
    // Re-read and keep the maximum: two processes raising at once can never lower a mark.
    const cur = readAnchors(pid);
    for (const [id, a] of Object.entries(updates)) if (!cur[id] || a.rev >= cur[id].rev) cur[id] = a;
    mkdirSync(dirname(anchorFile(pid)), { recursive: true });
    writeJsonAtomic(anchorFile(pid), cur);
  } catch {
    /* best effort: the anchor only adds detection */
  }
}

function verifySig(pub: string | undefined, sig: string | undefined, payload: string): boolean {
  if (!pub || !sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(payload), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/**
 * Sign a person's change: the revision moves past everything this machine has seen for the event,
 * the decision (and an optional new check result) is signed, and the anchor is raised.
 */
function signChange(store: Store, e: CanonEvent, check?: CanonCheck) {
  const pid = projectId(store, true);
  const k = loadOwnKey(true)!;
  e.rev = Math.max(e.rev ?? 0, readAnchors(pid)[e.id]?.rev ?? 0) + 1;
  e.pub = k.pub;
  e.keyId = k.id;
  e.sig = edSign(null, Buffer.from(decisionPayload(pid, e)), k.priv).toString("base64");
  if (check) {
    check.pub = k.pub;
    check.sig = edSign(null, Buffer.from(checkPayload(pid, e, check)), k.priv).toString("base64");
    e.lastCheck = check;
  } else if (e.lastCheck) {
    e.lastCheck = undefined; // a check result belongs to one revision; a new decision needs a new check
  }
  return { pid, anchor: { rev: e.rev, status: e.status, sig: e.sig } as Anchor };
}

/** Can this machine vouch for an event's binding state? */
function trustOf(pid: string, e: CanonEvent, trusted: Set<string>, anchor?: Anchor): CanonTrust {
  // Rolled back to an older version (or replaced by a proposal with a used id): never current.
  if (anchor && ((e.rev ?? 0) < anchor.rev || ((e.rev ?? 0) === anchor.rev && e.sig !== anchor.sig))) return "tampered";
  // Only a never-signed id can be a plain proposal; a signed id relabelled as "proposed" must verify (and won't).
  if (e.status === "proposed" && !anchor) return "n/a";
  if (!e.sig || !e.pub || !pid) return "unsigned";
  if (!verifySig(e.pub, e.sig, decisionPayload(pid, e))) return "tampered";
  return trusted.has(keyIdOf(e.pub)) ? "verified" : "untrusted";
}

// ------------------------------------------------------------------ storage

function file(store: Store) {
  return store.path("canon.json");
}

const one = (s: string, max = 300) => s.replace(/\s+/g, " ").trim().slice(0, max);
const isDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const strArr = (x: unknown) => (Array.isArray(x) ? x.filter((v) => typeof v === "string").map((v) => v.slice(0, 80)).slice(0, 20) : typeof x === "string" ? [x.slice(0, 80)] : undefined);

/** Normalise one stored entry (files can be edited by hand or by merges). */
function normalise(raw: any): CanonEvent | null {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^k\d{1,6}$/.test(raw.id) || typeof raw.text !== "string") return null;
  const status: CanonStatus = ["proposed", "active", "rejected", "retired"].includes(raw.status) ? raw.status : "proposed";
  const lc = raw.lastCheck && typeof raw.lastCheck === "object" && (raw.lastCheck.status === "passed" || raw.lastCheck.status === "failed") ? raw.lastCheck : undefined;
  return {
    id: raw.id,
    kind: raw.kind === "future" ? "future" : "past",
    text: one(raw.text, 400),
    status,
    hard: raw.hard !== false,
    check: typeof raw.check === "string" && raw.check ? raw.check : undefined,
    suggestedCheck: typeof raw.suggestedCheck === "string" && raw.suggestedCheck ? raw.suggestedCheck.slice(0, 500) : undefined,
    due: isDate(raw.due) ? raw.due : undefined,
    evidence: strArr(raw.evidence),
    source: ["user", "archivist", "agent"].includes(raw.source) ? raw.source : "agent",
    proposedBy: typeof raw.proposedBy === "string" ? raw.proposedBy.slice(0, 80) : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    decidedBy: typeof raw.decidedBy === "string" ? raw.decidedBy.slice(0, 80) : undefined,
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : undefined,
    decidedVia: typeof raw.decidedVia === "string" ? raw.decidedVia.slice(0, 40) : undefined,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 300) : undefined,
    lastCheck: lc
      ? { status: lc.status, at: String(lc.at ?? ""), node: typeof lc.node === "string" ? lc.node : null, clean: lc.clean === true, detail: typeof lc.detail === "string" ? lc.detail.slice(0, 600) : undefined, by: typeof lc.by === "string" ? lc.by : undefined, how: lc.how === "manual" ? "manual" : "command", sig: typeof lc.sig === "string" ? lc.sig : undefined, pub: typeof lc.pub === "string" ? lc.pub : undefined }
      : undefined,
    sig: typeof raw.sig === "string" ? raw.sig : undefined,
    pub: typeof raw.pub === "string" ? raw.pub : undefined,
    rev: Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : undefined,
    keyId: typeof raw.keyId === "string" ? raw.keyId : undefined,
  };
}

/** Strict read for writers: a file that cannot be parsed is never overwritten (e.g. a merge conflict). */
function readRaw(store: Store): CanonEvent[] {
  const f = file(store);
  if (!existsSync(f)) return [];
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch (err: any) {
    throw new Error(`.scenaria/canon.json cannot be read (${String(err?.message ?? err).slice(0, 80)}) — fix it (merge conflict?) before changing canon events.`);
  }
  return (Array.isArray(raw?.events) ? raw.events : []).map(normalise).filter((e: CanonEvent | null): e is CanonEvent => e !== null);
}

/**
 * Canon events as they count: signatures verified, `trust` set, unverifiable binding states
 * reported as status "tampered" (not binding). A broken file reads as empty with `error` set.
 */
export function canonState(store: Store): { events: CanonEvent[]; error: string | null; missing: string[] } {
  let events: CanonEvent[];
  try {
    events = readRaw(store);
  } catch (err: any) {
    return { events: [], error: String(err?.message ?? err), missing: [] };
  }
  const trusted = trustedIds();
  const pid = projectId(store, false);
  const anchors = readAnchors(pid);
  const raise: Record<string, Anchor> = {};
  for (const e of events) {
    e.trust = trustOf(pid, e, trusted, anchors[e.id]);
    e.keyId = e.pub ? keyIdOf(e.pub) : undefined; // derived from the key itself, never taken on trust
    if (e.trust === "tampered" || e.trust === "unsigned") e.status = "tampered";
    else if (e.trust === "untrusted") e.status = "untrusted";
    // A newer verified revision (e.g. a teammate's approval pulled from git) raises the mark.
    if (e.trust === "verified" && e.sig && (!anchors[e.id] || (e.rev ?? 0) > anchors[e.id].rev)) raise[e.id] = { rev: e.rev ?? 0, status: e.status, sig: e.sig };
    // A check result counts only for this revision and with a valid signature from a trusted key.
    if (e.lastCheck && !(e.trust === "verified" && verifySig(e.lastCheck.pub, e.lastCheck.sig, checkPayload(pid, e, e.lastCheck)) && trusted.has(keyIdOf(e.lastCheck.pub!)))) {
      if (e.trust === "verified") e.checkTampered = true; // visible, never silently dropped
      e.lastCheck = undefined;
    }
  }
  raiseAnchors(pid, raise);
  // An approved event that vanished from the file: its fixed point would silently stop applying.
  const present = new Set(events.map((e) => e.id));
  const missing = Object.entries(anchors)
    .filter(([id, a]) => a.status === "active" && !present.has(id))
    .map(([id]) => id);
  return { events, error: null, missing };
}

export function readCanon(store: Store): CanonEvent[] {
  return canonState(store).events;
}

function writeCanon(store: Store, events: CanonEvent[]) {
  const f = file(store);
  if (existsSync(f)) {
    try {
      copyFileSync(f, store.path("canon.json.bak"));
    } catch {}
  }
  writeJsonAtomic(f, { events: events.map(({ trust, checkTampered, ...e }) => e) });
}

// ------------------------------------------------------------------ changes

/** Reject what could make a command read differently than it runs (newlines, control and bidi characters). */
export function validateCheck(cmd: string | undefined): string | undefined {
  if (cmd === undefined || cmd === null || !String(cmd).trim()) return undefined;
  const c = String(cmd).trim();
  if (c.length > 500) throw new Error("check command is longer than 500 characters — put it in a script and call that");
  if (/[\u0000-\u001f\u007f‪-‮⁦-⁩​-‏]/.test(c)) throw new Error("check command must be a single line without control or bidirectional characters");
  return c;
}

function validate(input: CanonInput) {
  if (input.kind !== "past" && input.kind !== "future") throw new Error('kind must be "past" or "future"');
  const text = one(String(input.text ?? ""), 400);
  if (text.length < 4) throw new Error("canon text is too short");
  if (input.due && !isDate(input.due)) throw new Error("due must be a valid date YYYY-MM-DD");
  return { text };
}

function nextId(events: CanonEvent[]) {
  return `k${events.reduce((m, e) => Math.max(m, parseInt(e.id.slice(1), 10) || 0), 0) + 1}`;
}

/**
 * Add a canon event. A person's event is active (signed) at once; an agent's or the archivist's
 * is a proposal whose suggested check is kept as text only.
 */
export function addCanon(store: Store, input: CanonInput, who: { source: CanonEvent["source"]; by?: string; via?: string }): CanonEvent {
  const { text } = validate(input);
  const byUser = who.source === "user";
  const check = byUser ? validateCheck(input.check) : undefined;
  const suggested = byUser ? undefined : input.check ? String(input.check).slice(0, 500) : undefined;
  return store.withLock(() => {
    const events = readRaw(store);
    const sameText = (e: CanonEvent) => e.kind === input.kind && e.text.toLowerCase() === text.toLowerCase();
    const pending = events.find((e) => sameText(e) && e.status === "proposed");
    if (byUser && pending) throw new Error(`A proposal with this text exists (${pending.id}) — approve it instead.`);
    // Agents can't re-propose what a person rejected or retired; a person may re-add it.
    const dup = events.find((e) => sameText(e) && (byUser ? e.status === "active" : true));
    if (dup) return dup;
    const now = new Date().toISOString();
    const ev: CanonEvent = {
      id: nextId(events),
      kind: input.kind,
      text,
      status: byUser ? "active" : "proposed",
      hard: input.hard !== false,
      check,
      suggestedCheck: suggested,
      due: input.due,
      evidence: strArr(input.evidence),
      source: who.source,
      proposedBy: who.by?.slice(0, 80),
      createdAt: now,
      ...(byUser ? { decidedBy: who.by, decidedAt: now, decidedVia: who.via } : {}),
    };
    const signed = byUser ? signChange(store, ev) : null;
    writeCanon(store, [...events, ev]);
    if (signed) raiseAnchors(signed.pid, { [ev.id]: signed.anchor });
    store.appendEvent({ type: "canon", data: { message: `${ev.id} ${byUser ? "added" : "proposed"} (${ev.kind}): ${ev.text}`, id: ev.id, status: ev.status } });
    return ev;
  });
}

export type CanonAction = "approve" | "reject" | "retire" | "confirm";

/** A person's decision on a canon event (signed). */
export function decideCanon(store: Store, id: string, action: CanonAction, who: { by?: string; via: string; reason?: string; adoptCheck?: boolean | string; head?: string | null }): CanonEvent {
  return store.withLock(() => {
    const events = readRaw(store);
    const ev = events.find((e) => e.id === id);
    if (!ev) throw new Error(`Unknown canon event "${id}"`);
    const pid = projectId(store, false);
    const anchor = readAnchors(pid)[id];
    const trust = trustOf(pid, ev, trustedIds(), anchor);
    const bad = trust === "tampered" || trust === "unsigned" || trust === "untrusted";
    // Re-approving an unverifiable event never revives what a person closed: the last status this
    // machine saw signed (or, without that, the stored one) decides.
    const closed = anchor && (anchor.status === "retired" || anchor.status === "rejected") ? anchor.status : bad && (ev.status === "retired" || ev.status === "rejected") ? ev.status : null;
    if (action === "approve" && closed) throw new Error(`${id} was ${closed} by a person — add it again (as a new event) if it should apply again`);
    if (action === "approve" && ev.status !== "proposed" && !bad) throw new Error(`${id} is ${ev.status}, only proposals can be approved`);
    if (action === "reject" && ev.status !== "proposed" && !bad) throw new Error(`${id} is ${ev.status}, only proposals can be rejected`);
    if (action === "retire" && (ev.status !== "active" || bad)) throw new Error(`${id} is not an approved active event`);
    if (action === "confirm") {
      if (ev.status !== "active" || bad) throw new Error(`${id} is not an approved active event`);
      const c: CanonCheck = { status: "passed", at: new Date().toISOString(), node: who.head ?? null, clean: true, detail: `confirmed by ${who.by ?? "a person"}${who.reason ? `: ${one(who.reason, 200)}` : ""}`, by: who.by, how: "manual" };
      const signed = signChange(store, ev, c);
      writeCanon(store, events);
      raiseAnchors(signed.pid, { [id]: signed.anchor });
      store.appendEvent({ type: "canon", nodeId: who.head ?? undefined, data: { message: `${id} confirmed as met by ${who.by ?? "?"} via ${who.via}`, id } });
      return ev;
    }
    if (action === "approve") {
      // A command only runs if the person adopts it explicitly: the command of a proposal or of an
      // unverified event could have been written by anyone. With a string, it must be exactly the
      // command the person was shown.
      const candidates = [ev.check, ev.suggestedCheck].filter((c): c is string => Boolean(c));
      let adopt: string | undefined;
      if (typeof who.adoptCheck === "string") {
        adopt = candidates.find((c) => c === who.adoptCheck);
        if (!adopt) throw new Error(`${id}: the check command changed since you saw it — reload and review it again`);
      } else if (who.adoptCheck === true) {
        if (new Set(candidates).size > 1) throw new Error(`${id} has two different commands — say which one to adopt`);
        adopt = candidates[0];
      }
      ev.check = adopt ? validateCheck(adopt) : undefined;
      ev.suggestedCheck = adopt ? undefined : ev.suggestedCheck ?? (candidates[0] ? candidates[0].slice(0, 500) : undefined);
    }
    ev.status = action === "approve" ? "active" : action === "reject" ? "rejected" : "retired";
    ev.decidedBy = who.by?.slice(0, 80);
    ev.decidedAt = new Date().toISOString();
    ev.decidedVia = who.via;
    if (who.reason) ev.reason = one(who.reason, 300);
    const signed = signChange(store, ev);
    writeCanon(store, events);
    raiseAnchors(signed.pid, { [id]: signed.anchor });
    store.appendEvent({ type: "canon", data: { message: `${id} ${ev.status} by ${who.by ?? "?"} via ${who.via}${who.reason ? `: ${who.reason}` : ""}`, id, status: ev.status } });
    return ev;
  });
}

export function activeCanon(store: Store): CanonEvent[] {
  return readCanon(store).filter((e) => e.status === "active");
}

/** Run the check commands of approved canon events — only on a person's request. Async: the server keeps serving. */
export async function runCanonChecks(store: Store, opts: { root: string; head: string | null; clean: boolean; ids?: string[]; by?: string; timeoutMs?: number }) {
  const targets = activeCanon(store).filter((e) => e.check && (!opts.ids?.length || opts.ids.includes(e.id)));
  const results: { id: string; status: "passed" | "failed"; detail: string }[] = [];
  for (const ev of targets) {
    const r = await new Promise<{ code: number | null; tail: string; timedOut: boolean }>((resolve) => {
      const child = spawn(ev.check!, { cwd: opts.root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let tail = "";
      const keep = (d: Buffer) => {
        tail = (tail + d.toString("utf8")).slice(-4000);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? 300_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, tail: String(err.message), timedOut: false });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, tail, timedOut });
      });
    });
    const lines = r.tail.trim().split("\n").slice(-6).join(" | ").slice(-500);
    const status = r.code === 0 && !r.timedOut ? "passed" : "failed";
    results.push({ id: ev.id, status, detail: status === "passed" ? "exit 0" : `${r.timedOut ? "timeout" : `exit ${r.code}`} · ${lines}` });
  }
  if (results.length) {
    store.withLock(() => {
      const events = readRaw(store);
      // Only events that are still verified and active (and still have the command that ran) get a result.
      const current = new Map(canonState(store).events.filter((e) => e.status === "active").map((e) => [e.id, e.check]));
      const raise: Record<string, Anchor> = {};
      let pid = "";
      for (const res of results) {
        const ev = events.find((e) => e.id === res.id);
        const ran = targets.find((t) => t.id === res.id)?.check;
        if (!ev || !current.has(ev.id) || current.get(ev.id) !== ran || ev.check !== ran) continue;
        const c: CanonCheck = { status: res.status, at: new Date().toISOString(), node: opts.head, clean: opts.clean, detail: res.detail, by: opts.by, how: "command" };
        const signed = signChange(store, ev, c);
        pid = signed.pid;
        raise[ev.id] = signed.anchor;
      }
      writeCanon(store, events);
      raiseAnchors(pid, raise);
      store.appendEvent({ type: "canon", nodeId: opts.head ?? undefined, data: { message: `canon checks: ${results.map((r) => `${r.id} ${r.status}`).join(", ")}`, results } });
    });
  }
  return results;
}

// ------------------------------------------------------------------ the archivist (deterministic)

const FIXED = /\b(must|never|always|only|required|requires|mandatory|policy|compliance|gdpr|dsgvo|muss|müssen|nie|niemals|immer|nur|pflicht|vorgabe|verboten|darf nicht)\b/i;
/** Facts describe what IS; only clearly normative ones are candidates (not "only X was used", not to-dos). */
const NORMATIVE = /\b(must (?:be|stay|remain|run|use|not|never|always|have)|never|always|required|mandatory|policy|compliance|gdpr|dsgvo|niemals|pflicht|vorgabe|verboten|darf nicht|darf nie|dürfen nicht|(?:muss|müssen) (?:immer|stets|bleiben|nie)|zwingend|vorgeschrieben)\b|\b(?:muss|müssen)\b[^.;]{0,50}\b(?:werden|bleiben)\b/i;
const FUTURE = /\b(by|until|deadline|launch|release|scale|users?|requests?|req\/s|rps|load|peak|black friday|bis|ab|stichtag|nutzer|anfragen|last)\b/i;

export interface CanonSuggestion extends CanonInput {
  why: string;
}

/**
 * Candidate fixed points from the recorded history: verified or confident decisions on the current
 * line, rules, and facts phrased as obligations. Nothing is stored — a person accepts or ignores them.
 * Anything already active, proposed, rejected or retired is not suggested again.
 */
export function suggestCanon(store: Store, nodes: ScenariaNode[], path: ScenariaNode[], rules: { id: string; text: string }[]): CanonSuggestion[] {
  const existing = readCanon(store);
  const known = existing.map((e) => new Set(tokenize(e.text)));
  const isKnown = (text: string) => {
    const t = new Set(tokenize(text));
    return known.some((k) => {
      const shared = [...t].filter((x) => k.has(x)).length;
      return shared / Math.max(1, Math.min(t.size, k.size)) >= 0.7;
    });
  };
  const out: CanonSuggestion[] = [];
  const push = (s: CanonSuggestion) => {
    if (!isKnown(s.text) && !out.some((o) => o.text.toLowerCase() === s.text.toLowerCase())) out.push(s);
  };
  const onPath = new Set(path.map((n) => n.id));
  path.forEach((n, i) => {
    if (n.type !== "decision" || !n.chosen) return;
    const taken = path[i + 1]?.viaOption ?? n.chosen;
    const verified = n.verification?.status === "passed";
    const confident = (n.confidence ?? 0) >= 0.8 && Boolean(n.rationale);
    if (!verified && !confident) return;
    const label = optionLabel(n, taken) ?? "";
    push({
      kind: "past",
      text: one(`${n.question ?? n.title} → ${label}`, 300),
      evidence: [n.id],
      why: verified ? `decision ${n.id} was verified` : `decision ${n.id} was taken with ${Math.round((n.confidence ?? 0) * 100)} % confidence: ${one(n.rationale ?? "", 120)}`,
    });
  });
  for (const r of rules) if (FIXED.test(r.text)) push({ kind: "past", text: r.text, evidence: [r.id], why: `project rule ${r.id} is phrased as an obligation` });
  for (const n of nodes) {
    if (!onPath.has(n.id)) continue;
    (n.facts ?? []).forEach((f, k) => {
      const conf = n.factInfo?.[k]?.confidence;
      if (conf !== undefined && conf < 0.8) return;
      if (NORMATIVE.test(f)) push({ kind: FUTURE.test(f) && /\d/.test(f) ? "future" : "past", text: f, evidence: [`${n.id}.f${k + 1}`], why: `fact ${n.id}.f${k + 1} is phrased as an obligation` });
    });
    if (n.expectedOutcome && n.type === "decision" && FUTURE.test(n.expectedOutcome) && /\d/.test(n.expectedOutcome)) {
      push({ kind: "future", text: n.expectedOutcome, evidence: [n.id], why: `expected outcome of decision ${n.id} names a measurable target` });
    }
  }
  return out.slice(0, 20);
}

/** Canon lines for capsules and prompts: hard events first and never cut; soft ones up to `maxSoft`. */
export function canonLines(events: CanonEvent[], maxSoft = 8): { line: string; hard: boolean }[] {
  const act = events.filter((e) => e.status === "active");
  const fmt = (e: CanonEvent) => {
    const check = e.lastCheck ? ` [last check: ${e.lastCheck.status}${e.lastCheck.clean ? "" : " on unsaved files"}${e.lastCheck.how === "manual" ? ", confirmed by a person" : ""}]` : e.check ? " [check defined, not run yet]" : "";
    return `- ${e.id} (${e.kind}${e.hard ? ", hard" : ", soft"}${e.due ? `, by ${e.due}` : ""}): ${e.text}${check}`;
  };
  const hard = act.filter((e) => e.hard).map((e) => ({ line: fmt(e), hard: true }));
  const soft = act.filter((e) => !e.hard);
  const lines = [...hard, ...soft.slice(0, maxSoft).map((e) => ({ line: fmt(e), hard: false }))];
  if (soft.length > maxSoft) lines.push({ line: `- … ${soft.length - maxSoft} more soft event(s) (scenaria_canon {action: "list"})`, hard: false });
  return lines;
}

export function renderCanon(events: CanonEvent[], maxSoft = 8): string[] {
  return canonLines(events, maxSoft).map((l) => l.line);
}
