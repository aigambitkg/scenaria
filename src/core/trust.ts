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

/** Check every person / audit-agent verdict of the given nodes. Nodes without such a verdict are absent from the map. */
export function verdictTrustAll(store: Store, nodes: ScenariaNode[]): Map<string, VerdictTrust> {
  const out = new Map<string, VerdictTrust>();
  const claimed = nodes.filter((n) => n.verification?.origin === "person" || n.verification?.origin === "auditor");
  if (!claimed.length) return out;
  const pid = projectIdentity(store, false);
  const trusted = trustedApproverIdSet();
  const reg = auditorRegistry();
  for (const n of claimed) {
    const v = n.verification!;
    if (v.origin === "person") {
      if (!pid || !v.pub || !v.sig || !v.work || !verifyEd25519(v.pub, v.sig, JSON.stringify([pid, ...verdictParts(n.id, v)]))) out.set(n.id, "forged");
      else if (!trusted.has(publicKeyId(v.pub))) out.set(n.id, "untrusted");
      else out.set(n.id, v.work === workHash(n) ? "ok" : "superseded");
      continue;
    }
    const env = v.auditor?.request;
    let p: any = null;
    try {
      p = env ? JSON.parse(env.payload) : null;
    } catch {}
    const keyId = env ? publicKeyId(env.pub) : "";
    const bound = p?.action === "verdict" && pid && p.project === pid && p.verdict?.node === n.id && p.verdict?.status === v.status && typeof p.verdict?.workHash === "string" && v.auditor?.keyId === keyId;
    if (!requestSignatureValid(env) || !bound) out.set(n.id, "forged");
    else if (!reg.keys.some((k) => k.id === keyId && k.pub === env!.pub)) out.set(n.id, reg.removed.some((k) => k.id === keyId) ? "revoked" : "untrusted");
    else out.set(n.id, p.verdict.workHash === workHash(n) ? "ok" : "superseded");
  }
  return out;
}
