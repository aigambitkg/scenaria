// Batch C5: closing Batch C. One regression test per finding of the two independent whole-batch reviews
// (security S-K1…S-K3, personas U-K1…U-K5; the LOW findings are Kev's decision).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { buildAuditFile } from "../dist/core/auditfile.js";
import { exportAuditFile, verifyAuditExport } from "../dist/core/auditexport.js";
import { writeAuditPackage } from "../dist/core/auditpackage.js";
import { signRecord } from "../dist/core/canon.js";
import { tempProject, importUrl } from "./helpers.mjs";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const src = (f) => readFileSync(join(ROOT, "ui", "src", f), "utf8");
// A child's console output can carry colour codes (the test runner may set FORCE_COLOR): compare plain text.
const plain = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, "");

function project() {
  const p = tempProject("c5-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API with tests", title: "Build the API", goal: "Endpoints and tests" });
  s.decide({ question: "Which framework?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "faster", context: "new API", servesGoal: "small API", agent: "codex" });
  p.write("a.txt", "2");
  const cp = s.checkpoint({ title: "API skeleton", outputs: ["`a.txt`"], agent: "codex" });
  return { p, s, cp };
}
const nodeFile = (p, id) => join(p.dir, ".scenaria/nodes", `${id}.json`);
const editParent = (p, id, parentId) => {
  const n = JSON.parse(readFileSync(nodeFile(p, id), "utf8"));
  n.parentId = parentId;
  writeFileSync(nodeFile(p, id), JSON.stringify(n));
};

test("C5 S-K1: a loop in the parent links never hangs the audit file; it raises the alarm step_cycle", () => {
  for (const kind of ["self", "pair"]) {
    const { p, s, cp } = project();
    const ids = s.store.listNodes().map((n) => n.id);
    const before = ids[ids.indexOf(cp.id) - 1];
    if (kind === "self") editParent(p, cp.id, cp.id);
    else {
      editParent(p, cp.id, before);
      editParent(p, before, cp.id);
    }
    // In a child process with a time limit: an endless loop would block this test process for good.
    const code = `
      const { Scenaria } = await import(${JSON.stringify(importUrl(join(ROOT, "dist/core/index.js")))});
      const { buildAuditFile } = await import(${JSON.stringify(importUrl(join(ROOT, "dist/core/auditfile.js")))});
      const s = Scenaria.open(${JSON.stringify(p.dir)});
      const f = buildAuditFile(s);
      console.log(JSON.stringify({ state: f.integrity.state, w: f.integrity.warnings.map((w) => [w.code, w.items]) }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000, env: process.env });
    assert.equal(r.status, 0, `${kind}: finished (${r.signal ?? ""} ${r.stderr})`);
    const out = JSON.parse(plain(r.stdout).trim().split("\n").pop());
    assert.equal(out.state, "alarm", kind);
    const w = out.w.find(([c]) => c === "step_cycle");
    assert.ok(w, `${kind}: step_cycle alarm`);
    assert.deepEqual([...w[1]].sort(), (kind === "self" ? [cp.id] : [before, cp.id]).sort(), kind);
  }
});

test("C5 S-K2: deleting or rolling back the newest step raises an alarm (anchored project)", () => {
  {
    const { p, cp } = project();
    rmSync(nodeFile(p, cp.id));
    const s = Scenaria.open(p.dir);
    assert.deepEqual(s.integrity().stepsMissing, [cp.id], "the newest step is missing");
    assert.equal(buildAuditFile(s).integrity.state, "alarm");
  }
  {
    const { p, s, cp } = project();
    const old = readFileSync(nodeFile(p, cp.id), "utf8");
    s.update(cp.id, { summary: "Deployed to production", status: "done" });
    writeFileSync(nodeFile(p, cp.id), old); // the newest write rolled back by hand
    const t = Scenaria.open(p.dir);
    assert.equal(t.integrity().state.get(cp.id), "tampered");
    assert.equal(buildAuditFile(t).integrity.state, "alarm");
  }
  // A normal project: no alarm, also not for the newest step.
  const { s } = project();
  const i = s.integrity();
  assert.deepEqual(i.stepsMissing, []);
  assert.ok([...i.state.values()].every((v) => v === "ok"));
});

test("C5 S-K3: a lone surrogate an agent sends never makes the person's export fail verify", async () => {
  const { p, s } = project();
  s.checkpoint({ title: "done \ud800", outputs: ["x"], agent: "codex\udc00", model: "gpt\ud800" });
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  const text = JSON.stringify(x);
  assert.doesNotMatch(text, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, "no lone surrogate in the signed export");
  assert.deepEqual(verifyAuditExport(text).valid, true);
  const out = mkdtempSync(join(tmpdir(), "c5-pkg-"));
  const folder = writeAuditPackage(out, x, "de", (parts) => signRecord(s.store, parts));
  assert.equal(verifyAuditExport(readFileSync(join(folder, "audit-file.json"), "utf8")).valid, true);
  const r = spawnSync(process.execPath, [CLI, "audit-file", "verify", folder], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  void p;
});

test("C5 U-K5: verify of a package with a changed reading copy starts with NOT VALID (and exits 1)", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  const out = mkdtempSync(join(tmpdir(), "c5-pkg-"));
  const folder = writeAuditPackage(out, x, "de", (parts) => signRecord(s.store, parts));
  const html = join(folder, "audit-file.html");
  writeFileSync(html, readFileSync(html, "utf8").replace("</body>", "<p>alles belegt</p></body>"));
  const r = spawnSync(process.execPath, [CLI, "audit-file", "verify", folder], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r.status, 1);
  const first = r.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n")[0];
  assert.match(first, /^NOT VALID as a package: reading copy audit-file\.html was changed/, first);
  assert.doesNotMatch(first, /^Valid/);
  // An untouched package still starts with "Valid:".
  const ok = writeAuditPackage(mkdtempSync(join(tmpdir(), "c5-pkg-")), x, "de", (parts) => signRecord(s.store, parts));
  const r2 = spawnSync(process.execPath, [CLI, "audit-file", "verify", ok], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /^Valid: content and signature match/);
});

test("C5 U-K1: the removal step no longer promises the entry stays visible at its control", () => {
  const i18n = src("i18n.ts");
  assert.doesNotMatch(i18n, /stay visible in the audit file|bleiben in der Prüfakte sichtbar/);
  assert.match(i18n, /remove: \(\) => "The entry is marked as removed and signed, and no longer counts from now on\. It stays in \\"Signed approvals and decisions\\"/);
  assert.match(i18n, /remove: \(\) => "Der Eintrag wird als entfernt markiert und signiert und zählt ab jetzt nicht mehr\. Er bleibt in der Liste „Signierte Freigaben und Entscheidungen“/);
  // And the core really keeps it: the approvals list names the removal (whole project).
});

test("C5 U-K2: the package button waits for 'Show' when typed dates differ, and the done text names the period", () => {
  const ui = src("AuditFile.tsx");
  assert.match(ui, /const periodPending = from !== shown\.from \|\| to !== shown\.to;/);
  assert.match(ui, /disabled=\{busy \|\| periodPending\} onClick=\{makePackage\}/);
  assert.match(ui, /setShown\(\{ from: f, to: tt \}\)/, "the shown period is the one the file was loaded for");
  assert.match(ui, /t\.afPackageDone\(done\.folder, done\.where, donePeriod\)/);
  const i18n = src("i18n.ts");
  assert.equal((i18n.match(/afPeriodPending:/g) ?? []).length, 2, "DE and EN");
  assert.equal((i18n.match(/afPackageDone: \(folder: string, where: string, period: string\)/g) ?? []).length, 2);
});

test("C5 U-K3: readers other than the person never see 'signed by you'", () => {
  const ui = src("AuditFile.tsx");
  assert.match(ui, /e\.trust === "verified" && !props\.edit \? t\.afTrustPerson/);
  const i18n = src("i18n.ts");
  assert.match(i18n, /afTrustPerson: "signed by the person"/);
  assert.match(i18n, /afTrustPerson: "von der Person signiert"/);
});

test("C5 U-K4: the approvals list and verdict history show plain labels; a verdict is not 'carries no control'", () => {
  const ui = src("AuditFile.tsx");
  assert.doesNotMatch(ui, /<strong>\{a\.kind\}<\/strong>/);
  assert.doesNotMatch(ui, /\{h\.current\.status\} · \{h\.current\.origin\}/);
  assert.match(ui, /t\.afCarriesNoKind\[a\.kind\] \?\? t\.afCarriesNo/);
  const i18n = src("i18n.ts");
  assert.doesNotMatch(i18n, /trägt keine Kontrolle|carries no control/);
  // Every kind the audit file emits has a label in both languages.
  const kinds = [...readFileSync(join(ROOT, "src/core/auditfile.ts"), "utf8").matchAll(/kind: "([a-z-]+)", ref/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 7, "kinds found");
  const blocks = [...i18n.matchAll(/afKindL: \{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2);
  for (const b of blocks) for (const k of new Set(kinds)) assert.match(b, new RegExp(`(^|[ ,{])"?${k}"?:`), `label for ${k}`);
  assert.match(i18n, /afVerdictCounts: "zählt als unabhängiges Prüfurteil"/);
});

// ------------------------------------------------------------------ C5.3: the LOW points Kev decided to fix (2026-10-17)

const pkg = (s, lang = "de") => writeAuditPackage(mkdtempSync(join(tmpdir(), "c5-pkg-")), exportAuditFile(s, { from: null, to: null }, { version: "test" }), lang, (parts) => signRecord(s.store, parts));
const verifyCli = (folder) => {
  const r = spawnSync(process.execPath, [CLI, "audit-file", "verify", folder], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, out: r.stdout.replace(/\x1b\[[0-9;]*m/g, "") };
};

test("C5 S-K5: the note on checking is signed and checked; files Scenaria did not write are named", async () => {
  const { checkExportPath } = await import("../dist/core/auditpackage.js");
  const { s } = project();
  const folder = pkg(s);
  const copies = JSON.parse(readFileSync(join(folder, "audit-file.copies.json"), "utf8"));
  assert.equal(copies.version, 2);
  assert.match(copies.copies["PRUEFEN.txt"], /^[0-9a-f]{64}$/);
  let c = checkExportPath(folder, "test");
  assert.deepEqual(c.copies.map((x) => [x.name, x.state]), [["audit-file.html", "same"], ["audit-file.md", "same"], ["PRUEFEN.txt", "same"]]);
  assert.equal(c.extra, undefined);
  // A PDF saved into the folder is named, not checked, and does not fail the check.
  writeFileSync(join(folder, "audit-file.pdf"), "%PDF-1.4 planted");
  let v = verifyCli(folder);
  assert.equal(v.status, 0);
  assert.match(v.out, /not part of the package, not checked: audit-file\.pdf/);
  // A changed note fails the check.
  const note = join(folder, "PRUEFEN.txt");
  writeFileSync(note, readFileSync(note, "utf8").replace(/Schlüsselkennung: \S+/, "Schlüsselkennung: 0000000000000000"));
  c = checkExportPath(folder, "test");
  assert.equal(c.copies.find((x) => x.name === "PRUEFEN.txt").state, "different");
  v = verifyCli(folder);
  assert.equal(v.status, 1);
  assert.match(v.out.split("\n")[0], /^NOT VALID as a package: note on checking PRUEFEN\.txt was changed/);
});

test("C5 S-K6: copies and evidence are checked as raw bytes; invalid UTF-8 is refused", async () => {
  const { checkExportPath } = await import("../dist/core/auditpackage.js");
  const { s } = project();
  const { addOrgEvidence } = await import("../dist/core/orgevidence.js");
  addOrgEvidence(s.store, { control: "A.2.2", url: "https://intranet.example.org/p.pdf", hash: "sha256:" + "a".repeat(64), title: "Richtlinie \ufffd Entwurf", role: "KI-Beauftragte", name: "X", date: "2026-09-01" }, { by: "kev", via: "terminal" });
  const folder = pkg(s);
  for (const name of ["audit-file.html", "audit-file.md"]) {
    const f = join(folder, name);
    const before = readFileSync(f);
    const at = before.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    assert.ok(at >= 0, `${name} holds U+FFFD`);
    writeFileSync(f, Buffer.concat([before.subarray(0, at), Buffer.from([0xff]), before.subarray(at + 3)]));
    assert.equal(checkExportPath(folder, "test").copies.find((x) => x.name === name).state, "different", name);
    writeFileSync(f, before);
  }
  const ev = join(folder, "audit-file.json");
  const b = readFileSync(ev);
  const at = b.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
  assert.ok(at >= 0);
  writeFileSync(ev, Buffer.concat([b.subarray(0, at), Buffer.from([0xff]), b.subarray(at + 3)]));
  const r = checkExportPath(folder, "test");
  assert.equal(r.valid, false);
  assert.match(r.problem, /UTF-8/);
});

test("C5 S-K7: 'roles only' leaves out the names of registered audit agents", async () => {
  const { addAuditor, auditorKeygen } = await import("../dist/core/auditors.js");
  const { s } = project();
  const k = auditorKeygen(mkdtempSync(join(tmpdir(), "c5-auditor-")));
  addAuditor(k.pub, "Max Mustermann");
  const ro = JSON.stringify(exportAuditFile(s, { from: null, to: null }, { version: "test", names: "roles-only" }));
  assert.doesNotMatch(ro, /Max Mustermann/);
  assert.match(ro, /audit agent\(s\)/);
  assert.match(JSON.stringify(exportAuditFile(s, { from: null, to: null }, { version: "test" })), /Max Mustermann/, "with names it stays");
});

test("C5: a damaged (too short) auditor-mode key is replaced on disk, never kept only in memory", async () => {
  const home = mkdtempSync(join(tmpdir(), "c5-home-"));
  const { dirname } = await import("node:path");
  const env = { ...process.env, SCENARIA_HOME: home };
  // Where the global config lives under this home.
  const where = spawnSync(process.execPath, ["--input-type=module", "-e", `const { globalConfigPath } = await import(${JSON.stringify(importUrl(join(ROOT, "dist/core/global.js")))}); console.log(globalConfigPath());`], { encoding: "utf8", env });
  const keyFile = join(dirname(where.stdout.trim()), "auditview.key");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, Buffer.from("short"));
  const { p } = project();
  const code = `
    const { Scenaria } = await import(${JSON.stringify(importUrl(join(ROOT, "dist/core/index.js")))});
    const { createApp } = await import(${JSON.stringify(importUrl(join(ROOT, "dist/server.js")))});
    const { createServer } = await import("node:http");
    const s = Scenaria.open(${JSON.stringify(p.dir)});
    const app = createApp(s, { approvalCode: "c", approvalSecret: "sess", openApproval: async () => ({ opened: true }), auditViewEveryMs: 0 });
    const server = createServer(app.handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const r = await fetch("http://127.0.0.1:" + server.address().port + "/api/audit-file/auditor-mode", { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: "{}" });
    console.log(String(r.status));
    server.close(); app.close?.();
    process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(plain(r.stdout).trim().split("\n").pop(), "200", r.stderr);
  assert.ok(readFileSync(keyFile).length >= 32, "the key on disk was replaced");
});

test("C5 U-K6…U-K11 and the observations: texts, colours, labels", () => {
  const html = readFileSync(join(ROOT, "src/core/audithtml.ts"), "utf8");
  assert.doesNotMatch(html, /\.b-partly\{[^}]*--ok/, "'partly' is not green on the print page");
  const cli = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
  assert.doesNotMatch(cli, /\["partly", C\.green\]/, "nor in the terminal");
  const i18n = src("i18n.ts");
  assert.match(i18n, /afSteps: \(n: number\) => \(n === 1 \? "1 step"/);
  assert.match(i18n, /afSteps: \(n: number\) => \(n === 1 \? "1 Schritt"/);
  assert.match(i18n, /evHashFile: "Compute from a file"/);
  assert.match(i18n, /evHashFile: "Aus Datei berechnen"/);
  assert.equal((i18n.match(/afAccessNow: /g) ?? []).length, 2, "the read setting is shown (DE/EN)");
  const ui = src("AuditFile.tsx");
  assert.match(ui, /t\.afAccessNow\(file\.access\.mode\)/);
  assert.doesNotMatch(ui, /\{t\.afIntegrity\}: \{file\.integrity\.headline/, "one term, not two");
  assert.doesNotMatch(readFileSync(join(ROOT, "src/core/auditfile.ts"), "utf8"), /Der Manipulationsnachweis ist (intakt|beschädigt)/);
  assert.match(ui, /aria-label=\{t\.afFilterGroup\}/);
  assert.match(src("HelpButton.tsx"), /h\.title\?\.\(topic\) \?\? topic/);
  // Muted text and warnings reach 4.5:1 on white (light mode).
  const css = src("styles.css");
  const lum = (h) => {
    const c = [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  for (const v of ["--ink-3", "--warn"]) {
    const hex = css.match(new RegExp(`${v}: (#[0-9a-f]{6})`))[1];
    assert.ok(1.05 / (lum(hex) + 0.05) >= 4.5, `${v} ${hex}`);
  }
  assert.match(css, /\.simple-main > \.banner \{ position: static;/, "the notice never covers the top bar");
});

test("C5: a discarded entry keeps the control it concerned in the signed record", async () => {
  const { removeOrgEvidence, orgEvidenceStates, readOrgEvidence } = await import("../dist/core/orgevidence.js");
  const { p, s } = project();
  const f = join(p.dir, ".scenaria/org-evidence.json");
  const { addOrgEvidence } = await import("../dist/core/orgevidence.js");
  addOrgEvidence(s.store, { control: "A.2.2", url: "https://intranet.example.org/p.pdf", hash: "sha256:" + "a".repeat(64), title: "P", role: "KI-Beauftragte", name: "X", date: "2026-09-01" }, { by: "kev", via: "terminal" });
  const raw = JSON.parse(readFileSync(f, "utf8"));
  raw.entries.push({ ...raw.entries[0], id: "e7", control: "A.3.2", sig: undefined, pub: undefined });
  writeFileSync(f, JSON.stringify(raw));
  assert.equal(removeOrgEvidence(s.store, "e7", { by: "kev", via: "terminal" }).discarded, true);
  assert.equal(readOrgEvidence(s.store).entries.find((x) => x.id === "e7").control, "A.3.2");
  assert.equal(orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e7").trust, "verified");
  assert.ok(buildAuditFile(s).approvals.some((a) => a.kind === "evidence" && a.action === "discarded" && a.ref === "A.3.2/e7"));
});

test("C5 (§9 C2.1): the audit file's own alarms also reach the project check", async () => {
  const { projectMetrics } = await import("../dist/core/analysis.js");
  const { p, s, cp } = project();
  const n = JSON.parse(readFileSync(nodeFile(p, cp.id), "utf8"));
  n.snapshot = { ...n.snapshot, commit: "0".repeat(40) };
  n.verification = { status: "passed", origin: "person", at: new Date().toISOString(), by: "kev", via: "dashboard", sig: "AAAA", pub: "AAAA" };
  writeFileSync(nodeFile(p, cp.id), JSON.stringify(n));
  const codes = projectMetrics(Scenaria.open(p.dir)).issues.map((i) => i.code);
  assert.ok(codes.includes("snapshot_missing"), codes.join(","));
  assert.ok(codes.includes("verdict_forged"), codes.join(","));
  void s;
});

// ------------------------------------------------------------------ review of the C5 fixes (R1–R5)

test("C5 R1: a reader without the lock never sees a false alarm while another process writes", async () => {
  const { spawn } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "c5-race-home-"));
  const dir = mkdtempSync(join(tmpdir(), "c5-race-"));
  const env = { ...process.env, SCENARIA_HOME: home };
  const idx = JSON.stringify(importUrl(join(ROOT, "dist/core/index.js")));
  const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { Scenaria } = await import(${idx});
    const { writeFileSync } = await import("node:fs");
    writeFileSync(${JSON.stringify(join(dir, "a.txt"))}, "0");
    const s = Scenaria.init(${JSON.stringify(dir)});
    s.startMission({ projectGoal: "G", title: "T", goal: "g" });
    for (let i = 0; i < 10; i++) s.checkpoint({ title: "c" + i, outputs: ["x"], agent: "a" });`], { env, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  // Saving a state takes longer on Windows (starting git costs more there): more time for the same overlap.
  const SECS = process.platform === "win32" ? 18 : 6;
  const run = (code) =>
    new Promise((res) => {
      let out = "";
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("exit", () => res(out.trim()));
    });
  const writer = `
    const { Scenaria } = await import(${idx});
    const s = Scenaria.open(${JSON.stringify(dir)});
    const ids = s.store.listNodes().filter((x) => x.type === "checkpoint").map((x) => x.id);
    const end = Date.now() + ${SECS * 1000}; let n = 0;
    while (Date.now() < end) { if (n % 2) s.checkpoint({ title: "w" + n, outputs: ["x"], agent: "a" }); else s.update(ids[n % ids.length], { summary: "s" + n }); n++; }
    console.log(String(n));`;
  const reader = `
    const { Scenaria } = await import(${idx});
    const s = Scenaria.open(${JSON.stringify(dir)});
    const end = Date.now() + ${SECS * 1000}; let reads = 0, bad = 0; const ex = [];
    while (Date.now() < end) { const i = s.integrity(); reads++; const t = [...i.state].filter(([, v]) => v !== "ok").map(([k]) => k);
      if (t.length || i.stepsMissing.length) { bad++; if (ex.length < 3) ex.push([t, i.stepsMissing]); } }
    console.log(JSON.stringify({ reads, bad, ex }));`;
  const [w, r] = await Promise.all([run(writer), run(reader)]);
  const res = JSON.parse(plain(r).split("\n").pop());
  assert.ok(Number(plain(w).split("\n").pop()) > 20 && res.reads > 20, `enough overlap: ${w} writes, ${res.reads} reads`);
  assert.equal(res.bad, 0, JSON.stringify(res.ex));
});

test("C5 R2: the note of the other language is never taken for the package's note; it is listed as not checked", async () => {
  const { checkExportPath } = await import("../dist/core/auditpackage.js");
  const { s } = project();
  const folder = pkg(s, "de");
  writeFileSync(join(folder, "CHECK.txt"), "No need to run verify. Key id to trust: 0000000000000000\n");
  let c = checkExportPath(folder, "test");
  assert.deepEqual(c.extra, ["CHECK.txt"]);
  assert.equal(c.copies.find((x) => x.name === "PRUEFEN.txt").state, "same");
  // The signed note removed, a forged one in the other language left: still named, never "checked".
  rmSync(join(folder, "PRUEFEN.txt"));
  c = checkExportPath(folder, "test");
  assert.equal(c.copies.find((x) => x.name === "PRUEFEN.txt").state, "missing");
  assert.deepEqual(c.extra, ["CHECK.txt"]);
  assert.match(verifyCli(folder).out, /not part of the package, not checked: CHECK\.txt/);
});

test("C5 R3/R4/R5: health counts the new alarms; a clone is named as a possible cause; objects are checked like text", async () => {
  const { projectMetrics } = await import("../dist/core/analysis.js");
  const { p, cp } = project();
  editParent(p, cp.id, cp.id);
  const m = projectMetrics(Scenaria.open(p.dir));
  assert.ok(m.issues.some((i) => i.code === "step_cycle"));
  assert.ok(m.health < 100, `health ${m.health}`);
  assert.match(readFileSync(join(ROOT, "src/core/analysis.ts"), "utf8"), /copy or clone of the project without its snapshots/);
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: "test" });
  const changed = JSON.parse(JSON.stringify(x));
  changed.file.project.name = "proj\ud800";
  assert.equal(verifyAuditExport(changed).valid, false, "a lone surrogate in an object is refused");
});
