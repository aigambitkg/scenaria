/**
 * Who gave a verdict, and does it count as "verified"?
 *
 * Security rule 11: only the person, or a registered audit agent that is independent of Scenaria and of
 * the working agent, can make a step count as verified. An agent may report on its own work, but a
 * "passed" from an agent is shown as self-reported and never counts. A "failed" or "warning" counts from
 * anyone: a self-report can lower trust, never raise it.
 *
 * When the person or an audit agent has given a verdict, a later agent report or automatic check never
 * replaces it: it is kept next to it as `report`, and only a negative report lowers the outcome.
 *
 * These helpers read the stored fields only. Whether the person's signature and the audit agent's request
 * are authentic is checked by the engine (`integrity().confirmed`), which is what counts.
 *
 * Shared with the dashboard, so this file must have NO imports.
 */

export type VerdictOrigin = "person" | "auditor" | "agent" | "auto" | "legacy";
export type EffectiveStatus = "unverified" | "passed" | "warning" | "failed";

interface ReportLike {
  status?: string;
  origin?: string;
}
interface VerdictLike {
  status?: string;
  origin?: string;
  by?: string;
  report?: ReportLike | null;
}

/** The origin of a verdict. Verdicts written before origins existed are "legacy" (unproven). */
export function verdictOrigin(v: VerdictLike | null | undefined): VerdictOrigin | null {
  if (!v || !v.status || v.status === "unverified") return null;
  if (v.origin === "person" || v.origin === "auditor" || v.origin === "agent" || v.origin === "auto") return v.origin;
  return v.by === "scenaria-auto" ? "auto" : "legacy";
}

/** Given by the person or a registered audit agent (by its stored fields). */
export function isAuthoritative(v: VerdictLike | null | undefined): boolean {
  const o = verdictOrigin(v);
  return o === "person" || o === "auditor";
}

/** A later agent report or automatic check that lowers the outcome. */
function negativeReport(v: VerdictLike | null | undefined): "failed" | "warning" | null {
  const s = v?.report?.status;
  return s === "failed" || s === "warning" ? s : null;
}

/** "Passed" from the person or a registered audit agent, not lowered by a later report. */
export function isConfirmedPass(v: VerdictLike | null | undefined): boolean {
  return v?.status === "passed" && isAuthoritative(v) && !negativeReport(v);
}

/** "Passed" that does not count (an agent's own report, an automatic check, or an unproven old verdict). */
export function isUnconfirmedPass(v: VerdictLike | null | undefined): boolean {
  return v?.status === "passed" && !isAuthoritative(v);
}

/** The status that counts: an unconfirmed pass is not verified; a negative report lowers anything. */
export function effectiveStatus(v: VerdictLike | null | undefined): EffectiveStatus {
  const s = v?.status;
  const low = negativeReport(v);
  if (s === "failed" || low === "failed") return "failed";
  if (s === "warning" || low === "warning") return "warning";
  return isConfirmedPass(v) ? "passed" : "unverified";
}

/**
 * How to show a verdict: "passed" only when it counts; otherwise "self" with the reason. `confirmed` is the
 * engine's check (authentic and untampered) when known — false turns an authoritative pass into "unconfirmed".
 */
export function verdictView(
  v: VerdictLike | null | undefined,
  confirmed?: boolean,
): { cls: "unverified" | "passed" | "warning" | "failed" | "self"; reason: "agent" | "auto" | "legacy" | "unconfirmed" | null } {
  const eff = effectiveStatus(v);
  if (v?.status === "passed" && eff !== "failed" && eff !== "warning") {
    if (isUnconfirmedPass(v)) {
      const o = verdictOrigin(v);
      return { cls: "self", reason: o === "auto" ? "auto" : o === "legacy" ? "legacy" : "agent" };
    }
    if (confirmed === false) return { cls: "self", reason: "unconfirmed" };
    return { cls: "passed", reason: null };
  }
  return { cls: eff, reason: null };
}
