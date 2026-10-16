// Batch C2: the ISO/IEC 42001 audit file computed from a project's real records.
// Kev's decisions (2026-10-16): whole project unless a period is chosen; a damaged tamper evidence warns
// clearly but lowers no status; only the person decides who may read the audit file (default: only them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { buildAuditFile, parsePeriod, INTEGRITY_RULES } from "../dist/core/auditfile.js";
import { readAuditAccess, setAuditAccess } from "../dist/core/auditaccess.js";
import { ANNEX_A_CONTROLS, EVIDENCE_SOURCES } from "../dist/core/iso42001.js";
import { globalConfigPath } from "../dist/core/global.js";
import { callTool } from "../dist/tools.js";
import { addAuditor, auditorKeygen, buildAuditorRequest, signAuditorRequest } from "../dist/core/auditors.js";
import { createApp } from "../dist/server.js";
import { tempProject } from "./helpers.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const agent = { agent: "codex", source: "mcp" };

function project() {
  const p = tempProject("auditfile-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API with tests", title: "Build the API", goal: "Endpoints and tests" });
  const d = s.decide({ question: "Which framework?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "faster", context: "new API", servesGoal: "small API", agent: "codex", model: "gpt-5" });
  p.write("a.txt", "2");
  const cp = s.checkpoint({ title: "API skeleton", outputs: ["`a.txt`"], agent: "codex", model: "gpt-5" });
  return { p, s, d, cp };
}
const ctl = (f, id) => f.controls.find((c) => c.id === id);
const nodeFile = (p, id) => join(p.dir, ".scenaria/nodes", `${id}.json`);
const editNode = (p, id, fn) => {
  const raw = JSON.parse(readFileSync(nodeFile(p, id), "utf8"));
  fn(raw);
  writeFileSync(nodeFile(p, id), JSON.stringify(raw));
};
const accessFile = () => join(dirname(globalConfigPath()), "audit-access.json");

test("C2: every Annex A control, status never above the catalogue's coverage, summary adds up", () => {
  const { s } = project();
  const f = buildAuditFile(s);
  assert.equal(f.kind, "scenaria/iso42001-audit-file");
  assert.equal(f.standard, "ISO/IEC 42001:2023");
  assert.deepEqual(f.controls.map((c) => c.id), ANNEX_A_CONTROLS.map((c) => c.id));
  const rank = { not_covered: 0, organisational: 1, partly: 2, evidenced: 3 };
  for (const c of f.controls) {
    const cat = ANNEX_A_CONTROLS.find((x) => x.id === c.id);
    assert.equal(c.coverage, cat.coverage, c.id);
    if (cat.coverage === "organisational") assert.equal(c.status, "organisational", c.id);
    else assert.ok(rank[c.status] <= rank[cat.coverage], `${c.id}: ${c.status} not above ${cat.coverage}`);
    // "not covered" says why, "partly" has every required source with data.
    if (c.status === "not_covered") assert.ok(c.missing.length > 0, c.id);
    if (c.status === "partly") assert.ok(c.required.every((r) => r.hasData), c.id);
  }
  const sum = f.summary;
  assert.equal(sum.partly + sum.not_covered + sum.organisational + sum.evidenced, 38);
  assert.equal(sum.organisational, 25);
  assert.equal(sum.evidenced, 0, "nothing claims full evidence");
  assert.deepEqual(Object.keys(f.sources).sort(), Object.keys(EVIDENCE_SOURCES).sort(), "every evidence source is evaluated");
  // Whole project by default (Kev's decision).
  assert.equal(f.period.whole, true);
  assert.equal(f.period.from, null);
  assert.ok(f.period.steps >= 3);
  // What the project has: decisions, checkpoints, snapshots, attribution, goal → A.6.2.3 and A.6.2.2 are partly.
  assert.equal(ctl(f, "A.6.2.3").status, "partly");
  assert.equal(ctl(f, "A.6.2.2").status, "partly");
  assert.deepEqual(f.sources.models.facts.models, ["gpt-5"]);
  // Without approvals or independent verdicts these stay "not covered".
  assert.equal(ctl(f, "A.3.2").status, "not_covered");
  assert.deepEqual(ctl(f, "A.3.2").missing, ["approvals", "verdicts"]);
  assert.equal(ctl(f, "A.6.2.4").status, "not_covered");
});

test("C2 rule 11: self-reported and automatic verdicts never carry a control; the person's verdict does", () => {
  const { s, d, cp } = project();
  callTool(s, "scenaria_verify", { id: cp.id, status: "passed", notes: "all good" }, agent); // self-report
  let f = buildAuditFile(s);
  assert.equal(f.sources.verdicts.count, 0, "a self-report is not an independent verdict");
  assert.equal(f.sources.verdicts.facts.agent, 1);
  assert.equal(f.sources.verdicts.facts.all, 1);
  assert.match(f.sources.verdicts.note.de, /Selbstauskünfte/);
  assert.equal(ctl(f, "A.6.2.4").status, "not_covered");
  // The person checks (interactive terminal / approval session in real use): signed, it carries A.6.2.4.
  s.verify(d.id, { status: "failed", notes: "wrong library", origin: "person", via: "terminal", by: "kev" });
  f = buildAuditFile(s);
  assert.equal(f.sources.verdicts.count, 1, "an independent check counts even when it failed");
  assert.equal(f.sources.verdicts.facts.confirmedPasses, 0, "but it is not a confirmed pass");
  assert.equal(ctl(f, "A.6.2.4").status, "partly");
  const a = f.approvals.find((x) => x.kind === "verdict");
  assert.deepEqual([a.ref, a.action, a.origin, a.via], [d.id, "failed", "person", "terminal"]);
  assert.ok(a.keyId, "the signing key is named");
});

test("C2: an edited verdict is no evidence; a damaged tamper evidence warns clearly but lowers no status", () => {
  const { p, s, cp } = project();
  const before = buildAuditFile(s);
  assert.equal(before.integrity.state, "ok");
  assert.match(before.integrity.headline.de, /intakt/);
  // An agent writes a "person" verdict into the node file.
  callTool(s, "scenaria_verify", { id: cp.id, status: "passed" }, agent);
  editNode(p, cp.id, (n) => (n.verification.origin = "person"));
  const f = buildAuditFile(s);
  assert.equal(f.sources.verdicts.count, 0, "the edited verdict does not count");
  assert.equal(f.integrity.state, "alarm");
  assert.match(f.integrity.headline.de, /^Achtung: Der Manipulationsnachweis ist beschädigt/);
  const w = f.integrity.warnings.find((x) => x.code === "tampered");
  assert.equal(w.level, "alarm");
  assert.deepEqual(w.items, [cp.id]);
  assert.ok(w.explain.de && w.explain.en && w.title.de && w.title.en);
  // Status stays (Kev's decision), but every control that uses an affected source carries the alarm.
  assert.equal(ctl(f, "A.6.2.3").status, ctl(before, "A.6.2.3").status);
  assert.equal(ctl(f, "A.6.2.3").alarm, true);
  assert.ok(ctl(f, "A.6.2.3").warnings.includes("tampered"));
  assert.equal(ctl(f, "A.3.3").alarm, false, "a control without sources is not affected");
  assert.equal(f.summary.withAlarm, f.controls.filter((c) => c.alarm).length);
  assert.ok(f.summary.withAlarm > 0);
  assert.ok(f.sources.decisions.warnings.includes("tampered"));
  assert.deepEqual(f.sources.ledger.facts.changedSteps, [cp.id]);
});

test("C2: signed approvals (fixed rules, project rules, reseals) are listed; edited rules no longer count", () => {
  const { p, s } = project();
  s.addCanonAsUser({ kind: "past", text: "Runs only in the EU" }, { user: "kev", via: "cli" });
  s.addRule("Write a test for every bug fix", "manual", undefined, { by: "kev", via: "terminal" });
  s.reseal({ kind: "person", via: "terminal" }, { user: "kev" });
  let f = buildAuditFile(s);
  const kinds = f.approvals.map((a) => a.kind);
  for (const k of ["canon", "rule", "reseal"]) assert.ok(kinds.includes(k), k);
  assert.ok(f.approvals.every((a) => a.origin === "person" || a.origin === "auditor"));
  assert.equal(f.reseals.authentic.length, 1);
  assert.deepEqual(f.reseals.unproven, []);
  assert.equal(f.sources.canon.count, 1);
  assert.equal(f.sources.rules.count, 1);
  assert.equal(ctl(f, "A.6.1.3").status, "partly", "decisions + signed approvals");
  assert.equal(ctl(f, "A.6.1.2").status, "partly", "goal + signed fixed rule");
  // Sorted by time.
  assert.deepEqual(f.approvals.map((a) => a.at), [...f.approvals.map((a) => a.at)].sort());
  // An agent edits the rule text: it is no longer the person's rule.
  const mf = join(p.dir, ".scenaria/memory.json");
  const mem = JSON.parse(readFileSync(mf, "utf8"));
  mem.rules[0].text = "Bug fixes need no tests";
  writeFileSync(mf, JSON.stringify(mem));
  f = buildAuditFile(s);
  assert.equal(f.sources.rules.count, 0);
  assert.ok(!f.approvals.some((a) => a.kind === "rule"));
  const w = f.integrity.warnings.find((x) => x.code === "rule_tampered");
  assert.equal(w.level, "alarm");
  assert.ok(f.sources.rules.warnings.includes("rule_tampered"));
});

test("C2: period filter — whole days in UTC, invalid input refused, data outside the period does not count", () => {
  assert.deepEqual(parsePeriod("2026-10-01", "2026-10-02"), { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T23:59:59.999Z" });
  assert.deepEqual(parsePeriod("", undefined), { from: null, to: null });
  assert.throws(() => parsePeriod("yesterday"), /not a date/);
  assert.throws(() => parsePeriod("2026-10-05", "2026-10-01"), /starts after it ends/);
  const { s } = project();
  s.addRule("Keep it small", "manual", undefined, { by: "kev", via: "terminal" });
  const future = buildAuditFile(s, parsePeriod("2999-01-01"));
  assert.equal(future.period.whole, false);
  assert.equal(future.period.steps, 0);
  assert.equal(future.sources.decisions.count, 0);
  assert.equal(ctl(future, "A.6.2.3").status, "not_covered");
  assert.equal(future.approvals.length, 0);
  // A project rule decided before the period still applies in it.
  assert.equal(future.sources.rules.count, 1);
  const past = buildAuditFile(s, parsePeriod(undefined, "2000-01-01"));
  assert.equal(past.sources.rules.count, 0, "not yet in force before it was decided");
  assert.equal(past.period.steps, 0);
});

test("C2: the audit file names no machine path", () => {
  const { p, s } = project();
  const json = JSON.stringify(buildAuditFile(s));
  assert.ok(!json.includes(p.dir), "no absolute project path");
  assert.ok(!json.includes(dirname(globalConfigPath())), "no config path");
});

test("C2: every integrity code the audit file maps exists in the project check, and the alarms are mapped", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "dist", "core", "analysis.js"), "utf8");
  for (const code of Object.keys(INTEGRITY_RULES)) if (code !== "evaluation_failed") assert.match(src, new RegExp(`code: "${code}"`), code);
  // Every high-severity tamper/signature finding of the project check becomes an alarm in the audit file.
  for (const code of ["tampered", "ledger_missing", "ledger_broken", "ledger_diverged", "ledger_replaced", "reseal_unproven", "verdict_untrusted", "verdict_removed", "canon_tampered", "canon_untrusted", "canon_check_tampered", "canon_gate_tampered", "canon_missing", "canon_unreadable", "rule_tampered", "rule_missing", "project_id_changed"]) {
    assert.equal(INTEGRITY_RULES[code]?.level, "alarm", code);
  }
  for (const r of Object.values(INTEGRITY_RULES)) for (const k of r.sources) assert.ok(EVIDENCE_SOURCES[k], k);
});

test("C2 access: only the person reads by default; the person's setting is signed and fail-closed", () => {
  const { s } = project();
  assert.deepEqual(readAuditAccess(s.store), { mode: "person", trust: "default", set: null });
  const a = setAuditAccess(s.store, "open", { by: "kev", via: "terminal" });
  assert.equal(a.mode, "open");
  assert.equal(a.trust, "verified");
  assert.equal(a.set.by, "kev");
  assert.ok(s.store.readEvents().some((e) => /audit file read access set to "open" by kev via terminal/.test(e.data?.message ?? "")));
  // In the audit file itself, as a signed approval.
  assert.ok(buildAuditFile(s).approvals.some((x) => x.kind === "access" && x.action === "open"));
  // Someone edits the stored setting (or copies one from another project): "person" applies again.
  const file = accessFile();
  const all = JSON.parse(readFileSync(file, "utf8"));
  const pid = Object.keys(all.projects).find((k) => all.projects[k].mode === "open" && all.projects[k].by === "kev");
  all.projects[pid].by = "someone else";
  writeFileSync(file, JSON.stringify(all));
  assert.deepEqual(readAuditAccess(s.store), { mode: "person", trust: "invalid", set: null });
  // A forged "open" without a signature does not open it either.
  all.projects[pid] = { mode: "open", rev: 99, at: new Date().toISOString(), by: "agent", via: "dashboard" };
  writeFileSync(file, JSON.stringify(all));
  assert.equal(readAuditAccess(s.store).mode, "person");
  assert.throws(() => setAuditAccess(s.store, "everyone", { by: "kev", via: "terminal" }), /mode must be one of/);
});

test("C2 access over HTTP: agents get 403 until the person opens it; only the person changes it", async () => {
  const { s } = project();
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agentH = { "x-scenaria": "1", "x-scenaria-agent": "codex" };
  const person = { "x-scenaria": "1", cookie: "scenaria_approval=sess" };
  const get = (path, h) => fetch(base + path, { headers: h });
  const post = (path, body, h) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  try {
    let r = await get("/api/audit-file", agentH);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "approval_required");
    r = await get("/api/audit-file", person);
    assert.equal(r.status, 200);
    const f = await r.json();
    assert.equal(f.controls.length, 38);
    // Reading the setting is open (nothing secret); changing it is the person's.
    const acc = await (await get("/api/audit-file/access", agentH)).json();
    assert.deepEqual([acc.mode, acc.trust, acc.approval], ["person", "default", false]);
    r = await post("/api/audit-file/access", { mode: "open" }, agentH);
    assert.equal(r.status, 403);
    assert.equal(readAuditAccess(s.store).mode, "person", "nothing changed");
    r = await post("/api/audit-file/access", { mode: "everyone" }, person);
    assert.equal(r.status, 400);
    r = await post("/api/audit-file/access", { mode: "open" }, person);
    assert.equal(r.status, 200);
    const set = await r.json();
    assert.deepEqual([set.mode, set.trust, set.set.via], ["open", "verified", "dashboard"]);
    assert.match(set.set.by, /local approval link/);
    assert.equal((await get("/api/audit-file", agentH)).status, 200, "open: agents may read");
    // Period over HTTP; an invalid one is refused.
    const fut = await (await get("/api/audit-file?from=2999-01-01", agentH)).json();
    assert.equal(fut.period.steps, 0);
    assert.equal((await get("/api/audit-file?from=soon", agentH)).status, 400);
    // The person closes it again.
    assert.equal((await post("/api/audit-file/access", { mode: "person" }, person)).status, 200);
    assert.equal((await get("/api/audit-file", agentH)).status, 403);
  } finally {
    server.close();
  }
});

test("C2 access in the CLI: an agent's shell neither reads (default) nor changes the setting", () => {
  const { p, s } = project();
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, encoding: "utf8" }); // no TTY
  let r = cli(["audit-file"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Only the person reads the audit file/);
  r = cli(["audit-file", "access", "open"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /person's setting: run this in an interactive terminal/);
  assert.equal(readAuditAccess(s.store).mode, "person");
  r = cli(["audit-file", "access", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mode, "person");
  // Opened by the person: an agent's shell may read it.
  setAuditAccess(s.store, "open", { by: "kev", via: "terminal" });
  r = cli(["audit-file", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const f = JSON.parse(r.stdout);
  assert.equal(f.controls.length, 38);
  r = cli(["audit-file"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ISO\/IEC 42001 audit file/);
  assert.match(r.stdout, /A\.6\.2\.3/);
  assert.match(r.stdout, /Signed approvals of rules and work in the period: 0 · also listed \(carry no control\): access/, "the CLI count matches the list it summarises");
  r = cli(["audit-file", "--from", "nonsense"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a date/);
});

// ------------------------------------------------------------------ regression tests for review C2 (K1–K12)

test("C2 K1: an audit agent's reseal moved into another period (unsigned time) is unproven and counts nowhere", () => {
  const { p, s, d, cp } = project();
  const k = auditorKeygen(mkdtempSync(join(tmpdir(), "c2-auditor-")));
  addAuditor(k.pub, "CI");
  s.applyAuditorRequest(signAuditorRequest(buildAuditorRequest(s.store, { action: "reseal" }), readFileSync(k.keyFile, "utf8")));
  let f = buildAuditFile(Scenaria.open(p.dir));
  assert.equal(f.reseals.authentic.length, 1, "the real reseal is authentic");
  const win = parsePeriod(new Date(Date.parse(d.createdAt) - 1000).toISOString(), cp.createdAt);
  const rf = join(p.dir, ".scenaria/reseals/rs1.json");
  const rec = JSON.parse(readFileSync(rf, "utf8"));
  rec.at = d.createdAt; // an agent moves it into the decision window
  writeFileSync(rf, JSON.stringify(rec));
  f = buildAuditFile(Scenaria.open(p.dir), win);
  assert.deepEqual(f.reseals.authentic, []);
  assert.deepEqual(f.reseals.unproven, ["rs1"]);
  assert.equal(f.sources.reseals.count, 0);
  assert.ok(!f.approvals.some((a) => a.kind === "reseal"));
  assert.equal(ctl(f, "A.6.1.3").status, "not_covered");
  assert.equal(f.integrity.state, "alarm");
  assert.ok(f.integrity.warnings.some((w) => w.code === "reseal_unproven" && w.items.includes("rs1")));
});

test("C2 K2: reseals and the read setting are listed but approve no work and carry no control", () => {
  const { s } = project();
  setAuditAccess(s.store, "person", { by: "kev", via: "terminal" });
  s.reseal({ kind: "person", via: "terminal" }, { user: "kev" });
  const f = buildAuditFile(s);
  assert.deepEqual(f.approvals.map((a) => [a.kind, a.carries]).sort(), [["access", false], ["reseal", false]]);
  assert.equal(f.sources.approvals.count, 0);
  assert.equal(f.sources.approvals.hasData, false);
  assert.match(f.sources.approvals.note.de, /tragen aber keine Kontrolle/);
  assert.equal(f.sources.signatures.count, 2, "both are still signed records");
  for (const id of ["A.3.2", "A.6.1.3", "A.9.2"]) assert.equal(ctl(f, id).status, "not_covered", id);
});

test("C2 K3: a period before the main goal was recorded does not count the goal", () => {
  const { s } = project();
  const f = buildAuditFile(s, parsePeriod("1990-01-01", "1990-12-31"));
  assert.equal(f.period.steps, 0);
  assert.equal(f.sources.goal.count, 0);
  assert.equal(ctl(f, "A.6.2.2").status, "not_covered");
  assert.equal(ctl(f, "A.9.3").status, "not_covered");
  assert.equal(f.summary.partly, 0, "a period without records shows nothing as evidenced");
  // From the project's start on, the main goal and the task count.
  const now = buildAuditFile(s);
  assert.deepEqual(now.sources.goal.facts, { mainGoal: 1, tasks: 1 });
});

test("C2 K4: hand-edited fields of the wrong type never break the audit file or hide the alarm", async () => {
  const edits = {
    "root goal is a number": (p) => editNode(p, "n0", (n) => (n.goal = 42)),
    "rationale is a number": (p, d) => editNode(p, d.id, (n) => (n.rationale = 7)),
    "irreversible is a number": (p, d, cp) => editNode(p, cp.id, (n) => (n.irreversible = 5)),
    "verdict time is a number": (p, d, cp, s) => {
      callTool(s, "scenaria_verify", { id: cp.id, status: "passed" }, agent);
      editNode(p, cp.id, (n) => (n.verification.at = 5));
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const { p, s, d, cp } = project();
    edit(p, d, cp, s);
    const f = buildAuditFile(Scenaria.open(p.dir));
    assert.equal(f.controls.length, 38, name);
    assert.equal(f.integrity.state, "alarm", `${name}: the edit is visible`);
    assert.ok(f.integrity.warnings.some((w) => w.code === "tampered"), name);
  }
  // Over HTTP the person gets the file (with the alarm), not an error.
  const { p, s, d } = project();
  editNode(p, d.id, (n) => (n.rationale = 7));
  const app = createApp(Scenaria.open(p.dir), { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/audit-file`, { headers: { cookie: "scenaria_approval=sess" } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).integrity.state, "alarm");
  } finally {
    server.close();
  }
});

test("C2 K5: grouped findings count every affected item", () => {
  const { p, s, d, cp } = project();
  s.verify(d.id, { status: "passed", notes: "ok", origin: "person", via: "terminal", by: "kev" });
  s.verify(cp.id, { status: "passed", notes: "ok", origin: "person", via: "terminal", by: "kev" });
  for (const id of [d.id, cp.id]) editNode(p, id, (n) => delete n.verification);
  const f = buildAuditFile(Scenaria.open(p.dir));
  const w = f.integrity.warnings.find((x) => x.code === "verdict_removed");
  assert.equal(w.count, 2);
  assert.deepEqual([...w.items].sort(), [d.id, cp.id].sort());
});

test("C2 K6: a reseal this machine did not anchor is unproven only, never also authentic", () => {
  const { p, s } = project();
  s.reseal({ kind: "person", via: "terminal" }, { user: "kev" });
  // This machine's anchor loses the reseal entry (like a teammate's machine that never saw it).
  const anchors = join(dirname(globalConfigPath()), "anchors");
  
  for (const fn of readdirSync(anchors)) {
    const file = join(anchors, fn);
    const a = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(a.reseals) && a.reseals.some((r) => r.id === "rs1")) {
      a.reseals = a.reseals.filter((r) => r.id !== "rs1");
      writeFileSync(file, JSON.stringify(a));
    }
  }
  const f = buildAuditFile(Scenaria.open(p.dir));
  assert.deepEqual(f.reseals.unproven, ["rs1"]);
  assert.deepEqual(f.reseals.authentic, []);
  assert.equal(f.sources.reseals.count, 0);
  assert.ok(!f.approvals.some((a) => a.kind === "reseal"));
});

test("C2 K7: only real days and date-times with a time zone are accepted", () => {
  for (const bad of ["2026-02-30", "5/10/2026", "1", "2026-10-01T10:00", "+010000-01-01", "2026-13-01", "2026-10"]) {
    assert.throws(() => parsePeriod(bad), /not a date/, bad);
  }
  assert.deepEqual(parsePeriod("2026-10-01T12:00+02:00"), { from: "2026-10-01T10:00:00.000Z", to: null });
  assert.deepEqual(parsePeriod(null, "2026-10-01T10:00Z"), { from: null, to: "2026-10-01T10:00:00.000Z" });
  assert.throws(() => parsePeriod("2026-10-02", "2026-10-01T23:00Z"), /starts after it ends/);
});

test("C2 K8: fields a signature does not cover are marked as unsigned", () => {
  const { p, s } = project();
  s.addCanonAsUser({ kind: "past", text: "Runs only in the EU" }, { user: "kev", via: "cli" });
  s.addRule("Keep it small", "manual", undefined, { by: "kev", via: "terminal" });
  s.reseal({ kind: "person", via: "terminal" }, { user: "kev" });
  const f = buildAuditFile(s);
  const by = (k) => f.approvals.find((a) => a.kind === k);
  assert.deepEqual(by("canon").unsigned, ["via"], "canon: the channel is not signed");
  assert.deepEqual(by("rule").unsigned, [], "rules sign by, via and time");
  assert.notEqual(by("reseal").via, "", "a reseal names its channel");
  // An agent rewrites the unsigned channel: the entry says it is unsigned, the signed parts are unchanged.
  const cf = join(p.dir, ".scenaria/canon.json");
  const c = JSON.parse(readFileSync(cf, "utf8"));
  c.events[0].decidedVia = "dashboard (four-eyes)";
  writeFileSync(cf, JSON.stringify(c));
  const g = buildAuditFile(Scenaria.open(p.dir)).approvals.find((a) => a.kind === "canon");
  assert.deepEqual(g.unsigned, ["via"]);
  assert.equal(g.by, "kev");
});

test("C2 K9: the audit file names the bound project id, and the project file's id only when it differs", () => {
  const { p, s } = project();
  s.addCanonAsUser({ kind: "past", text: "EU only" }, { user: "kev", via: "cli" }); // binds the id
  const bound = buildAuditFile(s).project.id;
  assert.ok(bound);
  const cf = join(p.dir, ".scenaria/config.json");
  const cfg = JSON.parse(readFileSync(cf, "utf8"));
  cfg.projectId = "0123456789abcdef01234567";
  writeFileSync(cf, JSON.stringify(cfg));
  const f = buildAuditFile(Scenaria.open(p.dir));
  assert.equal(f.project.id, bound);
  assert.equal(f.project.configId, "0123456789abcdef01234567");
  assert.ok(f.integrity.warnings.some((w) => w.code === "project_id_changed"));
});

test("C2 K10: the CLI reads only at a full interactive terminal; --out-file is for the person too", () => {
  const src = readFileSync(CLI, "utf8");
  const block = src.slice(src.indexOf('case "audit-file"'), src.indexOf('case "protocol"'));
  assert.match(block, /isPersonTerminal\(\)/);
  assert.doesNotMatch(block, /stderr\.isTTY/, "no weaker check than rule 6");
  const { p } = project();
  const out = join(p.dir, "audit.json");
  const r = spawnSync(process.execPath, [CLI, "audit-file", "--out-file", out], { cwd: p.dir, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.throws(() => readFileSync(out), /ENOENT/, "nothing written for an agent's shell");
});

test("C2 K11: a copied project starts at 'person'; an older signed setting put back does not count", () => {
  const { p, s } = project();
  setAuditAccess(s.store, "open", { by: "kev", via: "terminal" });
  const copy = join(mkdtempSync(join(tmpdir(), "c2-copy-")), "proj");
  cpSync(p.dir, copy, { recursive: true });
  const c = Scenaria.open(copy);
  assert.equal(readAuditAccess(c.store).mode, "person", "the copy has its own setting");
  setAuditAccess(c.store, "person", { by: "kev", via: "terminal" });
  assert.equal(readAuditAccess(s.store).mode, "open", "changing the copy leaves the original alone");
  // Rollback: an older "open" file restored after the person closed it.
  const file = accessFile();
  const older = readFileSync(file, "utf8");
  setAuditAccess(s.store, "person", { by: "kev", via: "terminal" });
  writeFileSync(file, older);
  const a = readAuditAccess(s.store);
  assert.deepEqual([a.mode, a.trust], ["person", "invalid"]);
});

test("C2 K12: the limit is stated where the setting is explained; team mode gets its own way in", async () => {
  const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" }).stdout;
  assert.match(help, /protects the audit file, not\s+the raw records/);
  const { s } = project();
  const app = createApp(s, { token: "t", approverToken: "a", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/audit-file`, { headers: { authorization: "Bearer t" } });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /approver link/);
    const ok = await fetch(`http://127.0.0.1:${server.address().port}/api/audit-file`, { headers: { authorization: "Bearer t", cookie: "scenaria_approval=sess" } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
  const f = buildAuditFile(s);
  assert.match(f.integrity.headline.de, /aufgezeichneten Schritten und den signierten Nachweisen/);
  assert.match(f.integrity.note.de, /nicht in der Hash-Kette/);
});

// ------------------------------------------------------------------ second review round (N1–N4)

async function personGet(s, path = "/api/audit-file") {
  const server = createServer(createApp(s, { approvalCode: "c", approvalSecret: "sess" }).handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { cookie: "scenaria_approval=sess" } });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

test("C2 N1: a deleted or destroyed step raises an alarm (audit file and project check)", () => {
  for (const how of ["delete", "garbage"]) {
    const { p, d } = project();
    const file = join(p.dir, ".scenaria/nodes", `${d.id}.json`);
    if (how === "delete") rmSync(file);
    else writeFileSync(file, "{oops");
    const s = Scenaria.open(p.dir);
    assert.deepEqual(s.integrity().stepsMissing, [d.id], how);
    const f = buildAuditFile(s);
    assert.equal(f.integrity.state, "alarm", how);
    const w = f.integrity.warnings.find((x) => x.code === "step_missing");
    assert.deepEqual(w.items, [d.id], how);
    assert.equal(ctl(f, "A.6.2.3").alarm, true, how);
    assert.doesNotMatch(f.integrity.headline.en, /intact/, how);
  }
  // A normal project: nothing missing (also not the newest step).
  const { s } = project();
  assert.deepEqual(s.integrity().stepsMissing, []);
});

test("C2 N2: a destroyed root step or hash chain never makes the audit file unavailable", async () => {
  {
    const { p } = project();
    writeFileSync(join(p.dir, ".scenaria/nodes/n0.json"), "{oops");
    const r = await personGet(Scenaria.open(p.dir));
    assert.equal(r.status, 200);
    assert.equal(r.body.integrity.state, "alarm");
    assert.equal(r.body.sources.goal.count, 0, "no root, no main goal");
  }
  {
    const { p } = project();
    rmSync(join(p.dir, ".scenaria/ledger.jsonl"));
    mkdirSync(join(p.dir, ".scenaria/ledger.jsonl"));
    const r = await personGet(Scenaria.open(p.dir));
    assert.equal(r.status, 200);
    assert.equal(r.body.integrity.state, "alarm");
    const w = r.body.integrity.warnings.find((x) => x.code === "evaluation_failed");
    assert.ok(w, "the failed check is named");
    assert.equal(r.body.sources.verdicts.count, 0, "nothing counts as authentic without the check");
    assert.ok(!JSON.stringify(r.body).includes(p.dir), "no machine path in error details");
  }
});

test("C2 N3: when the project check fails, the specific alarms stay and no status drops", () => {
  const { p, s, d, cp } = project();
  s.verify(d.id, { status: "passed", notes: "ok", origin: "person", via: "terminal", by: "kev" });
  s.verify(cp.id, { status: "passed", notes: "ok", origin: "person", via: "terminal", by: "kev" });
  for (const id of [d.id, cp.id]) editNode(p, id, (n) => delete n.verification);
  const before = buildAuditFile(Scenaria.open(p.dir));
  editNode(p, cp.id, (n) => (n.createdAt = { x: 1 })); // one more edit that may break the check
  const f = buildAuditFile(Scenaria.open(p.dir));
  const codes = f.integrity.warnings.map((w) => w.code);
  assert.ok(codes.includes("verdict_removed"), codes.join(","));
  assert.equal(f.integrity.warnings.find((w) => w.code === "verdict_removed").count, 2);
  assert.ok(codes.includes("tampered"));
  assert.equal(ctl(f, "A.6.2.6").status, ctl(before, "A.6.2.6").status, "health keeps its steps");
});

test("C2 N4: the time the main goal was set is kept on the root (hash chain), not only in the event log", async () => {
  const p = tempProject("auditfile-goal-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "Build the API", goal: "Endpoints and tests" }); // no main goal yet
  await new Promise((r) => setTimeout(r, 30));
  const cut = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 30));
  s.setProjectGoal("A small API with tests", { agent: "codex" });
  assert.ok(s.project().meta.goalSince > cut);
  const period = parsePeriod(null, cut);
  assert.equal(buildAuditFile(Scenaria.open(p.dir), period).sources.goal.facts.mainGoal, 0);
  // An agent deletes the event line: the root still knows.
  const ef = join(p.dir, ".scenaria/events.jsonl");
  writeFileSync(ef, readFileSync(ef, "utf8").split("\n").filter((l) => !/main goal set/.test(l)).join("\n"));
  const f = buildAuditFile(Scenaria.open(p.dir), period);
  assert.equal(f.sources.goal.facts.mainGoal, 0);
  assert.equal(f.integrity.state, "ok");
  // Changing the goal later keeps the first time.
  const first = s.project().meta.goalSince;
  s.setProjectGoal("A small, tested API", { agent: "codex" });
  assert.equal(s.project().meta.goalSince, first);
});

test("C2 K8: a reseal shows the channel it was signed with", () => {
  const { s } = project();
  s.reseal({ kind: "person", via: "dashboard" }, { user: "kev" });
  const f = buildAuditFile(s);
  assert.equal(f.reseals.authentic[0].via, "dashboard");
  assert.equal(f.approvals.find((a) => a.kind === "reseal").via, "dashboard");
});
