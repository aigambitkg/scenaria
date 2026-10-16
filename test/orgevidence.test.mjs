// Batch C3: the organisation's own evidence per ISO/IEC 42001 Annex A control.
// Kev's decisions (2026-10-16): stored in the project like canon.json; it never raises a status; per project with
// "take over from another project"; documents by URL and hash; owner with role and name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { buildAuditFile, parsePeriod } from "../dist/core/auditfile.js";
import { setAuditAccess } from "../dist/core/auditaccess.js";
import { Store } from "../dist/core/store.js";
import { ANNEX_A_CONTROLS } from "../dist/core/iso42001.js";
import { registerProject } from "../dist/core/projects.js";
import {
  addOrgEvidence,
  confirmOrgEvidence,
  controlFingerprint,
  copyOrgEvidence,
  documentHash,
  entryDigest,
  planCopy,
  planRemove,
  orgEvidenceStates,
  readOrgEvidence,
  removeOrgEvidence,
  validateInput,
} from "../dist/core/orgevidence.js";
import { createApp } from "../dist/server.js";
import { tempProject } from "./helpers.mjs";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const HASH = "sha256:" + "a".repeat(64);
const who = { by: "kev", via: "terminal" };
const doc = (over = {}) => ({ control: "A.2.2", url: "https://intranet.example.org/ki-richtlinie.pdf", hash: HASH, title: "KI-Richtlinie", role: "KI-Beauftragte", name: "Petra Vollmer", date: "2026-09-01", ...over });

function project(prefix = "orgev-") {
  const p = tempProject(prefix);
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API", title: "Build", goal: "Endpoints" });
  s.decide({ question: "Framework?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "fast", context: "new", servesGoal: "API", agent: "codex" });
  p.write("a.txt", "2");
  s.checkpoint({ title: "Skeleton", outputs: ["`a.txt`"], agent: "codex" });
  return { p, s };
}
const ctl = (f, id) => f.controls.find((c) => c.id === id);
const evFile = (p) => join(p.dir, ".scenaria/org-evidence.json");
const editEv = (p, fn) => {
  const raw = JSON.parse(readFileSync(evFile(p), "utf8"));
  fn(raw);
  writeFileSync(evFile(p), JSON.stringify(raw));
};

test("C3: a recorded document is signed, shown at its control, and never changes a status", () => {
  const { s } = project();
  const before = buildAuditFile(s);
  const e = addOrgEvidence(s.store, doc(), who);
  assert.equal(e.id, "e1");
  assert.ok(e.sig && e.keyId && e.rev === 1);
  assert.equal(e.catalogue, controlFingerprint(ANNEX_A_CONTROLS.find((c) => c.id === "A.2.2")));
  // A document for a control Scenaria partly evidences too.
  addOrgEvidence(s.store, doc({ control: "A.6.2.3", url: "https://intranet.example.org/doku.pdf", title: "Doku-Prozess" }), who);
  const f = buildAuditFile(s);
  const c = ctl(f, "A.2.2");
  assert.equal(c.status, "organisational", "status stays (Kev's decision 2)");
  assert.equal(c.orgEvidence.state, "documented");
  assert.deepEqual([c.orgEvidence.entries[0].owner.role, c.orgEvidence.entries[0].owner.name, c.orgEvidence.entries[0].hash, c.orgEvidence.entries[0].trust], ["KI-Beauftragte", "Petra Vollmer", HASH, "verified"]);
  for (const x of f.controls) assert.equal(x.status, ctl(before, x.id).status, `${x.id}: status unchanged`);
  assert.equal(f.summary.orgDocumented, 2);
  assert.equal(f.integrity.state, "ok");
  const a = f.approvals.filter((x) => x.kind === "evidence");
  assert.equal(a.length, 2);
  assert.ok(a.every((x) => x.carries === false && x.unsigned.length === 0));
  assert.equal(f.sources.approvals.count, 0, "documents approve no work");
  assert.match(f.catalogue.hash, /^[0-9a-f]{32}$/);
  assert.equal(f.catalogue.controls, 38);
});

test("C3: input is checked — real controls, web links only, SHA-256, role and name, a real past day", () => {
  assert.throws(() => validateInput(doc({ control: "A.99" })), /not an Annex A control/);
  assert.throws(() => validateInput(doc({ url: "file:///Users/kev/policy.pdf" })), /Only http and https/);
  assert.throws(() => validateInput(doc({ url: "/Users/kev/policy.pdf" })), /full web address/);
  assert.throws(() => validateInput(doc({ url: "https://kev:secret@intranet.example.org/x" })), /user name or password/);
  assert.throws(() => validateInput(doc({ hash: "abc" })), /SHA-256/);
  assert.throws(() => validateInput(doc({ role: " " })), /role is required/);
  assert.throws(() => validateInput(doc({ name: "" })), /name is required/);
  assert.throws(() => validateInput(doc({ date: "2026-02-30" })), /real day/);
  assert.throws(() => validateInput(doc({ date: "2999-01-01" })), /future/);
  assert.equal(validateInput(doc({ hash: "SHA256:" + "B".repeat(64) })).hash, "sha256:" + "b".repeat(64));
  assert.equal(documentHash(Buffer.from("abc")), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("C3: an edited, rolled-back or deleted entry is detected and never counts", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  const v1 = readFileSync(evFile(p), "utf8");
  // Edited: another link.
  editEv(p, (r) => (r.entries[0].url = "https://elsewhere.example.org/x.pdf"));
  let f = buildAuditFile(s);
  assert.equal(ctl(f, "A.2.2").orgEvidence.state, "unconfirmed");
  assert.equal(ctl(f, "A.2.2").orgEvidence.entries[0].trust, "tampered");
  assert.equal(ctl(f, "A.2.2").alarm, true);
  assert.ok(f.integrity.warnings.some((w) => w.code === "org_evidence_tampered" && w.level === "alarm" && w.controls.includes("A.2.2")));
  const dig = orgEvidenceStates(s.store).entries[0].digest;
  assert.throws(() => confirmOrgEvidence(s.store, "e1", dig, who), /changed outside Scenaria/);
  // Back to the signed version, then removed; the old signed version put back counts as tampered (rolled back).
  writeFileSync(evFile(p), v1);
  removeOrgEvidence(s.store, "e1", who);
  writeFileSync(evFile(p), v1);
  f = buildAuditFile(s);
  assert.equal(ctl(f, "A.2.2").orgEvidence.entries[0].trust, "tampered");
  // Deleted from the file.
  addOrgEvidence(s.store, doc({ control: "A.2.3" }), who);
  editEv(p, (r) => (r.entries = r.entries.filter((e) => e.control !== "A.2.3")));
  f = buildAuditFile(s);
  const w = f.integrity.warnings.find((x) => x.code === "org_evidence_missing");
  assert.equal(w.level, "alarm");
  assert.ok(w.items.length >= 1);
  // A destroyed file never breaks the audit file.
  writeFileSync(evFile(p), "{ <<<<<<< merge");
  f = buildAuditFile(s);
  assert.ok(f.integrity.warnings.some((x) => x.code === "org_evidence_unreadable"));
  assert.throws(() => addOrgEvidence(s.store, doc({ control: "A.2.4" }), who), /cannot be read/);
});

test("C3: removal is a signed record; periods show what was in force then; ids are never reused", () => {
  const { p, s } = project();
  const e = addOrgEvidence(s.store, doc(), who);
  const mid = new Date(Date.parse(e.activeFrom) + 5).toISOString();
  removeOrgEvidence(s.store, "e1", who);
  const st = orgEvidenceStates(s.store).entries[0];
  assert.deepEqual([st.entry.status, st.trust, st.entry.rev], ["removed", "verified", 2]);
  // Whole project = the current state: not documented any more.
  assert.equal(ctl(buildAuditFile(s), "A.2.2").orgEvidence.state, "none");
  // A period while it was in force: documented.
  const f = buildAuditFile(s, parsePeriod(e.activeFrom, mid));
  assert.equal(ctl(f, "A.2.2").orgEvidence.state, "documented");
  // A period that ended before it was recorded: nothing.
  assert.equal(ctl(buildAuditFile(s, parsePeriod("2020-01-01", "2020-12-31")), "A.2.2").orgEvidence.state, "none");
  assert.throws(() => removeOrgEvidence(s.store, "e1", who), /already removed/);
  // The file is deleted: the next id is still new (the marks outside the project remember e1).
  writeFileSync(evFile(p), JSON.stringify({ entries: [] }));
  assert.equal(readOrgEvidence(s.store).nextId, 2);
  assert.equal(addOrgEvidence(s.store, doc({ control: "A.2.3" }), who).id, "e2");
  assert.throws(() => addOrgEvidence(s.store, doc({ control: "A.2.3" }), who), /already recorded/);
});

test("C3: unsigned or untrusted entries count only after the person confirms what they saw; a re-worded control asks again", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  // A teammate's entry written into the file without a signature this machine can check.
  editEv(p, (r) => r.entries.push({ ...r.entries[0], id: "e9", control: "A.3.2", rev: 1, sig: undefined, pub: undefined }));
  let f = buildAuditFile(s);
  assert.equal(ctl(f, "A.3.2").orgEvidence.state, "unconfirmed");
  assert.ok(f.integrity.warnings.some((w) => w.code === "org_evidence_unconfirmed" && w.level === "note" && w.controls.includes("A.3.2")));
  const st9 = orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e9");
  assert.throws(() => confirmOrgEvidence(s.store, "e9", "0".repeat(24), who), /not what was shown/);
  assert.throws(() => confirmOrgEvidence(s.store, "e9", { url: 1 }, who), /not what was shown/, "a wrong type is a plain refusal");
  confirmOrgEvidence(s.store, "e9", st9.digest, who);
  f = buildAuditFile(s);
  assert.equal(ctl(f, "A.3.2").orgEvidence.state, "documented");
  assert.throws(() => confirmOrgEvidence(s.store, "e9", entryDigest(readOrgEvidence(s.store).entries.find((x) => x.id === "e9")), who), /already confirmed/);
  // The control's wording changes in a later catalogue: still documented, but the person is asked to look again.
  const c = ANNEX_A_CONTROLS.find((x) => x.id === "A.2.2");
  const old = c.organisation.de;
  c.organisation.de = old + " (neu gefasst)";
  try {
    f = buildAuditFile(s);
    assert.equal(ctl(f, "A.2.2").orgEvidence.entries[0].catalogueChanged, true);
    assert.ok(f.integrity.warnings.some((w) => w.code === "org_evidence_catalogue_changed" && w.controls.includes("A.2.2")));
    confirmOrgEvidence(s.store, "e1", orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e1").digest, who);
    f = buildAuditFile(s);
    assert.equal(ctl(f, "A.2.2").orgEvidence.entries[0].catalogueChanged, false);
  } finally {
    c.organisation.de = old;
  }
});

test("C3: take over from another project — only what this machine can vouch for, signed anew, never twice", () => {
  const a = project("orgev-a-");
  const b = project("orgev-b-");
  addOrgEvidence(a.s.store, doc(), who);
  addOrgEvidence(a.s.store, doc({ control: "A.2.3", url: "https://intranet.example.org/abgleich.pdf" }), who);
  addOrgEvidence(a.s.store, doc({ control: "A.2.4", url: "https://intranet.example.org/review.pdf" }), who);
  removeOrgEvidence(a.s.store, "e3", who);
  editEv(a.p, (r) => (r.entries.find((e) => e.id === "e2").name = "x")); // an unknown field: harmless
  editEv(a.p, (r) => (r.entries.find((e) => e.id === "e2").owner.name = "Someone else")); // tampered
  const plan = planCopy(b.s.store, a.p.dir);
  assert.deepEqual(plan.take.map((t) => t.id), ["e1"]);
  assert.throws(() => copyOrgEvidence(b.s.store, a.p.dir, who, undefined, ["e1", "e2"]), /changed since they were shown/);
  const r = copyOrgEvidence(b.s.store, a.p.dir, who, undefined, ["e1"]);
  assert.equal(r.copied.length, 1);
  assert.deepEqual(r.skipped, [{ id: "e2", reason: "tampered" }]);
  const c = r.copied[0];
  assert.equal(c.control, "A.2.2");
  assert.ok(c.copiedFrom && !c.copiedFrom.includes("/"), "the project's name, never a folder path");
  const f = buildAuditFile(b.s);
  assert.equal(ctl(f, "A.2.2").orgEvidence.state, "documented");
  assert.equal(ctl(f, "A.2.2").orgEvidence.entries[0].copiedFrom, c.copiedFrom);
  assert.equal(copyOrgEvidence(b.s.store, a.p.dir, who).copied.length, 0, "already here: not copied twice");
  assert.ok(planCopy(b.s.store, a.p.dir).skipped.some((x) => x.reason === "already_here"));
  assert.throws(() => copyOrgEvidence(b.s.store, b.p.dir, who), /this project/);
});

test("C3 person-only: agents neither read (default) nor change anything over HTTP or the CLI", async () => {
  const { p, s } = project();
  const other = project("orgev-src-");
  addOrgEvidence(other.s.store, doc(), who);
  registerProject(other.p.dir);
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agentH = { "x-scenaria": "1", "x-scenaria-agent": "codex" };
  const person = { "x-scenaria": "1", cookie: "scenaria_approval=sess" };
  const get = (path, h) => fetch(base + path, { headers: h });
  const post = (path, body, h) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  try {
    assert.equal((await get("/api/audit-file/evidence", agentH)).status, 403);
    for (const [path, body] of [["/api/audit-file/evidence", doc()], ["/api/audit-file/evidence/remove", { id: "e1" }], ["/api/audit-file/evidence/confirm", { id: "e1" }], ["/api/audit-file/evidence/copy", { from: other.p.dir }]]) {
      const r = await post(path, body, agentH);
      assert.equal(r.status, 403, path);
    }
    assert.equal(readOrgEvidence(s.store).entries.length, 0, "nothing changed");
    let r = await post("/api/audit-file/evidence", doc({ url: "file:///etc/passwd" }), person);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "bad_url");
    r = await post("/api/audit-file/evidence", doc(), person);
    assert.equal(r.status, 200);
    const e = (await r.json()).entry;
    assert.deepEqual([e.decidedVia, e.status], ["dashboard", "active"]);
    assert.match(e.decidedBy, /local approval link/);
    r = await get("/api/audit-file/evidence", person);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).entries[0].trust, "verified");
    // Copy only from a project the person has on this machine, never any folder.
    r = await post("/api/audit-file/evidence/copy", { from: "/tmp" }, person);
    assert.equal(r.status, 400);
    r = await post("/api/audit-file/evidence/copy", { from: other.p.dir }, person);
    assert.equal(r.status, 400, "the plan comes first");
    r = await post("/api/audit-file/evidence/copy", { from: other.p.dir, dryRun: true }, person);
    assert.equal(r.status, 200);
    const plan = await r.json();
    assert.deepEqual(plan.take, [], "the same document is already here");
    r = await post("/api/audit-file/evidence/copy", { from: other.p.dir, expect: [] }, person);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).copied.length, 0);
    r = await post("/api/audit-file/evidence/confirm", { id: "e1", digest: 5 }, person);
    assert.equal(r.status, 400);
    r = await post("/api/audit-file/evidence/remove", { id: "e1" }, person);
    assert.equal(r.status, 200);
    setAuditAccess(s.store, "open", { by: "kev", via: "terminal" });
    assert.equal((await get("/api/audit-file/evidence", agentH)).status, 200, "open: agents may read");
  } finally {
    server.close();
  }
  // CLI without a terminal (an agent's shell).
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: p.dir, encoding: "utf8" });
  const r = cli(["audit-file", "evidence", "add", "--control", "A.2.2", "--url", "https://x.example.org/p.pdf", "--hash", HASH, "--role", "AI officer", "--name", "N", "--date", "2026-09-01"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the person's: run this in an interactive terminal/);
  assert.equal(readOrgEvidence(s.store).entries.filter((x) => x.status === "active").length, 0);
  for (const args of [["rm", "e1"], ["confirm", "e1"], ["copy", "--from", other.p.dir]]) {
    const x = cli(["audit-file", "evidence", ...args]);
    assert.notEqual(x.status, 0, args.join(" "));
  }
  // Opened by the person above: the listing is readable.
  const l = cli(["audit-file", "evidence", "--json"]);
  assert.equal(l.status, 0, l.stderr);
  assert.equal(JSON.parse(l.stdout).entries.length, 1);
});

// ------------------------------------------------------------------ review of C3 (C3-1 … C3-9)

const plant = (p, entry) => editEv(p, (r) => r.entries.push({ control: "A.3.2", url: "https://agent.example.org/x.pdf", hash: HASH, owner: { role: "Agent", name: "Agent" }, date: "2020-06-01", catalogue: "", status: "active", activeFrom: "2020-06-01T00:00:00.000Z", recordedBy: "Agent", recordedVia: "terminal", recordedAt: "2020-06-01T00:00:00.000Z", rev: 1, decidedBy: "Agent", decidedVia: "terminal", decidedAt: "2020-06-01T00:00:00.000Z", ...entry }));
const y2021 = () => parsePeriod("2021-01-01", "2021-12-31");

test("C3-1: removing an entry the person did not sign discards it — its content is never signed and never counts", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  plant(p, { id: "e7" });
  assert.equal(ctl(buildAuditFile(s, y2021()), "A.3.2").orgEvidence.state, "unconfirmed");
  const r = removeOrgEvidence(s.store, "e7", who);
  assert.equal(r.discarded, true);
  const f = buildAuditFile(s, y2021());
  assert.equal(ctl(f, "A.3.2").orgEvidence.state, "none");
  const tomb = readOrgEvidence(s.store).entries.find((x) => x.id === "e7");
  assert.deepEqual([tomb.discarded, tomb.url, tomb.owner.name, tomb.control], [true, "", "", ""]);
  assert.equal(orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e7").trust, "verified", "the discard itself is the person's");
  assert.ok(buildAuditFile(s).approvals.some((a) => a.kind === "evidence" && a.action === "discarded" && a.ref === "e7"));
  // The person's own entry: a tombstone with its content (recorded and removed both listed).
  removeOrgEvidence(s.store, "e1", who);
  const acts = buildAuditFile(s).approvals.filter((a) => a.ref === "A.2.2/e1").map((a) => a.action);
  assert.deepEqual(acts.sort(), ["recorded", "removed"]);
});

test("C3-2: confirming signs exactly what was shown, in force from the confirmation, without a claimed origin", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  plant(p, { id: "e8", url: doc().url, owner: { role: "CEO", name: "Forged Owner" }, copiedFrom: "Konzern HQ", activeFrom: "2019-01-01T00:00:00.000Z" });
  const st = orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e8");
  // Changed after it was shown: refused.
  editEv(p, (r) => (r.entries.find((e) => e.id === "e8").owner.name = "Other"));
  assert.throws(() => confirmOrgEvidence(s.store, "e8", st.digest, who), /not what was shown/);
  const st2 = orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e8");
  const e = confirmOrgEvidence(s.store, "e8", st2.digest, who);
  assert.ok(Date.parse(e.activeFrom) > Date.parse("2026-01-01"), "in force from now, not from the planted date");
  assert.equal(e.copiedFrom, undefined);
  assert.equal(e.recordedBy, "kev");
  assert.equal(ctl(buildAuditFile(s, y2021()), "A.3.2").orgEvidence.state, "none");
  assert.equal(ctl(buildAuditFile(s), "A.3.2").orgEvidence.state, "documented");
});

test("C3-3: once anchored, anything but the person's newer revision is tampered — re-activation, duplicates, deleted tombstones", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  removeOrgEvidence(s.store, "e1", who);
  editEv(p, (r) => Object.assign(r.entries[0], { status: "active", rev: 3, url: "https://agent.example.org/new.pdf", sig: undefined, pub: undefined, removedAt: undefined }));
  let f = buildAuditFile(s);
  assert.ok(f.integrity.warnings.some((w) => w.code === "org_evidence_tampered" && w.level === "alarm" && w.items.includes("e1")));
  assert.ok(!f.integrity.warnings.some((w) => w.code === "org_evidence_unconfirmed"), "never only a note");
  // Duplicate id: both copies are tampered, none can be confirmed.
  const { p: p2, s: s2 } = project();
  addOrgEvidence(s2.store, doc(), who);
  editEv(p2, (r) => r.entries.unshift({ ...r.entries[0], url: "https://agent.example.org/dup.pdf", sig: undefined, pub: undefined, rev: 2 }));
  const st = orgEvidenceStates(s2.store).entries;
  assert.deepEqual(st.map((x) => x.trust), ["tampered", "tampered"]);
  assert.throws(() => confirmOrgEvidence(s2.store, "e1", st[0].digest, who), /changed outside Scenaria/);
  // Removing keeps the person's genuine copy as a tombstone with its content and drops the agent's copy (N3).
  const rm = removeOrgEvidence(s2.store, "e1", who);
  assert.deepEqual([rm.discarded, rm.dropped, rm.entry.url], [false, 1, doc().url]);
  assert.equal(readOrgEvidence(s2.store).entries.filter((x) => x.id === "e1").length, 1);
  assert.equal(orgEvidenceStates(s2.store).entries[0].trust, "verified");
  // A tombstone deleted from the file is hidden history: missing.
  const { p: p3, s: s3 } = project();
  addOrgEvidence(s3.store, doc(), who);
  removeOrgEvidence(s3.store, "e1", who);
  editEv(p3, (r) => (r.entries = []));
  f = buildAuditFile(s3);
  assert.ok(f.integrity.warnings.some((w) => w.code === "org_evidence_missing" && w.items.includes("e1")));
});

test("C3-4/5/6/9: no control characters, normalised links, sane ids, and a file that is not a plain file never hangs", () => {
  assert.throws(() => validateInput(doc({ url: "https://intranet.example.org/a\u001b[2K\rb.pdf" })), /control or direction/);
  assert.throws(() => validateInput(doc({ url: "javascript:alert(1)" })), /Only http and https/);
  assert.equal(validateInput(doc({ url: "https://bücher.example/x" })).url, "https://xn--bcher-kva.example/x");
  assert.equal(validateInput(doc({ title: "a\u202eb" })).title, "a b");
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  // Control characters planted in a signed field: dropped on read, so the signature no longer matches.
  editEv(p, (r) => (r.entries[0].url = r.entries[0].url + "\u001b[2K"));
  assert.equal(orgEvidenceStates(s.store).entries[0].entry.url.includes("\u001b"), false);
  assert.equal(orgEvidenceStates(s.store).entries[0].trust, "tampered");
  // A huge nextId is ignored: ids stay plain and unique.
  editEv(p, (r) => (r.nextId = 1e21));
  assert.equal(readOrgEvidence(s.store).nextId, 2);
  // Not a plain file: unreadable at once, never blocking.
  rmSync(evFile(p));
  mkdirSync(evFile(p));
  const t0 = Date.now();
  const f = buildAuditFile(s);
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(f.integrity.warnings.some((w) => w.code === "org_evidence_unreadable"));
});

test("C3 periods: only a start, only an end", () => {
  const { s } = project();
  const e = addOrgEvidence(s.store, doc(), who);
  const later = new Date(Date.parse(e.activeFrom) + 60_000).toISOString();
  assert.equal(ctl(buildAuditFile(s, parsePeriod(later, null)), "A.2.2").orgEvidence.state, "documented", "still in force after the start");
  assert.equal(ctl(buildAuditFile(s, parsePeriod(null, "2020-01-01")), "A.2.2").orgEvidence.state, "none", "not yet in force by then");
});

test("C3-8: take over neither from a folder that claims another project's id nor entries whose control was re-worded", () => {
  const a = project("orgev-a2-");
  addOrgEvidence(a.s.store, doc(), who);
  const b = project("orgev-b2-");
  // An agent sets up a folder that claims to be project A.
  const fake = project("orgev-fake-");
  const cfg = JSON.parse(readFileSync(join(fake.p.dir, ".scenaria/config.json"), "utf8"));
  rmSync(join(fake.p.dir, ".scenaria/org-evidence.json"), { force: true });
  cfg.projectId = JSON.parse(readFileSync(join(a.p.dir, ".scenaria/config.json"), "utf8")).projectId;
  writeFileSync(join(fake.p.dir, ".scenaria/config.json"), JSON.stringify(cfg));
  // Fresh folder key: its first binding takes the claimed id.
  const fake2 = tempProjectLike(fake.p.dir);
  Scenaria.open(fake2);
  // Shown to the person, never a refusal a throwaway folder could force forever (N4).
  assert.equal(planCopy(b.s.store, a.p.dir).sameIdElsewhere, 1);
  rmSync(fake2, { recursive: true, force: true });
  assert.equal(planCopy(b.s.store, a.p.dir).sameIdElsewhere, 0, "a deleted folder does not count");
  // Re-worded control in the source: skipped until the person confirms it there.
  const c = project("orgev-c2-");
  addOrgEvidence(c.s.store, doc({ control: "A.2.3" }), who);
  const ctrl = ANNEX_A_CONTROLS.find((x) => x.id === "A.2.3");
  const old = ctrl.organisation.en;
  ctrl.organisation.en = old + " (changed)";
  try {
    assert.deepEqual(planCopy(b.s.store, c.p.dir).skipped.map((x) => x.reason), ["catalogue_changed"]);
  } finally {
    ctrl.organisation.en = old;
  }
});

function tempProjectLike(dir) {
  // The same project folder content under a new path (a copy an agent made).
  const to = dir + "-copy";
  spawnSync("cp", ["-R", dir, to]);
  return to;
}

test("C3 N2/N3: a planted huge id never blocks new entries; the person's changed entry is not discarded without being asked", () => {
  const { p, s } = project();
  assert.equal(addOrgEvidence(s.store, doc(), who).id, "e1");
  plant(p, { id: "e9999999" });
  editEv(p, (r) => (r.nextId = 9999999));
  assert.equal(addOrgEvidence(s.store, doc({ control: "A.2.3" }), who).id, "e2", "an id pushed to the end never blocks");
  assert.equal(removeOrgEvidence(s.store, "e9999999", who).discarded, true);
  editEv(p, (r) => (r.nextId = 3));
  assert.equal(addOrgEvidence(s.store, doc({ control: "A.2.4" }), who).id, "e3", "still free ids after the discard");
  // The person's e1 is edited outside Scenaria: removing it would lose its history — refused unless asked.
  editEv(p, (r) => (r.entries.find((e) => e.id === "e1").owner.name = "Agent"));
  assert.throws(() => removeOrgEvidence(s.store, "e1", who), /restore .* from git first/);
  assert.equal(removeOrgEvidence(s.store, "e1", who, { discard: true }).discarded, true);
});

test("C3: the removal plan names exactly what will happen (the CLI shows it before the person confirms)", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), who);
  assert.equal(planRemove(s.store, "e1").outcome, "remove");
  // An agent's copy under the same id, placed first: the plan still names the person's genuine copy.
  editEv(p, (r) => r.entries.unshift({ ...r.entries[0], owner: { role: "Agent", name: "Agent" }, sig: undefined, pub: undefined }));
  const plan = planRemove(s.store, "e1");
  assert.deepEqual([plan.outcome, plan.entry.owner.name, plan.dropped], ["remove", "Petra Vollmer", 1]);
  plant(p, { id: "e5" });
  assert.equal(planRemove(s.store, "e5").outcome, "discard");
  editEv(p, (r) => (r.entries = r.entries.filter((e) => e.id !== "e1" || e.owner.name === "Agent")));
  assert.equal(planRemove(s.store, "e1").outcome, "restore_first");
  assert.equal(planRemove(s.store, "e1", { discard: true }).outcome, "discard");
});
