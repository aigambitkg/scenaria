// Batch E1a: every number with its derivation (Kev's decision 2026-10-17). The value is computed by the formula
// from the inputs; anyone can recompute it. These tests recompute every derivation Scenaria hands out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { projectMetrics } from "../dist/core/analysis.js";
import { buildAuditFile } from "../dist/core/auditfile.js";
import { exportAuditFile, verifyAuditExport } from "../dist/core/auditexport.js";
import { FORMULAS, derive, countOf, recompute, fidelityCombine, expand, compact } from "../dist/core/derivation.js";
import { combine } from "../dist/core/fidelity.js";
import { tempProject } from "./helpers.mjs";

const ROOT = join(import.meta.dirname, "..");

function project() {
  const p = tempProject("deriv-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small invoice API with tests and docs", title: "Build the invoice API", goal: "Endpoints for invoices, with tests" });
  s.decide({ question: "Which framework for the invoice API?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "faster and typed", context: "new API", servesGoal: "small invoice API", confidence: 0.8, agent: "codex" });
  p.write("a.txt", "2");
  s.checkpoint({ title: "Invoice endpoints with tests", outputs: ["`a.txt`"], agent: "codex", irreversible: ["sent a mail"] });
  s.decide({ question: "Database?", options: ["SQLite", "Postgres"], agent: "codex" }); // open, no rationale
  s.checkpoint({ title: "Unrelated: holiday photos sorted", outputs: ["x"], agent: "codex" });
  return { p, s };
}

const shape = (d, key) => {
  assert.equal(typeof d.key, "string", key);
  assert.ok(FORMULAS[d.formula], `${key}: known formula ${d.formula}`);
  assert.match(d.formula, /^[a-z]+\/\d+$/, `${key}: formula with version`);
  assert.ok(d.expression.de && d.expression.en, `${key}: expression DE/EN`);
  assert.ok(d.sentence.de && d.sentence.en, `${key}: sentence DE/EN`);
  assert.ok(Array.isArray(d.inputs) && d.inputs.every((i) => i.name && i.label?.de && i.label?.en), `${key}: labelled inputs`);
  assert.equal(recompute(d), d.value, `${key}: recomputes to its value`);
};

test("E1a: the derivation module has no imports (shared with the dashboard)", () => {
  const src = readFileSync(join(ROOT, "src/core/derivation.ts"), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
});

test("E1a: every context-fidelity score is its derivation's value and recomputes from its inputs", () => {
  const { s } = project();
  const pts = Object.values(s.fidelity().points);
  assert.ok(pts.length >= 6);
  for (const p of pts) {
    assert.equal(recompute(p.why), p.score, `${p.id}: the short form recomputes`);
    const full = expand(p.why);
    shape(full, p.id);
    assert.equal(full.formula, "fidelity/1");
    assert.equal(full.value, p.score, p.id);
  }
  // The shared formula is the one the forecast uses too.
  assert.equal(combine(0.5, 0.4, 1, 0.8), fidelityCombine(0.5, 0.4, 1, 0.8));
  // A root step is 100; a step changed outside Scenaria is capped at 25.
  const root = pts.find((p) => p.id === "n0");
  assert.equal(root.score, 100);
  assert.equal(derive("x", "fidelity/1", { anchor: 1, continuity: 1, integrity: 0, epistemic: 1, tampered: true, canonBroken: false, root: false }).value, 25);
  assert.equal(derive("x", "fidelity/1", { anchor: 1, continuity: 1, integrity: 1, epistemic: 1, tampered: false, canonBroken: true, root: false }).value, 40);
});

test("E1a: the health score and every count of the project check recompute from their inputs", () => {
  const { s } = project();
  const m = projectMetrics(s);
  shape(m.why.health, "health");
  assert.equal(m.why.health.value, m.health);
  assert.ok(m.health < 100, "the open decision and decision quality deduct something");
  assert.match(m.why.health.sentence.de, /^\d+ von 100 = 100 − /);
  for (const [k, v] of Object.entries(m.counts)) {
    const d = m.why.counts[k];
    assert.ok(d, `derivation for count ${k}`);
    shape(d, k);
    assert.equal(d.value, v, k);
  }
  assert.equal(m.counts.irreversible, 1);
  assert.deepEqual(m.why.counts.irreversible.inputs.find((i) => i.name === "items").value, ["n3#1"]);
  assert.equal(m.counts.openDecisions, 1);
});

test("E1a: the health formula is the one the project check always used", () => {
  // Kept equal to the code before E1 (analysis.ts), term by term.
  const old = (o) => {
    let h = 100;
    if (o.goalMissing) h -= 20;
    h -= Math.min(40, o.tamper * 20);
    h -= Math.min(30, o.canon * 15);
    h -= Math.min(25, Math.round((1 - o.quality) * 40));
    h -= Math.min(30, o.builtOnFailure * 15);
    h -= Math.min(10, o.openDecisions * 2);
    h -= Math.min(10, o.lowConfidence * 3);
    h -= Math.min(5, o.manyBranches * 2);
    return Math.max(0, Math.min(100, h));
  };
  const cases = [
    { goalMissing: false, tamper: 0, canon: 0, quality: 1, builtOnFailure: 0, openDecisions: 0, lowConfidence: 0, manyBranches: 0 },
    { goalMissing: true, tamper: 3, canon: 1, quality: 0.5, builtOnFailure: 1, openDecisions: 7, lowConfidence: 2, manyBranches: 4 },
    { goalMissing: false, tamper: 1, canon: 0, quality: 0.83, builtOnFailure: 0, openDecisions: 2, lowConfidence: 1, manyBranches: 0 },
  ];
  for (const c of cases) assert.equal(derive("health", "health/1", c).value, old(c), JSON.stringify(c));
});

test("E1a: the audit file's summary carries a derivation per number; the signed export keeps them checkable", () => {
  const { s } = project();
  const f = buildAuditFile(s);
  const keys = ["controls", "partly", "organisational", "not_covered", "evidenced", "withAlarm", "withNotes", "orgDocumented"];
  for (const k of keys) {
    const d = f.derivations[`summary.${k}`];
    assert.ok(d, k);
    shape(d, k);
    assert.equal(d.value, f.summary[k], k);
    // The listed items are exactly the controls counted.
    const items = d.inputs.find((i) => i.name === "items").value;
    assert.ok(items.every((id) => f.controls.some((c) => c.id === id)), k);
  }
  assert.equal(f.derivations["summary.controls"].value, 38);
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  assert.equal(verifyAuditExport(JSON.stringify(x)).valid, true);
  for (const d of Object.values(x.file.derivations)) assert.equal(recompute(d), d.value);
});

test("E1a: a changed derivation no longer recomputes to its value", () => {
  const d = countOf("x", ["A.2.2", "A.2.3"], { de: "Test", en: "test" });
  assert.equal(recompute(d), 2);
  const forged = JSON.parse(JSON.stringify(d));
  forged.value = 5;
  assert.notEqual(recompute(forged), forged.value);
  assert.equal(recompute({ ...d, formula: "unknown/9" }), null);
});

test("E1a: fidelity scores are unchanged by the derivation (same as the plain formula)", () => {
  const { p, s } = project();
  // Hand-edit one step: tampered → capped.
  const f = join(p.dir, ".scenaria/nodes/n3.json");
  const n = JSON.parse(readFileSync(f, "utf8"));
  n.title = "edited";
  writeFileSync(f, JSON.stringify(n));
  const t = Scenaria.open(p.dir);
  const pt = t.fidelity().points.n3;
  assert.ok(pt.score <= 25);
  assert.equal(pt.why.inputs.tampered, true);
  assert.equal(recompute(pt.why), pt.score);
  void s;
});

// ------------------------------------------------------------------ review of E1a (K1–K6)

test("E1a K1: a hand-edited field of the wrong type never breaks the project check or the fidelity", async () => {
  for (const bad of [5, "sent a mail", { a: 1 }]) {
    const { p } = project();
    const f = join(p.dir, ".scenaria/nodes/n3.json");
    const n = JSON.parse(readFileSync(f, "utf8"));
    n.irreversible = bad;
    n.outputs = bad;
    writeFileSync(f, JSON.stringify(n));
    const s = Scenaria.open(p.dir);
    const m = projectMetrics(s);
    assert.equal(m.counts.irreversible, 0, JSON.stringify(bad));
    assert.equal(recompute(m.why.health), m.health);
    assert.ok(s.fidelity().points.n3, "fidelity still computed");
    assert.ok(!buildAuditFile(s).integrity.warnings.some((w) => w.code === "evaluation_failed"), "no evaluation_failed");
  }
});

test("E1a K2/K3: the sentence matches the number for a changed project start and without a goal", () => {
  const root = derive("x", "fidelity/1", { anchor: 1, continuity: 1, integrity: 0, epistemic: 1, tampered: true, canonBroken: false, root: true });
  assert.equal(root.value, 25);
  assert.match(root.sentence.de, /außerhalb von Scenaria geändert/);
  assert.doesNotMatch(root.sentence.de + root.sentence.en, /voller Bezug|fully connected/);
  // Without a goal: the weights named in the sentence give the value.
  const v = { anchor: null, continuity: 0.4, integrity: 1, epistemic: 0.8, tampered: false, canonBroken: false, root: false };
  const d = derive("x", "fidelity/1", v);
  assert.match(d.sentence.de, /54\/23\/23/);
  assert.equal(d.value, Math.round(100 * (0.35 * 0.4 + 0.15 * 1 + 0.15 * 0.8) / 0.65));
  assert.doesNotMatch(d.sentence.de, /aus ohne/);
});

test("E1a K4: the health sentence says when the score is kept at 0", () => {
  const d = derive("health", "health/1", { goalMissing: true, tamper: ["a", "b", "c"], canon: ["x", "y"], quality: 0, builtOnFailure: ["s", "t"], openDecisions: [], lowConfidence: [], manyBranches: [] });
  assert.equal(d.value, 0);
  assert.match(d.sentence.de, /= -45, begrenzt auf 0/);
  assert.match(d.sentence.en, /= -45, kept at 0/);
});

test("E1a K5: recompute never throws and is not fooled by crafted derivations", () => {
  assert.equal(recompute(null), null);
  assert.equal(recompute({ formula: "constructor", inputs: [] }), null);
  assert.equal(recompute({ formula: "toString", inputs: {} }), null);
  const crafted = JSON.parse('{"key":"x","value":5,"formula":"count/1","inputs":[{"name":"__proto__","value":{"items":[1,2,3,4,5]}}]}');
  assert.equal(recompute(crafted), 0, "an input the formula does not know is ignored");
  assert.equal(expand({ formula: "valueOf", inputs: {} }), null);
});

test("E1a K6: the fidelity of each step travels in the short form; expanding it adds the texts", () => {
  const { s } = project();
  const pts = Object.values(s.fidelity().points);
  for (const p of pts) {
    assert.equal(p.why.expression, undefined, "no texts per step");
    assert.ok(JSON.stringify(p.why).length < 400, `${p.id}: short (${JSON.stringify(p.why).length} bytes)`);
    assert.deepEqual(compact(expand(p.why)), p.why);
  }
});

test("E1a: the health inputs list the findings they count, so they can be recounted", () => {
  const { p } = project();
  const f = join(p.dir, ".scenaria/nodes/n3.json");
  const n = JSON.parse(readFileSync(f, "utf8"));
  n.title = "edited by hand";
  writeFileSync(f, JSON.stringify(n));
  const m = projectMetrics(Scenaria.open(p.dir));
  const tamper = m.why.health.inputs.find((i) => i.name === "tamper").value;
  assert.ok(Array.isArray(tamper) && tamper.includes("tampered: n3"), JSON.stringify(tamper));
  assert.deepEqual(m.why.health.inputs.find((i) => i.name === "openDecisions").value, m.why.counts.openDecisions.inputs.find((i) => i.name === "items").value);
});

// ------------------------------------------------------------------ E1b: the derivation in the dashboard and the exports

test("E1b: 'How computed?' opens on hover (sentence), tap/click and keyboard, closes with Escape, and recomputes", () => {
  const why = readFileSync(join(ROOT, "ui/src/Why.tsx"), "utf8");
  assert.match(why, /title=\{full\.sentence\[lang\]\}/, "hover shows the sentence");
  assert.match(why, /aria-expanded=\{open\}/);
  assert.match(why, /e\.key !== "Escape" \|\| !open/);
  assert.match(why, /recompute\(src\)/, "the number is recomputed in the panel");
  assert.match(why, /type="button"/, "a real button: Enter and Space work");
  const ui = (f) => readFileSync(join(ROOT, "ui/src", f), "utf8");
  assert.match(ui("Fidelity.tsx"), /<Why d=\{cur\.why\}/);
  assert.match(ui("Dialogs.tsx"), /<Why d=\{m\.why\?\.health\}/);
  assert.match(ui("Dialogs.tsx"), /<WhyList items=/);
  assert.match(ui("AuditFile.tsx"), /<WhyList items=.*file\.derivations/);
  const i18n = ui("i18n.ts");
  for (const k of ["whyBtn", "whyFormula", "whyChecked", "whyMismatch", "whyCounts", "whyAuditCounts"]) assert.equal((i18n.match(new RegExp(`  ${k}: `, "g")) ?? []).length, 2, k);
  const help = ui("helpContent.ts");
  assert.ok(help.includes("ⓘ Wie berechnet?") && help.includes("ⓘ How computed?"));
});

test("E1b: the reading copies carry a footnote per number with its derivation; older files without them still render", async () => {
  const { renderAuditMarkdown } = await import("../dist/core/auditexport.js");
  const { renderAuditHtml } = await import("../dist/core/audithtml.js");
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  const md = renderAuditMarkdown(x, "de");
  assert.match(md, /teilweise belegt \[\^1\]: \d+/);
  assert.match(md, /\[\^1\]: .*Formel count\/1/);
  const html = renderAuditHtml(x, "en");
  assert.match(html, /<ol class="why-notes">\s*<li>\d+: controls with status/);
  assert.match(html, /<span>partly evidenced \[1\]<\/span>/);
  // An export from before E1 (no derivations) renders without footnotes.
  const old = JSON.parse(JSON.stringify(x));
  delete old.file.derivations;
  assert.doesNotMatch(renderAuditMarkdown(old, "de"), /\[\^1\]/);
  assert.doesNotMatch(renderAuditHtml(old, "de"), /<ol class="why-notes">/);
});

// ------------------------------------------------------------------ review of E1b (K1–K10)

const uisrc = (f) => readFileSync(join(ROOT, "ui/src", f), "utf8");

test("E1b K1: Escape is handled only while the focus is inside the derivation", () => {
  const why = uisrc("Why.tsx");
  assert.doesNotMatch(why, /window\.addEventListener\("keydown"/, "no page-wide key listener");
  assert.match(why, /onKeyDown=\{onKeyDown\}/);
  assert.match(why, /e\.nativeEvent\.stopImmediatePropagation\(\)/, "the dialog around it does not close too");
});

test("E1b K2: the check compares the recomputed value with the value it came with AND the number shown", () => {
  const why = uisrc("Why.tsx");
  assert.match(why, /again === src\.value && \(shown === undefined \|\| again === shown\)/);
  assert.match(why, /original=\{d\}/, "the short form as it came from the server is recomputed, not the expanded copy");
  assert.match(uisrc("Fidelity.tsx"), /<Why d=\{cur\.why\} shown=\{cur\.score\}/);
  assert.match(uisrc("Dialogs.tsx"), /<Why d=\{m\.why\?\.health\} shown=\{m\.health\}/);
  assert.match(uisrc("Dialogs.tsx"), /\[m\.why\.counts\[k\], m\.counts\[k\]\]/);
  assert.match(uisrc("AuditFile.tsx"), /\[file\.derivations\[`summary\.\$\{k\}`\], file\.summary\[k\]\]/);
  // A short form whose value does not follow from its inputs is caught by recompute.
  assert.notEqual(recompute({ key: "x", value: 99, formula: "fidelity/1", inputs: { anchor: 1, continuity: 1, integrity: 1, epistemic: 1, tampered: false, canonBroken: false, root: false } }), 99);
});

test("E1b K3/K9: the footnotes list every counted item; the marker follows the label", async () => {
  const { renderAuditMarkdown } = await import("../dist/core/auditexport.js");
  const { renderAuditHtml } = await import("../dist/core/audithtml.js");
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  const org = x.file.derivations["summary.organisational"].inputs.find((i) => i.name === "items").value;
  assert.ok(org.length > 12, "more items than the sentence shows");
  const md = renderAuditMarkdown(x, "en");
  const html = renderAuditHtml(x, "en");
  for (const id of org) {
    assert.ok(md.includes(id.replace(/\./g, "\\.")) || md.includes(id), `md lists ${id}`);
    assert.ok(html.includes(id), `html lists ${id}`);
  }
  assert.match(html, new RegExp(`Counted \\(${org.length}\\):`));
  assert.doesNotMatch(html, /<sup>/, "no superscript after a number");
});

test("E1b K4/K5/K6/K10: phone layout, tap target, every item, readable check line", () => {
  const css = uisrc("styles.css");
  assert.match(css, /\.why-inputs th \{ overflow-wrap: normal;/);
  assert.match(css, /\.why-btn \{ min-width: 24px; min-height: 24px;/);
  assert.match(css, /@media \(max-width: 480px\) \{\n  \.why-inputs tr \{ display: block;/);
  assert.match(css, /\.why-ok \{ color: var\(--ink-2\); \}/);
  const why = uisrc("Why.tsx");
  assert.doesNotMatch(why, /slice\(0, 40\)/, "every item is shown");
  assert.match(why, /className="why-items"/);
});

test("E1b K7/K8: plain words — no bilingual rule, finding codes as words, readable rewinds, honest help", () => {
  const why = uisrc("Why.tsx");
  assert.match(why, /\.filter\(\(i\) => i\.name !== "rule"\)/);
  const i18n = uisrc("i18n.ts");
  assert.equal((i18n.match(/  whyCode: \{/g) ?? []).length, 2);
  const blocks = [...i18n.matchAll(/  whyCode: \{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2);
  for (const b of blocks) for (const c of ["tampered", "low_confidence_unverified", "built_on_failure", "many_branches", "step_cycle", "snapshot_missing"]) assert.match(b, new RegExp(`\\n    ${c}: "`), c);
  const d = derive("health", "health/1", { goalMissing: false, tamper: [], canon: [], quality: 1, builtOnFailure: [], openDecisions: ["n1"], lowConfidence: ["low_confidence_unverified: n2"], manyBranches: [] });
  assert.doesNotMatch(d.sentence.de + d.sentence.en, /\(e\)|\(r\)|\(s\)/);
  assert.match(readFileSync(join(ROOT, "src/core/analysis.ts"), "utf8"), /`#\$\{i \+ 1\} \$\{String\(e\.ts/);
  const help = uisrc("helpContent.ts");
  assert.doesNotMatch(help, /Steht an jeder Zahl|Next to every number/);
});

test("E1b: verify recomputes the derivations of a signed file; a contradicting number is not valid", async () => {
  const { bodyDigest } = await import("../dist/core/auditexport.js");
  const { signRecord, publicKeyId } = await import("../dist/core/canon.js");
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  const ok = verifyAuditExport(JSON.stringify(x));
  assert.equal(ok.valid, true);
  assert.equal(ok.derivations, Object.keys(x.file.derivations).length);
  // Re-signed by the key holder, but a number no longer follows from its derivation.
  const body = JSON.parse(JSON.stringify(x));
  delete body.signature;
  body.file.summary.partly += 1;
  const digest = bodyDigest(body);
  const sig = signRecord(s.store, ["audit-export/v1", digest]);
  const forged = { ...body, signature: { alg: "Ed25519", digest, projectId: x.signature.projectId, keyId: publicKeyId(sig.pub), pub: sig.pub, sig: sig.sig, signed: JSON.stringify([x.signature.projectId, "audit-export/v1", digest]) } };
  const r = verifyAuditExport(JSON.stringify(forged));
  assert.equal(r.valid, false, JSON.stringify(r));
  assert.match(r.problem, /summary\.partly does not match its derivation/);
});
