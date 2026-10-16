/**
 * Batch C4a: the signed audit file — the evidence an auditor can check on their own.
 *
 * Kev's decisions (2026-10-16):
 *   - The evidence is a signed JSON file. Markdown (and, from C4b, PDF) are renderings of it that carry its
 *     fingerprint; only the JSON is checked.
 *   - The export names people by default; the person can choose "roles only" for each export (it is recorded
 *     in the signed file).
 *
 * The body (everything except `signature`) is serialised canonically (keys sorted, no undefined) and hashed
 * with SHA-256; the person's approver key signs ["<projectId>", "audit-export/v1", "<digest>"] (Ed25519). The
 * signature means: "computed by Scenaria on this machine at that time, from these records, and released by the
 * person holding this key". It does not prove the facts in the records; the integrity section says how far the
 * records themselves can be trusted. An auditor confirms the key id with the person over a second channel.
 *
 * Checking (`verifyAuditExport`) needs no project and no Scenaria data: only the file. It never throws.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import type { Scenaria } from "./engine.js";
import { buildAuditFile, type AuditFile, type Period } from "./auditfile.js";
import { projectIdentity, publicKeyId, signRecord, trustedApproverIdSet } from "./canon.js";
import { readLedgerAnchor } from "./seal.js";
import { COVERAGE_LABEL, EVIDENCE_SOURCES, type Lang2 } from "./iso42001.js";

export const AUDIT_EXPORT_KIND = "scenaria/iso42001-audit-export";
export const AUDIT_EXPORT_VERSION = 1;
const SIGNED_TAG = "audit-export/v1";

export type NamesMode = "with-names" | "roles-only";

export interface AuditExportBody {
  kind: typeof AUDIT_EXPORT_KIND;
  version: number;
  /** "with-names" (default) or "roles-only": people appear only by their role or as "person". */
  names: NamesMode;
  /** What was computed, from what. */
  context: {
    scenariaVersion: string;
    generatedAt: string;
    projectId: string;
    ledger: { lines: number; head: string | null; genesis: string | null };
    /** This machine's mark outside the project (null: none yet). */
    anchor: { genesis: string | null; lines: number | null; head: string | null } | null;
    catalogue: AuditFile["catalogue"];
    period: { from: string | null; to: string | null };
    meaning: { de: string; en: string };
  };
  file: AuditFile;
}

export interface AuditExport extends AuditExportBody {
  signature: {
    alg: "Ed25519";
    /** SHA-256 over the canonical body (hex). */
    digest: string;
    projectId: string;
    keyId: string;
    /** The person's public key (base64 SPKI DER). */
    pub: string;
    /** Signature (base64) over the UTF-8 bytes of `signed`. */
    sig: string;
    /** Exactly the signed bytes, for checking with other tools (e.g. openssl pkeyutl -verify -rawin). */
    signed: string;
  };
}

// ------------------------------------------------------------------ canonical form

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : stable(x)));
  if (v && typeof v === "object") {
    // No prototype: a key named "__proto__" stays an ordinary key (it never silently drops out; review C4a-3).
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

/**
 * The canonical serialisation the digest is computed over: keys sorted (UTF-16 code units), `undefined`
 * dropped, no whitespace, numbers and strings as JSON.stringify writes them. For JSON data this matches
 * RFC 8785 (JSON Canonicalization Scheme), so other tools can recompute it.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(stable(v));
}

export function bodyDigest(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

const signedText = (projectId: string, digest: string) => JSON.stringify([projectId, SIGNED_TAG, digest]);

/**
 * Strict JSON for checking (review C4a-3): duplicate keys, "__proto__"/"constructor"/"prototype" keys, numbers
 * that are not finite or not exactly representable, and nesting deeper than 64 are refused — anything a reader
 * could see differently than the digest does.
 */
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const n = text.length;
  const fail = (m: string): never => {
    throw new Error(`${m} at character ${i}`);
  };
  const ws = () => {
    while (i < n && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
  };
  const str = (): string => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === '"') break;
      else if (c < " ") fail("control character in a string");
      else i++;
    }
    if (text[i] !== '"') fail("unterminated string");
    i++;
    const decoded: string = JSON.parse(text.slice(start, i));
    // Only well-formed Unicode (I-JSON, as RFC 8785 requires): no lone surrogates.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(decoded)) fail("lone surrogate in a string");
    return decoded;
  };
  const num = (): number => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("bad value");
    i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) fail("number out of range");
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) fail("integer too large to be exact");
    // Only the spelling Scenaria (JSON.stringify) writes: 1.0000000000000001 or 1e-400 would read as another number.
    if (m[0] !== JSON.stringify(v)) fail("number not in its canonical spelling");
    return v;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail("nested too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = Object.create(null);
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a key");
        const k = str();
        if (k === "__proto__" || k === "constructor" || k === "prototype") fail(`forbidden key "${k}"`);
        if (Object.prototype.hasOwnProperty.call(o, k)) fail(`duplicate key "${k.slice(0, 40)}"`);
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        o[k] = value(depth + 1);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return o;
        } else fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return a;
        } else fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    return num();
  };
  const v = value(0);
  ws();
  if (i !== n) fail("unexpected text after the end");
  return v;
}

/** Walk an already parsed value for what the strict parser refuses (when the caller passes an object). */
function strictShape(v: unknown, depth = 0): string | null {
  if (depth > 64) return "nested too deep";
  if (typeof v === "number") return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)) ? null : "number out of range";
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = strictShape(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") return `forbidden key "${k}"`;
      const r = strictShape((v as Record<string, unknown>)[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ------------------------------------------------------------------ names

/**
 * Roles only: every personal name or account in the file is replaced (owners keep their role; who decided
 * becomes "person", "audit agent" or "earlier verdict"; OS accounts are only counted; the project check's
 * technical messages are left out). Titles and texts the person or the agents wrote (step titles, document
 * titles, rule texts) stay as recorded.
 */
export function withoutNames(f: AuditFile): AuditFile {
  const c: AuditFile = JSON.parse(JSON.stringify(f));
  for (const ctl of c.controls) for (const e of ctl.orgEvidence.entries) {
    e.owner = { role: e.owner.role, name: "" };
    e.decidedBy = "person";
  }
  for (const a of c.approvals) a.by = a.origin === "auditor" ? "audit agent" : "person";
  const role = (origin: string, by: string) => (origin === "auditor" ? "audit agent" : origin === "person" ? "person" : origin === "legacy" ? "earlier verdict" : by);
  for (const h of c.verdictHistory) {
    if (h.current) h.current.by = role(h.current.origin, h.current.by);
    for (const e of h.earlier) e.by = role(e.origin, e.by);
  }
  // The project check's technical messages can quote names: left out (the title and explanation stay).
  for (const w of c.integrity.warnings) w.details = [];
  for (const r of c.reseals.authentic) r.by = r.kind === "auditor" ? "audit agent" : "person";
  const attr = c.sources.attribution?.facts as Record<string, unknown> | undefined;
  if (attr && Array.isArray(attr.users)) attr.users = [`${(attr.users as unknown[]).length} account(s)`];
  if (c.access?.set) c.access.set.by = "person";
  return c;
}

// ------------------------------------------------------------------ export (the person's action)

export const EXPORT_MEANING = {
  de: "Diese Signatur bedeutet: Scenaria hat die Akte zu diesem Zeitpunkt auf diesem Rechner aus diesen Aufzeichnungen berechnet, und die Person mit diesem Schlüssel hat sie herausgegeben. Sie beweist nicht die Fakten in den Aufzeichnungen; wie weit diese verlässlich sind, steht im Abschnitt Manipulationsnachweis. Die Schlüsselkennung bestätigt die Person auf einem zweiten Weg (z. B. telefonisch).",
  en: "This signature means: Scenaria computed the audit file at this time on this machine from these records, and the person holding this key released it. It does not prove the facts in the records; how far they can be relied on is stated in the tamper-evidence section. The person confirms the key id over a second channel (e.g. by phone).",
};

/**
 * Compute and sign the audit file. Signs with the person's approver key: callers make sure a person acts
 * (approval session or interactive terminal, security rule 6).
 */
export function exportAuditFile(s: Scenaria, period: Period, opts: { names?: NamesMode; version: string; by?: string; via?: string }): AuditExport {
  const names: NamesMode = opts.names === "roles-only" ? "roles-only" : "with-names";
  const raw = buildAuditFile(s, period);
  const file = names === "roles-only" ? withoutNames(raw) : raw;
  const st = s.ledger.state();
  const a = readLedgerAnchor(s.root);
  const projectId = projectIdentity(s.store, true);
  const body: AuditExportBody = {
    kind: AUDIT_EXPORT_KIND,
    version: AUDIT_EXPORT_VERSION,
    names,
    context: {
      scenariaVersion: opts.version,
      generatedAt: file.generatedAt,
      projectId,
      ledger: { lines: st.lines, head: st.head, genesis: st.genesis },
      anchor: a ? { genesis: a.genesis ?? null, lines: a.hw?.lines ?? null, head: a.hw?.head ?? null } : null,
      catalogue: file.catalogue,
      period: { from: period.from, to: period.to },
      meaning: EXPORT_MEANING,
    },
    file,
  };
  const digest = bodyDigest(body);
  // signRecord signs JSON.stringify([projectId, ...parts]) = signedText(projectId, digest).
  const sig = signRecord(s.store, [SIGNED_TAG, digest]);
  if (sig.pid !== projectId) throw new Error("project id changed while exporting");
  s.store.appendEvent({ type: "update", data: { message: `audit file exported and signed (${names})`, digest, period: body.context.period, by: opts.by ?? "person", via: opts.via ?? "" } });
  return { ...body, signature: { alg: "Ed25519", digest, projectId, keyId: publicKeyId(sig.pub), pub: sig.pub, sig: sig.sig, signed: signedText(projectId, digest) } };
}

// ------------------------------------------------------------------ checking (anyone, anywhere)

export interface ExportCheck {
  /** Content and signature match. */
  valid: boolean;
  /** Plain reason when not valid. */
  problem?: string;
  digest?: string;
  keyId?: string;
  projectId?: string;
  generatedAt?: string;
  names?: NamesMode;
  integrity?: string;
  /** The key is one this machine trusts (own or a teammate's). For an auditor: usually false — confirm the id with the person. */
  keyTrustedHere?: boolean;
}

/** Check a signed audit file (parsed JSON or its text). Needs nothing but the file. Never throws. */
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const INTEGRITY_STATES = new Set(["ok", "notes", "alarm"]);

export function verifyAuditExport(input: unknown): ExportCheck {
  try {
    if (typeof input === "string" && input.length > MAX_EXPORT_BYTES) return { valid: false, problem: "too large" };
    let x: unknown;
    try {
      x = typeof input === "string" ? parseStrictJson(input) : input;
    } catch (err: any) {
      return { valid: false, problem: `not strict JSON (${String(err?.message ?? err).slice(0, 80)})` };
    }
    const shape = strictShape(x);
    if (shape) return { valid: false, problem: `not strict JSON (${shape})` };
    if (!x || typeof x !== "object" || (x as any).kind !== AUDIT_EXPORT_KIND) return { valid: false, problem: "not a Scenaria audit file export" };
    const { signature, ...body } = x as AuditExport;
    if ((body as any).version !== AUDIT_EXPORT_VERSION) return { valid: false, problem: `unknown version ${(body as any).version}` };
    if (!signature || typeof signature !== "object") return { valid: false, problem: "no signature" };
    const { digest, projectId, pub, sig } = signature;
    if (![digest, projectId, pub, sig].every((v) => typeof v === "string" && v)) return { valid: false, problem: "the signature is incomplete" };
    if (signature.alg !== "Ed25519") return { valid: false, problem: "unknown signature algorithm" };
    // Nothing unsigned rides along inside the signature block.
    const known = new Set(["alg", "digest", "projectId", "keyId", "pub", "sig", "signed"]);
    if (Object.keys(signature).some((k) => !known.has(k))) return { valid: false, problem: "unknown field in the signature" };
    if (!/^[0-9a-f]{64}$/.test(digest)) return { valid: false, problem: "the digest is not a SHA-256" };
    if (!/^[0-9a-f]{8,64}$/.test(projectId)) return { valid: false, problem: "the project id is not a Scenaria project id" };
    // The signed text is not taken from the file: it is rebuilt, and the stored copy must match it (review C4a-1).
    if (signature.signed !== signedText(projectId, digest)) return { valid: false, problem: "the signed text does not belong to this file" };
    const actual = bodyDigest(body);
    if (actual !== digest) return { valid: false, problem: "the content was changed after signing (digest does not match)", digest: actual };
    if (body.context?.projectId !== projectId) return { valid: false, problem: "the project id in the file does not match the signature" };
    let ok = false;
    try {
      ok = edVerify(null, Buffer.from(signedText(projectId, digest)), createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" }), Buffer.from(sig, "base64"));
    } catch {
      ok = false;
    }
    const keyId = publicKeyId(pub);
    if (!ok) return { valid: false, problem: "the signature does not match", digest, keyId };
    if (signature.keyId !== keyId) return { valid: false, problem: "the key id does not belong to the key", digest, keyId };
    const integrity = (body as any).file?.integrity?.state;
    if (!INTEGRITY_STATES.has(integrity)) return { valid: false, problem: "the tamper-evidence state is not one Scenaria writes", digest, keyId };
    if ((body as any).names !== "with-names" && (body as any).names !== "roles-only") return { valid: false, problem: "unknown names mode", digest, keyId };
    let trusted = false;
    try {
      trusted = trustedApproverIdSet().has(keyId);
    } catch {}
    const at = typeof body.context?.generatedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(body.context.generatedAt) ? body.context.generatedAt : "unknown";
    return { valid: true, digest, keyId, projectId, generatedAt: at, names: body.names, integrity, keyTrustedHere: trusted };
  } catch (err: any) {
    return { valid: false, problem: `cannot be read (${String(err?.message ?? err).slice(0, 80)})` };
  }
}

// ------------------------------------------------------------------ Markdown (a rendering; the JSON is the evidence)

/** Text for a Markdown table cell: no pipes, no line breaks, no HTML, no control characters. */
/**
 * Text for Markdown (a table cell or inline): every Markdown metacharacter is escaped, so recorded text can
 * never become a link, an image, emphasis, a heading or a new table cell (review C4a-4); no HTML, no line
 * breaks, no control or direction characters.
 */
const cell = (x: unknown) =>
  String(x ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]()!#|{}~$]/g, (c) => `\\${c}`)
    .replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
const day = (iso: string | null | undefined) => (iso ? String(iso).replace("T", " ").slice(0, 16) + " UTC" : "—");

/** Render a signed export as Markdown (DE or EN). Every page of a later PDF carries the same fingerprint. */
export function renderAuditMarkdown(x: AuditExport, lang: "de" | "en" = "de"): string {
  const L = (t: Lang2) => t[lang];
  const T = (de: string, en: string) => (lang === "de" ? de : en);
  const f = x.file;
  const sig = x.signature;
  const out: string[] = [];
  out.push(`# ${T("ISO/IEC 42001 Prüfakte", "ISO/IEC 42001 audit file")} — ${cell(f.project.name)}`);
  out.push("");
  out.push(`> ${T("Fingerabdruck", "Fingerprint")}: \`sha256:${sig.digest}\` · ${T("Schlüssel", "Key")} \`${sig.keyId}\` · ${T("Projekt", "Project")} \`${sig.projectId}\``);
  out.push(`> ${T("Diese Darstellung ist eine Lesekopie. Beweisstück ist die signierte JSON-Datei mit demselben Fingerabdruck.", "This is a reading copy. The evidence is the signed JSON file with the same fingerprint.")}`);
  out.push("");
  out.push(`| | |`);
  out.push(`|---|---|`);
  out.push(`| ${T("Norm", "Standard")} | ${cell(f.standard)} (${T("Katalog", "catalogue")} \`${f.catalogue.hash}\`, ${f.catalogue.controls} ${T("Kontrollen", "controls")}) |`);
  out.push(`| ${T("Zeitraum", "Period")} | ${f.period.whole ? T("das ganze Projekt", "the whole project") : `${day(f.period.from)} – ${day(f.period.to)}`} · ${f.period.steps} ${T("Schritte", "steps")} |`);
  out.push(`| ${T("Erstellt", "Generated")} | ${day(x.context.generatedAt)} · Scenaria ${cell(x.context.scenariaVersion)} |`);
  out.push(`| ${T("Hash-Kette", "Hash chain")} | ${x.context.ledger.lines} ${T("Einträge", "entries")}, ${T("Kopf", "head")} \`${x.context.ledger.head ?? "—"}\` |`);
  out.push(`| ${T("Personen", "People")} | ${x.names === "roles-only" ? T("nur Rollen (Namen weggelassen)", "roles only (names left out)") : T("mit Namen", "with names")} |`);
  out.push("");
  out.push(`**${T("Was die Signatur bedeutet", "What the signature means")}:** ${L(x.context.meaning)}`);
  out.push("");
  out.push(`**${T("Geltungsbereich", "Scope")}:** ${cell(L(f.scope))}`);
  out.push("");
  out.push(`## ${T("Manipulationsnachweis", "Tamper evidence")}`);
  out.push("");
  out.push(`**${cell(L(f.integrity.headline))}**`);
  out.push("");
  for (const w of f.integrity.warnings) {
    out.push(`- ${w.level === "alarm" ? "⚠ " : ""}**${cell(L(w.title))}**${w.count > 1 ? ` (${w.count})` : ""}: ${cell(L(w.explain))}${w.items.length ? ` — ${cell(w.items.slice(0, 12).join(", "))}${w.items.length > 12 ? ", …" : ""}` : ""}`);
  }
  if (f.integrity.warnings.length) out.push("");
  out.push(cell(L(f.integrity.note)));
  out.push("");
  out.push(`## ${T("Übersicht", "Summary")}`);
  out.push("");
  out.push(`- ${T("teilweise belegt", "partly evidenced")}: ${f.summary.partly}`);
  out.push(`- ${T("nicht abgedeckt", "not covered")}: ${f.summary.not_covered}`);
  out.push(`- ${T("Nachweis durch die Organisation", "evidence by the organisation")}: ${f.summary.organisational}`);
  out.push(`- ${T("Dokumente der Organisation eingetragen (von der Person signiert)", "organisation's documents recorded (signed by the person)")}: ${f.summary.orgDocumented} / ${f.summary.controls}`);
  if (f.summary.withAlarm) out.push(`- ⚠ ${T("Kontrollen mit Alarm", "controls with an alarm")}: ${f.summary.withAlarm}`);
  out.push("");
  out.push(`## ${T("Kontrollen", "Controls")}`);
  out.push("");
  out.push(`| ${T("Kontrolle", "Control")} | ${T("Titel", "Title")} | ${T("Status aus den Aufzeichnungen", "Status from the records")} | ${T("Dokument der Organisation", "Organisation's document")} | ${T("Hinweise", "Notes")} |`);
  out.push(`|---|---|---|---|---|`);
  const orgWord = { documented: T("eingetragen", "recorded"), unconfirmed: T("nicht bestätigt", "not confirmed"), none: "—" };
  for (const c of f.controls) {
    const notes = [c.missing.length ? `${T("keine Daten", "no data")}: ${c.missing.map((m) => L(EVIDENCE_SOURCES[m].label)).join(", ")}` : "", c.alarm ? `⚠ ${c.warnings.join(", ")}` : c.warnings.length ? c.warnings.join(", ") : ""].filter(Boolean).join("; ");
    out.push(`| ${cell(c.id)} | ${cell(L(c.title))} | ${cell(L(COVERAGE_LABEL[c.status]))} | ${orgWord[c.orgEvidence.state]} | ${cell(notes)} |`);
  }
  out.push("");
  const docs = f.controls.flatMap((c) => c.orgEvidence.entries.map((e) => ({ c, e })));
  out.push(`## ${T("Dokumente der Organisation", "The organisation's documents")}`);
  out.push("");
  if (!docs.length) out.push(T("Keine eingetragen.", "None recorded."));
  else {
    out.push(`| ${T("Kontrolle", "Control")} | ${T("Dokument", "Document")} | SHA-256 | ${T("Verantwortlich", "Owner")} | ${T("Datum", "Date")} | ${T("gilt ab", "in force from")} | ${T("Stand", "State")} |`);
    out.push(`|---|---|---|---|---|---|---|`);
    for (const { c, e } of docs) {
      const state = e.counts ? (e.catalogueChanged ? T("signiert, Kontrolle neu gefasst", "signed, control re-worded") : T("signiert", "signed")) : `${T("zählt nicht", "does not count")} (${e.trust})`;
      out.push(`| ${cell(c.id)} | ${cell(e.title ? `${e.title} — ${e.url}` : e.url)} | \`${cell(e.hash.replace(/^sha256:/, ""))}\` | ${cell(e.owner.name ? `${e.owner.role}: ${e.owner.name}` : e.owner.role)} | ${cell(e.date)} | ${day(e.activeFrom)}${e.removedAt ? ` – ${day(e.removedAt)}` : ""} | ${cell(state)}${e.copiedFrom ? ` · ${T("übernommen aus", "taken over from")} ${cell(e.copiedFrom)}` : ""} |`);
    }
  }
  out.push("");
  out.push(`## ${T("Signierte Freigaben und Entscheidungen im Zeitraum", "Signed approvals and decisions in the period")}`);
  out.push("");
  if (!f.approvals.length) out.push(T("Keine.", "None."));
  else {
    out.push(`| ${T("Zeit", "Time")} | ${T("Art", "Kind")} | ${T("Bezug", "Ref")} | ${T("Aktion", "Action")} | ${T("von", "by")} | ${T("Weg", "via")} | ${T("zählt als Freigabe", "counts as approval")} |`);
    out.push(`|---|---|---|---|---|---|---|`);
    for (const a of f.approvals) out.push(`| ${day(a.at)} | ${cell(a.kind)} | ${cell(a.ref)} | ${cell(a.action)} | ${cell(a.by)}${a.unsigned.includes("by") ? "*" : ""} | ${cell(a.via)}${a.unsigned.includes("via") ? "*" : ""} | ${a.carries ? T("ja", "yes") : T("nein", "no")} |`);
    out.push("");
    out.push(`\\* ${T("nicht von der Signatur gedeckt (wie aufgezeichnet)", "not covered by the signature (as recorded)")}`);
  }
  out.push("");
  if (f.verdictHistory.length) {
    out.push(`## ${T("Prüfurteile mit Verlauf", "Verdicts with history")}`);
    out.push("");
    for (const h of f.verdictHistory) {
      out.push(`- **${cell(h.node)}**: ${h.current ? `${T("jetzt", "now")} ${cell(h.current.status)} (${cell(h.current.origin)}, ${day(h.current.at)}${h.current.counts ? `, ${T("zählt", "counts")}` : ""})` : "—"}${h.earlier.length ? `; ${T("früher", "earlier")}: ${h.earlier.map((e) => `${cell(e.status)} (${cell(e.origin)}, ${day(e.at)}, ${cell(e.signature)})`).join("; ")}` : ""}${h.stepChanged ? ` ⚠ ${T("Schritt außerhalb von Scenaria geändert", "step changed outside Scenaria")}` : ""} — ${T("Schritt", "step")}: „${cell(h.title)}“`);
    }
    out.push("");
  }
  out.push(`## ${T("Neu-Versiegelungen", "Reseals")}`);
  out.push("");
  out.push(f.reseals.authentic.length ? f.reseals.authentic.map((r) => `- ${cell(r.id)}: ${day(r.at)}, ${cell(r.kind)} (${cell(r.by)})`).join("\n") : T("Keine.", "None."));
  if (f.reseals.unproven.length) out.push(`- ⚠ ${T("ohne Nachweis", "without proof")}: ${cell(f.reseals.unproven.join(", "))}`);
  out.push("");
  out.push(`## ${T("So prüfen Sie die Akte", "How to check this audit file")}`);
  out.push("");
  out.push(T(
    "1. Mit Scenaria (ohne Projekt): `scenaria audit-file verify <datei.json>` — prüft Inhalt und Signatur.",
    "1. With Scenaria (no project needed): `scenaria audit-file verify <file.json>` — checks content and signature.",
  ));
  out.push(T(
    `2. Ohne Scenaria: den Inhalt ohne \`signature\` nach RFC 8785 (JCS) kanonisch serialisieren, SHA-256 bilden und mit \`signature.digest\` vergleichen. Den signierten Text selbst bilden, nicht aus der Datei übernehmen: genau \`["<projectId>","audit-export/v1","<digest>"]\` mit diesen beiden Werten. Dann die Ed25519-Signatur \`signature.sig\` über diese UTF-8-Bytes mit \`signature.pub\` prüfen (z. B. \`openssl pkeyutl -verify -rawin -pubin\`).`,
    `2. Without Scenaria: serialise the content without \`signature\` canonically per RFC 8785 (JCS), compute SHA-256 and compare with \`signature.digest\`. Build the signed text yourself, do not take it from the file: exactly \`["<projectId>","audit-export/v1","<digest>"]\` with these two values. Then check the Ed25519 signature \`signature.sig\` over these UTF-8 bytes with \`signature.pub\` (e.g. \`openssl pkeyutl -verify -rawin -pubin\`).`,
  ));
  out.push(T(
    `3. Die Schlüsselkennung \`${sig.keyId}\` mit der Person auf einem zweiten Weg bestätigen.`,
    `3. Confirm the key id \`${sig.keyId}\` with the person over a second channel.`,
  ));
  out.push("");
  return out.join("\n");
}
