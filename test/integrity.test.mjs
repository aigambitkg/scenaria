// Batch A (rule 11): only the person or a registered, independent audit agent can verify a step or
// reset the tamper evidence. A working agent can report, never certify or reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempProject, importPath } from "./helpers.mjs";
import { Scenaria } from "../dist/core/engine.js";
import { callTool } from "../dist/tools.js";
import { createApp } from "../dist/server.js";
import { projectMetrics } from "../dist/core/analysis.js";
import { checkExpectations } from "../dist/core/workspace.js";
import { addAuditor, auditorKeygen, buildAuditorRequest, listAuditors, removeAuditor, signAuditorRequest } from "../dist/core/auditors.js";
import { ownApproverKey } from "../dist/core/canon.js";
import { ledgerAnchorFile } from "../dist/core/seal.js";
import { isConfirmedPass } from "../dist/core/verdict.js";
import { contentHash as contentHashOf } from "../dist/core/ledger.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const cli = (dir, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env } });
const agent = { source: "mcp", agent: "claude-code" };

function project() {
  const p = tempProject();
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  const d = s.decide({ question: "Which store?", options: ["files", "db"], chosen: "files", rationale: "simple" });
  p.write("b.txt", "2");
  const cp = s.checkpoint({ title: "stored", outputs: ["`b.txt` written"] });
  return { p, s: Scenaria.open(p.dir), d, cp };
}

/** A key pair for an audit agent in its own folder (outside every project), registered by "the person". */
function auditor(name = "Prüfagent") {
  const dir = mkdtempSync(join(tmpdir(), "scenaria-auditor-"));
  const k = auditorKeygen(dir);
  addAuditor(k.pub, name);
  return { ...k, pem: readFileSync(k.keyFile, "utf8") };
}

// ------------------------------------------------------------------ verdicts carry their origin

test("an agent's 'passed' is self-reported: recorded, never counts as verified; a 'failed' always counts", () => {
  const { s, cp, d } = project();
  const r = callTool(s, "scenaria_verify", { id: cp.id, status: "passed", notes: "looks fine to me" }, agent);
  assert.match(r.text, /self-reported/);
  const n = s.node(cp.id);
  assert.equal(n.verification.status, "passed");
  assert.equal(n.verification.origin, "agent");
  assert.equal(isConfirmedPass(n.verification), false);
  assert.equal(s.lastGood(), null);
  assert.equal(s.status().counts.verified, 0);
  assert.equal(s.status().counts.selfReported, 1);
  const m = projectMetrics(s);
  assert.equal(m.counts.passed, 0);
  assert.ok(m.issues.some((i) => i.code === "self_reported" && i.value === 1));
  assert.equal(checkExpectations(s, [`${cp.id} verified`])[0].status, "unknown");
  assert.match(s.treeText(), /✔\?/);
  // A failure from an agent counts: a self-report may lower trust, never raise it.
  callTool(s, "scenaria_verify", { id: d.id, status: "failed", notes: "wrong library" }, agent);
  assert.ok(projectMetrics(s).issues.some((i) => i.code === "built_on_failure"));
});

test("the person's verdict counts; a verdict from before origins existed (legacy) does not", () => {
  const { p, s, cp } = project();
  const v = s.verify(cp.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
  assert.equal(v.verification.origin, "person");
  assert.equal(v.verification.via, "terminal");
  assert.equal(s.lastGood().id, cp.id);
  assert.equal(s.status().counts.verified, 1);
  // Simulate an old node file: a "passed" without an origin.
  const f = join(p.dir, ".scenaria/nodes", `${cp.id}.json`);
  const raw = JSON.parse(readFileSync(f, "utf8"));
  delete raw.verification.origin;
  raw.verification.by = "dashboard";
  writeFileSync(f, JSON.stringify(raw));
  const s2 = Scenaria.open(p.dir);
  assert.equal(isConfirmedPass(s2.node(cp.id).verification), false);
  assert.equal(s2.lastGood(), null);
});

test("an automatic 'passed' (deterministic checks only) is not a verdict that counts", () => {
  const { s, cp } = project();
  const v = s.verify(cp.id);
  assert.equal(v.verification.status, "passed");
  assert.equal(v.verification.origin, "auto");
  assert.equal(s.lastGood(), null);
  assert.ok(!projectMetrics(s).issues.some((i) => i.code === "self_reported"), "automatic checks are not reported as an agent's self-report");
});

test("CLI: a verdict from a shell without a terminal is self-reported", () => {
  const { p, cp } = project();
  const r = cli(p.dir, ["verify", cp.id, "--status", "passed"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-reported/);
  const s = Scenaria.open(p.dir);
  assert.equal(s.node(cp.id).verification.origin, "agent");
  assert.equal(s.lastGood(), null);
});

test("HTTP: a verdict needs the approval session; without it only the automatic checks run", async () => {
  const { s, cp } = project();
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, h = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: JSON.stringify(body) });
  try {
    const no = await post("/api/verify", { id: cp.id, status: "passed" });
    assert.equal(no.status, 403);
    assert.equal((await no.json()).code, "approval_required");
    assert.equal(Scenaria.open(s.root).node(cp.id).verification, undefined);
    const auto = await post("/api/verify", { id: cp.id, auto: true });
    assert.equal(auto.status, 200);
    assert.equal((await auto.json()).verification.origin, "auto");
    const yes = await post("/api/verify", { id: cp.id, status: "passed" }, { cookie: "scenaria_approval=sess" });
    assert.equal(yes.status, 200);
    const n = await yes.json();
    assert.equal(n.verification.origin, "person");
    assert.equal(n.verification.via, "dashboard");
    // Registering an audit agent is the person's too.
    const k = auditorKeygen(mkdtempSync(join(tmpdir(), "scenaria-auditor-")));
    assert.equal((await post("/api/auditors/add", { pub: k.pub, name: "x" })).status, 403);
    assert.equal((await post("/api/auditors/remove", { id: k.id })).status, 403);
    const added = await post("/api/auditors/add", { pub: k.pub, name: "via dashboard" }, { cookie: "scenaria_approval=sess" });
    assert.equal(added.status, 200);
    assert.ok((await (await fetch(`${base}/api/auditors`)).json()).auditors.some((a) => a.id === k.id));
    removeAuditor(k.id);
  } finally {
    app.close();
    server.close();
  }
});

// ------------------------------------------------------------------ resealing is the person's (or a registered audit agent's)

test("reseal: refused without an authority (engine), from an agent's shell (CLI) and through every tool", () => {
  const { p, s } = project();
  const before = readFileSync(join(p.dir, ".scenaria/ledger.jsonl"), "utf8");
  assert.throws(() => s.reseal(), /person's action/);
  assert.throws(() => s.reseal({ kind: "agent" }), /person's action/);
  const r = cli(p.dir, ["integrity", "--reseal"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /person's action/);
  assert.throws(() => callTool(s, "scenaria_auditor_submit", { request: { payload: "{}", pub: "AAAA", sig: "AAAA" } }, agent), /not a registered audit agent|signature/);
  assert.equal(readFileSync(join(p.dir, ".scenaria/ledger.jsonl"), "utf8"), before, "the ledger was not touched");
  assert.ok(!existsSync(join(p.dir, ".scenaria/reseals")));
});

test("the person's reseal is recorded, signed and anchored outside the project", () => {
  const { p, s } = project();
  const r = s.reseal({ kind: "person", via: "terminal" }, { user: "kev" });
  assert.equal(r.record.kind, "person");
  assert.equal(r.record.verified, true);
  assert.ok(r.record.sig && r.record.pub);
  assert.ok(existsSync(join(p.dir, ".scenaria", r.archived)), "the old ledger is kept");
  const anchor = JSON.parse(readFileSync(ledgerAnchorFile(p.dir), "utf8"));
  assert.equal(anchor.reseals.length, 1);
  assert.equal(anchor.genesis, r.record.newGenesis);
  const i = s.integrity();
  assert.deepEqual(i.resealsUnproven, []);
  assert.equal(i.reseals.length, 1);
  assert.ok(projectMetrics(s).issues.some((x) => x.code === "resealed"));
  // Deleting or editing the record afterwards is reported.
  const rec = join(p.dir, ".scenaria/reseals", `${r.record.id}.json`);
  const raw = JSON.parse(readFileSync(rec, "utf8"));
  raw.by = "someone else";
  writeFileSync(rec, JSON.stringify(raw));
  assert.deepEqual(s.integrity().resealsUnproven, [r.record.id]);
  rmSync(rec);
  assert.deepEqual(s.integrity().resealsUnproven, [r.record.id]);
  assert.ok(projectMetrics(s).issues.some((x) => x.code === "reseal_unproven" && x.severity === "high"));
});

test("deleting the ledger AND its marker file no longer makes Scenaria reseal silently", () => {
  const { p, s, cp } = project();
  s.integrity(); // anchors this ledger (trust on first use)
  rmSync(join(p.dir, ".scenaria/ledger.jsonl"));
  rmSync(join(p.dir, ".scenaria/ledger.sealed"));
  const s2 = Scenaria.open(p.dir);
  assert.ok(!existsSync(join(p.dir, ".scenaria/ledger.jsonl")), "no silent seal on open");
  assert.equal(s2.integrity().ledgerMissing, true);
  // A later write starts a new ledger: it is not the anchored one.
  s2.update(cp.id, { title: "stored (edited)" });
  const i = s2.integrity();
  assert.equal(i.ledgerReplaced, true);
  assert.ok(projectMetrics(s2).issues.some((x) => x.code === "ledger_replaced" && x.severity === "high"));
});

test("a hand-made fresh ledger (same format, new chain) is reported as replaced", () => {
  const { p, s } = project();
  s.integrity();
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  const lines = readFileSync(lf, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // An agent rewrites the ledger: same nodes, recomputed chain from a new timestamp.
  renameSync(lf, lf + ".gone");
  const s2 = Scenaria.open(p.dir);
  const nodes = s2.store.listNodes();
  s2.ledger.append(nodes.map((n) => ({ id: n.id, hash: lines.find((l) => l.id === n.id)?.hash ?? "x", op: "seal" })));
  assert.equal(s2.integrity().ledgerReplaced, true);
});

// ------------------------------------------------------------------ the registered audit agent

test("audit agent: its signed verdict counts; replay, other node, edited payload and unregistered keys are refused", () => {
  const { s, cp, d } = project();
  const a = auditor();
  const payload = buildAuditorRequest(s.store, { action: "verdict", node: cp.id, status: "passed", notes: "files and claims match" });
  const env = signAuditorRequest(payload, a.pem);
  const r = callTool(s, "scenaria_auditor_submit", { request: env }, agent);
  assert.match(r.text, /verified by audit agent Prüfagent/);
  const n = s.node(cp.id);
  assert.equal(n.verification.origin, "auditor");
  assert.equal(n.verification.auditor.keyId, a.id);
  assert.equal(n.verification.notes, "files and claims match");
  assert.equal(s.lastGood().id, cp.id);
  // Replay: the node changed (it now carries the verdict), so the same request no longer fits.
  assert.throws(() => s.applyAuditorRequest(env), /already used|changed after the request/);
  // Another node: the request names cp, not d.
  const forD = JSON.parse(payload);
  forD.verdict.node = d.id;
  assert.throws(() => s.applyAuditorRequest({ ...env, payload: JSON.stringify(forD) }), /signature does not match/);
  // An edited status breaks the signature.
  const p2 = buildAuditorRequest(s.store, { action: "verdict", node: d.id, status: "failed" });
  const env2 = signAuditorRequest(p2, a.pem);
  assert.throws(() => s.applyAuditorRequest({ ...env2, payload: env2.payload.replace('"failed"', '"passed"') }), /signature does not match/);
  // A key that the person never registered.
  const rogue = auditorKeygen(mkdtempSync(join(tmpdir(), "scenaria-rogue-")));
  assert.throws(() => s.applyAuditorRequest(signAuditorRequest(p2, readFileSync(rogue.keyFile, "utf8"))), /not a registered audit agent/);
  removeAuditor(a.id);
  assert.throws(() => s.applyAuditorRequest(env2), /not a registered audit agent/);
});

test("audit agent: expired, future-dated and foreign-project requests are refused", () => {
  const one = project();
  const other = project();
  const a = auditor();
  const base = JSON.parse(buildAuditorRequest(one.s.store, { action: "verdict", node: one.cp.id, status: "passed" }));
  const old = signAuditorRequest(JSON.stringify({ ...base, at: new Date(Date.now() - 25 * 3600_000).toISOString() }), a.pem);
  assert.throws(() => one.s.applyAuditorRequest(old), /older than 24 hours/);
  const future = signAuditorRequest(JSON.stringify({ ...base, at: new Date(Date.now() + 3600_000).toISOString() }), a.pem);
  assert.throws(() => one.s.applyAuditorRequest(future), /future/);
  const env = signAuditorRequest(JSON.stringify(base), a.pem);
  assert.throws(() => other.s.applyAuditorRequest(env), /another project/);
  removeAuditor(a.id);
});

test("audit agent: a reseal by signed request is recorded; a stale request (ledger moved on) is refused", () => {
  const { p, s, cp } = project();
  const a = auditor("CI-Prüfer");
  const stale = signAuditorRequest(buildAuditorRequest(s.store, { action: "reseal" }), a.pem);
  s.update(cp.id, { title: "moved on" });
  assert.throws(() => s.applyAuditorRequest(stale), /ledger changed after the request/);
  const env = signAuditorRequest(buildAuditorRequest(s.store, { action: "reseal" }), a.pem);
  const r = cli(p.dir, ["auditor", "submit"], JSON.stringify(env));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Resealed .* by the audit agent/);
  const s2 = Scenaria.open(p.dir);
  const i = s2.integrity();
  assert.equal(i.reseals.length, 1);
  assert.equal(i.reseals[0].kind, "auditor");
  assert.deepEqual(i.resealsUnproven, []);
  assert.equal(i.ledgerReplaced, false);
  removeAuditor(a.id);
});

test("audit keys: never inside a project or Scenaria's config; the person's own approver key cannot be an audit agent", () => {
  const { p } = project();
  assert.throws(() => auditorKeygen(join(p.dir, "keys")), /must not live in a Scenaria project/);
  assert.throws(() => auditorKeygen(join(process.env.SCENARIA_HOME, "auditor")), /Scenaria's own config folder/);
  const own = ownApproverKey();
  assert.throws(() => addAuditor(own.pub, "me"), /your own approver key/);
  assert.throws(() => addAuditor("not a key"), /Not an Ed25519 public key/);
  // CLI: registering is the person's (interactive terminal only).
  const k = auditorKeygen(mkdtempSync(join(tmpdir(), "scenaria-auditor-")));
  const r = cli(p.dir, ["auditor", "add", k.pubFile, "--name", "sneaky"]);
  assert.notEqual(r.status, 0);
  assert.ok(!listAuditors().some((x) => x.id === k.id));
});

test("audit agent: a request signed with plain openssl (no Scenaria code) is accepted", (t) => {
  const probe = spawnSync("openssl", ["pkeyutl", "-help"], { encoding: "utf8" });
  if (probe.error || !/rawin/.test(probe.stdout + probe.stderr)) return t.skip("openssl without -rawin (Ed25519) on this machine");
  const { s, cp } = project();
  const a = auditor("openssl");
  const dir = mkdtempSync(join(tmpdir(), "scenaria-openssl-"));
  const payload = buildAuditorRequest(s.store, { action: "verdict", node: cp.id, status: "passed" });
  writeFileSync(join(dir, "payload.json"), payload);
  const sig = spawnSync("openssl", ["pkeyutl", "-sign", "-rawin", "-inkey", a.keyFile, "-in", join(dir, "payload.json")]);
  assert.equal(sig.status, 0, String(sig.stderr));
  s.applyAuditorRequest({ payload, pub: readFileSync(a.pubFile, "utf8").trim(), sig: Buffer.from(sig.stdout).toString("base64") });
  assert.equal(s.node(cp.id).verification.origin, "auditor");
  removeAuditor(a.id);
});

test("tests never write to the real home config", () => {
  assert.match(process.env.SCENARIA_HOME ?? "", /scenaria-home-/);
});

// ------------------------------------------------------------------ review K1–K11 (regression tests)

const nodeFile = (p, id) => join(p.dir, ".scenaria/nodes", `${id}.json`);
const editNode = (p, id, fn) => {
  const raw = JSON.parse(readFileSync(nodeFile(p, id), "utf8"));
  fn(raw);
  writeFileSync(nodeFile(p, id), JSON.stringify(raw));
};

test("K1: a verdict edited into a node file never counts — and a later normal write does not launder it", () => {
  const { p, s, cp } = project();
  callTool(s, "scenaria_verify", { id: cp.id, status: "passed" }, agent);
  editNode(p, cp.id, (n) => (n.verification.origin = "person"));
  assert.equal(s.integrity().state.get(cp.id), "tampered");
  assert.equal(s.lastGood(), null);
  assert.equal(s.status().counts.verified, 0);
  // Any write through Scenaria (here: a rewind lesson on that node) must not wash the edit clean.
  s.update(cp.id, { summary: "ok" });
  callTool(s, "scenaria_rewind", { id: cp.id, lesson: "keep going" }, agent);
  const i = s.integrity();
  assert.equal(i.state.get(cp.id), "tampered");
  assert.equal(i.confirmed.has(cp.id), false);
  assert.equal(s.lastGood(), null);
  assert.ok(projectMetrics(s).issues.some((x) => x.code === "tampered" && x.nodeId === cp.id));
});

test("K1: an 'auditor' verdict without a valid request, or a person verdict signed by an unknown key, does not count", () => {
  const { p, s, cp, d } = project();
  editNode(p, cp.id, (n) => (n.verification = { status: "passed", origin: "auditor", at: new Date().toISOString(), auditor: { keyId: "x", request: { payload: "{}", pub: "AAAA", sig: "AAAA" } } }));
  assert.equal(s.integrity().state.get(cp.id), "tampered");
  // A valid signature, but from a key this machine does not trust (a throwaway key the agent made).
  const v = s.verify(d.id, { status: "passed", origin: "person", via: "terminal" });
  assert.ok(s.integrity().confirmed.has(d.id), "the real person's verdict counts");
  const rogue = auditorKeygen(mkdtempSync(join(tmpdir(), "scenaria-rogue-")));
  const env = signAuditorRequest(JSON.stringify(["x"]), readFileSync(rogue.keyFile, "utf8"));
  editNode(p, d.id, (n) => {
    n.verification.pub = env.pub; // not the approver key: the signature no longer verifies → forged
  });
  assert.equal(s.integrity().confirmed.has(d.id), false);
  assert.ok(v.verification.sig, "the person's verdict is signed");
});

test("K2: an agent can never replace the person's verdict; its report sits next to it and only a negative one lowers the outcome", () => {
  const { s, d, cp } = project();
  s.verify(d.id, { status: "failed", notes: "wrong library", origin: "person", via: "terminal" });
  callTool(s, "scenaria_verify", { id: d.id, status: "passed", notes: "all good now" }, agent);
  callTool(s, "scenaria_verify", { id: d.id }, agent); // automatic checks
  const n = s.node(d.id);
  assert.equal(n.verification.status, "failed");
  assert.equal(n.verification.origin, "person");
  assert.equal(n.verification.report, undefined, "a better self-report is not even attached to a failure");
  assert.ok(projectMetrics(s).issues.some((x) => x.code === "built_on_failure"));
  assert.equal(checkExpectations(s, [`${d.id} failed`])[0].status, "confirmed");
  // A person's pass, then an agent reports a failure: the outcome is lowered, the person's verdict stays.
  s.verify(cp.id, { status: "passed", origin: "person", via: "terminal" });
  assert.ok(s.integrity().confirmed.has(cp.id));
  callTool(s, "scenaria_verify", { id: cp.id, status: "failed", notes: "tests break" }, agent);
  const c = s.node(cp.id);
  assert.equal(c.verification.origin, "person");
  assert.equal(c.verification.report.status, "failed");
  assert.equal(s.integrity().confirmed.has(cp.id), false);
  assert.equal(s.lastGood(), null);
  assert.equal(projectMetrics(s).counts.failed, 2);
});

test("K3: SCENARIA_HOME inside a project is ignored; an audit agent registered in another home does not count here", () => {
  const { p, s, cp } = project();
  const inside = join(p.dir, ".scenaria", "fake-home");
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `import { globalConfigPath } from ${importPath(join(import.meta.dirname, "..", "dist", "core", "global.js"))}; console.log(globalConfigPath());`], { encoding: "utf8", env: { ...process.env, SCENARIA_HOME: inside } });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(!probe.stdout.includes(inside), `trust material must not come from inside the project: ${probe.stdout}`);
  // An agent uses its own home OUTSIDE the project with its own registry: the verdict is recorded there…
  const otherHome = mkdtempSync(join(tmpdir(), "scenaria-otherhome-"));
  const k = auditorKeygen(mkdtempSync(join(tmpdir(), "scenaria-auditor-")));
  const env = { ...process.env, SCENARIA_HOME: otherHome };
  const reg = spawnSync(process.execPath, ["--input-type=module", "-e", `import { addAuditor } from ${importPath(join(import.meta.dirname, "..", "dist", "core", "auditors.js"))}; addAuditor(${JSON.stringify(k.pub)}, "own");`], { encoding: "utf8", env });
  assert.equal(reg.status, 0, reg.stderr);
  const req = spawnSync(process.execPath, [CLI, "auditor", "request", "verdict", cp.id, "--status", "passed"], { cwd: p.dir, encoding: "utf8", env });
  const signed = signAuditorRequest(req.stdout.trim(), readFileSync(k.keyFile, "utf8"));
  const sub = spawnSync(process.execPath, [CLI, "auditor", "submit"], { cwd: p.dir, encoding: "utf8", env, input: JSON.stringify(signed) });
  assert.equal(sub.status, 0, sub.stderr);
  // …but in the person's own view it does not count, and it is reported.
  const i = Scenaria.open(p.dir).integrity();
  assert.equal(i.confirmed.has(cp.id), false);
  assert.deepEqual(i.verdictsUntrusted, [cp.id]);
  assert.ok(projectMetrics(Scenaria.open(p.dir)).issues.some((x) => x.code === "verdict_untrusted" && x.severity === "high"));
});

test("K4: a reseal request is bound to the exact node contents and can be used only once", () => {
  const { p, s, cp } = project();
  const a = auditor("CI");
  const env = signAuditorRequest(buildAuditorRequest(s.store, { action: "reseal" }), a.pem);
  assert.equal(JSON.parse(env.payload).nodes.count, s.store.listNodes().length);
  editNode(p, cp.id, (n) => (n.outputs = ["something else"]));
  assert.throws(() => s.applyAuditorRequest(env), /nodes changed|ledger changed/);
  // With honest contents it works once; replaying it (even after restoring the old ledger) is refused.
  editNode(p, cp.id, (n) => (n.outputs = ["`b.txt` written"]));
  const env2 = signAuditorRequest(buildAuditorRequest(s.store, { action: "reseal" }), a.pem);
  const r = s.applyAuditorRequest(env2);
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  rmSync(lf);
  renameSync(join(p.dir, ".scenaria", r.archived), lf);
  assert.throws(() => s.applyAuditorRequest(env2), /already used/);
  removeAuditor(a.id);
});

test("K5: truncating, rewriting, extending or rolling back the ledger is reported (high-water mark outside the project)", () => {
  const { p, s, cp } = project();
  s.update(cp.id, { title: "two" });
  s.update(cp.id, { title: "three" });
  assert.equal(s.integrity().ledgerDiverged, null);
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  const full = readFileSync(lf, "utf8");
  // Truncate (keep the genesis).
  writeFileSync(lf, full.trim().split("\n").slice(0, -2).join("\n") + "\n");
  assert.ok(s.integrity().ledgerDiverged, "truncation");
  assert.ok(projectMetrics(s).issues.some((x) => x.code === "ledger_diverged" && x.severity === "high"));
  writeFileSync(lf, full);
  // A hand-appended, correctly chained line is caught as well.
  const { p: p2, s: s2, cp: cp2 } = project();
  editNode(p2, cp2.id, (n) => (n.title = "faked"));
  s2.ledger.append([{ id: cp2.id, hash: "f".repeat(32), op: "write" }]);
  assert.ok(s2.integrity().ledgerDiverged, "hand-appended line");
  // Rolling back the whole .scenaria folder to an earlier copy.
  const { p: p3, s: s3, d: d3 } = project();
  const backup = mkdtempSync(join(tmpdir(), "scenaria-backup-"));
  spawnSync("cp", ["-a", join(p3.dir, ".scenaria"), backup]);
  s3.verify(d3.id, { status: "failed", origin: "person", via: "terminal" });
  rmSync(join(p3.dir, ".scenaria"), { recursive: true, force: true });
  spawnSync("cp", ["-a", join(backup, ".scenaria"), p3.dir]);
  assert.ok(Scenaria.open(p3.dir).integrity().ledgerDiverged, "rollback");
});

test("K6: a reseal record signed by an unregistered key, or one this machine never saw, is unproven", () => {
  const { p, s } = project();
  s.integrity();
  const rogue = auditorKeygen(mkdtempSync(join(tmpdir(), "scenaria-rogue-")));
  const st = s.ledger.state();
  const payload = JSON.stringify({ v: "scenaria-auditor/v1", action: "reseal", project: "x", at: new Date().toISOString(), nonce: "n", ledger: { exists: true, lines: st.lines, head: st.head } });
  const req = signAuditorRequest(payload, readFileSync(rogue.keyFile, "utf8"));
  const dir = join(p.dir, ".scenaria/reseals");
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "rs1.json"), JSON.stringify({ id: "rs1", at: new Date().toISOString(), kind: "auditor", by: "auditor:CI-Prüfer", via: "signed request", archived: null, archivedLines: st.lines, archivedHead: st.head, newGenesis: st.genesis, nodes: 3, auditor: { keyId: rogue.id, request: req } }));
  const i = s.integrity();
  assert.deepEqual(i.resealsUnproven, ["rs1"]);
  assert.equal(i.reseals.length, 0);
});

test("K7: starting a new project in the same folder is no false alarm; the dashboard can reseal for the person", async () => {
  const { p } = project();
  Scenaria.open(p.dir).integrity();
  rmSync(join(p.dir, ".scenaria"), { recursive: true, force: true });
  const s = Scenaria.init(p.dir, { newProjectInFolder: true }); // the person confirmed "start a new project here"
  s.checkpoint({ title: "fresh start" });
  const i = s.integrity();
  assert.equal(i.ledgerReplaced, false);
  assert.equal(i.ledgerMissing, false);
  assert.equal(i.ledgerDiverged, null);
  assert.ok(i.restarted);
  const m = projectMetrics(s);
  assert.ok(m.issues.some((x) => x.code === "project_restarted" && x.severity === "low"));
  const alarms = (issues) => issues.filter((x) => /ledger|tamper|reseal|verdict/.test(x.code) && x.severity === "high");
  assert.deepEqual(alarms(m.issues), []);
  // Dashboard reseal: the person's only.
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, h = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: "{}" });
  try {
    assert.equal((await post("/api/integrity/reseal")).status, 403);
    const ok = await post("/api/integrity/reseal", { cookie: "scenaria_approval=sess" });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).record, /^rs\d+$/);
    assert.equal(Scenaria.open(p.dir).integrity().reseals[0].kind, "person");
  } finally {
    app.close();
    server.close();
  }
});

test("K9: the resume capsule and the board label a self-reported pass", () => {
  const { s, cp } = project();
  callTool(s, "scenaria_verify", { id: cp.id, status: "passed" }, agent);
  s.checkpoint({ title: "next" });
  assert.match(s.context().markdown, /self-reported — not verified/);
  assert.equal(callTool(s, "scenaria_get_node", { refs: [cp.id] }, agent).data?.[0]?.verification ?? "self-reported", "self-reported");
});

test("existing v0.9.1 projects open without alarms (no anchor yet: trust on first use)", () => {
  const { p, s, cp } = project();
  rmSync(ledgerAnchorFile(p.dir), { force: true }); // as if created by v0.9.1 (no anchor on this machine)
  callTool(s, "scenaria_verify", { id: cp.id, status: "passed" }, agent);
  const m = projectMetrics(Scenaria.open(p.dir));
  assert.deepEqual(m.issues.filter((x) => /ledger|tamper|reseal|verdict/.test(x.code) && x.severity === "high"), []);
  assert.ok(existsSync(ledgerAnchorFile(p.dir)));
});

// ------------------------------------------------------------------ re-review R1–R7 (regression tests)

test("R1: an agent cannot wipe the evidence by re-initialising; only the person starts a new project in the folder", async () => {
  const { p, s, d } = project();
  s.verify(d.id, { status: "failed", notes: "wrong", origin: "person", via: "terminal" });
  s.integrity();
  // The agent rewrites history, moves .scenaria aside, runs init (no terminal), and moves it back.
  editNode(p, d.id, (n) => { delete n.verification; n.title = "harmless"; });
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  rmSync(lf);
  const s0 = Scenaria.open(p.dir);
  s0.ledger.append(s0.store.listNodes().map((n) => ({ id: n.id, hash: "0".repeat(32), op: "seal" })));
  renameSync(join(p.dir, ".scenaria"), join(p.dir, ".scenaria-old"));
  const r = cli(p.dir, ["init"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /still anchored on this machine/);
  rmSync(join(p.dir, ".scenaria"), { recursive: true, force: true });
  renameSync(join(p.dir, ".scenaria-old"), join(p.dir, ".scenaria"));
  const i = Scenaria.open(p.dir).integrity();
  assert.ok(i.ledgerReplaced || i.ledgerDiverged, "the rewritten ledger is still caught");
  // A real fresh start by the person (confirmed) is clean.
  const q = tempProject();
  Scenaria.init(q.dir).checkpoint({ title: "a" });
  Scenaria.open(q.dir).integrity();
  rmSync(join(q.dir, ".scenaria"), { recursive: true, force: true });
  const agentInit = Scenaria.init(q.dir); // an agent's auto-init: the old anchor stays
  agentInit.checkpoint({ title: "b" });
  assert.equal(agentInit.integrity().ledgerReplaced, true);
  agentInit.reseal({ kind: "person", via: "dashboard" }); // the person reviews and accepts
  const after = agentInit.integrity();
  assert.equal(after.ledgerReplaced, false);
  assert.deepEqual(after.resealsUnproven, []);
});

test("R2: a verdict covers exactly the work it was given on; a later change supersedes it", () => {
  const { s, d, cp } = project();
  s.verify(d.id, { status: "passed", origin: "person", via: "terminal" });
  const a = auditor("CI");
  s.applyAuditorRequest(signAuditorRequest(buildAuditorRequest(s.store, { action: "verdict", node: cp.id, status: "passed" }), a.pem));
  assert.deepEqual([...s.integrity().confirmed].sort(), [cp.id, d.id].sort());
  s.update(d.id, { rationale: "the person agreed to wipe production" });
  callTool(s, "scenaria_choose", { id: d.id, option: "db", rationale: "changed" }, agent);
  s.update(cp.id, { title: "Wipe prod" });
  const i = s.integrity();
  assert.deepEqual([...i.confirmed], []);
  assert.deepEqual(i.verdictsSuperseded.sort(), [cp.id, d.id].sort());
  assert.equal(s.lastGood(), null);
  assert.ok(projectMetrics(s).issues.some((x) => x.code === "verdict_superseded"));
  // Lessons a rewind attaches do not supersede (they are not the work).
  const { s: s2, cp: c2 } = project();
  s2.verify(c2.id, { status: "passed", origin: "person", via: "terminal" });
  s2.checkpoint({ title: "later" });
  s2.rewind(c2.id, { lesson: "keep this" });
  assert.ok(s2.integrity().confirmed.has(c2.id));
  removeAuditor(a.id);
});

test("R3: a later self-reported pass never lifts an earlier failed report (with or without the person's verdict)", () => {
  const { s, d, cp } = project();
  s.verify(cp.id, { status: "passed", origin: "person", via: "terminal" });
  callTool(s, "scenaria_verify", { id: cp.id, status: "failed", notes: "tests break" }, agent);
  callTool(s, "scenaria_verify", { id: cp.id, status: "passed", notes: "fixed, trust me" }, agent);
  assert.equal(s.node(cp.id).verification.report.status, "failed");
  assert.equal(s.integrity().confirmed.has(cp.id), false);
  callTool(s, "scenaria_verify", { id: d.id, status: "failed" }, agent);
  callTool(s, "scenaria_verify", { id: d.id, status: "passed" }, agent);
  assert.equal(s.node(d.id).verification.status, "failed");
  assert.equal(projectMetrics(s).counts.failed, 2);
  // The person (or a registered audit agent) can lift it.
  s.verify(d.id, { status: "passed", origin: "person", via: "terminal" });
  assert.ok(s.integrity().confirmed.has(d.id));
});

test("R4/R5: writes this machine did not track are named (extended, medium) and shown by scenaria integrity", () => {
  const { p, s, cp } = project();
  s.integrity();
  // An older Scenaria still running would append correctly chained lines without raising the mark.
  s.ledger.append([{ id: cp.id, hash: "a".repeat(32), op: "write" }]);
  const i = s.integrity();
  assert.equal(i.ledgerDiverged.kind, "extended");
  assert.deepEqual(i.ledgerDiverged.since, [cp.id]);
  const m = projectMetrics(s);
  assert.ok(m.issues.some((x) => x.code === "ledger_extended" && x.severity === "medium"));
  assert.ok(!m.issues.some((x) => x.code === "ledger_diverged"));
  const r = cli(p.dir, ["integrity"]);
  assert.match(r.stdout, /did not see/);
  const j = JSON.parse(cli(p.dir, ["integrity", "--json"]).stdout);
  assert.equal(j.data?.ledgerDiverged?.kind ?? j.ledgerDiverged?.kind, "extended");
});

test("R6: a write interrupted between the ledger and the node file heals with the next write (no false 'tampered')", () => {
  const { p, s, cp, d } = project();
  // Simulate the crash: the ledger has the new hash and the mark names cp as in flight, the node file is old.
  const before = JSON.parse(readFileSync(nodeFile(p, cp.id), "utf8"));
  s.update(cp.id, { title: "new title" });
  writeFileSync(nodeFile(p, cp.id), JSON.stringify(before)); // node file still the previous version
  const af = ledgerAnchorFile(p.dir);
  const a = JSON.parse(readFileSync(af, "utf8"));
  const lf = readFileSync(join(p.dir, ".scenaria/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  a.hw = { ...a.hw, pending: true, inflight: { id: cp.id, hash: lf[lf.length - 1].hash } };
  writeFileSync(af, JSON.stringify(a));
  assert.equal(s.integrity().state.get(cp.id), "ok", "interrupted write is tolerated");
  s.update(cp.id, { title: "new title" }); // the next write completes it
  s.update(d.id, { title: "other node" });
  assert.equal(s.integrity().state.get(cp.id), "ok");
});

test("R7: the board and the knowledge-base notes do not call a forged pass 'passed'", () => {
  const { p, s, cp } = project();
  editNode(p, cp.id, (n) => (n.verification = { status: "passed", origin: "person", at: new Date().toISOString(), by: "person" }));
  const items = callTool(s, "scenaria_workspace", { full: true }, agent).text;
  assert.doesNotMatch(items, new RegExp(`${cp.id}[^\\n]*\\[passed\\]`));
  s.update(cp.id, { summary: "x" }); // rewrites the note
  assert.match(readFileSync(join(p.dir, ".scenaria/kb", `${cp.id}.md`), "utf8"), /NOT CONFIRMED|does not count/);
});

// ------------------------------------------------------------------ round 3 (F1 + low items)

test("F1: removing the person's verdict by hand (with a correctly chained ledger line) is caught as high", () => {
  const { p, s, d } = project();
  s.verify(d.id, { status: "failed", notes: "wrong", origin: "person", via: "terminal" });
  editNode(p, d.id, (n) => delete n.verification);
  const n = JSON.parse(readFileSync(nodeFile(p, d.id), "utf8"));
  s.ledger.append([{ id: d.id, hash: contentHashOf(n), op: "write" }]); // the agent extends the chain itself
  const i = s.integrity();
  assert.deepEqual(i.verdictsRemoved, [d.id]);
  assert.equal(i.state.get(d.id), "tampered");
  const m = projectMetrics(s);
  assert.ok(m.issues.some((x) => x.code === "verdict_removed" && x.severity === "high"));
  // And a pass on a step written in such unseen lines does not count.
  const { p: p2, s: s2, cp: c2 } = project();
  s2.verify(c2.id, { status: "passed", origin: "person", via: "terminal" });
  editNode(p2, c2.id, (x) => (x.title = "changed by hand"));
  s2.ledger.append([{ id: c2.id, hash: contentHashOf(JSON.parse(readFileSync(nodeFile(p2, c2.id), "utf8"))), op: "write" }]);
  assert.equal(s2.integrity().confirmed.has(c2.id), false);
  assert.deepEqual(s2.integrity().unseenWrites, [c2.id]);
});

test("low: finishing a task the person verified does not supersede the verdict; an interrupted write stays tolerated after other writes", () => {
  const { s } = project();
  const g = s.startMission({ title: "Contact form", goal: "Enquiries reach sales" });
  s.checkpoint({ title: "form" });
  s.verify(g.id, { status: "passed", origin: "person", via: "terminal" });
  s.checkpoint({ title: "done", taskDone: true, summary: "all done" });
  assert.equal(s.node(g.id).status, "done");
  assert.ok(!s.integrity().verdictsSuperseded.includes(g.id));
  assert.ok(s.integrity().confirmed.has(g.id));
  const { p, s: s2, cp, d } = project();
  const before = JSON.parse(readFileSync(nodeFile(p, cp.id), "utf8"));
  s2.update(cp.id, { title: "new" });
  writeFileSync(nodeFile(p, cp.id), JSON.stringify(before));
  const af = ledgerAnchorFile(p.dir);
  const a = JSON.parse(readFileSync(af, "utf8"));
  const lines = readFileSync(join(p.dir, ".scenaria/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  a.hw = { ...a.hw, pending: true, inflight: { id: cp.id, hash: lines[lines.length - 1].hash } };
  writeFileSync(af, JSON.stringify(a));
  s2.update(d.id, { title: "other" }); // another write after the crash
  s2.update(d.id, { title: "other 2" });
  assert.equal(s2.integrity().state.get(cp.id), "ok");
  s2.update(cp.id, { title: "new" }); // completing the interrupted write
  assert.equal(s2.integrity().state.get(cp.id), "ok");
});
