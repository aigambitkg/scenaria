/**
 * Registered audit agents (security rule 11).
 *
 * An audit agent is independent of Scenaria and of the working agent: it holds its OWN Ed25519 key,
 * created and kept outside Scenaria and outside the project (another machine, a CI secret, a hardware
 * key). The person registers its public key once on this machine (~/.config/scenaria/trusted-auditors.json,
 * person-only). From then on the audit agent can do exactly two things, each with a signed request:
 *
 *   - "verdict": give a verdict on one node that counts as verified. The request is bound to the node's
 *     exact content hash, so it cannot be reused for another node or after the node changed.
 *   - "reseal":  accept the current state as the new integrity baseline. The request is bound to the
 *     ledger's current state (exists, line count, last chain hash), so it cannot be replayed later.
 *
 * Requests are valid for 24 hours. Scenaria only VERIFIES: it never holds the audit agent's private key.
 * Anyone may hand a signed request to Scenaria (CLI, MCP, HTTP) — the signature is the authority.
 *
 * Wire format (sign the exact UTF-8 bytes of `payload`, e.g. with `openssl pkeyutl -sign -rawin`):
 *   { "payload": "<JSON string>", "pub": "<base64 SPKI DER>", "sig": "<base64 Ed25519 signature>" }
 *
 * Honest limit: a process with the person's full user rights can edit trusted-auditors.json. The
 * registry is outside the project, so an agent that only works inside the project cannot add itself.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { globalConfigPath } from "./global.js";
import { checkIntegrity, contentHash, Ledger, workHash, type LedgerState } from "./ledger.js";
import { ownApproverKeyId, projectIdentity, publicKeyId, verifyEd25519 } from "./canon.js";
import type { Store } from "./store.js";
import type { ScenariaNode, VerificationStatus } from "./types.js";

export const AUDITOR_VERSION = "scenaria-auditor/v1";
/** How long a signed request stays valid. */
export const REQUEST_TTL_MS = 24 * 3600_000;
/** Allowed clock difference for requests "from the future". */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface AuditorKey {
  id: string;
  pub: string;
  name?: string;
  addedAt: string;
}

export interface AuditorEnvelope {
  payload: string;
  pub: string;
  sig: string;
}

export interface AuditorPayload {
  v: typeof AUDITOR_VERSION;
  action: "verdict" | "reseal";
  project: string;
  at: string;
  nonce: string;
  verdict?: { node: string; nodeHash: string; workHash: string; status: Exclude<VerificationStatus, "unverified">; notes?: string };
  ledger?: Pick<LedgerState, "exists" | "lines" | "head">;
  /** For a reseal: exactly the node contents the audit agent accepts (and which of them are tampered now). */
  nodes?: { count: number; digest: string; tampered: string[] };
}

export class AuditorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ registry (person-only writes)

function cfgDir() {
  return dirname(globalConfigPath());
}
function registryFile() {
  return join(cfgDir(), "trusted-auditors.json");
}

function validPub(pub: string): boolean {
  try {
    const k = createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
    return k.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

interface Registry {
  keys: AuditorKey[];
  /** Unregistered audit agents (kept, so their earlier verdicts show as revoked, not as unknown). */
  removed: (AuditorKey & { removedAt: string })[];
}

/** The whole registry on this machine (active keys and unregistered ones). */
export function auditorRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), "utf8"));
    const ok = (k: any) => typeof k?.pub === "string" && typeof k?.id === "string" && publicKeyId(k.pub) === k.id && validPub(k.pub);
    return { keys: Array.isArray(raw?.keys) ? raw.keys.filter(ok) : [], removed: Array.isArray(raw?.removed) ? raw.removed.filter(ok) : [] };
  } catch {
    return { keys: [], removed: [] };
  }
}

function writeRegistry(r: Registry) {
  mkdirSync(cfgDir(), { recursive: true });
  writeFileSync(registryFile(), JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
}

/** The audit agents registered on this machine. */
export function listAuditors(): AuditorKey[] {
  return auditorRegistry().keys;
}

/** Register an audit agent's public key. Callers must make sure a person does this (terminal / approval session). */
export function addAuditor(pubInput: string, name?: string): AuditorKey {
  const pub = normalizePub(pubInput);
  if (!validPub(pub)) throw new AuditorError("bad_key", "Not an Ed25519 public key (expected base64 SPKI DER or a PEM public key).");
  const id = publicKeyId(pub);
  if (ownApproverKeyId() === id) throw new AuditorError("own_key", "This is your own approver key. An audit agent needs its own key, kept outside Scenaria.");
  const reg = auditorRegistry();
  const k: AuditorKey = { id, pub, name: name?.trim().slice(0, 80) || undefined, addedAt: new Date().toISOString() };
  writeRegistry({ keys: [...reg.keys.filter((x) => x.id !== id), k], removed: reg.removed.filter((x) => x.id !== id) });
  return k;
}

/** Remove a registered audit agent (person-only). Its earlier verdicts then show as revoked (they no longer count). */
export function removeAuditor(id: string): boolean {
  const reg = auditorRegistry();
  const gone = reg.keys.find((k) => k.id === id);
  if (!gone) return false;
  writeRegistry({ keys: reg.keys.filter((k) => k.id !== id), removed: [...reg.removed.filter((k) => k.id !== id), { ...gone, removedAt: new Date().toISOString() }] });
  return true;
}

/** Accept base64 SPKI DER, or a PEM public key. */
export function normalizePub(input: string): string {
  const s = String(input ?? "").trim();
  if (s.includes("BEGIN PUBLIC KEY")) {
    try {
      return createPublicKey(s).export({ type: "spki", format: "der" }).toString("base64");
    } catch {
      return "";
    }
  }
  return s.replace(/\s+/g, "");
}

// ------------------------------------------------------------------ helpers for the audit agent's side

/** Is `dir` inside a Scenaria project (or inside Scenaria's own config folder)? Then it is no place for an audit key. */
function forbiddenKeyPlace(dir: string): string | null {
  let abs = resolve(dir);
  try {
    abs = realpathSync(abs);
  } catch {}
  let cfg = cfgDir();
  try {
    cfg = realpathSync(cfg);
  } catch {}
  const rel = relative(cfg, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return "Scenaria's own config folder";
  for (let cur = abs; ; cur = dirname(cur)) {
    if (existsSync(join(cur, ".scenaria", "config.json"))) return `a Scenaria project (${cur})`;
    if (dirname(cur) === cur) break;
  }
  return null;
}

/** Create a key pair for an audit agent in a folder OUTSIDE every Scenaria project and outside Scenaria's config. */
export function auditorKeygen(dir: string): { id: string; pub: string; keyFile: string; pubFile: string } {
  mkdirSync(dir, { recursive: true });
  const bad = forbiddenKeyPlace(dir);
  if (bad) throw new AuditorError("bad_place", `An audit key must not live in ${bad}: the working agent could read it. Choose a folder outside every project (better: another machine or a CI secret).`);
  const keyFile = join(resolve(dir), "auditor-key.pem");
  const pubFile = join(resolve(dir), "auditor-key.pub");
  if (existsSync(keyFile)) throw new AuditorError("exists", `${keyFile} already exists.`);
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {}
  const pub = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  writeFileSync(pubFile, pub + "\n");
  return { id: publicKeyId(pub), pub, keyFile, pubFile };
}

/** Sign a request payload with an audit agent's private key (PEM). */
export function signAuditorRequest(payload: string, privatePem: string): AuditorEnvelope {
  const priv = createPrivateKey(privatePem);
  if (priv.asymmetricKeyType !== "ed25519") throw new AuditorError("bad_key", "The audit key must be an Ed25519 private key.");
  const pub = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { payload, pub, sig: edSign(null, Buffer.from(payload, "utf8"), priv).toString("base64") };
}

/** Build the payload an audit agent signs. Read-only for the tree (it may create the project's id). */
export function buildAuditorRequest(store: Store, input: { action: "verdict"; node: string; status: string; notes?: string } | { action: "reseal" }): string {
  const project = projectIdentity(store, true);
  const base = { v: AUDITOR_VERSION, action: input.action, project, at: new Date().toISOString(), nonce: randomBytes(9).toString("base64url") };
  if (input.action === "verdict") {
    if (!["passed", "warning", "failed"].includes(input.status)) throw new AuditorError("bad_status", "status must be passed, warning or failed.");
    const node = store.readNode(input.node);
    const notes = input.notes?.trim().slice(0, 2000);
    return JSON.stringify({ ...base, verdict: { node: node.id, nodeHash: contentHash(node), workHash: workHash(node), status: input.status, ...(notes ? { notes } : {}) } });
  }
  const st = new Ledger(store.path("ledger.jsonl")).state();
  return JSON.stringify({ ...base, ledger: { exists: st.exists, lines: st.lines, head: st.head }, nodes: nodeSet(store) });
}

/** A digest of every node's exact content, and the nodes that do not match the ledger right now. */
export function nodeSet(store: Store): { count: number; digest: string; tampered: string[] } {
  const nodes = store.listNodes();
  const pairs = nodes.map((n) => [n.id, contentHash(n)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ledger = new Ledger(store.path("ledger.jsonl"));
  const integ = checkIntegrity(nodes, ledger, { expectSealed: true });
  const tampered = [...integ.state].filter(([, s]) => s !== "ok").map(([id]) => id).sort();
  return { count: nodes.length, digest: createHash("sha256").update(JSON.stringify(pairs)).digest("hex"), tampered };
}

/** Accept an envelope as an object or a JSON string. */
export function parseEnvelope(input: unknown): AuditorEnvelope {
  let x: any = input;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      throw new AuditorError("bad_request", "The signed request is not valid JSON.");
    }
  }
  if (!x || typeof x.payload !== "string" || typeof x.pub !== "string" || typeof x.sig !== "string") throw new AuditorError("bad_request", 'A signed request needs "payload", "pub" and "sig" (strings).');
  if (x.payload.length > 20_000) throw new AuditorError("bad_request", "The request payload is too large.");
  return { payload: x.payload, pub: normalizePub(x.pub), sig: x.sig.trim() };
}

// ------------------------------------------------------------------ verification (Scenaria's side)

export interface VerifiedRequest {
  key: AuditorKey;
  payload: AuditorPayload;
  verdict?: AuditorPayload["verdict"];
}

/**
 * Check a signed request: registered key, valid signature, this project, fresh, and bound to exactly
 * the current state (the node's content, or the ledger). Throws an AuditorError with a plain reason.
 */
export function verifyAuditorRequest(
  store: Store,
  input: unknown,
  expect: { action: "verdict"; node: ScenariaNode } | { action: "reseal"; ledger?: LedgerState },
  now = Date.now(),
): VerifiedRequest {
  const env = parseEnvelope(input);
  const id = publicKeyId(env.pub);
  const key = listAuditors().find((k) => k.id === id && k.pub === env.pub);
  if (!key) throw new AuditorError("unknown_auditor", `Key ${id} is not a registered audit agent on this machine (the person registers it with: scenaria auditor add).`);
  if (!verifyEd25519(env.pub, env.sig, env.payload)) throw new AuditorError("bad_signature", "The signature does not match the request.");
  let p: AuditorPayload;
  try {
    p = JSON.parse(env.payload);
  } catch {
    throw new AuditorError("bad_request", "The signed payload is not valid JSON.");
  }
  if (p?.v !== AUDITOR_VERSION) throw new AuditorError("bad_request", `Unknown request version (expected ${AUDITOR_VERSION}).`);
  if (p.action !== expect.action) throw new AuditorError("wrong_action", `This request is for "${p.action}", not "${expect.action}".`);
  const pid = projectIdentity(store, false);
  if (!pid || p.project !== pid) throw new AuditorError("wrong_project", "This request was made for another project.");
  const at = Date.parse(p.at);
  if (!Number.isFinite(at) || now - at > REQUEST_TTL_MS) throw new AuditorError("expired", "The request is older than 24 hours — make a new one.");
  if (at - now > CLOCK_SKEW_MS) throw new AuditorError("future", "The request is dated in the future (check the clock).");
  if (expect.action === "verdict") {
    const v = p.verdict;
    if (!v || v.node !== expect.node.id) throw new AuditorError("wrong_node", "This request is for another node.");
    if (!["passed", "warning", "failed"].includes(v.status)) throw new AuditorError("bad_status", "status must be passed, warning or failed.");
    if (v.nodeHash !== contentHash(expect.node) || v.workHash !== workHash(expect.node)) throw new AuditorError("stale", `${expect.node.id} changed after the request was made — make a new one.`);
    return { key, payload: p, verdict: { ...v, notes: typeof v.notes === "string" ? v.notes.slice(0, 2000) : undefined } };
  }
  const cur = expect.ledger ?? new Ledger(store.path("ledger.jsonl")).state();
  const l = p.ledger;
  if (!l || l.exists !== cur.exists || l.lines !== cur.lines || (l.head ?? null) !== (cur.head ?? null)) throw new AuditorError("stale", "The ledger changed after the request was made — make a new one.");
  const ns = nodeSet(store);
  if (!p.nodes || p.nodes.digest !== ns.digest || p.nodes.count !== ns.count) throw new AuditorError("stale", "The nodes changed after the request was made — the audit agent must accept exactly the current contents. Make a new one.");
  return { key, payload: p };
}

/** First gate for any request: a registered key and a valid signature (before reading what it asks for). */
export function checkEnvelopeKey(input: unknown): { env: AuditorEnvelope; key: AuditorKey } {
  const env = parseEnvelope(input);
  const id = publicKeyId(env.pub);
  const key = listAuditors().find((k) => k.id === id && k.pub === env.pub);
  if (!key) throw new AuditorError("unknown_auditor", `Key ${id} is not a registered audit agent on this machine (the person registers it with: scenaria auditor add).`);
  if (!verifyEd25519(env.pub, env.sig, env.payload)) throw new AuditorError("bad_signature", "The signature does not match the request.");
  return { env, key };
}

/** Re-check a stored request's signature against its own payload (for reports). Registry membership is NOT required. */
export function requestSignatureValid(env: AuditorEnvelope | undefined): boolean {
  return Boolean(env && verifyEd25519(env.pub, env.sig, env.payload));
}
