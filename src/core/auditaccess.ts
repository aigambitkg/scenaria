/**
 * Who may read the ISO/IEC 42001 audit file of a project (Batch C2, Kev's decision 2026-10-16).
 *
 * - Only the person sets it: the caller makes sure it is the person (approval session in the dashboard,
 *   or an interactive terminal with a typed confirmation). Agents never change it.
 * - "person" (the default): only the person reads the audit file (dashboard approval mode, interactive
 *   terminal). "open": everyone who can reach this Scenaria may read it, like the other read endpoints.
 * - Kept OUTSIDE the project (~/.config/scenaria/audit-access.json), next to the approver key and the
 *   anchors (security rule 11): an agent working in the project cannot change it. The entry belongs to the
 *   project's bound id AND its real folder, so a copied project folder starts again at "person" (review K11).
 * - Every setting is signed with the person's approver key and bound to the project and the folder. The
 *   highest revision this machine has seen is kept in a separate mark: an older signed setting put back
 *   does not count (K11). Anything that does not verify falls back to "person": fail-closed.
 * - Honest limit: this protects the audit file (view and export). The raw records it is computed from
 *   (steps, decisions, fixed rules, the event log, the full export) stay readable for agents, as before
 *   (security rule 10).
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic, type Store } from "./store.js";
import { globalConfigPath } from "./global.js";
import { projectIdentity, publicKeyId, signRecord, verifyRecord } from "./canon.js";

export type AuditAccessMode = "person" | "open";
export const AUDIT_ACCESS_MODES: AuditAccessMode[] = ["person", "open"];

export interface AuditAccessEntry {
  mode: AuditAccessMode;
  /** Grows with every change of this project's setting. */
  rev: number;
  at: string;
  by: string;
  via: "dashboard" | "terminal";
  keyId?: string;
  pub?: string;
  sig?: string;
}

export interface AuditAccess {
  /** What applies now. Anything not verified is "person". */
  mode: AuditAccessMode;
  /** "default": never set; "verified": set by the person, signature valid; "invalid": a stored setting that does not verify (edited, older than seen, another folder or key). */
  trust: "default" | "verified" | "invalid";
  /** The person's setting as stored (only when verified). */
  set: { mode: AuditAccessMode; rev: number; at: string; by: string; via: string; keyId?: string } | null;
}

const cfg = () => dirname(globalConfigPath());
const accessFile = () => join(cfg(), "audit-access.json");
const marksFile = () => join(cfg(), "audit-access.marks.json");

function folderOf(store: Store): string {
  try {
    return realpathSync(store.root);
  } catch {
    return store.root;
  }
}

function readJson(file: string, key: string): Record<string, any> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const v = raw?.[key];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The entry key: the project's bound id and its real folder (never stored in the project). */
function entryKey(store: Store, create: boolean): string {
  const pid = projectIdentity(store, create);
  return pid ? `${pid}:${folderOf(store)}` : "";
}

const parts = (folder: string, e: Pick<AuditAccessEntry, "mode" | "rev" | "at" | "by" | "via">) => ["audit-access/v2", folder, e.mode, e.rev, e.at, e.by, e.via];

/** The read setting of this project's audit file, as this machine can vouch for it. */
export function readAuditAccess(store: Store): AuditAccess {
  const key = entryKey(store, false);
  const e = key ? (readJson(accessFile(), "projects")[key] as AuditAccessEntry | undefined) : undefined;
  const mark = key ? Number(readJson(marksFile(), "marks")[key] ?? 0) : 0;
  if (!e) return mark > 0 ? { mode: "person", trust: "invalid", set: null } : { mode: "person", trust: "default", set: null };
  const ok =
    typeof e === "object" &&
    AUDIT_ACCESS_MODES.includes(e.mode) &&
    Number.isInteger(e.rev) &&
    e.rev >= mark &&
    typeof e.at === "string" &&
    typeof e.by === "string" &&
    (e.via === "dashboard" || e.via === "terminal") &&
    verifyRecord(store, parts(folderOf(store), e), e.pub, e.sig);
  if (!ok) return { mode: "person", trust: "invalid", set: null };
  return { mode: e.mode, trust: "verified", set: { mode: e.mode, rev: e.rev, at: e.at, by: e.by, via: e.via, keyId: e.pub ? publicKeyId(e.pub) : undefined } };
}

/**
 * The PERSON sets who may read the audit file. Callers must make sure a person acts (approval session or
 * interactive terminal). Signed with the approver key, bound to the project and its folder; recorded in
 * the event log. (Like the other files in the config folder, writes from two processes at the same moment
 * are not locked against each other: the later one wins.)
 */
export function setAuditAccess(store: Store, mode: AuditAccessMode, who: { by: string; via: "dashboard" | "terminal" }): AuditAccess {
  if (!AUDIT_ACCESS_MODES.includes(mode)) throw new Error(`mode must be one of: ${AUDIT_ACCESS_MODES.join(", ")}`);
  const by = String(who.by ?? "person").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "person";
  const key = entryKey(store, true);
  const all = readJson(accessFile(), "projects");
  const marks = readJson(marksFile(), "marks");
  const prev = all[key] as AuditAccessEntry | undefined;
  const rev = Math.max(Number.isInteger(prev?.rev) ? prev!.rev : 0, Number(marks[key] ?? 0) || 0) + 1;
  const entry: AuditAccessEntry = { mode, rev, at: new Date().toISOString(), by, via: who.via };
  const signed = signRecord(store, parts(folderOf(store), entry));
  all[key] = { ...entry, keyId: publicKeyId(signed.pub), pub: signed.pub, sig: signed.sig };
  marks[key] = rev;
  writeJsonAtomic(marksFile(), { version: 1, marks });
  writeJsonAtomic(accessFile(), { version: 2, projects: all });
  store.appendEvent({ type: "update", data: { message: `audit file read access set to "${mode}" by ${by} via ${who.via}` } });
  return readAuditAccess(store);
}
