/**
 * Batch C2: the ISO/IEC 42001 audit file of one project, computed from its real records.
 *
 * For every Annex A control (catalogue: ./iso42001.ts) it shows the status the project reaches in the
 * chosen period:
 *   - "organisational": the organisation must provide the evidence; Scenaria at most supports it;
 *   - "partly":         every source the control needs (`required`) holds data in the period;
 *   - "not_covered":    a required source has nothing in the period.
 * The status is never higher than the catalogue's coverage.
 *
 * Counting rules (honesty first, security rule 11):
 *   - Verdicts carry a control only when they are independent and authentic: the person's or a registered
 *     audit agent's, signature valid, on an untampered step whose work did not change since. Self-reported
 *     and automatic verdicts are listed, but never carry.
 *   - Approvals count only with a valid signature from a key this machine trusts.
 *   - Canon and project rules count only when signed by the person (trusted key).
 *
 * Integrity (Kev's decision 2026-10-16): a damaged tamper evidence does NOT lower the status. It shows a
 * clear warning at the top and at every control that uses an affected source, with the cause in plain
 * words. The findings come from the project check (the same codes as `scenaria analyze`) and concern the
 * whole record, not only the period.
 *
 * Period (Kev's decision 2026-10-16): the whole project unless a period is chosen. Dates without a time
 * are whole days in UTC.
 *
 * Scope: Scenaria provides evidence of how AI agents worked in projects. It does not provide evidence of
 * how AI models are developed or trained, nor of the organisation's policies and impact assessments.
 */
import type { Scenaria } from "./engine.js";
import { metrics as checkMetrics, projectMetrics, type Issue } from "./analysis.js";
import { listReseals } from "./seal.js";
import { projectIdChanged } from "./canon.js";
import { gateResults } from "./gate.js";
import { archivedVerdictTrust, verdictTrustAll, type ArchivedTrust } from "./trust.js";
import { listAuditors } from "./auditors.js";
import { projectIdentity, publicKeyId } from "./canon.js";
import { verdictOrigin } from "./verdict.js";
import { readAuditAccess, type AuditAccess } from "./auditaccess.js";
import { catalogueFingerprint, counts as orgCounts, orgEvidenceStates, type OrgEvidenceState, type OrgEvidenceTrust } from "./orgevidence.js";
import {
  ANNEX_A_CONTROLS,
  ANNEX_A_SCOPE,
  ANNEX_A_STANDARD,
  EVIDENCE_SOURCES,
  type ControlStatus,
  type Coverage,
  type EvidenceSource,
  type Lang2,
} from "./iso42001.js";
import type { ScenariaNode } from "./types.js";
import { homedir } from "node:os";
import { realRoot } from "./projects.js";

export const AUDIT_FILE_KIND = "scenaria/iso42001-audit-file";
export const AUDIT_FILE_VERSION = 1;

// ------------------------------------------------------------------ period

export interface Period {
  /** Inclusive bounds (ISO 8601, UTC); null = open end. */
  from: string | null;
  to: string | null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A date-time needs a time zone (Z or ±hh:mm): never the server's local time (review K7). */
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A real calendar day (2026-02-30 is not one). */
const realDay = (y: string, m: string, d: string) => {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() === Number(m) - 1 && t.getUTCDate() === Number(d);
};

/**
 * Parse a period. Accepted: YYYY-MM-DD (a whole day in UTC) or an ISO 8601 date-time with a time zone
 * (2026-10-01T10:00Z, 2026-10-01T12:00+02:00). Throws on anything else, and when the period starts after it ends.
 */
export function parsePeriod(from?: string | null, to?: string | null): Period {
  const one = (x: unknown, end: boolean): string | null => {
    const v = typeof x === "string" ? x.trim() : "";
    if (!v) return null;
    const day = DAY.exec(v);
    const dt = DATETIME.exec(v);
    if ((!day && !dt) || !realDay(...((day ?? dt)!.slice(1, 4) as [string, string, string]))) {
      throw new Error(`"${v.slice(0, 40)}" is not a date: use YYYY-MM-DD (a whole day, UTC) or a date-time with a time zone, e.g. 2026-10-01T10:00Z`);
    }
    let t = Date.parse(day ? `${v}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : v);
    if (Number.isNaN(t)) throw new Error(`"${v.slice(0, 40)}" is not a date`);
    // An end given to the minute covers that whole minute (C2.1, review K6): "18:00" includes 18:00:30.
    if (end && dt && !/T\d{2}:\d{2}:\d{2}/.test(v)) t += 59_999;
    return new Date(t).toISOString();
  };
  const p = { from: one(from, false), to: one(to, true) };
  if (p.from && p.to && Date.parse(p.from) > Date.parse(p.to)) throw new Error("The period starts after it ends.");
  return p;
}

/**
 * A time stamp as stored: only a string counts (a number would be read as a year). A date-time without a
 * time zone (an imported or hand-edited record) is read as UTC, never in the server's local time (C2.1, K6).
 */
const NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
export const storedTime = (ts: unknown): number => {
  if (typeof ts !== "string") return NaN;
  const m = NO_ZONE.exec(ts.trim());
  return Date.parse(m ? `${m[1]}T${m[2]}Z` : ts);
};
const time = storedTime;
const inPeriod = (p: Period, ts: unknown): boolean => {
  const t = time(ts);
  if (Number.isNaN(t)) return false;
  return (!p.from || t >= Date.parse(p.from)) && (!p.to || t <= Date.parse(p.to));
};
/** In force at some point of the period: decided before it ended. */
const decidedBy = (p: Period, ts: unknown): boolean => {
  const t = time(ts);
  return !Number.isNaN(t) && (!p.to || t <= Date.parse(p.to));
};
/** Robust reads of hand-editable fields (review K4): a wrong type is treated as missing, never thrown on. */
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const has = (x: unknown): boolean => str(x).trim().length > 0;
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

// ------------------------------------------------------------------ integrity findings → warnings

export type WarningLevel = "alarm" | "note";

export interface AuditWarning {
  code: string;
  level: WarningLevel;
  /** The evidence sources this finding concerns. */
  sources: EvidenceSource[];
  title: Lang2;
  /** What it means for the audit, in plain words. */
  explain: Lang2;
  /** How many findings of this kind (e.g. changed steps). */
  count: number;
  /** The affected items (step ids, rule ids, …), at most 30. */
  items: string[];
  /** The technical messages of the project check, at most 5. */
  details: string[];
  /** Controls this finding concerns directly (the organisation's evidence, C3); others go by `sources`. */
  controls?: string[];
}

/** Everything that is written per step, and therefore in the hash chain. */
const STEP_SOURCES: EvidenceSource[] = ["decisions", "checkpoints", "snapshots", "attribution", "irreversible", "goal", "verdicts", "rewinds", "models", "ledger"];

type Rule = { level: WarningLevel; sources: EvidenceSource[]; title: Lang2; explain: Lang2 };

const ALARM_TEXT: Lang2 = {
  de: "Der Manipulationsnachweis ist beschädigt. Was die betroffenen Quellen zeigen, kann nachträglich verändert worden sein.",
  en: "The tamper evidence is damaged. What the affected sources show may have been changed afterwards.",
};

/** Project-check codes that concern the tamper evidence, and what they mean for the audit file. */
export const INTEGRITY_RULES: Record<string, Rule> = {
  tampered: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Schritte außerhalb von Scenaria geändert", en: "Steps changed outside Scenaria" },
    explain: { de: "Einzelne Schritte passen nicht mehr zur Hash-Kette: Sie wurden nach dem Aufzeichnen verändert. Ihr Inhalt ist nicht verlässlich.", en: "Some steps no longer match the hash chain: they were changed after they were recorded. Their content is not reliable." },
  },
  step_missing: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Schritte gelöscht oder zerstört", en: "Steps deleted or destroyed" },
    explain: { de: "Schritte stehen in der Hash-Kette, aber ihre Dateien fehlen oder sind unlesbar. Was sie aufgezeichnet hatten, fehlt in der Akte.", en: "Steps are in the hash chain, but their files are missing or unreadable. What they recorded is missing from the audit file." },
  },
  ledger_missing: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Hash-Kette fehlt", en: "Hash chain missing" },
    explain: { de: "Das Protokoll mit der Hash-Kette wurde gelöscht. Änderungen an Schritten lassen sich nicht mehr erkennen.", en: "The hash-chained log was deleted. Changes to steps can no longer be detected." },
  },
  ledger_broken: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Hash-Kette unterbrochen", en: "Hash chain broken" },
    explain: { de: "Das Protokoll wurde mitten in der Kette verändert. Ab dieser Stelle ist der Nachweis nicht verlässlich.", en: "The log was changed inside the chain. From that point on the evidence is not reliable." },
  },
  ledger_diverged: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Hash-Kette zurückgesetzt oder umgeschrieben", en: "Hash chain rolled back or rewritten" },
    explain: { de: "Das Protokoll endet nicht dort, wo dieser Rechner es zuletzt gesehen hat: gekürzt, umgeschrieben oder zurückgespielt.", en: "The log does not end where this machine last saw it: shortened, rewritten or rolled back." },
  },
  ledger_replaced: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Hash-Kette ersetzt", en: "Hash chain replaced" },
    explain: { de: "Das Protokoll wurde ohne Berechtigung neu angelegt. Was vorher aufgezeichnet war, ist nicht mehr belegt.", en: "The log was started again without authority. What was recorded before is no longer evidenced." },
  },
  ledger_extended: {
    level: "alarm",
    sources: STEP_SOURCES,
    title: { de: "Schritte ohne Wissen dieses Rechners geschrieben", en: "Steps written without this machine's knowledge" },
    explain: { de: "Die Kette wurde fortgesetzt, ohne dass Scenaria auf diesem Rechner es gesehen hat (z. B. ein anderer Rechner, eine alte Version oder eine Handänderung). Diese Schritte sind zu prüfen.", en: "The chain was continued without Scenaria on this machine seeing it (e.g. another machine, an old version or a hand edit). These steps need review." },
  },
  reseal_unproven: {
    level: "alarm",
    sources: ["reseals", "ledger", "signatures"],
    title: { de: "Neu-Versiegelung ohne Nachweis", en: "Reseal without proof" },
    explain: { de: "Der Manipulationsnachweis wurde zurückgesetzt, ohne dass ein echter Nachweis der Person oder eines Prüf-Agenten vorliegt.", en: "The tamper evidence was reset without an authentic record of the person or an audit agent." },
  },
  verdict_forged: {
    level: "alarm",
    sources: ["verdicts", "signatures"],
    title: { de: "Prüfurteile gefälscht oder beschädigt", en: "Verdicts forged or damaged" },
    explain: { de: "Prüfurteile geben vor, von der Person oder einem Prüf-Agenten zu stammen, lassen sich aber nicht bestätigen oder nicht einmal lesen. Sie zählen nicht; der Schritt gilt als verändert.", en: "Verdicts claim to come from the person or an audit agent, but cannot be confirmed or cannot even be read. They do not count; the step counts as changed." },
  },
  snapshot_missing: {
    level: "alarm",
    sources: ["snapshots"],
    title: { de: "Gesicherte Dateistände fehlen", en: "Stored file states missing" },
    explain: { de: "Schritte verweisen auf Dateistände, die im Sicherungsspeicher von Scenaria nicht mehr vorhanden sind. Zu diesen Schritten lassen sich die Dateien nicht wiederherstellen; sie zählen nicht.", en: "Steps point to file states that are no longer in Scenaria's snapshot store. Their files cannot be restored; they do not count." },
  },
  verdict_archive_invalid: {
    level: "note",
    sources: ["verdicts"],
    title: { de: "Frühere Prüfurteile nicht bestätigt", en: "Earlier verdicts not confirmed" },
    explain: { de: "Im Verlauf eines Schritts stehen frühere Urteile, deren Signatur sich nicht bestätigen lässt. Sie dienen nur dem Vergleich und zählen ohnehin nicht.", en: "A step's history holds earlier verdicts whose signature cannot be confirmed. They are kept for comparison only and never count." },
  },
  org_evidence_tampered: {
    level: "alarm",
    sources: [],
    title: { de: "Nachweise der Organisation verändert", en: "Organisation's evidence changed" },
    explain: { de: "Einträge zu Dokumenten der Organisation passen nicht mehr zu ihrer Signatur oder wurden auf einen älteren Stand zurückgesetzt. Sie zählen nicht; die Person entfernt sie und trägt das Dokument neu ein.", en: "Entries for the organisation's documents no longer match their signature or were put back to an older state. They do not count; the person removes them and records the document again." },
  },
  org_evidence_missing: {
    level: "alarm",
    sources: [],
    title: { de: "Nachweise der Organisation gelöscht", en: "Organisation's evidence deleted" },
    explain: { de: "Von der Person eingetragene Dokumente fehlen in der Datei. Sie wurden außerhalb von Scenaria entfernt.", en: "Documents the person recorded are missing from the file. They were removed outside Scenaria." },
  },
  org_evidence_unreadable: {
    level: "alarm",
    sources: [],
    title: { de: "Nachweise der Organisation nicht lesbar", en: "Organisation's evidence unreadable" },
    explain: { de: "Die Datei mit den Dokumenten der Organisation ist beschädigt (z. B. ein Merge-Konflikt). Kein Dokument kann gezeigt werden.", en: "The file with the organisation's documents is damaged (e.g. a merge conflict). No document can be shown." },
  },
  org_evidence_unconfirmed: {
    level: "note",
    sources: [],
    title: { de: "Nachweise der Organisation noch nicht bestätigt", en: "Organisation's evidence not confirmed yet" },
    explain: { de: "Einträge ohne Signatur oder mit einem Schlüssel, dem dieser Rechner nicht vertraut (z. B. eines Teammitglieds). Sie zählen erst, wenn die Person sie bestätigt.", en: "Entries without a signature or with a key this machine does not trust (e.g. a teammate's). They count only after the person confirms them." },
  },
  org_evidence_catalogue_changed: {
    level: "note",
    sources: [],
    title: { de: "Kontrolle im Katalog geändert", en: "Control changed in the catalogue" },
    explain: { de: "Der Text der Kontrolle hat sich geändert, seit das Dokument eingetragen wurde. Die Person prüft, ob es noch passt, und bestätigt es.", en: "The control's text changed since the document was recorded. The person checks that it still fits and confirms it." },
  },
  verdict_untrusted: {
    level: "alarm",
    sources: ["verdicts", "approvals", "signatures"],
    title: { de: "Prüfurteile mit fremdem Schlüssel", en: "Verdicts with an unknown key" },
    explain: { de: "Prüfurteile sind gültig signiert, aber mit einem Schlüssel, dem dieser Rechner nicht vertraut. Sie zählen nicht.", en: "Verdicts are validly signed, but with a key this machine does not trust. They do not count." },
  },
  verdict_removed: {
    level: "alarm",
    sources: ["verdicts", "approvals", "signatures"],
    title: { de: "Prüfurteile entfernt oder geändert", en: "Verdicts removed or changed" },
    explain: { de: "Prüfurteile der Person oder eines Prüf-Agenten, die dieser Rechner aufgezeichnet hat, fehlen oder wurden verändert.", en: "Verdicts of the person or an audit agent that this machine recorded are missing or were changed." },
  },
  canon_tampered: {
    level: "alarm",
    sources: ["canon", "approvals", "signatures"],
    title: { de: "Feste Regeln verändert", en: "Fixed rules changed" },
    explain: { de: "Feste Regeln passen nicht mehr zu ihrer Signatur. Sie zählen nicht, bis die Person sie erneut freigibt.", en: "Fixed rules no longer match their signature. They do not count until the person approves them again." },
  },
  canon_untrusted: {
    level: "alarm",
    sources: ["canon", "approvals", "signatures"],
    title: { de: "Feste Regeln mit fremdem Schlüssel", en: "Fixed rules with an unknown key" },
    explain: { de: "Feste Regeln sind mit einem Schlüssel signiert, dem dieser Rechner nicht vertraut. Sie zählen nicht.", en: "Fixed rules are signed with a key this machine does not trust. They do not count." },
  },
  canon_check_tampered: {
    level: "alarm",
    sources: ["canon", "approvals", "signatures"],
    title: { de: "Prüfergebnis einer festen Regel verändert", en: "Check result of a fixed rule changed" },
    explain: { de: "Ein Prüfergebnis passt nicht mehr zu seiner Signatur und zählt nicht.", en: "A check result no longer matches its signature and does not count." },
  },
  canon_gate_tampered: {
    level: "alarm",
    sources: ["canon", "approvals", "signatures"],
    title: { de: "Prüfläufe je Arbeitslinie verändert", en: "Line checks changed" },
    explain: { de: "Ergebnisse der Prüfläufe je Arbeitslinie passen nicht zu ihrer Signatur oder wurden zurückgespielt. Sie zählen nicht.", en: "Results of the line checks do not match their signature or were rolled back. They do not count." },
  },
  canon_missing: {
    level: "alarm",
    sources: ["canon", "approvals", "signatures"],
    title: { de: "Feste Regeln gelöscht", en: "Fixed rules deleted" },
    explain: { de: "Freigegebene feste Regeln fehlen in der Datei. Sie wurden außerhalb von Scenaria entfernt.", en: "Approved fixed rules are missing from the file. They were removed outside Scenaria." },
  },
  canon_unreadable: {
    level: "alarm",
    sources: ["canon", "approvals", "signatures"],
    title: { de: "Feste Regeln nicht lesbar", en: "Fixed rules unreadable" },
    explain: { de: "Die Datei mit den festen Regeln ist beschädigt. Keine feste Regel kann belegt werden.", en: "The file with the fixed rules is damaged. No fixed rule can be evidenced." },
  },
  rule_tampered: {
    level: "alarm",
    sources: ["rules", "approvals", "signatures"],
    title: { de: "Projektregeln verändert", en: "Project rules changed" },
    explain: { de: "Projektregeln passen nicht mehr zu ihrer Signatur. Sie gelten nicht, bis die Person sie bestätigt.", en: "Project rules no longer match their signature. They do not apply until the person confirms them." },
  },
  rule_missing: {
    level: "alarm",
    sources: ["rules", "approvals", "signatures"],
    title: { de: "Projektregeln gelöscht", en: "Project rules deleted" },
    explain: { de: "Freigegebene Projektregeln fehlen in der Datei. Sie wurden außerhalb von Scenaria entfernt.", en: "Approved project rules are missing from the file. They were removed outside Scenaria." },
  },
  project_id_changed: {
    level: "alarm",
    sources: ["signatures", "approvals", "canon", "rules", "verdicts", "reseals"],
    title: { de: "Projektkennung geändert", en: "Project id changed" },
    explain: { de: "Die Kennung in der Projektdatei passt nicht zu der, die dieser Rechner dem Ordner zugeordnet hat. Signaturen werden gegen die zugeordnete Kennung geprüft.", en: "The id in the project file does not match the one this machine bound to the folder. Signatures are checked against the bound id." },
  },
  verdict_superseded: {
    level: "note",
    sources: ["verdicts"],
    title: { de: "Prüfurteile überholt", en: "Verdicts superseded" },
    explain: { de: "Nach einem Prüfurteil wurde der Schritt geändert. Das Urteil gilt nicht mehr und braucht eine neue Prüfung.", en: "A step changed after its verdict. The verdict no longer applies and needs a new check." },
  },
  verdict_revoked: {
    level: "note",
    sources: ["verdicts", "auditors"],
    title: { de: "Prüf-Agent abgemeldet", en: "Audit agent unregistered" },
    explain: { de: "Urteile eines Prüf-Agenten, den die Person abgemeldet hat, zählen nicht mehr.", en: "Verdicts of an audit agent the person unregistered no longer count." },
  },
  rules_unconfirmed: {
    level: "note",
    sources: ["rules"],
    title: { de: "Projektregeln noch nicht bestätigt", en: "Project rules not confirmed yet" },
    explain: { de: "Ältere oder fremd signierte Projektregeln zählen erst, wenn die Person sie einmal bestätigt.", en: "Older or foreign-signed project rules count only after the person confirms them once." },
  },
  evaluation_failed: {
    level: "alarm",
    sources: [],
    title: { de: "Teil der Aufzeichnung nicht auswertbar", en: "Part of the record cannot be evaluated" },
    explain: { de: "Eine Quelle ließ sich nicht auswerten, meist weil eine Datei außerhalb von Scenaria verändert wurde. Für diese Quelle zeigt die Akte nichts.", en: "A source could not be evaluated, usually because a file was changed outside Scenaria. The audit file shows nothing for this source." },
  },
  project_restarted: {
    level: "note",
    sources: ["ledger"],
    title: { de: "Projekt in diesem Ordner neu begonnen", en: "Project restarted in this folder" },
    explain: { de: "Die Person hat in diesem Ordner ein neues Projekt begonnen. Die Akte zeigt nur das neue Projekt.", en: "The person started a new project in this folder. The audit file shows only the new project." },
  },
};

/** Codes the audit file computes itself (not from the project check): their own lists, never a message of `scenaria analyze`. */
export const AUDIT_FILE_OWN_CODES = [
  "evaluation_failed",
  "verdict_forged",
  "snapshot_missing",
  "verdict_archive_invalid",
  "org_evidence_tampered",
  "org_evidence_missing",
  "org_evidence_unreadable",
  "org_evidence_unconfirmed",
  "org_evidence_catalogue_changed",
];

/**
 * Group the project check's findings by code. Where the engine knows the full list of affected items
 * (e.g. every removed verdict), count and items come from that list, not from the number of messages (review K5).
 */
/** Error texts can name files: never put a machine path into the audit file (rule 12). */
const PATH_RE = /(?:[A-Za-z]:)?(?:[\\/][^\s'",:;)]+){2,}/g;
/** Known folders (project, home) are replaced as a whole first, so a path with spaces leaks nothing (C2.1, review K4). */
let knownRoots: string[] = [];
export function scrubPaths(msg: string, roots: string[] = []): string {
  let out = String(msg);
  for (const r of [...roots].sort((a, b) => b.length - a.length)) if (r && r.length > 1) out = out.split(r).join("<path>");
  return out.replace(PATH_RE, "<path>");
}
const withoutPaths = (msg: string) => scrubPaths(msg, knownRoots);

function warningsFrom(issues: Issue[], lists: Record<string, string[]>, failed: { source: EvidenceSource | "check"; error: string }[]): AuditWarning[] {
  const byCode = new Map<string, AuditWarning>();
  for (const i of issues) {
    const r = INTEGRITY_RULES[i.code];
    if (!r) continue;
    const w = byCode.get(i.code) ?? { code: i.code, level: r.level, sources: r.sources, title: r.title, explain: r.explain, count: 0, items: [], details: [] };
    w.count++;
    const item = i.nodeId ?? i.subject;
    if (item && !w.items.includes(item)) w.items.push(item);
    if (w.details.length < 5) w.details.push(withoutPaths(String(i.message ?? "")).slice(0, 300));
    byCode.set(i.code, w);
  }
  // The engine's own lists win: full counts (K5), and the alarm stays even when the project check failed (N3).
  for (const [code, items] of Object.entries(lists)) {
    const r = INTEGRITY_RULES[code];
    if (!r || !items.length) continue;
    const all = [...new Set(items)];
    const w = byCode.get(code) ?? { code, level: r.level, sources: r.sources, title: r.title, explain: r.explain, count: 0, items: [], details: [] };
    w.count = Math.max(w.count, all.length);
    w.items = all;
    byCode.set(code, w);
  }
  if (failed.length) {
    const r = INTEGRITY_RULES.evaluation_failed;
    const srcs = failed.map((x) => x.source).filter((x): x is EvidenceSource => x !== "check");
    byCode.set("evaluation_failed", { code: "evaluation_failed", level: r.level, sources: failed.some((x) => x.source === "check") ? (Object.keys(EVIDENCE_SOURCES) as EvidenceSource[]) : srcs, title: r.title, explain: r.explain, count: failed.length, items: failed.map((x) => x.source), details: failed.map((x) => withoutPaths(x.error).slice(0, 200)).slice(0, 5) });
  }
  for (const w of byCode.values()) w.items = w.items.slice(0, 30);
  const order = (w: AuditWarning) => (w.level === "alarm" ? 0 : 1);
  return [...byCode.values()].sort((a, b) => order(a) - order(b) || a.code.localeCompare(b.code));
}

// ------------------------------------------------------------------ approvals and reseals

export type ApprovalKind = "canon" | "canon-check" | "gate" | "rule" | "verdict" | "reseal" | "access" | "evidence";

export interface ApprovalEntry {
  at: string;
  kind: ApprovalKind;
  /** What it is about: canon event, rule, step, reseal record, … */
  ref: string;
  /** approved / rejected / retired / active / removed / passed / failed / warning / resealed / person / open … */
  action: string;
  /** Who, as recorded. */
  by: string;
  /** dashboard / terminal / signed request / command / manual … */
  via: string;
  /** person or audit agent. */
  origin: "person" | "auditor";
  /** Id of the signing key. */
  keyId?: string;
  /** Short text: the rule, the event, the step title. */
  text?: string;
  /**
   * Shown fields that the signature does NOT cover (review K8): they are as recorded and could have been
   * edited without the signature noticing. `text` is context (the rule, the event, or a step title, which is
   * in the hash chain), not part of every signature.
   */
  unsigned: ("by" | "via")[];
  /**
   * Whether it approves work or rules and therefore carries the "approvals" source (review K2). Reseals
   * (accept a ledger state) and the read setting of the audit file are listed but carry no control.
   * Verdicts are listed too, but carry only the "verdicts" source, so nothing counts twice (C2.1, Kev 2026-10-16).
   */
  carries: boolean;
}

/** A step whose verdict was replaced at least once: the current verdict and the earlier ones, for comparison (C2.1). */
export interface VerdictHistoryEntry {
  node: string;
  title: string;
  /** The verdict in force now; `counts` = it carries the "verdicts" source. */
  current: { status: string; at: string; origin: string; by: string; counts: boolean } | null;
  /** Earlier verdicts, oldest first. They never count. */
  earlier: { status: string; at: string; origin: string; by: string; via: string; replacedAt: string; signature: ArchivedTrust; unsigned: ("by" | "via")[] }[];
  /**
   * The step was changed outside Scenaria or written without this machine seeing it: its history may have
   * been edited too, so a "signed" entry only proves that verdict existed, not that it belonged here (R4).
   */
  stepChanged: boolean;
}

export interface ResealEntry {
  id: string;
  at: string;
  kind: "person" | "auditor";
  by: string;
  /** How (signed): terminal / dashboard, or "signed request" for an audit agent. */
  via: string;
}

// ------------------------------------------------------------------ sources and controls

export interface SourceEvidence {
  source: EvidenceSource;
  /** What counts for this source in the period (see `counted`). */
  count: number;
  /** Data in the period that can carry a control. */
  hasData: boolean;
  /** What `count` counts, in plain words. */
  counted: Lang2;
  /** Further numbers and names (by kind, by origin, …). */
  facts: Record<string, number | string[]>;
  /** A note on this source in this project (e.g. "only self-reported verdicts"). */
  note?: Lang2;
  /** Codes of warnings that concern this source. */
  warnings: string[];
}

export interface ControlResult {
  id: string;
  area: string;
  group: string;
  title: Lang2;
  /** Best coverage Scenaria can reach (catalogue). */
  coverage: Coverage;
  /** What this project reaches in the period. */
  status: ControlStatus;
  required: { source: EvidenceSource; count: number; hasData: boolean }[];
  supporting: { source: EvidenceSource; count: number; hasData: boolean }[];
  /** Required sources without data in the period (why "not_covered"). */
  missing: EvidenceSource[];
  /** Codes of warnings that concern a source of this control. */
  warnings: string[];
  /** Some of them is an alarm (tamper evidence damaged). */
  alarm: boolean;
  scenaria: Lang2;
  /** What the organisation must document (catalogue text). */
  organisation: Lang2;
  appliesWhen?: Lang2;
  /**
   * The organisation's own documents for this control (C3, Kev 2026-10-16). Never changes `status`:
   * "documented" = at least one document in force in the period, signed by the person and confirmed on this
   * machine; "unconfirmed" = documents exist, but none counts yet; "none".
   */
  orgEvidence: { state: "documented" | "unconfirmed" | "none"; entries: OrgEvidenceView[] };
}

/** One document of the organisation, as shown in the audit file. Every field is signed. */
export interface OrgEvidenceView {
  id: string;
  url: string;
  hash: string;
  title?: string;
  owner: { role: string; name: string };
  date: string;
  note?: string;
  activeFrom: string;
  removedAt?: string;
  decidedBy: string;
  decidedVia: string;
  decidedAt: string;
  keyId?: string;
  copiedFrom?: string;
  trust: OrgEvidenceTrust;
  /** Counts for the control in this period. */
  counts: boolean;
  catalogueChanged: boolean;
}

export interface AuditFile {
  kind: typeof AUDIT_FILE_KIND;
  version: number;
  standard: string;
  scope: Lang2;
  generatedAt: string;
  /** The id signatures are checked against (bound to the folder on this machine); `configId` when the project file names another one. */
  project: { name: string; id: string | null; configId?: string };
  period: {
    from: string | null;
    to: string | null;
    /** No period chosen: the whole project. */
    whole: boolean;
    /** The steps in the period: how many, first and last. */
    steps: number;
    firstStep: string | null;
    lastStep: string | null;
    note: Lang2;
  };
  integrity: {
    /** "ok": nothing found; "notes": only notes; "alarm": the tamper evidence is damaged. */
    state: "ok" | "notes" | "alarm";
    headline: Lang2;
    warnings: AuditWarning[];
    note: Lang2;
  };
  summary: Record<ControlStatus, number> & { controls: number; withAlarm: number; withNotes: number; orgDocumented: number };
  /** The catalogue this file was computed with (a later change shows). */
  catalogue: { standard: string; controls: number; hash: string };
  sources: Record<EvidenceSource, SourceEvidence>;
  controls: ControlResult[];
  approvals: ApprovalEntry[];
  /** Steps with replaced verdicts in the period: current and earlier verdicts side by side (never counted twice). */
  verdictHistory: VerdictHistoryEntry[];
  /** Authentic reseals (record valid AND as this machine anchored them); unproven ones only by id. */
  reseals: { authentic: ResealEntry[]; unproven: string[] };
  access: AuditAccess;
}

const t = (de: string, en: string): Lang2 => ({ de, en });
const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0))].sort();

/** Compute the audit file of a project. Read-only (apart from the bookkeeping every read check does). */
export function buildAuditFile(s: Scenaria, period: Period = { from: null, to: null }): AuditFile {
  const generatedAt = new Date().toISOString();
  knownRoots = [s.root, (() => { try { return realRoot(s.root); } catch { return ""; } })(), homedir()].filter((x, i, a) => x && a.indexOf(x) === i).sort((a, b) => b.length - a.length);
  const p = period;
  // A source that cannot be evaluated never breaks the whole file: it shows nothing and raises an alarm (review K4).
  const failed: { source: EvidenceSource | "check"; error: string }[] = [];
  const safe = <T>(source: EvidenceSource | "check", fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err: any) {
      failed.push({ source, error: String(err?.message ?? err) });
      return fallback;
    }
  };

  const nodes = safe("check", () => s.store.listNodes(), [] as ScenariaNode[]);
  const boundId = safe("check", () => projectIdentity(s.store, false) || null, null);
  const configId = safe("check", () => str(s.store.readConfig().projectId), "");
  const projectName = safe("check", () => str(s.config().projectName), "");
  const events = safe("rewinds", () => s.store.readEvents(), []);
  // If the tamper evidence itself cannot be checked, nothing counts as authentic and the whole file carries the alarm.
  const integ = safe("check", () => s.integrity(), {
    state: new Map(),
    ledgerBrokenAt: null,
    entries: 0,
    torn: 0,
    ledgerMissing: false,
    stepsMissing: [],
    ledgerReplaced: false,
    ledgerDiverged: null,
    resealsUnproven: [],
    reseals: [],
    restarted: null,
    confirmed: new Set<string>(),
    verdictsForged: [],
    verdictsUntrusted: [],
    verdictsRevoked: [],
    verdictsSuperseded: [],
    verdictsRemoved: [],
    unseenWrites: [],
  } as unknown as ReturnType<Scenaria["integrity"]>);
  const gate = safe("approvals", () => gateResults(s), { results: [], tampered: [] as string[] });
  // The project check; if it fails on a hand-edited step, its integrity findings are still computed (N3).
  const metrics = safe("health", () => projectMetrics(s), null) ?? {
    issues: (() => {
      try {
        const cs = s.canonState();
        const ri = s.ruleIssues();
        return checkMetrics([], null, { integrity: integ.state, stepsMissing: integ.stepsMissing, ledgerBrokenAt: integ.ledgerBrokenAt, ledgerMissing: integ.ledgerMissing, ledgerReplaced: integ.ledgerReplaced, ledgerDiverged: integ.ledgerDiverged, resealsUnproven: integ.resealsUnproven, reseals: integ.reseals, restarted: integ.restarted, verdictsUntrusted: integ.verdictsUntrusted, verdictsRevoked: integ.verdictsRevoked, verdictsSuperseded: integ.verdictsSuperseded, verdictsRemoved: integ.verdictsRemoved, canon: cs.events, canonError: cs.error, canonMissing: cs.missing, gateTampered: gate.tampered, rules: { unconfirmed: ri.unconfirmed, tampered: ri.tampered, missing: ri.missing, proposals: 0 }, projectIdChanged: projectIdChanged(s.store) }).issues;
      } catch {
        return [] as Issue[];
      }
    })(),
  } as ReturnType<typeof projectMetrics>;

  const stepsIn = nodes.filter((n) => inPeriod(p, n.createdAt));
  // Is every recorded file state still stored? One git call for the whole project, every time (C2.1, Kev 2026-10-16).
  const withCommit = nodes.filter((n) => n.snapshot && typeof n.snapshot === "object" && has(n.snapshot.commit));
  const missingCommits = safe(
    "snapshots",
    () => {
      if (!withCommit.length) return new Set<string>();
      if (!s.repo) throw new Error("git is not available: the stored file states cannot be checked");
      return s.repo.missingCommits(withCommit.map((n) => str(n.snapshot!.commit)));
    },
    // Not checkable (no git, git failed): nothing is claimed missing; the source shows nothing and the alarm says why (R1).
    new Set<string>(),
  );
  const snapshotMissing = withCommit.filter((n) => missingCommits.has(str(n.snapshot!.commit))).map((n) => n.id);
  const snapshotMissingSet = new Set(snapshotMissing);
  const sortedTimes = stepsIn.map((n) => str(n.createdAt)).sort((a, b) => storedTime(a) - storedTime(b));
  const of = (type: ScenariaNode["type"]) => stepsIn.filter((n) => n.type === type);

  // ---- reseals: authentic only when the record is valid AND matches what this machine anchored (K1, K6)
  const unproven = new Set(integ.resealsUnproven);
  const resealVia = new Map(safe("reseals", () => listReseals(s.store), []).map((r) => [r.id, str(r.via)]));
  const reseals: ResealEntry[] = integ.reseals.filter((r) => !unproven.has(r.id)).map((r) => ({ id: r.id, at: r.at, kind: r.kind, by: r.by, via: resealVia.get(r.id) ?? "" }));

  // ---- verdicts: independent and authentic only carry (rule 11)
  const trust = safe("verdicts", () => verdictTrustAll(s.store, nodes), new Map<string, never>() as ReturnType<typeof verdictTrustAll>);
  const unseen = new Set(integ.unseenWrites);
  const removed = new Set(integ.verdictsRemoved);
  const independent = (n: ScenariaNode) =>
    (n.verification?.origin === "person" || n.verification?.origin === "auditor") &&
    trust.get(n.id) === "ok" &&
    integ.state.get(n.id) === "ok" &&
    !unseen.has(n.id) &&
    !removed.has(n.id);
  const verdictNodes = nodes.filter((n) => n.verification && typeof n.verification === "object" && n.verification.status !== "unverified" && inPeriod(p, n.verification.at));
  // Earlier (replaced) verdicts: kept for comparison, never counted (C2.1, Kev 2026-10-16).
  const archivedTrust = safe("verdicts", () => archivedVerdictTrust(s.store, nodes), new Map<string, ArchivedTrust[]>());
  const verdictHistory: VerdictHistoryEntry[] = [];
  let earlierInPeriod = 0;
  const archiveInvalid: string[] = [];
  for (const n of nodes) {
    const hist = Array.isArray(n.verificationHistory) ? n.verificationHistory : [];
    if (!hist.length) continue;
    const tr = archivedTrust.get(n.id) ?? [];
    if (tr.some((x) => x === "forged" || x === "untrusted" || x === "revoked")) archiveInvalid.push(n.id);
    const earlier = hist
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v && typeof v === "object" && inPeriod(p, v.at))
      .map(({ v, i }) => ({ status: str(v.status), at: str(v.at), origin: str(verdictOrigin(v) ?? "legacy"), by: str(v.by), via: v.origin === "auditor" ? "signed request" : str(v.via), replacedAt: str(v.replacedAt), signature: tr[i] ?? "forged", unsigned: (v.origin === "auditor" ? ["by"] : v.origin === "person" ? [] : ["by", "via"]) as ("by" | "via")[] }));
    const cur = n.verification && typeof n.verification === "object" ? n.verification : null;
    const curIn = cur && cur.status !== "unverified" && inPeriod(p, cur.at);
    if (!earlier.length && !curIn) continue;
    earlierInPeriod += earlier.length;
    verdictHistory.push({
      node: n.id,
      title: str(n.title),
      current: cur ? { status: str(cur.status), at: str(cur.at), origin: str(verdictOrigin(cur) ?? "legacy"), by: str(cur.by), counts: false } : null,
      earlier,
      stepChanged: integ.state.get(n.id) === "tampered" || (integ.unseenWrites ?? []).includes(n.id),
    });
  }
  const independentNodes = verdictNodes.filter(independent);
  const counting = new Set(independentNodes.map((n) => n.id));
  for (const h of verdictHistory) if (h.current) h.current.counts = counting.has(h.node);
  const byOrigin: Record<string, number> = { person: 0, auditor: 0, agent: 0, auto: 0, legacy: 0 };
  for (const n of verdictNodes) {
    const o = verdictOrigin(n.verification) ?? "legacy";
    byOrigin[o] = (byOrigin[o] ?? 0) + 1;
  }

  // ---- approvals (signed, by a trusted key). Fields the signature does not cover are named (K8).
  const approvals: ApprovalEntry[] = [];
  const canon = safe("canon", () => s.canonState(), { events: [], error: null, missing: [] } as ReturnType<Scenaria["canonState"]>);
  for (const e of canon.events) {
    if (e.trust === "verified" && inPeriod(p, e.decidedAt)) {
      approvals.push({ at: str(e.decidedAt), kind: "canon", ref: e.id, action: e.status, by: str(e.decidedBy) || "person", via: str(e.decidedVia), origin: "person", keyId: e.keyId, text: str(e.text), unsigned: ["via"], carries: true });
    }
    const c = e.lastCheck;
    if (e.trust === "verified" && c && inPeriod(p, c.at)) {
      approvals.push({ at: str(c.at), kind: "canon-check", ref: e.id, action: c.status, by: str(c.by) || "person", via: c.how === "manual" ? "manual" : "command", origin: "person", keyId: c.pub ? publicKeyId(c.pub) : undefined, text: str(e.text), unsigned: ["by"], carries: true });
    }
  }
  for (const g of gate.results) {
    if (inPeriod(p, g.at)) approvals.push({ at: str(g.at), kind: "gate", ref: `${g.node}/${g.event}`, action: g.status, by: str(g.by) || "person", via: "command", origin: "person", keyId: g.pub ? publicKeyId(g.pub) : undefined, text: str(g.text), unsigned: ["by"], carries: true });
  }
  const ruleStates = safe("rules", () => s.ruleStates(), { rules: [], missing: [] } as ReturnType<Scenaria["ruleStates"]>);
  for (const { rule, trust: rt } of ruleStates.rules) {
    if (rt === "verified" && inPeriod(p, rule.decidedAt)) {
      approvals.push({ at: str(rule.decidedAt), kind: "rule", ref: rule.id, action: rule.status ?? "active", by: str(rule.decidedBy) || "person", via: str(rule.decidedVia), origin: "person", keyId: rule.keyId, text: str(rule.text), unsigned: [], carries: true });
    }
  }
  for (const n of independentNodes) {
    const v = n.verification!;
    const auditor = v.origin === "auditor";
    approvals.push({ at: str(v.at), kind: "verdict", ref: n.id, action: v.status, by: str(v.by) || (auditor ? "auditor" : "person"), via: auditor ? "signed request" : str(v.via), origin: auditor ? "auditor" : "person", keyId: auditor ? v.auditor?.keyId : v.pub ? publicKeyId(v.pub) : undefined, text: str(n.title), unsigned: auditor ? ["by"] : [], carries: false });
  }
  for (const r of reseals) {
    // An audit agent's request signs the ledger state, not who or how it is shown (C2.1, review K5).
    if (inPeriod(p, r.at)) approvals.push({ at: r.at, kind: "reseal", ref: r.id, action: "resealed", by: r.by, via: r.via, origin: r.kind, unsigned: r.kind === "auditor" ? ["by", "via"] : [], carries: false });
  }
  const access = safe("check", () => readAuditAccess(s.store), { mode: "person", trust: "invalid", set: null } as unknown as AuditAccess);
  if (access.trust === "verified" && access.set && inPeriod(p, access.set.at)) {
    approvals.push({ at: access.set.at, kind: "access", ref: "audit-file", action: access.set.mode, by: access.set.by, via: access.set.via, origin: "person", keyId: access.set.keyId, unsigned: [], carries: false });
  }
  // ---- the organisation's own documents per control (C3): signed by the person, never raise a status
  const org = safe("check", () => orgEvidenceStates(s.store), { entries: [] as OrgEvidenceState[], missing: [] as string[], error: null as string | null });
  const periodEnd = p.to ? Date.parse(p.to) : Infinity;
  // Whole project: the current state; a period: in force at some point of it.
  const periodStart = p.from ? Date.parse(p.from) : p.to ? -Infinity : Date.now();
  const inForce = (x: OrgEvidenceState) => {
    if (x.entry.discarded) return false;
    const from = time(x.entry.activeFrom);
    if (Number.isNaN(from) || from > periodEnd) return false;
    if (x.entry.status === "removed") {
      const gone = time(x.entry.removedAt);
      return !Number.isNaN(gone) && gone > periodStart;
    }
    return true;
  };
  const orgByControl = new Map<string, OrgEvidenceView[]>();
  for (const x of org.entries) {
    if (!inForce(x)) continue;
    const e = x.entry;
    const view: OrgEvidenceView = {
      id: e.id,
      url: e.url,
      hash: e.hash,
      ...(e.title ? { title: e.title } : {}),
      owner: { role: e.owner.role, name: e.owner.name },
      date: e.date,
      ...(e.note ? { note: e.note } : {}),
      activeFrom: e.activeFrom,
      ...(e.removedAt ? { removedAt: e.removedAt } : {}),
      decidedBy: e.decidedBy,
      decidedVia: e.decidedVia,
      decidedAt: e.decidedAt,
      ...(e.pub ? { keyId: publicKeyId(e.pub) } : {}),
      ...(e.copiedFrom ? { copiedFrom: e.copiedFrom } : {}),
      trust: x.trust,
      counts: orgCounts(x),
      catalogueChanged: x.catalogueChanged,
    };
    orgByControl.set(e.control, [...(orgByControl.get(e.control) ?? []), view]);
  }
  for (const x of org.entries) {
    // The person's signed decisions on documents, in the chronological list: when it came into force (recorded
    // or a teammate's entry confirmed) and the latest decision. They approve no work (carry nothing).
    if (x.trust !== "verified") continue;
    const e = x.entry;
    const keyId = e.pub ? publicKeyId(e.pub) : undefined;
    const ref = e.discarded ? e.id : `${e.control}/${e.id}`;
    if (!e.discarded && inPeriod(p, e.recordedAt)) {
      approvals.push({ at: e.recordedAt, kind: "evidence", ref, action: "recorded", by: e.recordedBy, via: e.recordedVia, origin: "person", keyId, text: e.title || e.url, unsigned: [], carries: false });
    }
    if (e.decidedAt !== e.recordedAt && inPeriod(p, e.decidedAt)) {
      approvals.push({ at: e.decidedAt, kind: "evidence", ref, action: e.discarded ? "discarded" : e.status === "removed" ? "removed" : "confirmed", by: e.decidedBy, via: e.decidedVia, origin: "person", keyId, text: e.discarded ? "" : e.title || e.url, unsigned: [], carries: false });
    } else if (e.discarded && inPeriod(p, e.decidedAt)) {
      approvals.push({ at: e.decidedAt, kind: "evidence", ref, action: "discarded", by: e.decidedBy, via: e.decidedVia, origin: "person", keyId, text: "", unsigned: [], carries: false });
    }
  }
  const controlsOf = (pred: (x: OrgEvidenceState) => boolean) => [...new Set(org.entries.filter(pred).map((x) => x.entry.control).filter(Boolean))];
  const orgLists: Record<string, { items: string[]; controls: string[] }> = {
    org_evidence_tampered: { items: org.entries.filter((x) => x.trust === "tampered").map((x) => x.entry.id), controls: controlsOf((x) => x.trust === "tampered") },
    org_evidence_missing: { items: org.missing, controls: [] },
    org_evidence_unreadable: { items: org.error ? ["org-evidence"] : [], controls: org.error ? ANNEX_A_CONTROLS.map((c) => c.id) : [] },
    org_evidence_unconfirmed: { items: org.entries.filter((x) => x.entry.status === "active" && !x.entry.discarded && (x.trust === "unsigned" || x.trust === "untrusted")).map((x) => x.entry.id), controls: controlsOf((x) => x.entry.status === "active" && !x.entry.discarded && (x.trust === "unsigned" || x.trust === "untrusted")) },
    org_evidence_catalogue_changed: { items: org.entries.filter((x) => x.trust === "verified" && x.catalogueChanged).map((x) => x.entry.id), controls: controlsOf((x) => x.trust === "verified" && x.catalogueChanged) },
  };
  approvals.sort((a, b) => time(a.at) - time(b.at) || a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
  const carrying = approvals.filter((a) => a.carries);
  const kindsOf = (xs: ApprovalEntry[]) => {
    const k: Record<string, number> = {};
    for (const a of xs) k[a.kind] = (k[a.kind] ?? 0) + 1;
    return k;
  };

  // ---- the other sources
  const root = safe("goal", () => s.project(), null);
  const tasksIn = of("goal").filter((n) => has(n.goal) || has(n.title));
  // When the main goal was first recorded: kept on the root since 0.9.6 (in the hash chain). Older projects: the
  // root's time or a later "goal set" event, whichever is later (the event log is not in the chain).
  const rootAt = time(root?.createdAt);
  const goalEvent = events.find((e) => e.type === "update" && e.nodeId === root?.id && list(e.data?.fields).includes("goal"));
  const goalSince = has(root?.meta?.goalSince) ? Math.max(rootAt, time(root?.meta?.goalSince)) : Math.max(rootAt, time(goalEvent?.ts)) || rootAt;
  const mainGoal = has(root?.goal) && !Number.isNaN(goalSince) && (!p.to || goalSince <= Date.parse(p.to));
  const messagesIn = safe("conversations", () => s.conversations.allMessages().filter((m) => inPeriod(p, m.ts)), []);
  const sessionsIn = new Set(messagesIn.map((m) => m.sessionId));
  const sessions = safe("models", () => s.conversations.listSessions(), []);
  const ledgerLines = safe("ledger", () => s.ledger.read().lines, []);
  const ledgerIn = ledgerLines.filter((l) => inPeriod(p, l.ts));
  const rewindsIn = events.filter((e) => e.type === "rewind" && inPeriod(p, e.ts));
  const lessonsIn = stepsIn.filter((n) => list(n.lessons).length > 0);
  const fid = safe("fidelity", () => s.fidelity().points as Record<string, { score: number; flags: string[] }>, {});
  const fidIn = stepsIn.filter((n) => fid[n.id] && typeof fid[n.id].score === "number");
  const canonInForce = canon.events.filter((e) => e.trust === "verified" && e.status === "active" && decidedBy(p, e.decidedAt));
  const rulesInForce = ruleStates.rules.filter((x) => x.trust === "verified" && (x.rule.status ?? "active") === "active" && decidedBy(p, x.rule.decidedAt));
  const auditorsKnown = safe("auditors", () => listAuditors().filter((k) => decidedBy(p, k.addedAt)), []);
  const models = uniq([...stepsIn.map((n) => str(n.model)), ...messagesIn.map((m) => str(m.model))]);
  const providers = uniq([...sessions.filter((x) => sessionsIn.has(x.id)).map((x) => str(x.provider)), ...messagesIn.map((m) => str(m.provider))]);
  const attributed = stepsIn.filter((n) => has(n.agent) || has(n.model) || has(n.user));
  const issueCount = (sev: string) => metrics.issues.filter((i) => i.severity === sev).length;

  const warnings = warningsFrom(
    metrics.issues,
    {
      tampered: nodes.filter((n) => integ.state.get(n.id) === "tampered").map((n) => n.id),
      step_missing: integ.stepsMissing ?? [],
      verdict_removed: integ.verdictsRemoved,
      verdict_forged: integ.verdictsForged ?? [],
      snapshot_missing: snapshotMissing,
      verdict_archive_invalid: archiveInvalid,
      ...Object.fromEntries(Object.entries(orgLists).map(([k, v]) => [k, v.items])),
      verdict_untrusted: integ.verdictsUntrusted,
      verdict_superseded: integ.verdictsSuperseded,
      verdict_revoked: integ.verdictsRevoked,
      ledger_extended: integ.ledgerDiverged?.kind === "extended" ? integ.ledgerDiverged.since : [],
      canon_gate_tampered: gate.tampered,
      reseal_unproven: integ.resealsUnproven,
    },
    failed,
  );
  for (const w of warnings) if (orgLists[w.code]) w.controls = orgLists[w.code].controls;
  // A failed project check does not empty the "health" source (its steps are still there); the alarm says what failed.
  const unreadable = new Set<string>(failed.map((x) => x.source).filter((x) => x !== "health"));

  const src = (source: EvidenceSource, count: number, counted: Lang2, facts: SourceEvidence["facts"] = {}, note?: Lang2, hasData = count > 0): SourceEvidence => ({
    source,
    count: unreadable.has(source) ? 0 : count,
    hasData: unreadable.has(source) ? false : hasData,
    counted,
    facts,
    ...(unreadable.has(source) ? { note: t("Diese Quelle ließ sich nicht auswerten (siehe Warnung).", "This source could not be evaluated (see the warning).") } : note ? { note } : {}),
    warnings: warnings.filter((w) => w.sources.includes(source)).map((w) => w.code),
  });

  const decisions = of("decision");
  const sources: Record<EvidenceSource, SourceEvidence> = {
    decisions: src("decisions", decisions.length, t("aufgezeichnete Entscheidungen im Zeitraum", "decisions recorded in the period"), {
      chosen: decisions.filter((n) => has(n.chosen)).length,
      withRationale: decisions.filter((n) => has(n.chosen) && has(n.rationale)).length,
      open: decisions.filter((n) => !has(n.chosen)).length,
    }),
    checkpoints: src("checkpoints", of("checkpoint").length, t("Zwischenstände im Zeitraum", "checkpoints in the period"), {
      automatic: of("checkpoint").filter((n) => n.source === "watch" || n.agent === "watch").length,
      autosaves: of("autosave").length,
    }),
    snapshots: src(
      "snapshots",
      stepsIn.filter((n) => n.snapshot && typeof n.snapshot === "object" && has(n.snapshot.commit) && !missingCommits.has(str(n.snapshot.commit))).length,
      t("Schritte, deren Dateistand noch gespeichert ist (bei dieser Akte geprüft)", "steps whose file state is still stored (checked for this audit file)"),
      { missing: stepsIn.filter((n) => snapshotMissingSet.has(n.id)).length },
    ),
    attribution: src("attribution", attributed.length, t("Schritte mit Angabe zu Agent, Modell oder Konto (wie angegeben)", "steps stating agent, model or account (as stated)"), {
      agents: uniq(stepsIn.map((n) => str(n.agent))),
      users: uniq(stepsIn.map((n) => str(n.user))),
      steps: stepsIn.length,
    }),
    conversations: src("conversations", messagesIn.length, t("aufgezeichnete Nachrichten im Zeitraum", "recorded messages in the period"), { sessions: sessionsIn.size }),
    ledger: src("ledger", ledgerIn.length, t("Einträge der Hash-Kette im Zeitraum", "hash-chain entries in the period"), {
      entries: ledgerLines.length,
      unsealedSteps: stepsIn.filter((n) => integ.state.get(n.id) === "unsealed").map((n) => n.id),
      changedSteps: stepsIn.filter((n) => integ.state.get(n.id) === "tampered").map((n) => n.id),
    }),
    signatures: src("signatures", approvals.length, t("gültig signierte Nachweise im Zeitraum (Freigaben, Prüfurteile, Neu-Versiegelungen, Leseeinstellung, Dokumente der Organisation)", "validly signed records in the period (approvals, verdicts, reseals, read setting, the organisation's documents)"), kindsOf(approvals)),
    reseals: src("reseals", reseals.filter((r) => inPeriod(p, r.at)).length, t("echte Neu-Versiegelungen im Zeitraum", "authentic reseals in the period"), { unproven: integ.resealsUnproven }),
    approvals: src(
      "approvals",
      carrying.length,
      t("signierte Freigaben von Regeln und Arbeit (feste Regeln, Prüfläufe, Projektregeln) im Zeitraum", "signed approvals of rules and work (fixed rules, checks, project rules) in the period"),
      kindsOf(carrying),
      approvals.length > carrying.length
        ? t(
            "Prüfurteile, Neu-Versiegelungen, die Leseeinstellung der Akte und Dokumente der Organisation stehen in der Liste, tragen aber keine Kontrolle: Prüfurteile zählen nur als „Prüfurteile“ (nichts zählt doppelt), Dokumente stehen bei ihrer Kontrolle, die anderen geben keine Arbeit frei.",
            "Verdicts, reseals, the audit file's read setting and the organisation's documents are listed, but carry no control here: verdicts count only as “verdicts” (nothing counts twice), documents are shown at their control, the others approve no work.",
          )
        : undefined,
    ),
    verdicts: src(
      "verdicts",
      independentNodes.length,
      t("unabhängige, echte Prüfurteile (Person oder Prüf-Agent) im Zeitraum", "independent, authentic verdicts (person or audit agent) in the period"),
      { ...byOrigin, confirmedPasses: independentNodes.filter((n) => integ.confirmed.has(n.id)).length, all: verdictNodes.length, earlier: earlierInPeriod },
      verdictNodes.length > independentNodes.length || earlierInPeriod > 0
        ? t(
            "Selbstauskünfte, automatische und nicht (mehr) gültige Urteile sind mitgezählt unter „alle“, tragen aber keine Kontrolle. Frühere, ersetzte Urteile stehen im Verlauf („früher“) zum Vergleich und zählen nie.",
            "Self-reported, automatic and no longer valid verdicts are counted under “all”, but carry no control. Earlier, replaced verdicts are in the history (“earlier”) for comparison and never count.",
          )
        : undefined,
    ),
    auditors: src("auditors", auditorsKnown.length, t("auf diesem Rechner registrierte Prüf-Agenten (aktueller Stand)", "audit agents registered on this machine (current state)"), {
      names: uniq(auditorsKnown.map((k) => str(k.name) || k.id)),
    }),
    irreversible: src("irreversible", stepsIn.filter((n) => list(n.irreversible).length > 0).length, t("Schritte mit gemeldeten Wirkungen nach außen", "steps with reported external effects")),
    rewinds: src(
      "rewinds",
      rewindsIn.length + lessonsIn.length,
      t("Rücksprünge und festgehaltene Lehren im Zeitraum", "rewinds and recorded lessons in the period"),
      { rewinds: rewindsIn.length, lessons: lessonsIn.length },
    ),
    goal: src(
      "goal",
      (mainGoal ? 1 : 0) + tasksIn.length,
      t("Hauptziel (wenn vor Ende des Zeitraums festgehalten) und Aufgaben im Zeitraum", "main goal (when recorded before the period ended) and tasks in the period"),
      { mainGoal: mainGoal ? 1 : 0, tasks: tasksIn.length },
      t("Gezeigt wird das aktuelle Hauptziel; frühere Fassungen haben nur ein Enddatum.", "The current main goal is shown; earlier versions only have an end date."),
    ),
    canon: src("canon", canonInForce.length, t("von der Person signierte, geltende feste Regeln", "fixed rules signed by the person and in force"), {
      ids: canonInForce.map((e) => e.id),
      checksPassed: canonInForce.filter((e) => e.lastCheck?.status === "passed").length,
    }),
    rules: src("rules", rulesInForce.length, t("von der Person signierte, geltende Projektregeln", "project rules signed by the person and in force"), {
      ids: rulesInForce.map((x) => x.rule.id),
    }),
    health: src(
      "health",
      stepsIn.length,
      t("Schritte, die der Projekt-Check im Zeitraum auswertet", "steps the health check evaluates in the period"),
      { high: issueCount("high"), medium: issueCount("medium"), low: issueCount("low") },
      t("Die Befunde des Projekt-Checks gelten für das ganze Projekt.", "The health check's findings concern the whole project."),
    ),
    fidelity: src("fidelity", fidIn.length, t("Schritte mit berechnetem Wert „beim Thema bleiben“ (Heuristik)", "steps with a computed context fidelity (heuristic)"), {
      drift: fidIn.filter((n) => list(fid[n.id].flags).includes("drift")).length,
      breaks: fidIn.filter((n) => list(fid[n.id].flags).includes("break")).length,
    }),
    models: src("models", models.length, t("verschiedene Modelle laut Aufzeichnung", "different models as recorded"), { models, providers }),
  };

  // ---- controls
  const alarmCodes = new Set(warnings.filter((w) => w.level === "alarm").map((w) => w.code));
  const controls: ControlResult[] = ANNEX_A_CONTROLS.map((c) => {
    const req = c.required.map((k) => ({ source: k, count: sources[k].count, hasData: sources[k].hasData }));
    const sup = c.supporting.map((k) => ({ source: k, count: sources[k].count, hasData: sources[k].hasData }));
    const missing = req.filter((r) => !r.hasData).map((r) => r.source);
    const status: ControlStatus = c.coverage === "organisational" ? "organisational" : missing.length ? "not_covered" : c.coverage;
    const all = [...c.required, ...c.supporting];
    const ws = warnings.filter((w) => w.sources.some((x) => all.includes(x)) || (w.controls ?? []).includes(c.id)).map((w) => w.code);
    const docs = orgByControl.get(c.id) ?? [];
    return {
      id: c.id,
      area: c.area,
      group: c.group,
      title: c.title,
      coverage: c.coverage,
      status,
      required: req,
      supporting: sup,
      missing,
      warnings: ws,
      alarm: ws.some((x) => alarmCodes.has(x)),
      scenaria: c.scenaria,
      organisation: c.organisation,
      ...(c.appliesWhen ? { appliesWhen: c.appliesWhen } : {}),
      orgEvidence: { state: docs.some((d) => d.counts) ? "documented" : docs.length ? "unconfirmed" : "none", entries: docs },
    };
  });

  const summary = {
    controls: controls.length,
    evidenced: controls.filter((c) => c.status === "evidenced").length,
    partly: controls.filter((c) => c.status === "partly").length,
    organisational: controls.filter((c) => c.status === "organisational").length,
    not_covered: controls.filter((c) => c.status === "not_covered").length,
    withAlarm: controls.filter((c) => c.alarm).length,
    withNotes: controls.filter((c) => !c.alarm && c.warnings.length > 0).length,
    orgDocumented: controls.filter((c) => c.orgEvidence.state === "documented").length,
  };

  const state: AuditFile["integrity"]["state"] = alarmCodes.size ? "alarm" : warnings.length ? "notes" : "ok";
  // Scoped to what is checked (K12): steps, signed records and reseals — not conversations or the event log.
  const headline: Lang2 =
    state === "alarm"
      ? { de: `Achtung: ${ALARM_TEXT.de} Betroffen: ${summary.withAlarm} von ${summary.controls} Kontrollen.`, en: `Warning: ${ALARM_TEXT.en} Affected: ${summary.withAlarm} of ${summary.controls} controls.` }
      : state === "notes"
        ? t("Der Manipulationsnachweis ist intakt. Es gibt Hinweise, die ein Auditor kennen sollte.", "The tamper evidence is intact. There are notes an auditor should know.")
        : t(
            "Der Manipulationsnachweis ist intakt: Bei den aufgezeichneten Schritten und den signierten Nachweisen wurde keine Veränderung außerhalb von Scenaria gefunden.",
            "The tamper evidence is intact: no change outside Scenaria was found in the recorded steps and the signed records.",
          );

  const whole = !p.from && !p.to;

  return {
    kind: AUDIT_FILE_KIND,
    version: AUDIT_FILE_VERSION,
    standard: ANNEX_A_STANDARD,
    scope: ANNEX_A_SCOPE,
    generatedAt,
    project: { name: projectName, id: boundId, ...(configId && configId !== boundId ? { configId } : {}) },
    period: {
      from: p.from,
      to: p.to,
      whole,
      steps: stepsIn.length,
      firstStep: sortedTimes[0] ?? null,
      lastStep: sortedTimes[sortedTimes.length - 1] ?? null,
      note: whole
        ? t("Zeitraum: das ganze Projekt.", "Period: the whole project.")
        : t(
            "Zeitraum wie gewählt, in UTC (Tage ohne Uhrzeit gelten ganz; in Deutschland beginnt ein UTC-Tag um 1 Uhr, im Sommer um 2 Uhr; ein Ende auf die Minute schließt diese Minute ein). Hauptziel, feste Regeln, Projektregeln und Prüf-Agenten zählen, wenn sie vor dem Ende des Zeitraums galten; Regeln ab ihrer letzten Entscheidung.",
            "Period as chosen, in UTC (days without a time count whole; an end given to the minute includes that minute). The main goal, fixed rules, project rules and audit agents count when they applied before the end of the period; rules from their latest decision.",
          ),
    },
    integrity: {
      state,
      headline,
      warnings,
      note: t(
        "Die Prüfung des Manipulationsnachweises betrifft die ganze Aufzeichnung, nicht nur den Zeitraum. Sie senkt keinen Status, sondern warnt bei jeder betroffenen Kontrolle. Gesprächsverläufe, Projektregeln und das Ereignisprotokoll (Rücksprünge) sind nicht in der Hash-Kette; ihre Zeitangaben stammen aus der Aufzeichnung.",
        "The tamper-evidence check concerns the whole record, not only the period. It lowers no status; it warns at every affected control. Conversations, project rules and the event log (rewinds) are not in the hash chain; their times are as recorded.",
      ),
    },
    summary,
    catalogue: catalogueFingerprint(),
    sources,
    controls,
    approvals,
    verdictHistory,
    reseals: { authentic: reseals, unproven: integ.resealsUnproven },
    access,
  };
}
