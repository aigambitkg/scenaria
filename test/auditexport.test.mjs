// Batch C4a: the signed audit file. Kev's decisions (2026-10-16): the signed JSON is the evidence; Markdown/PDF
// are renderings with its fingerprint; names by default, "roles only" on request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { parsePeriod } from "../dist/core/auditfile.js";
import { addOrgEvidence } from "../dist/core/orgevidence.js";
import { bodyDigest, canonicalJson, exportAuditFile, renderAuditMarkdown, verifyAuditExport } from "../dist/core/auditexport.js";
import { createApp, VERSION } from "../dist/server.js";
import { tempProject } from "./helpers.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const HASH = "sha256:" + "c".repeat(64);
const who = { by: "kev", via: "terminal" };

function project() {
  const p = tempProject("auditexp-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API", title: "Build", goal: "Endpoints" });
  s.decide({ question: "Framework?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "fast", context: "new", servesGoal: "API", agent: "codex" });
  p.write("a.txt", "2");
  const cp = s.checkpoint({ title: "Skeleton", outputs: ["`a.txt`"], agent: "codex" });
  s.verify(cp.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
  addOrgEvidence(s.store, { control: "A.2.2", url: "https://intranet.example.org/policy.pdf", hash: HASH, title: "AI policy | v2", role: "AI officer", name: "Petra Vollmer", date: "2026-09-01" }, who);
  return { p, s };
}
const clone = (x) => JSON.parse(JSON.stringify(x));

test("C4a: the export is signed, survives being saved and re-read, and names no machine path", () => {
  const { p, s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  assert.equal(x.kind, "scenaria/iso42001-audit-export");
  assert.equal(x.names, "with-names");
  assert.equal(x.signature.digest, bodyDigest({ ...x, signature: undefined }));
  const text = JSON.stringify(x, null, 2);
  const r = verifyAuditExport(text);
  assert.equal(r.valid, true, r.problem);
  assert.equal(r.keyTrustedHere, true, "the person's own key");
  assert.equal(r.integrity, "ok");
  assert.ok(!text.includes(p.dir), "no machine path");
  assert.equal(x.context.scenariaVersion, VERSION);
  assert.equal(x.context.ledger.lines > 0, true);
  assert.equal(x.context.catalogue.controls, 38);
  // Keys in another order: the canonical form is the same.
  const reordered = Object.fromEntries(Object.entries(clone(x)).reverse());
  assert.equal(verifyAuditExport(reordered).valid, true);
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
});

test("C4a: any change after signing is detected — content, signature, key, project", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  let y = clone(x);
  y.file.controls[0].status = "evidenced";
  assert.match(verifyAuditExport(y).problem, /changed after signing/);
  y = clone(x);
  y.file.controls.find((c) => c.id === "A.2.2").orgEvidence.entries[0].owner.name = "Someone";
  assert.equal(verifyAuditExport(y).valid, false);
  y = clone(x);
  y.names = "roles-only";
  assert.equal(verifyAuditExport(y).valid, false);
  y = clone(x);
  y.signature.sig = Buffer.alloc(64, 1).toString("base64");
  assert.match(verifyAuditExport(y).problem, /signature does not match/);
  y = clone(x);
  y.signature.projectId = "other";
  assert.equal(verifyAuditExport(y).valid, false);
  y = clone(x);
  y.signature.keyId = "000000000000";
  assert.match(verifyAuditExport(y).problem, /key id/);
  assert.equal(verifyAuditExport("{ not json").valid, false);
  assert.equal(verifyAuditExport({ kind: "x" }).valid, false);
  assert.equal(verifyAuditExport(null).valid, false);
});

test("C4a: roles only leaves out every name and account, and says so in the signed file", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { names: "roles-only", version: VERSION });
  assert.equal(x.names, "roles-only");
  const text = JSON.stringify(x);
  assert.ok(!text.includes("Petra Vollmer"));
  assert.ok(!/"by":"kev"/.test(text));
  const me = userInfo().username;
  if (me && me.length > 2) assert.ok(!text.includes(`"${me}"`), "no OS account");
  const e = x.file.controls.find((c) => c.id === "A.2.2").orgEvidence.entries[0];
  assert.deepEqual(e.owner, { role: "AI officer", name: "" });
  assert.equal(verifyAuditExport(x).valid, true);
  assert.match(renderAuditMarkdown(x, "de"), /nur Rollen/);
});

test("C4a: the Markdown is a reading copy with the fingerprint, every control, and safe table cells", () => {
  const { s } = project();
  const x = exportAuditFile(s, parsePeriod("2020-01-01", null), { version: VERSION });
  const md = renderAuditMarkdown(x, "de");
  assert.ok(md.includes(`sha256:${x.signature.digest}`));
  assert.match(md, /Lesekopie/);
  for (const c of x.file.controls) assert.ok(md.includes(`| ${c.id} |`), c.id);
  assert.ok(md.includes("AI policy \\| v2"), "a pipe in a title never breaks the table");
  assert.match(md, /scenaria audit-file verify/);
  const en = renderAuditMarkdown(x, "en");
  assert.match(en, /reading copy/);
});

test("C4a: anyone can check the file without a project or keys; signing is the person's", async () => {
  const { p, s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const dir = mkdtempSync(join(tmpdir(), "auditor-"));
  writeFileSync(join(dir, "akte.json"), JSON.stringify(x, null, 2));
  const env = { ...process.env, SCENARIA_HOME: mkdtempSync(join(tmpdir(), "auditor-home-")) };
  let r = spawnSync(process.execPath, [CLI, "audit-file", "verify", "akte.json", "--json"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.valid, true);
  assert.equal(out.keyTrustedHere, false, "an auditor's machine does not know the key: confirm it with the person");
  const bad = clone(x);
  bad.file.summary.partly += 1;
  writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
  r = spawnSync(process.execPath, [CLI, "audit-file", "verify", "bad.json"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /NOT VALID/);
  // With openssl, if present: the signed bytes and the key check out with a standard tool too.
  const has = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (has.status === 0) {
    const der = Buffer.from(x.signature.pub, "base64");
    const pem = `-----BEGIN PUBLIC KEY-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;
    writeFileSync(join(dir, "pub.pem"), pem);
    writeFileSync(join(dir, "signed.txt"), x.signature.signed);
    writeFileSync(join(dir, "sig.bin"), Buffer.from(x.signature.sig, "base64"));
    const o = spawnSync("openssl", ["pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", "pub.pem", "-in", "signed.txt", "-sigfile", "sig.bin"], { cwd: dir, encoding: "utf8" });
    if (!/unknown option|-rawin/.test(o.stderr)) assert.match(o.stdout + o.stderr, /Signature Verified Successfully/);
  }
  // Signing: an agent's shell is refused; over HTTP only the approval session.
  r = spawnSync(process.execPath, [CLI, "audit-file", "export", "--out-dir", dir], { cwd: p.dir, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Signing the audit file is the person's/);
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, h) => fetch(base + "/api/audit-file/export", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({}, { "x-scenaria": "1", "x-scenaria-agent": "codex" })).status, 403);
    const ok = await post({ names: "roles-only", lang: "en" }, { "x-scenaria": "1", cookie: "scenaria_approval=sess" });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(verifyAuditExport(j.export).valid, true);
    assert.equal(j.export.names, "roles-only");
    assert.match(j.markdown, /reading copy/);
    assert.equal((await post({ from: "soon" }, { "x-scenaria": "1", cookie: "scenaria_approval=sess" })).status, 400);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ review of C4a (C4a-1 … C4a-9)

import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { parseStrictJson } from "../dist/core/auditexport.js";

/** An export signed with someone else's key (what an attacker can always make). */
function selfSigned(body) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const digest = bodyDigest(body);
  const signed = JSON.stringify([body.context.projectId, "audit-export/v1", digest]);
  const keyId = createHash("sha256").update(pub).digest("hex").slice(0, 12);
  return { ...body, signature: { alg: "Ed25519", digest, projectId: body.context.projectId, keyId, pub, sig: edSign(null, Buffer.from(signed), privateKey).toString("base64"), signed } };
}

test("C4a-1: a signature of another record (a project rule) never passes as the audit file's", () => {
  const { p, s } = project();
  s.addRule("Write a test for every bug fix", "manual", undefined, { by: "kev", via: "terminal" });
  const rule = JSON.parse(readFileSync(join(p.dir, ".scenaria/memory.json"), "utf8")).rules[0];
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const { signature, ...body } = clone(x);
  body.file.summary.partly = 38;
  const digest = bodyDigest(body);
  const forged = { ...body, signature: { ...signature, digest, sig: rule.sig, signed: JSON.stringify([signature.projectId, "rule/v1", rule.rev, rule.id, rule.text, rule.status, rule.decidedBy, rule.decidedVia, rule.decidedAt]) } };
  assert.match(verifyAuditExport(forged).problem, /signed text does not belong/);
  const y = clone(x);
  y.signature.alg = "RSA";
  assert.match(verifyAuditExport(y).problem, /algorithm/);
});

test("C4a-2/7: nothing from the file reaches the terminal unchecked; a damaged tamper evidence is said plainly", () => {
  const { p, s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const { signature: _s, ...body } = clone(x);
  body.file.integrity.state = "ok\u001b[2K\r key b9e852395f4e (trusted on this machine)";
  const evil = selfSigned(body);
  assert.match(verifyAuditExport(evil).problem, /tamper-evidence state/);
  const dir = mkdtempSync(join(tmpdir(), "auditor2-"));
  writeFileSync(join(dir, "evil.json"), JSON.stringify(evil));
  let r = spawnSync(process.execPath, [CLI, "audit-file", "verify", "evil.json"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.ok(!(r.stdout + r.stderr).includes("\u001b[2K"), "no escape sequence from the file");
  // A project whose tamper evidence is damaged: the signed file says so, and verify says it loudly.
  callToolEdit(p);
  const y = exportAuditFile(Scenaria.open(p.dir), { from: null, to: null }, { version: VERSION });
  writeFileSync(join(dir, "alarm.json"), JSON.stringify(y));
  r = spawnSync(process.execPath, [CLI, "audit-file", "verify", "alarm.json"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DAMAGED tamper evidence/);
});

function callToolEdit(p) {
  const nodes = join(p.dir, ".scenaria/nodes");
  const f = join(nodes, "n2.json");
  const n = JSON.parse(readFileSync(f, "utf8"));
  n.title = "changed by hand";
  writeFileSync(f, JSON.stringify(n));
}

test("C4a-3: duplicate keys, __proto__ keys and numbers out of range are refused, whatever the signature", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const text = JSON.stringify(x);
  assert.equal(verifyAuditExport(text).valid, true);
  assert.match(verifyAuditExport(text.replace('"state":"ok"', '"state":"ok","state":"alarm"')).problem, /duplicate key/);
  assert.match(verifyAuditExport(text.replace('"names":"with-names"', '"names":"with-names","__proto__":{"x":1}')).problem, /forbidden key/);
  assert.match(verifyAuditExport(text.replace('"to":null', '"to":1e999')).problem, /out of range/);
  assert.throws(() => parseStrictJson('{"a":1} x'), /unexpected text/);
  assert.deepEqual({ ...parseStrictJson('{"a":[1,2.5,"x\\"y"],"b":null}') }, { a: [1, 2.5, 'x"y'], b: null });
});

test("C4a-4/6: recorded text cannot become Markdown; roles only drops technical messages and every 'by'", () => {
  const { p, s } = project();
  s.checkpoint({ title: "![](https://evil.example/beacon.png) **ALL 38 CONTROLS EVIDENCED** a\\|b [x](https://evil.example)", outputs: [], agent: "codex" });
  const last = s.store.listNodes().at(-1);
  s.verify(last.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
  s.verify(last.id, { status: "failed", origin: "person", via: "terminal", by: "kev" });
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const md = renderAuditMarkdown(x, "en");
  assert.ok(!md.includes("![]("), "no image");
  assert.ok(!md.includes("**ALL 38"), "no emphasis from recorded text");
  assert.ok(!md.includes("](https://evil"), "no link from recorded text");
  assert.ok(md.includes("\\!\\[\\]\\(https://evil.example/beacon.png\\)"));
  // Roles only: no technical messages, no names in any 'by'.
  callToolEdit(p);
  const r = exportAuditFile(Scenaria.open(p.dir), { from: null, to: null }, { names: "roles-only", version: VERSION });
  assert.ok(r.file.integrity.warnings.length > 0);
  assert.ok(r.file.integrity.warnings.every((w) => w.details.length === 0));
  const bys = JSON.stringify(r).match(/"by":"[^"]*"/g) ?? [];
  assert.ok(bys.every((b) => !/kev/.test(b)), bys.join(" "));
});

test("C4a-5: the export checks the folder before signing and never writes over an existing file", () => {
  const { p } = project();
  const r = spawnSync(process.execPath, [CLI, "audit-file", "export", "--out-dir", join(p.dir, "missing")], { cwd: p.dir, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not a folder/);
  const events = readFileSync(join(p.dir, ".scenaria/events.jsonl"), "utf8");
  assert.ok(!events.includes("audit file exported and signed"), "nothing was signed");
});

test("C4a review round 2: canonical numbers only, well-formed text, no extra signature fields, no math, plain files only", () => {
  const { s } = project();
  const x = exportAuditFile(s, { from: null, to: null }, { version: VERSION });
  const text = JSON.stringify(x);
  assert.match(verifyAuditExport(text.replace('"version":1', '"version":1.0000000000000001')).problem, /canonical spelling/);
  assert.match(verifyAuditExport(text.replace('"names":"with-names"', '"names":"with-names","z":"\\ud800"')).problem, /lone surrogate/);
  const y = clone(x);
  y.signature.x = "rides along";
  assert.match(verifyAuditExport(y).problem, /unknown field/);
  s.checkpoint({ title: "$\\color{red}{ALL OK}$", outputs: [], agent: "codex" });
  const last = s.store.listNodes().at(-1);
  s.verify(last.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
  s.verify(last.id, { status: "failed", origin: "person", via: "terminal", by: "kev" });
  const md = renderAuditMarkdown(exportAuditFile(s, { from: null, to: null }, { version: VERSION }), "en");
  assert.ok(md.includes("\\$\\\\color\\{red\\}\\{ALL OK\\}\\$"), "every $ and brace escaped: no math from recorded text");
  const dir = mkdtempSync(join(tmpdir(), "auditor3-"));
  const r = spawnSync(process.execPath, [CLI, "audit-file", "verify", dir], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /not a plain file/i);
});
