// Batch C4c-2: the organisation's evidence in the dashboard. The person signs only what they saw: recording shows
// the checked, normalised values first (dryRun, nothing written) and then sends exactly those; removing shows the
// outcome and the entry first and sends both back; a changed file is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { addOrgEvidence, entryDigest, planRemove, readOrgEvidence, removeOrgEvidence } from "../dist/core/orgevidence.js";
import { createApp } from "../dist/server.js";
import { tempProject } from "./helpers.mjs";

const HASH = "sha256:" + "b".repeat(64);
const doc = (over = {}) => ({ control: "A.2.2", url: "https://intranet.example.org/ki-richtlinie.pdf", hash: HASH, title: "KI-Richtlinie", role: "KI-Beauftragte", name: "Petra Vollmer", date: "2026-09-01", ...over });

function project() {
  const p = tempProject("evform-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API", title: "Build", goal: "Endpoints" });
  return { p, s };
}
async function serve(s) {
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess", openApproval: async () => ({ opened: true }), auditViewEveryMs: 0 });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, h = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: JSON.stringify(body ?? {}) });
  return { server, post };
}
const person = { cookie: "scenaria_approval=sess" };
const agent = { "x-scenaria-agent": "codex" };

test("C4c-2: the preview checks and normalises without writing; the signed entry is exactly the preview", async () => {
  const { s } = project();
  const { server, post } = await serve(s);
  try {
    assert.equal((await post("/api/audit-file/evidence", { ...doc(), dryRun: true }, agent)).status, 403, "agents preview nothing");
    let r = await post("/api/audit-file/evidence", { ...doc({ url: "https://bücher.example/Richtlinie", hash: "B".repeat(64), title: "  KI-Richtlinie  " }), dryRun: true }, person);
    assert.equal(r.status, 200);
    const { input } = await r.json();
    assert.equal(input.url, "https://xn--bcher-kva.example/Richtlinie", "an international domain shows as punycode");
    assert.equal(input.hash, HASH);
    assert.equal(input.title, "KI-Richtlinie");
    assert.equal(readOrgEvidence(s.store).entries.length, 0, "nothing written by the preview");
    // A bad input is refused in the preview already.
    r = await post("/api/audit-file/evidence", { ...doc({ url: "file:///etc/passwd" }), dryRun: true }, person);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "bad_url");
    // Sending the preview's values signs exactly them.
    r = await post("/api/audit-file/evidence", input, person);
    assert.equal(r.status, 200);
    const e = (await r.json()).entry;
    for (const k of ["control", "url", "hash", "title", "date"]) assert.equal(e[k], input[k], k);
    assert.deepEqual(e.owner, { role: input.role, name: input.name });
  } finally {
    server.close();
  }
});

test("C4c-2: removing shows outcome and entry first and is refused when the entry changed meanwhile", async () => {
  const { p, s } = project();
  const e = addOrgEvidence(s.store, doc(), { by: "kev", via: "terminal" });
  const { server, post } = await serve(s);
  try {
    let r = await post("/api/audit-file/evidence/remove", { id: e.id, dryRun: true }, person);
    assert.equal(r.status, 200);
    const plan = await r.json();
    assert.equal(plan.outcome, "remove");
    assert.equal(plan.entry.url, doc().url);
    assert.equal(plan.digest, entryDigest(readOrgEvidence(s.store).entries[0]));
    assert.equal(readOrgEvidence(s.store).entries[0].status, "active", "the plan changes nothing");
    // A wrong digest or outcome: refused, nothing changed.
    for (const expect of [{ outcome: "remove", digest: "0".repeat(64) }, { outcome: "discard", digest: plan.digest }]) {
      r = await post("/api/audit-file/evidence/remove", { id: e.id, expect }, person);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "changed");
      assert.equal(readOrgEvidence(s.store).entries[0].status, "active");
    }
    // Changed outside Scenaria after the person looked: the plan differs now, the old expectation is refused.
    const f = join(p.dir, ".scenaria/org-evidence.json");
    const raw = JSON.parse(readFileSync(f, "utf8"));
    raw.entries[0].title = "edited";
    writeFileSync(f, JSON.stringify(raw));
    r = await post("/api/audit-file/evidence/remove", { id: e.id, expect: { outcome: plan.outcome, digest: plan.digest } }, person);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "changed");
    raw.entries[0].title = "KI-Richtlinie";
    writeFileSync(f, JSON.stringify(raw));
    // What was shown: removed and signed.
    r = await post("/api/audit-file/evidence/remove", { id: e.id, expect: { outcome: plan.outcome, digest: plan.digest } }, person);
    assert.equal(r.status, 200);
    assert.equal(readOrgEvidence(s.store).entries[0].status, "removed");
    // Agents can do none of it.
    assert.equal((await post("/api/audit-file/evidence/remove", { id: e.id, dryRun: true }, agent)).status, 403);
  } finally {
    server.close();
  }
});

test("C4c-2: the core refuses a removal whose expectation does not match (decided under the lock)", () => {
  const { s } = project();
  const e = addOrgEvidence(s.store, doc(), { by: "kev", via: "terminal" });
  const plan = planRemove(s.store, e.id);
  assert.throws(() => removeOrgEvidence(s.store, e.id, { by: "kev", via: "dashboard" }, { expect: { outcome: "remove", digest: "x" } }), /not what was shown/);
  const r = removeOrgEvidence(s.store, e.id, { by: "kev", via: "dashboard" }, { expect: { outcome: plan.outcome, digest: entryDigest(plan.entry) } });
  assert.equal(r.entry.status, "removed");
});

test("C4c-2: in auditor mode the browser previews, removes and confirms nothing", async () => {
  const { s } = project();
  const e = addOrgEvidence(s.store, doc(), { by: "kev", via: "terminal" });
  const { server, post } = await serve(s);
  try {
    const start = await post("/api/audit-file/auditor-mode", {}, person);
    const v = start.headers.getSetCookie().find((c) => c.startsWith("scenaria_auditview=")).split(";")[0];
    for (const [path, body] of [["/api/audit-file/evidence", { ...doc(), dryRun: true }], ["/api/audit-file/evidence/remove", { id: e.id, dryRun: true }], ["/api/audit-file/evidence/confirm", { id: e.id, digest: "x" }], ["/api/audit-file/evidence/copy", { from: "/tmp", dryRun: true }]]) {
      const r = await post(path, body, { cookie: v });
      assert.equal(r.status, 403, path);
      assert.equal((await r.json()).code, "auditor_mode", path);
    }
  } finally {
    server.close();
  }
});

test("C4c-2: the dashboard sends what it showed (static check of the form)", () => {
  const src = readFileSync(new URL("../ui/src/OrgEvidenceForm.tsx", import.meta.url), "utf8");
  assert.match(src, /api\.orgEvidenceAdd\(preview\)/, "recording sends the preview's values");
  assert.match(src, /api\.orgEvidenceRemove\(st\.entry\.id, step\.discard, \{ outcome: p\.outcome, digest: p\.digest \}\)/, "removing sends outcome and digest shown");
  assert.match(src, /api\.orgEvidenceConfirm\(st\.entry\.id, st\.digest\)/, "confirming sends the digest of the entry shown");
  assert.match(src, /api\.orgEvidenceCopy\(from, \{ name: plan\.from\.name, entries: plan\.take\.map\(\(x\) => \(\{ id: x\.id, digest: x\.digest \}\)\) \}\)/, "taking over sends the name and every entry's digest shown");
  assert.doesNotMatch(src, /FormData|XMLHttpRequest|fetch\(/, "the document file is never uploaded (only api calls with JSON, no file)");
});

// ---------------------------------------------------------------- review C4c-2 (K1–K4), a test per finding
import { copyOrgEvidence, planCopy, validateInput, confirmOrgEvidence, orgEvidenceStates } from "../dist/core/orgevidence.js";
import { registerProject } from "../dist/core/projects.js";

test("C4c-2 K1: taking over is refused when the recorded project name or any signed value changed after the plan", () => {
  const a = project();
  const b = project();
  addOrgEvidence(b.s.store, doc({ note: "nur intern" }), { by: "kev", via: "terminal" });
  const plan = planCopy(a.s.store, b.p.dir);
  assert.equal(plan.take.length, 1);
  assert.equal(plan.take[0].note, "nur intern", "the note is part of the plan");
  const expect = { name: plan.from.name, entries: plan.take.map((x) => ({ id: x.id, digest: x.digest })) };
  // The other project's name changes after the plan (an agent edits its config).
  const cfgFile = join(b.p.dir, ".scenaria/config.json");
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
  const oldName = cfg.projectName;
  cfg.projectName = "TÜV-geprüfte Konzernrichtlinie";
  writeFileSync(cfgFile, JSON.stringify(cfg));
  assert.throws(() => copyOrgEvidence(a.s.store, b.p.dir, { by: "kev", via: "dashboard" }, undefined, expect), /changed since they were shown/);
  cfg.projectName = oldName;
  writeFileSync(cfgFile, JSON.stringify(cfg));
  // A digest that does not match the entry shown.
  assert.throws(() => copyOrgEvidence(a.s.store, b.p.dir, { by: "kev", via: "dashboard" }, undefined, { ...expect, entries: [{ id: plan.take[0].id, digest: "0".repeat(64) }] }), /changed since they were shown/);
  const r = copyOrgEvidence(a.s.store, b.p.dir, { by: "kev", via: "dashboard" }, undefined, expect);
  assert.equal(r.copied.length, 1);
  assert.equal(r.copied[0].note, "nur intern");
  assert.equal(r.copied[0].copiedFrom, plan.from.name);
});

test("C4c-2 K1: the HTTP copy needs the name and every digest shown", async () => {
  const a = project();
  const b = project();
  addOrgEvidence(b.s.store, doc(), { by: "kev", via: "terminal" });
  registerProject(b.p.dir);
  const { server, post } = await serve(a.s);
  try {
    const plan = await (await post("/api/audit-file/evidence/copy", { from: b.p.dir, dryRun: true }, person)).json();
    assert.match(plan.take[0].digest, /^[0-9a-f]{64}$/);
    let r = await post("/api/audit-file/evidence/copy", { from: b.p.dir, expect: plan.take.map((x) => x.id) }, person);
    assert.equal(r.status, 400, "ids alone are not enough");
    assert.equal((await r.json()).code, "plan_first");
    r = await post("/api/audit-file/evidence/copy", { from: b.p.dir, expect: { name: plan.from.name, entries: plan.take.map((x) => ({ id: x.id, digest: x.digest })) } }, person);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).copied.length, 1);
  } finally {
    server.close();
  }
});

test("C4c-2 K2: confirming refuses an entry that would change when signed (a look-alike link)", () => {
  const { p, s } = project();
  addOrgEvidence(s.store, doc(), { by: "kev", via: "terminal" });
  // A hand-made, unsigned entry with a look-alike domain (Cyrillic "а") and an upper-case hash.
  const f = join(p.dir, ".scenaria/org-evidence.json");
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const planted = { ...raw.entries[0], id: "e7", url: "https://exаmple.org/policy", hash: "sha256:" + "AB".repeat(32) };
  delete planted.pub;
  delete planted.sig;
  delete planted.keyId;
  raw.entries.push(planted);
  raw.nextId = 8;
  writeFileSync(f, JSON.stringify(raw));
  const st = orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e7");
  assert.equal(st.trust, "unsigned");
  assert.equal(st.normal, false, "marked for the dashboard: only discard is offered (review C4c-2 R1)");
  assert.equal(orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e1").normal, true);
  assert.throws(() => confirmOrgEvidence(s.store, "e7", st.digest, { by: "kev", via: "dashboard" }), /would change when signed/);
  assert.equal(orgEvidenceStates(s.store).entries.find((x) => x.entry.id === "e7").trust, "unsigned", "nothing signed");
});

test("C4c-2 K3: the HTTP removal needs the plan; K4: normalising twice gives the same values", async () => {
  const { s } = project();
  const e = addOrgEvidence(s.store, doc(), { by: "kev", via: "terminal" });
  const { server, post } = await serve(s);
  try {
    const r = await post("/api/audit-file/evidence/remove", { id: e.id }, person);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "plan_first");
    assert.equal(readOrgEvidence(s.store).entries[0].status, "active");
  } finally {
    server.close();
  }
  const title = "x".repeat(199) + " " + "y".repeat(20);
  const once = validateInput(doc({ title }));
  assert.equal(once.title, "x".repeat(199), "cut right after a space: trimmed");
  assert.deepEqual(validateInput(once), once, "idempotent");
});

test("C4c-2 R1: the dashboard offers only discard for an entry not in normal form, and says why in the person's language", () => {
  const src = readFileSync(new URL("../ui/src/OrgEvidenceForm.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!st\.normal\) return \{ remove: false, discard: true, confirm: false \};/);
  const app = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
  for (const code of ["not_normal", "changed", "plan_first"]) assert.match(app, new RegExp(`errorTexts\\.${code} = `), code);
});
