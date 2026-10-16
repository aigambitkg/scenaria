/**
 * Batch C4b: the print-ready page of a signed audit file (Kev's decision 2026-10-16: the PDF is made by the
 * browser — "Print → Save as PDF" — from this page; no PDF library).
 *
 * The page is a reading copy: every printed page carries the fingerprint of the signed JSON in its footer,
 * and the page says that only the JSON is the evidence. It is self-contained (no scripts, no external files,
 * a Content-Security-Policy that forbids loading anything), and every recorded text is HTML-escaped.
 */
import { ANNEX_A_AREAS, COVERAGE_LABEL, EVIDENCE_SOURCES, type Lang2 } from "./iso42001.js";
import type { AuditExport } from "./auditexport.js";

/** HTML text: escaped, without control or direction characters, on one line. */
const esc = (x: unknown) =>
  String(x ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string | null | undefined) => (iso ? `${esc(String(iso).replace("T", " ").slice(0, 16))} UTC` : "—");

const CSS = `
:root{--ink:#1b1d21;--muted:#5d6470;--line:#d9dde3;--soft:#f4f6f8;--ok:#1f7a4d;--okbg:#e6f4ec;--warn:#8a5a00;--warnbg:#fff4dc;--bad:#a8261b;--badbg:#fde8e6;--accent:#2b4a7a}
*{box-sizing:border-box}
html{background:#fff}
body{margin:0 auto;max-width:980px;padding:28px 24px 64px;color:var(--ink);background:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:15px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line);break-after:avoid}
h3{font-size:13px;margin:16px 0 6px;color:var(--accent);break-after:avoid}
p{margin:6px 0}
.sub{color:var(--muted);margin:0 0 14px}
.fp{border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--soft);padding:10px 12px;margin:12px 0;font-size:12px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all}
td{overflow-wrap:anywhere}
td.fix,td .fixw{overflow-wrap:normal}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
th,td{text-align:left;vertical-align:top;padding:5px 6px;border-bottom:1px solid var(--line);overflow-wrap:break-word}
table.data{table-layout:fixed}
p,li,.state,.fp,.sub,h1{overflow-wrap:anywhere}
th,td.fix{overflow-wrap:normal;hyphens:manual}
.fixw{white-space:nowrap}
.foot .mono{flex-shrink:0}
th{background:var(--soft);font-weight:600}
thead{display:table-header-group}
tr{break-inside:avoid}
tr.area td{background:#fff;font-weight:600;color:var(--accent);padding-top:12px;border-bottom:1px solid var(--accent)}
.meta td:first-child{width:28%;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0}
.stat{border:1px solid var(--line);border-radius:6px;padding:8px 10px}
.stat b{display:block;font-size:20px}
.stat span{color:var(--muted);font-size:11.5px}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;white-space:nowrap;border:1px solid transparent}
.b-partly{background:var(--okbg);color:var(--ok)}
.b-not_covered{background:var(--warnbg);color:var(--warn)}
.b-organisational{background:var(--soft);color:var(--muted);border-color:var(--line)}
.b-evidenced{background:var(--okbg);color:var(--ok)}
.b-doc{background:var(--okbg);color:var(--ok)}
.b-unconfirmed{background:var(--warnbg);color:var(--warn)}
.b-alarm{background:var(--badbg);color:var(--bad)}
.state{padding:10px 12px;border-radius:6px;margin:8px 0;font-weight:600}
.state.ok{background:var(--okbg);color:var(--ok)}
.state.notes{background:var(--warnbg);color:var(--warn)}
.state.alarm{background:var(--badbg);color:var(--bad)}
ul{margin:6px 0;padding-left:20px}
li{margin:3px 0}
.muted{color:var(--muted)}
.foot{margin-top:24px;padding:5px 0 0;border-top:1px solid var(--line);color:var(--muted);font-size:10px;display:flex;justify-content:space-between;gap:12px;white-space:nowrap}
.foot span{overflow:hidden;text-overflow:ellipsis}
.printhint{border:1px dashed var(--accent);border-radius:6px;padding:8px 12px;margin:0 0 16px;color:var(--accent)}
@page{size:A4;margin:16mm 13mm 20mm}
table.sheet{width:100%;table-layout:fixed;border-collapse:collapse;margin:0;font-size:inherit}table.sheet>tbody>tr>td,table.sheet>tfoot>tr>td{padding:0;border:0;overflow-wrap:normal}
table.sheet>tfoot{display:table-footer-group}
@media print{body{max-width:none;padding:0;font-size:11px}.printhint{display:none}.foot{margin-top:8px;padding-top:3px}h2{break-after:avoid}a{color:inherit;text-decoration:none}}
`;

/** The print-ready page (DE or EN). */
export function renderAuditHtml(x: AuditExport, lang: "de" | "en" = "de"): string {
  const L = (t: Lang2) => t[lang];
  const T = (de: string, en: string) => (lang === "de" ? de : en);
  const f = x.file;
  const s = x.signature;
  const fpShort = `${s.digest.slice(0, 16)}…${s.digest.slice(-8)}`;
  const h: string[] = [];
  h.push(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`);
  h.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
  h.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  h.push(`<meta name="scenaria-fingerprint" content="sha256:${esc(s.digest)}">`);
  h.push(`<title>${T("Prüfakte", "Audit file")} – ${esc(f.project.name)} – ${esc(s.digest.slice(0, 8))}</title><style>${CSS}</style></head><body>`);
  // The whole page sits in one table whose footer row — the fingerprint line — repeats on every printed page
  // in every browser (review C4b-4); fixed width, so a long word wraps instead of widening the page (C4b-2).
  const foot = `<div class="foot"><span>${T("Prüfakte", "Audit file")} ${esc(f.project.name)} · ${T("Lesekopie", "Reading copy")}</span><span class="mono">sha256:${esc(fpShort)} · ${T("Schlüssel", "key")} ${esc(s.keyId)}</span></div>`;
  h.push(`<table class="sheet"><tfoot><tr><td>${foot}</td></tr></tfoot><tbody><tr><td>`);
  h.push(`<div class="printhint">${T("Als PDF sichern: im Browser „Drucken“ wählen und „Als PDF sichern“ (bzw. „Microsoft Print to PDF“). Dieser Hinweis wird nicht gedruckt.", "Save as PDF: choose “Print” in the browser, then “Save as PDF”. This note is not printed.")}</div>`);
  h.push(`<h1>${T("ISO/IEC 42001 Prüfakte", "ISO/IEC 42001 audit file")} — ${esc(f.project.name)}</h1>`);
  h.push(`<p class="sub">${esc(f.standard)} · ${T("Anhang A", "Annex A")} · ${f.catalogue.controls} ${T("Kontrollen", "controls")}</p>`);
  h.push(`<div class="fp"><b>${T("Fingerabdruck", "Fingerprint")}</b>: <code>sha256:${esc(s.digest)}</code><br><b>${T("Schlüssel", "Key")}</b>: <code>${esc(s.keyId)}</code> · <b>${T("Projekt", "Project")}</b>: <code>${esc(s.projectId)}</code><br>${T("Dies ist eine Lesekopie. Beweisstück ist die signierte Datei <code>audit-file.json</code> mit demselben Fingerabdruck.", "This is a reading copy. The evidence is the signed file <code>audit-file.json</code> with the same fingerprint.")}</div>`);
  h.push(`<table class="meta"><tbody>`);
  h.push(`<tr><td>${T("Zeitraum", "Period")}</td><td>${f.period.whole ? T("das ganze Projekt", "the whole project") : `${when(f.period.from)} – ${when(f.period.to)}`} · ${f.period.steps} ${T("Schritte", "steps")}</td></tr>`);
  h.push(`<tr><td>${T("Erstellt", "Generated")}</td><td>${when(x.context.generatedAt)} · Scenaria ${esc(x.context.scenariaVersion)}</td></tr>`);
  h.push(`<tr><td>${T("Hash-Kette", "Hash chain")}</td><td>${x.context.ledger.lines} ${T("Einträge", "entries")} · ${T("Kopf", "head")} <code>${esc(x.context.ledger.head ?? "—")}</code></td></tr>`);
  h.push(`<tr><td>${T("Katalog", "Catalogue")}</td><td><code>${esc(f.catalogue.hash)}</code></td></tr>`);
  h.push(`<tr><td>${T("Personen", "People")}</td><td>${x.names === "roles-only" ? T("nur Rollen (Namen weggelassen)", "roles only (names left out)") : T("mit Namen", "with names")}</td></tr>`);
  h.push(`</tbody></table>`);
  h.push(`<p><b>${T("Was die Signatur bedeutet", "What the signature means")}:</b> ${esc(L(x.context.meaning))}</p>`);
  h.push(`<p class="muted"><b>${T("Geltungsbereich", "Scope")}:</b> ${esc(L(f.scope))}</p>`);

  h.push(`<h2>${T("Manipulationsnachweis", "Tamper evidence")}</h2>`);
  h.push(`<div class="state ${esc(f.integrity.state)}">${esc(L(f.integrity.headline))}</div>`);
  if (f.integrity.warnings.length) {
    h.push(`<ul>`);
    for (const w of f.integrity.warnings) {
      h.push(`<li>${w.level === "alarm" ? `<span class="badge b-alarm">${T("Alarm", "Alarm")}</span> ` : ""}<b>${esc(L(w.title))}</b>${w.count > 1 ? ` (${w.count})` : ""}: ${esc(L(w.explain))}${w.items.length ? ` <span class="muted">— ${esc(w.items.slice(0, 12).join(", "))}${w.items.length > 12 ? ", …" : ""}</span>` : ""}</li>`);
    }
    h.push(`</ul>`);
  }
  h.push(`<p class="muted">${esc(L(f.integrity.note))}</p>`);

  h.push(`<h2>${T("Übersicht", "Summary")}</h2><div class="stats">`);
  const stat = (n: number, label: string) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  h.push(stat(f.summary.partly, T("teilweise belegt", "partly evidenced")));
  h.push(stat(f.summary.not_covered, T("nicht abgedeckt", "not covered")));
  h.push(stat(f.summary.organisational, T("Nachweis durch die Organisation", "evidence by the organisation")));
  h.push(stat(f.summary.orgDocumented, T("Dokumente der Organisation eingetragen", "organisation's documents recorded")));
  h.push(`</div>`);
  if (f.summary.withAlarm) h.push(`<p><span class="badge b-alarm">${f.summary.withAlarm} ${T("Kontrollen mit Alarm", "controls with an alarm")}</span></p>`);

  h.push(`<h2>${T("Kontrollen", "Controls")}</h2>`);
  h.push(`<table class="data"><colgroup><col style="width:9%"><col style="width:29%"><col style="width:22%"><col style="width:16%"><col style="width:24%"></colgroup><thead><tr><th>${T("Kontrolle", "Control")}</th><th>${T("Titel", "Title")}</th><th>${T("Status aus den Aufzeichnungen", "Status from the records")}</th><th>${T("Dokument der Organisation", "Organisation's document")}</th><th>${T("Hinweise", "Notes")}</th></tr></thead><tbody>`);
  for (const a of ANNEX_A_AREAS) {
    const cs = f.controls.filter((c) => c.area === a.id);
    if (!cs.length) continue;
    h.push(`<tr class="area"><td colspan="5">${esc(a.id)} · ${esc(L(a.title))}</td></tr>`);
    for (const c of cs) {
      const org = c.orgEvidence.state === "documented" ? `<span class="badge b-doc">${T("eingetragen", "recorded")}</span>` : c.orgEvidence.state === "unconfirmed" ? `<span class="badge b-unconfirmed">${T("nicht bestätigt", "not confirmed")}</span>` : `<span class="muted">—</span>`;
      const notes = [
        c.missing.length ? `${T("keine Daten", "no data")}: ${c.missing.map((m) => L(EVIDENCE_SOURCES[m].label)).join(", ")}` : "",
        c.warnings.length ? c.warnings.join(", ") : "",
      ].filter(Boolean);
      h.push(`<tr><td class="fix"><b>${esc(c.id)}</b></td><td>${esc(L(c.title))}</td><td><span class="badge b-${esc(c.status)}">${esc(L(COVERAGE_LABEL[c.status]))}</span>${c.alarm ? ` <span class="badge b-alarm">${T("Alarm", "Alarm")}</span>` : ""}</td><td>${org}</td><td class="muted">${esc(notes.join("; "))}</td></tr>`);
    }
  }
  h.push(`</tbody></table>`);

  const docs = f.controls.flatMap((c) => c.orgEvidence.entries.map((e) => ({ c, e })));
  h.push(`<h2>${T("Dokumente der Organisation", "The organisation's documents")}</h2>`);
  if (!docs.length) h.push(`<p class="muted">${T("Keine eingetragen.", "None recorded.")}</p>`);
  else {
    h.push(`<table class="data"><colgroup><col style="width:9%"><col style="width:35%"><col style="width:17%"><col style="width:11%"><col style="width:14%"><col style="width:14%"></colgroup><thead><tr><th>${T("Kontrolle", "Control")}</th><th>${T("Dokument", "Document")}</th><th>${T("Verantwortlich", "Owner")}</th><th>${T("Datum", "Date")}</th><th>${T("gilt", "in force")}</th><th>${T("Stand", "State")}</th></tr></thead><tbody>`);
    for (const { c, e } of docs) {
      const state = e.counts ? (e.catalogueChanged ? T("signiert, Kontrolle neu gefasst", "signed, control re-worded") : T("signiert", "signed")) : `${T("zählt nicht", "does not count")} (${e.trust})`;
      // The link is shown as text, never as a clickable link: what is printed is what was signed.
      h.push(`<tr><td class="fix"><b>${esc(c.id)}</b></td><td>${e.title ? `${esc(e.title)}<br>` : ""}<span class="mono">${esc(e.url)}</span><br><span class="mono muted">${esc(e.hash)}</span></td><td>${esc(e.owner.role)}${e.owner.name ? `<br>${esc(e.owner.name)}` : ""}</td><td class="fix"><span class="fixw">${esc(e.date)}</span></td><td>${when(e.activeFrom)}${e.removedAt ? `<br>– ${when(e.removedAt)}` : ""}</td><td><span class="fixw">${esc(state)}</span>${e.copiedFrom ? `<br><span class="muted">${T("übernommen aus", "taken over from")} ${esc(e.copiedFrom)}</span>` : ""}</td></tr>`);
    }
    h.push(`</tbody></table>`);
  }

  h.push(`<h2>${T("Signierte Freigaben und Entscheidungen im Zeitraum", "Signed approvals and decisions in the period")}</h2>`);
  if (!f.approvals.length) h.push(`<p class="muted">${T("Keine.", "None.")}</p>`);
  else {
    h.push(`<table class="data"><colgroup><col style="width:15%"><col style="width:10%"><col style="width:21%"><col style="width:11%"><col style="width:16%"><col style="width:13%"><col style="width:14%"></colgroup><thead><tr><th>${T("Zeit", "Time")}</th><th>${T("Art", "Kind")}</th><th>${T("Bezug", "Ref")}</th><th>${T("Aktion", "Action")}</th><th>${T("von", "by")}</th><th>${T("Weg", "via")}</th><th>${T("zählt als Freigabe", "counts as approval")}</th></tr></thead><tbody>`);
    for (const a of f.approvals) {
      h.push(`<tr><td>${when(a.at)}</td><td class="fix">${esc(a.kind)}</td><td>${esc(a.ref)}</td><td>${esc(a.action)}</td><td>${esc(a.by)}${a.unsigned.includes("by") ? "*" : ""}</td><td>${esc(a.via)}${a.unsigned.includes("via") ? "*" : ""}</td><td class="fix">${a.carries ? T("ja", "yes") : T("nein", "no")}</td></tr>`);
    }
    h.push(`</tbody></table><p class="muted">* ${T("nicht von der Signatur gedeckt (wie aufgezeichnet)", "not covered by the signature (as recorded)")}</p>`);
  }

  if (f.verdictHistory.length) {
    h.push(`<h2>${T("Prüfurteile mit Verlauf", "Verdicts with history")}</h2><ul>`);
    for (const v of f.verdictHistory) {
      h.push(
        `<li><b>${esc(v.node)}</b>: ${v.current ? `${T("jetzt", "now")} ${esc(v.current.status)} (${esc(v.current.origin)}, ${when(v.current.at)}${v.current.counts ? `, ${T("zählt", "counts")}` : ""})` : "—"}${v.earlier.length ? `; ${T("früher", "earlier")}: ${v.earlier.map((e) => `${esc(e.status)} (${esc(e.origin)}, ${when(e.at)}, ${esc(e.signature)})`).join("; ")}` : ""}${v.stepChanged ? ` <span class="badge b-alarm">${T("Schritt außerhalb von Scenaria geändert", "step changed outside Scenaria")}</span>` : ""}<br><span class="muted">${T("Schritt", "Step")}: „${esc(v.title)}“</span></li>`,
      );
    }
    h.push(`</ul>`);
  }

  h.push(`<h2>${T("Neu-Versiegelungen", "Reseals")}</h2>`);
  if (!f.reseals.authentic.length && !f.reseals.unproven.length) h.push(`<p class="muted">${T("Keine.", "None.")}</p>`);
  else {
    h.push(`<ul>${f.reseals.authentic.map((r) => `<li>${esc(r.id)}: ${when(r.at)}, ${esc(r.kind)} (${esc(r.by)})</li>`).join("")}${f.reseals.unproven.length ? `<li><span class="badge b-alarm">${T("ohne Nachweis", "without proof")}</span> ${esc(f.reseals.unproven.join(", "))}</li>` : ""}</ul>`);
  }

  h.push(`<h2>${T("So prüfen Sie die Akte", "How to check this audit file")}</h2><ol>`);
  h.push(`<li>${T("Mit Scenaria (ohne Projekt): <code>scenaria audit-file verify audit-file.json</code> – prüft Inhalt und Signatur; im Ordner des Prüfpakets genügt <code>scenaria audit-file verify</code>.", "With Scenaria (no project needed): <code>scenaria audit-file verify audit-file.json</code> – checks content and signature; inside the audit package folder <code>scenaria audit-file verify</code> is enough.")}</li>`);
  h.push(`<li>${T("Ohne Scenaria: den Inhalt ohne <code>signature</code> nach RFC 8785 (JCS) serialisieren, SHA-256 bilden und mit <code>signature.digest</code> vergleichen; den signierten Text selbst bilden: <code>[\"&lt;projectId&gt;\",\"audit-export/v1\",\"&lt;digest&gt;\"]</code>; die Ed25519-Signatur mit <code>signature.pub</code> prüfen (z. B. <code>openssl pkeyutl -verify -rawin -pubin</code>).", "Without Scenaria: serialise the content without <code>signature</code> per RFC 8785 (JCS), compute SHA-256 and compare with <code>signature.digest</code>; build the signed text yourself: <code>[\"&lt;projectId&gt;\",\"audit-export/v1\",\"&lt;digest&gt;\"]</code>; check the Ed25519 signature with <code>signature.pub</code> (e.g. <code>openssl pkeyutl -verify -rawin -pubin</code>).")}</li>`);
  h.push(`<li>${T(`Die Schlüsselkennung <code>${esc(s.keyId)}</code> mit der Person auf einem zweiten Weg bestätigen (z. B. telefonisch).`, `Confirm the key id <code>${esc(s.keyId)}</code> with the person over a second channel (e.g. by phone).`)}</li>`);
  h.push(`<li>${T("Diese Seite und die PDF sind Lesekopien: Sie tragen in der Fußzeile jeder Seite denselben Fingerabdruck wie die JSON-Datei.", "This page and the PDF are reading copies: the footer of every page carries the same fingerprint as the JSON file.")}</li>`);
  h.push(`</ol>`);
  h.push(`</td></tr></tbody></table>`);
  h.push(`</body></html>`);
  return h.join("\n");
}

/** The note that travels with the package: what is in it and how to check it (plain text, DE or EN). */
export function renderPackageReadme(x: AuditExport, lang: "de" | "en" = "de"): string {
  const s = x.signature;
  const T = (de: string, en: string) => (lang === "de" ? de : en);
  const one = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return [
    T("PRÜFPAKET – ISO/IEC 42001 Prüfakte", "AUDIT PACKAGE – ISO/IEC 42001 audit file"),
    "",
    `${T("Projekt", "Project")}: ${one(x.file.project.name)} (${s.projectId})`,
    `${T("Erstellt", "Generated")}: ${x.context.generatedAt} · Scenaria ${one(x.context.scenariaVersion)}`,
    `${T("Fingerabdruck", "Fingerprint")}: sha256:${s.digest}`,
    `${T("Schlüsselkennung", "Key id")}: ${s.keyId}  ← ${T("auf einem zweiten Weg mit der Person bestätigen", "confirm with the person over a second channel")}`,
    `${T("Personen", "People")}: ${x.names === "roles-only" ? T("nur Rollen", "roles only") : T("mit Namen", "with names")}`,
    "",
    T("Inhalt:", "Contents:"),
    `  audit-file.json  ${T("das Beweisstück (signiert)", "the evidence (signed)")}`,
    `  audit-file.html  ${T("Lesekopie zum Drucken; PDF: im Browser „Drucken → Als PDF sichern“", "reading copy to print; PDF: in the browser “Print → Save as PDF”")}`,
    `  audit-file.md    ${T("Lesekopie als Text", "reading copy as text")}`,
    `  audit-file.copies.json  ${T("die Signatur der Person über die beiden Lesekopien", "the person's signature over both reading copies")}`,
    "",
    T("Prüfen:", "Check:"),
    `  scenaria audit-file verify ${T("   (in diesem Ordner)", "   (in this folder)")}`,
    `  ${T("Ohne Scenaria: siehe Abschnitt „So prüfen Sie die Akte“ in audit-file.html.", "Without Scenaria: see “How to check this audit file” in audit-file.html.")}`,
    "",
    T(
      "Die Signatur bedeutet: Scenaria hat die Akte zu diesem Zeitpunkt aus diesen Aufzeichnungen berechnet, und die Person mit diesem Schlüssel hat sie herausgegeben. Sie beweist nicht jede einzelne Tatsache.",
      "The signature means: Scenaria computed the audit file at that time from these records, and the person holding this key released it. It does not prove every single fact.",
    ),
    "",
  ].join("\n");
}
