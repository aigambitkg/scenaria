// Batch C4b: the audit package — evidence, print-ready page (PDF via the browser), Markdown, a note on checking.
// Kev's decisions (2026-10-16): no PDF library; `verify` without a name finds the newest audit file here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { addOrgEvidence } from "../dist/core/orgevidence.js";
import { exportAuditFile } from "../dist/core/auditexport.js";
import { renderAuditHtml } from "../dist/core/audithtml.js";
import { checkExportPath, findNewestExport, writeAuditPackage } from "../dist/core/auditpackage.js";
import { VERSION } from "../dist/server.js";
import { signRecord } from "../dist/core/canon.js";
import { tempProject } from "./helpers.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function project() {
  const p = tempProject("auditpkg-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API", title: "Build", goal: "Endpoints" });
  s.decide({ question: "Framework?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "fast", context: "new", servesGoal: "API", agent: "codex" });
  const cp = s.checkpoint({ title: '<script>alert(1)</script> "quoted" & more', outputs: [], agent: "codex" });
  s.verify(cp.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
  s.verify(cp.id, { status: "failed", origin: "person", via: "terminal", by: "kev" });
  addOrgEvidence(s.store, { control: "A.2.2", url: "https://intranet.example.org/policy.pdf", hash: "sha256:" + "d".repeat(64), title: "AI <policy>", role: "AI officer", name: "Petra Vollmer", date: "2026-09-01" }, { by: "kev", via: "terminal" });
  return { p, s };
}
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, SCENARIA_HOME: mkdtempSync(join(tmpdir(), "pkg-home-")) } });

test("C4b: the package holds the evidence, a print-ready page, Markdown and a note; all name the same fingerprint", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const out = mkdtempSync(join(tmpdir(), "pkg-out-"));
  const folder = writeAuditPackage(out, x, "de");
  assert.deepEqual(readdirSync(folder).sort(), ["PRUEFEN.txt", "audit-file.html", "audit-file.json", "audit-file.md"]);
  const r = checkExportPath(folder, VERSION);
  assert.equal(r.valid, true, r.problem);
  assert.equal(r.package, true);
  // Since 0.9.13 (C5, S-K5) the note on checking is checked too.
  assert.deepEqual(r.copies, [{ name: "audit-file.html", state: "same" }, { name: "audit-file.md", state: "same" }, { name: "PRUEFEN.txt", state: "same" }]);
  const note = readFileSync(join(folder, "PRUEFEN.txt"), "utf8");
  assert.ok(note.includes(x.signature.digest) && note.includes(x.signature.keyId));
  assert.throws(() => writeAuditPackage(out, x, "de"), /EEXIST/, "never into an existing folder");
});

test("C4b: the page is self-contained, runs nothing and shows recorded text only as text", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const html = renderAuditHtml(x, "de");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.ok(!/<script/i.test(html), "no script element at all");
  assert.ok(!/<a\s/i.test(html), "no links: what is printed is what was signed");
  assert.ok(!/(src|href)=/i.test(html), "nothing is loaded");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; more"));
  assert.ok(html.includes("AI &lt;policy&gt;"));
  assert.equal((html.match(/name="scenaria-fingerprint"/g) ?? []).length, 1);
  assert.ok(html.includes(`class="foot"`) && html.includes(x.signature.digest.slice(0, 16)), "footer on every printed page");
  assert.match(html, /@page\{size:A4/);
  for (const c of x.file.controls) assert.ok(html.includes(`<b>${c.id}</b>`), c.id);
  const en = renderAuditHtml(x, "en");
  assert.match(en, /reading copy/);
  // Roles only: no name on the page.
  const r = exportAuditFile(s, { from: null, to: null }, { names: "roles-only", version: VERSION });
  assert.ok(!renderAuditHtml(r, "de").includes("Petra Vollmer"));
});

test("C4b: verify without a name checks the newest audit file here and says which; a changed reading copy is flagged", () => {
  const { s } = project();
  const out = mkdtempSync(join(tmpdir(), "pkg-newest-"));
  let r = run(["audit-file", "verify"], out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No audit file in this folder/);
  const signer = (parts) => signRecord(s.store, parts);
  const older = writeAuditPackage(out, exportAuditFile(s, { from: null, to: null }, { version: VERSION }), "de", signer);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(older, "audit-file.json"), old, old);
  const x2 = exportAuditFile(s, { from: null, to: null }, { names: "roles-only", version: VERSION });
  const newer = writeAuditPackage(out, x2, "en", signer);
  assert.deepEqual(findNewestExport(out), { path: join(newer, "audit-file.json"), others: 1 });
  r = run(["audit-file", "verify"], out);
  assert.equal(r.status, 0, r.stderr);
  // The CLI names the real folder (on macOS /var/… is really /private/var/…): compare real paths (HANDOFF §3).
  assert.ok(r.stdout.includes("Checking the newest audit file here") && r.stdout.includes(realpathSync.native(newer)), r.stdout);
  assert.match(r.stdout, /1 other audit file\(s\) here/);
  assert.match(r.stdout, /roles only/);
  assert.match(r.stdout, /reading copy audit-file\.html: same content as the evidence/);
  // Inside the package folder itself.
  r = run(["audit-file", "verify"], newer);
  assert.equal(r.status, 0, r.stderr);
  // Someone edits the reading copy to show another fingerprint: the evidence is fine, the copy is not.
  const page = readFileSync(join(newer, "audit-file.html"), "utf8");
  writeFileSync(join(newer, "audit-file.html"), page.replace(`sha256:${x2.signature.digest}"`, `sha256:${"0".repeat(64)}"`));
  r = run(["audit-file", "verify", newer], out);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /audit-file\.html: DOES NOT SHOW what the evidence holds/);
});

// ------------------------------------------------------------------ review of C4b (C4b-1 … C4b-8)

test("C4b-1: a reading copy is rendered again from the evidence and compared — an edited copy never passes", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const folder = writeAuditPackage(mkdtempSync(join(tmpdir(), "pkg-c1-")), x, "de");
  const page = readFileSync(join(folder, "audit-file.html"), "utf8");
  writeFileSync(join(folder, "audit-file.html"), page.replace("nicht abgedeckt", "nicht abgedeckt (bereinigt)"));
  writeFileSync(join(folder, "audit-file.md"), `> Fingerabdruck: \`sha256:${x.signature.digest}\`\n# Alles belegt\n`);
  let r = checkExportPath(folder, VERSION);
  assert.equal(r.valid, true, "the evidence itself is fine");
  assert.deepEqual(r.copies.map((c) => c.state), ["different", "different", "same"]);
  // Made by another Scenaria version: cannot be compared — never reported as matching.
  r = checkExportPath(folder, "0.0.0-other");
  assert.deepEqual(r.copies.map((c) => c.state), ["not_comparable", "not_comparable", "same"], "the untouched note still renders the same");
  const cli = run(["audit-file", "verify", folder], folder);
  assert.equal(cli.status, 1);
  // A missing copy is said, not hidden.
  const f2 = writeAuditPackage(mkdtempSync(join(tmpdir(), "pkg-c1b-")), x, "en");
  rmSync(join(f2, "audit-file.html"));
  assert.deepEqual(checkExportPath(f2, VERSION).copies, [{ name: "audit-file.html", state: "missing" }, { name: "audit-file.md", state: "same" }, { name: "CHECK.txt", state: "same" }]);
  // A single file is not a package: its reading copies are not checked, and that is said.
  const single = join(mkdtempSync(join(tmpdir(), "pkg-single-")), "audit-file-x.json");
  writeFileSync(single, JSON.stringify(x));
  const rs = run(["audit-file", "verify", single], tmpdir());
  assert.equal(rs.status, 0, rs.stderr);
  assert.match(rs.stdout, /reading copies: not checked/);
});

test("C4b-2/4/5/6: long words wrap, the fingerprint line repeats in every browser, a step title is shown apart", () => {
  const { s } = project();
  const long = "X".repeat(190);
  s.checkpoint({ title: `${long} now passed (person, counts); earlier: —`, outputs: [], agent: "codex" });
  const last = s.store.listNodes().at(-1);
  s.verify(last.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
  s.verify(last.id, { status: "failed", origin: "person", via: "terminal", by: "kev" });
  const html = renderAuditHtml(exportAuditFile(s, { from: null, to: null }, { version: VERSION }), "en");
  assert.match(html, /table\.sheet\{width:100%;table-layout:fixed/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /<tfoot><tr><td><div class="foot">/, "the fingerprint line is the repeating table footer");
  assert.ok(!/position:fixed/.test(html));
  assert.match(html, /Step: „XXXX/);
  assert.match(html, /\.foot span\{overflow:hidden;text-overflow:ellipsis\}/);
});

test("C4b-3: inside a package folder only its own evidence counts, whatever else lies there", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const folder = writeAuditPackage(mkdtempSync(join(tmpdir(), "pkg-c3-")), x, "de", (parts) => signRecord(s.store, parts));
  const planted = join(folder, "audit-file-zz.json");
  writeFileSync(planted, JSON.stringify(exportAuditFile(s, { from: null, to: null }, { names: "roles-only", version: VERSION })));
  const future = new Date(Date.now() + 3600_000);
  utimesSync(planted, future, future);
  assert.deepEqual(findNewestExport(folder), { path: join(folder, "audit-file.json"), others: 0 });
  const r = run(["audit-file", "verify"], folder);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /with names/);
  assert.match(r.stdout, /reading copy audit-file\.md: same content/);
});

test("C4b: the person also signs the reading copies, so any Scenaria version can tell an edited copy", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const folder = writeAuditPackage(mkdtempSync(join(tmpdir(), "pkg-signed-")), x, "de", (parts) => signRecord(s.store, parts));
  assert.ok(readdirSync(folder).includes("audit-file.copies.json"));
  // Another version would not be able to compare by rendering — with the signature it can.
  let r = checkExportPath(folder, "9.9.9-other");
  assert.deepEqual(r.copies.map((c) => c.state), ["same", "same", "same"]);
  const page = readFileSync(join(folder, "audit-file.html"), "utf8");
  writeFileSync(join(folder, "audit-file.html"), page.replace("Manipulationsnachweis</h2>", "Manipulationsnachweis (geprüft)</h2>"));
  r = checkExportPath(folder, "9.9.9-other");
  assert.deepEqual(r.copies.map((c) => c.state), ["different", "same", "same"]);
  // A forged copies signature is said loudly.
  const cf = join(folder, "audit-file.copies.json");
  const c = JSON.parse(readFileSync(cf, "utf8"));
  c.copies["audit-file.html"] = "0".repeat(64);
  writeFileSync(cf, JSON.stringify(c));
  r = checkExportPath(folder, VERSION);
  assert.equal(r.copiesSignature, "invalid");
  const cli = run(["audit-file", "verify", folder], folder);
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /reading copies \(audit-file\.copies\.json\) does NOT verify/);
});

test("C4b: a removed or replaced copies signature is never ignored", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const folder = writeAuditPackage(mkdtempSync(join(tmpdir(), "pkg-cpmiss-")), x, "de", (parts) => signRecord(s.store, parts));
  rmSync(join(folder, "audit-file.copies.json"));
  assert.equal(checkExportPath(folder, "9.9.9-other").copiesSignature, "missing");
  const r = run(["audit-file", "verify", folder], folder);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is MISSING/);
  mkdirSync(join(folder, "audit-file.copies.json"));
  assert.equal(checkExportPath(folder, VERSION).copiesSignature, "invalid");
});
