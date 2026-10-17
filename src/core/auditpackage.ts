/**
 * Batch C4b: the audit package — the folder the person hands to an auditor (Kev's decision 2026-10-16).
 *
 *   audit-package-<project>-<time>-<names>-<fingerprint>/
 *     audit-file.json   the evidence (signed, C4a)
 *     audit-file.html   reading copy to print; the PDF is made by the browser ("Print → Save as PDF")
 *     audit-file.md     reading copy as text
 *     PRUEFEN.txt / CHECK.txt   what is in it and how to check it
 *
 * The folder and every file are created exclusively (never over something that exists or a planted link).
 * `verify` without a file finds the newest export in a folder; for a package it also checks that the reading
 * copies carry the same fingerprint as the evidence.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAX_EXPORT_BYTES, parseStrictJson, renderAuditMarkdown, verifyAuditExport, type AuditExport, type ExportCheck } from "./auditexport.js";
import { renderAuditHtml, renderPackageReadme } from "./audithtml.js";

export const PACKAGE_EVIDENCE = "audit-file.json";
export const PACKAGE_COPIES = "audit-file.copies.json";
const COPIES_TAG = "audit-copies/v1";
/** Since 0.9.13 (C5, S-K5): the note on checking is signed too. */
const COPIES_TAG_V2 = "audit-copies/v2";
/** The note on checking, by language. */
export const PACKAGE_NOTES = { de: "PRUEFEN.txt", en: "CHECK.txt" } as const;
/** Every file Scenaria writes into a package (plus its one note); anything else is reported as not checked. */
const PACKAGE_FILES = new Set<string>([PACKAGE_EVIDENCE, PACKAGE_COPIES, "audit-file.html", "audit-file.md"]);
/** Version a.b.c at least `min`. */
function atLeast(v: unknown, min: number[]): boolean {
  const m = typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  if (!m) return false;
  const n = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (n[i] !== min[i]) return n[i] > min[i];
  return true;
}
/** SHA-256 of the raw bytes (a file) or of the UTF-8 bytes (a text): never of a decoded file (C5, S-K6). */
const sha256 = (t: string | Buffer) => createHash("sha256").update(typeof t === "string" ? Buffer.from(t, "utf8") : t).digest("hex");
/** Strict UTF-8: invalid bytes are refused, never replaced by U+FFFD on reading (C5, S-K6). */
const utf8 = (b: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(b);

/** The text the person signs for the reading copies (bound to the project and the evidence's fingerprint). */
export const copiesSignedText = (projectId: string, digest: string, lang: string, html: string, md: string, note?: string) =>
  JSON.stringify(note === undefined ? [projectId, COPIES_TAG, digest, lang, html, md] : [projectId, COPIES_TAG_V2, digest, lang, html, md, note]);

/**
 * Write the package into `parent` (which must exist). Returns the package folder. With `sign` (the person's
 * key, the same that signed the evidence), the reading copies' hashes are signed too (`audit-file.copies.json`),
 * so any Scenaria version can tell an edited copy (review of C4b: comparing by rendering again works only with
 * the same version).
 */
export function writeAuditPackage(parent: string, x: AuditExport, lang: "de" | "en" = "de", sign?: (parts: unknown[]) => { pub: string; sig: string }): string {
  const slug = (x.file.project.name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";
  const folder = join(parent, `audit-package-${slug}-${x.context.generatedAt.slice(0, 19).replace(/[-:T]/g, "")}-${x.names}-${x.signature.digest.slice(0, 8)}`);
  mkdirSync(folder); // fails when it exists: never into a folder someone prepared
  const put = (name: string, text: string) => writeFileSync(join(folder, name), text, { flag: "wx" });
  put(PACKAGE_EVIDENCE, JSON.stringify(x, null, 2) + "\n");
  const html = renderAuditHtml(x, lang);
  const md = renderAuditMarkdown(x, lang);
  const note = renderPackageReadme(x, lang);
  put("audit-file.html", html);
  put("audit-file.md", md);
  if (sign) {
    const h = sha256(html);
    const m = sha256(md);
    const n = sha256(note);
    const s = sign([COPIES_TAG_V2, x.signature.digest, lang, h, m, n]);
    if (s.pub !== x.signature.pub) throw new Error("the reading copies must be signed with the evidence's key");
    put(PACKAGE_COPIES, JSON.stringify({ kind: "scenaria/audit-copies", version: 2, digest: x.signature.digest, lang, copies: { "audit-file.html": h, "audit-file.md": m, [PACKAGE_NOTES[lang]]: n }, sig: s.sig }, null, 2) + "\n");
  }
  put(PACKAGE_NOTES[lang], note);
  return folder;
}

const isFile = (p: string) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The newest signed export in a folder. Inside a package folder only its own audit-file.json counts (review
 * C4b-3). Elsewhere: package folders (audit-package-* with audit-file.json) and single audit-file*.json files,
 * newest by modification time — which anyone who writes or unpacks files can set, so `others` says how many
 * more there are and the caller names them. Only plain files count (no links).
 */
export function findNewestExport(dir: string): { path: string; others: number } | null {
  if (isFile(join(dir, PACKAGE_EVIDENCE))) return { path: join(dir, PACKAGE_EVIDENCE), others: 0 };
  const found: { path: string; t: number }[] = [];
  const consider = (p: string) => {
    if (isFile(p)) found.push({ path: p, t: statSync(p).mtimeMs });
  };
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (/^audit-file.*\.json$/i.test(n)) consider(join(dir, n));
    else if (/^audit-package-/i.test(n)) {
      try {
        if (lstatSync(join(dir, n)).isDirectory()) consider(join(dir, n, PACKAGE_EVIDENCE));
      } catch {}
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.t - a.t || a.path.localeCompare(b.path));
  return { path: found[0].path, others: found.length - 1 };
}

export type CopyState = "same" | "different" | "not_comparable" | "missing";

export interface PackageCheck extends ExportCheck {
  /** The file that was checked. */
  file: string;
  /** Whether it is the evidence of a package (then its reading copies were looked at). */
  package: boolean;
  /**
   * Each reading copy of a package: "same" = rendered again from the verified evidence and identical byte for
   * byte; "different" = it does not show what the evidence holds; "not_comparable" = made by another Scenaria
   * version, so it cannot be compared (read the evidence instead); "missing".
   */
  copies: { name: string; state: CopyState }[];
  /**
   * The package's signature over its reading copies: "invalid" = present but not verifying (or not a plain,
   * small file); "missing" = absent although the exporting version always writes it. Either fails the check.
   */
  copiesSignature?: "invalid" | "missing";
  /** Files in the package folder that Scenaria did not write (e.g. a PDF saved there): never checked (C5, S-K5). */
  extra?: string[];
}

/** Check a signed export (a .json file, or a package folder). `version` is this Scenaria's version. Never throws. */
export function checkExportPath(path: string, version: string): PackageCheck {
  let file = path;
  const copies: PackageCheck["copies"] = [];
  const fail = (problem: string): PackageCheck => ({ valid: false, problem, file, package: false, copies });
  try {
    const st = lstatSync(path);
    if (st.isDirectory()) file = join(path, PACKAGE_EVIDENCE);
    else if (!st.isFile()) return fail("not a plain file");
  } catch {
    return fail("no such file");
  }
  if (!isFile(file)) return fail("not a plain file (or no audit-file.json in the folder)");
  try {
    if (statSync(file).size > MAX_EXPORT_BYTES) return fail("too large");
    let text: string;
    try {
      text = utf8(readFileSync(file));
    } catch {
      return fail("not valid UTF-8 (I-JSON requires it)");
    }
    const r = verifyAuditExport(text);
    const isPackage = basename(file) === PACKAGE_EVIDENCE;
    let noteName: string | null = null;
    let copiesProblem = false;
    let copiesMissing = false;
    // Reading copies of a package: rendered again from the verified evidence and compared byte for byte (C4b-1).
    if (r.valid && isPackage) {
      const x = JSON.parse(text) as AuditExport;
      const sameVersion = x.context?.scenariaVersion === version;
      // The person's signature over the copies' hashes (same key as the evidence) decides, whatever the version.
      let signedCopies: Record<string, string> | null = null;
      let signedLang: "de" | "en" | undefined;
      const cp = join(dirname(file), PACKAGE_COPIES);
      let cpPresent = false;
      try {
        lstatSync(cp);
        cpPresent = true;
      } catch {}
      if (cpPresent && (!isFile(cp) || statSync(cp).size >= 64 * 1024)) copiesProblem = true;
      // Every package written by Scenaria 0.9.10 or later carries the copies signature: missing means removed.
      if (!cpPresent && atLeast(x.context?.scenariaVersion, [0, 9, 10])) copiesMissing = true;
      if (cpPresent && isFile(cp) && statSync(cp).size < 64 * 1024) {
        try {
          const c = parseStrictJson(readFileSync(cp, "utf8")) as any;
          const h = c?.copies?.["audit-file.html"];
          const m = c?.copies?.["audit-file.md"];
          const sigNote = c?.lang === "de" || c?.lang === "en" ? PACKAGE_NOTES[c.lang as "de" | "en"] : "";
          const n = c?.version === 2 ? c?.copies?.[sigNote] : undefined;
          const okShape =
            c?.kind === "scenaria/audit-copies" &&
            (c.version === 1 || (c.version === 2 && /^[0-9a-f]{64}$/.test(n))) &&
            c.digest === x.signature.digest &&
            (c.lang === "de" || c.lang === "en") &&
            /^[0-9a-f]{64}$/.test(h) &&
            /^[0-9a-f]{64}$/.test(m) &&
            typeof c.sig === "string";
          const ok =
            okShape &&
            edVerify(null, Buffer.from(copiesSignedText(x.signature.projectId, x.signature.digest, c.lang, h, m, n)), createPublicKey({ key: Buffer.from(x.signature.pub, "base64"), format: "der", type: "spki" }), Buffer.from(c.sig, "base64"));
          signedCopies = ok ? { "audit-file.html": h, "audit-file.md": m, ...(n ? { [sigNote]: n } : {}) } : null;
          if (ok) signedLang = c.lang;
          if (!ok) copiesProblem = true;
        } catch {
          copiesProblem = true;
        }
      }
      const renders = {
        "audit-file.html": [renderAuditHtml(x, "de"), renderAuditHtml(x, "en")],
        "audit-file.md": [renderAuditMarkdown(x, "de"), renderAuditMarkdown(x, "en")],
      } as Record<string, string[]>;
      // The note on checking (C5, S-K5): the one the signature names, else the one that is there.
      // The package's language: from the copies signature (v1 and v2), else the one note that is there. The note of
      // the other language is not the package's: it is listed as a file Scenaria did not write (C5 review R2).
      const notes = Object.entries(PACKAGE_NOTES) as ["de" | "en", string][];
      const present = notes.filter(([, nm]) => isFile(join(dirname(file), nm)));
      const lang = signedLang ?? (present.length === 1 ? present[0][0] : undefined);
      if (lang) {
        noteName = PACKAGE_NOTES[lang];
        renders[noteName] = [renderPackageReadme(x, lang)];
      } else if (present.length > 1) {
        noteName = null; // two notes, no signature to tell: neither is checked, both are listed
      } else if (atLeast(x.context?.scenariaVersion, [0, 9, 10])) copies.push({ name: `${PACKAGE_NOTES.de} / ${PACKAGE_NOTES.en}`, state: "missing" });
      for (const name of Object.keys(renders)) {
        const p = join(dirname(file), name);
        if (!isFile(p)) {
          copies.push({ name, state: "missing" });
          continue;
        }
        if (statSync(p).size > MAX_EXPORT_BYTES) {
          copies.push({ name, state: "different" });
          continue;
        }
        const bytes = readFileSync(p);
        const signedHash = signedCopies?.[name];
        if (signedHash) copies.push({ name, state: sha256(bytes) === signedHash ? "same" : "different" });
        else copies.push({ name, state: renders[name].some((t) => Buffer.from(t, "utf8").equals(bytes)) ? "same" : sameVersion ? "different" : "not_comparable" });
      }
    }
    let extra: string[] = [];
    if (isPackage) {
      try {
        extra = readdirSync(dirname(file)).filter((n) => !PACKAGE_FILES.has(n) && n !== noteName && n !== ".DS_Store").sort();
      } catch {}
    }
    return { ...r, file, package: isPackage, copies, ...(extra.length ? { extra } : {}), ...(copiesProblem ? { copiesSignature: "invalid" as const } : copiesMissing ? { copiesSignature: "missing" as const } : {}) };
  } catch (err: any) {
    return fail(`cannot be read (${String(err?.message ?? err).slice(0, 80)})`);
  }
}
