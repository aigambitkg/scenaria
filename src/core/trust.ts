/**
 * Is a stored verdict of the person or of an audit agent authentic? (Security rule 11.)
 *
 * The stored fields alone could be edited in a node file, so the engine checks every such verdict:
 *   - the person's verdict carries a signature with the approver key (verdict/v1, bound to the project);
 *   - an audit agent's verdict carries its signed request, which must name this project, this node and
 *     this status, and whose key must be registered on this machine.
 * Results: "ok"; "forged" (signature missing or wrong — counted as tampering); "untrusted" (valid
 * signature, but a key this machine does not trust); "revoked" (an audit agent the person unregistered).
 * Only "ok" verdicts on untampered nodes count as verified (see Scenaria.integrity().confirmed).
 */
import { auditorRegistry, requestSignatureValid } from "./auditors.js";
import { projectIdentity, publicKeyId, trustedApproverIdSet, verifyEd25519 } from "./canon.js";
import type { Store } from "./store.js";
import type { ScenariaNode, Verification } from "./types.js";
import { workHash } from "./ledger.js";

export type VerdictTrust = "ok" | "forged" | "untrusted" | "revoked" | "superseded";

/** The signed parts of the person's verdict. */
export function verdictParts(id: string, v: Pick<Verification, "status" | "at" | "by" | "via" | "notes" | "work">): unknown[] {
  return ["verdict/v2", id, v.status, v.at ?? "", v.by ?? "", v.via ?? "", v.notes ?? "", v.work ?? ""];
}

/** Text fields of a signed record: anything else (a number, an object) is treated as damaged. */
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/** Check one claimed verdict. Throws nothing a hand-edited file could provoke: the caller turns an exception into "forged". */
function trustOf(n: ScenariaNode, v: Verification, pid: string, trusted: Set<string>, reg: ReturnType<typeof auditorRegistry>): VerdictTrust {
  if (v.origin === "person") {
    if (!pid || !text(v.pub) || !text(v.sig) || !text(v.work) || !verifyEd25519(v.pub, v.sig, JSON.stringify([pid, ...verdictParts(n.id, v)]))) return "forged";
    if (!trusted.has(publicKeyId(v.pub))) return "untrusted";
    return v.work === workHash(n) ? "ok" : "superseded";
  }
  const env = v.auditor?.request;
  // A request whose parts are not text cannot be authentic (C2.1, review K1: it used to throw).
  if (!env || typeof env !== "object" || !text(env.payload) || !text(env.pub) || !text(env.sig)) return "forged";
  let p: any = null;
  try {
    p = JSON.parse(env.payload);
  } catch {}
  const keyId = publicKeyId(env.pub);
  const bound = p?.action === "verdict" && pid && p.project === pid && p.verdict?.node === n.id && p.verdict?.status === v.status && typeof p.verdict?.workHash === "string" && v.auditor?.keyId === keyId;
  if (!requestSignatureValid(env) || !bound) return "forged";
  if (!reg.keys.some((k) => k.id === keyId && k.pub === env.pub)) return reg.removed.some((k) => k.id === keyId) ? "revoked" : "untrusted";
  return p.verdict.workHash === workHash(n) ? "ok" : "superseded";
}

/**
 * Check every person / audit-agent verdict of the given nodes. Nodes without such a verdict are absent from the map.
 * Never throws on a hand-edited node: a verdict that cannot even be read counts as "forged" (tampering, an alarm).
 */
export function verdictTrustAll(store: Store, nodes: ScenariaNode[]): Map<string, VerdictTrust> {
  const out = new Map<string, VerdictTrust>();
  const claimed = nodes.filter((n) => n.verification && typeof n.verification === "object" && (n.verification.origin === "person" || n.verification.origin === "auditor"));
  if (!claimed.length) return out;
  const pid = projectIdentity(store, false);
  const trusted = trustedApproverIdSet();
  const reg = auditorRegistry();
  for (const n of claimed) {
    let tr: VerdictTrust;
    try {
      tr = trustOf(n, n.verification!, pid, trusted, reg);
    } catch {
      tr = "forged";
    }
    out.set(n.id, tr);
  }
  return out;
}

/** How an archived (replaced) verdict checks out: its signature as given, not the current work (C2.1). */
export type ArchivedTrust = "signed" | "forged" | "untrusted" | "revoked" | "unsigned";

/**
 * Check the earlier verdicts of the given nodes (`verificationHistory`). The work hash is not compared: an
 * archived verdict was given on the work as it was then. Older verdicts without origin are "unsigned".
 * Returns, per node with a history, one result per entry in the same order. Never throws.
 */
export function archivedVerdictTrust(store: Store, nodes: ScenariaNode[]): Map<string, ArchivedTrust[]> {
  const out = new Map<string, ArchivedTrust[]>();
  const withHistory = nodes.filter((n) => Array.isArray(n.verificationHistory) && n.verificationHistory.length);
  if (!withHistory.length) return out;
  const pid = projectIdentity(store, false);
  const trusted = trustedApproverIdSet();
  const reg = auditorRegistry();
  for (const n of withHistory) {
    out.set(
      n.id,
      n.verificationHistory!.map((v): ArchivedTrust => {
        if (!v || typeof v !== "object") return "forged";
        if (v.origin !== "person" && v.origin !== "auditor") return v.origin === undefined ? "unsigned" : "forged";
        try {
          const tr = trustOf(n, v, pid, trusted, reg);
          return tr === "ok" || tr === "superseded" ? "signed" : tr;
        } catch {
          return "forged";
        }
      }),
    );
  }
  return out;
}
