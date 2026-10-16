// Batch C1: the ISO/IEC 42001 Annex A control catalogue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANNEX_A_CONTROLS,
  ANNEX_A_AREAS,
  ANNEX_A_GROUPS,
  A6_APPLIES,
  A6_APPLIES_AGENTS,
  EVIDENCE_SOURCES,
  COVERAGE_LABEL,
  ASSURANCE_LABEL,
  ANNEX_A_SCOPE,
  ANNEX_A_STANDARD,
  controlsOfArea,
  coverageSummary,
  sourcesOf,
} from "../dist/core/iso42001.js";
import { Scenaria } from "../dist/core/index.js";
import { tempProject } from "./helpers.mjs";

// The reviewed mapping (C1, review K1–K17). Changing a coverage level is a decision for Kev: update this
// table only together with the catalogue and the reason.
const EXPECTED = {
  "A.2.2": "organisational", "A.2.3": "organisational", "A.2.4": "organisational",
  "A.3.2": "partly", "A.3.3": "organisational",
  "A.4.2": "partly", "A.4.3": "organisational", "A.4.4": "partly", "A.4.5": "organisational", "A.4.6": "organisational",
  "A.5.2": "organisational", "A.5.3": "organisational", "A.5.4": "organisational", "A.5.5": "organisational",
  "A.6.1.2": "partly", "A.6.1.3": "partly",
  "A.6.2.2": "partly", "A.6.2.3": "partly", "A.6.2.4": "partly", "A.6.2.5": "organisational", "A.6.2.6": "partly", "A.6.2.7": "organisational", "A.6.2.8": "partly",
  "A.7.2": "organisational", "A.7.3": "organisational", "A.7.4": "organisational", "A.7.5": "partly", "A.7.6": "organisational",
  "A.8.2": "organisational", "A.8.3": "organisational", "A.8.4": "organisational", "A.8.5": "organisational",
  "A.9.2": "partly", "A.9.3": "partly", "A.9.4": "organisational",
  "A.10.2": "organisational", "A.10.3": "organisational", "A.10.4": "organisational",
};

const filled = (x) => typeof x === "string" && x.trim().length > 0;
const both = (l) => filled(l?.de) && filled(l?.en) && l.de !== l.en;

test("catalogue: all 38 Annex A controls of ISO/IEC 42001:2023, in order, each once", () => {
  assert.equal(ANNEX_A_STANDARD, "ISO/IEC 42001:2023");
  assert.deepEqual(ANNEX_A_CONTROLS.map((c) => c.id), Object.keys(EXPECTED));
  assert.equal(new Set(ANNEX_A_CONTROLS.map((c) => c.id)).size, 38);
});

test("catalogue: nine areas A.2–A.10, A.6 split into A.6.1 and A.6.2, no empty area", () => {
  assert.deepEqual(ANNEX_A_AREAS.map((a) => a.id), ["A.2", "A.3", "A.4", "A.5", "A.6", "A.7", "A.8", "A.9", "A.10"]);
  for (const a of ANNEX_A_AREAS) {
    assert.ok(both(a.title), a.id);
    assert.ok(controlsOfArea(a.id).length > 0, `${a.id} has controls`);
  }
  for (const c of ANNEX_A_CONTROLS) {
    assert.ok(c.id.startsWith(c.area + "."), `${c.id} in ${c.area}`);
    assert.ok(c.id.startsWith(c.group + "."), `${c.id} in group ${c.group}`);
  }
  assert.equal(controlsOfArea("A.1").length, 0, "A.10 is not mistaken for A.1");
  assert.equal(controlsOfArea("A.10").length, 3);
  assert.deepEqual(ANNEX_A_GROUPS.map((g) => g.id), ["A.6.1", "A.6.2"]);
  assert.deepEqual(ANNEX_A_CONTROLS.filter((c) => c.group === "A.6.1").map((c) => c.id), ["A.6.1.2", "A.6.1.3"]);
  assert.equal(ANNEX_A_CONTROLS.filter((c) => c.group === "A.6.2").length, 7);
  for (const g of ANNEX_A_GROUPS) assert.ok(both(g.title), g.id);
});

test("catalogue: the reviewed coverage per control is pinned; nothing claims full evidence", () => {
  for (const c of ANNEX_A_CONTROLS) assert.equal(c.coverage, EXPECTED[c.id], c.id);
  assert.deepEqual(coverageSummary(), { evidenced: 0, partly: 13, organisational: 25 });
});

test("catalogue: required sources carry partly-covered controls; organisational controls only support", () => {
  const known = new Set(Object.keys(EVIDENCE_SOURCES));
  for (const c of ANNEX_A_CONTROLS) {
    if (c.coverage === "organisational") assert.equal(c.required.length, 0, `${c.id}: organisational has no required source`);
    else assert.ok(c.required.length > 0, `${c.id}: names the sources it needs`);
    const all = sourcesOf(c);
    for (const s of all) assert.ok(known.has(s), `${c.id}: unknown source ${s}`);
    assert.equal(new Set(all).size, all.length, `${c.id}: no source twice`);
    if (all.length === 0) assert.match(c.scenaria.de, /^Keine eigenen Nachweise/, `${c.id} says it has nothing`);
    // Every control leaves something to the organisation (none is "evidenced").
    assert.ok(both(c.organisation), `${c.id}: organisation part`);
  }
  const used = new Set(ANNEX_A_CONTROLS.flatMap(sourcesOf));
  for (const k of known) assert.ok(used.has(k), `source ${k} is used`);
});

test("catalogue: scope guard — policies, impact assessments and data management stay with the organisation", () => {
  for (const id of ["A.2.2", "A.2.3", "A.2.4", "A.5.2", "A.5.3", "A.5.4", "A.5.5", "A.7.2", "A.7.3", "A.7.4", "A.7.6"]) {
    const c = ANNEX_A_CONTROLS.find((x) => x.id === id);
    assert.equal(c.coverage, "organisational", id);
  }
  // A.6 evidence applies only under a condition: development controls when the project builds the AI system,
  // operation controls (monitoring, event logs) when the agents themselves are the AI system in scope.
  for (const c of ANNEX_A_CONTROLS) {
    if (c.area !== "A.6") assert.equal(c.appliesWhen, undefined, c.id);
    else assert.deepEqual(c.appliesWhen, ["A.6.2.6", "A.6.2.8"].includes(c.id) ? A6_APPLIES_AGENTS : A6_APPLIES, c.id);
  }
  assert.ok(both(A6_APPLIES) && both(A6_APPLIES_AGENTS));
});

test("catalogue: evidence sources state assurance, hash-chain, scope, period and limits honestly", () => {
  for (const [k, s] of Object.entries(EVIDENCE_SOURCES)) {
    assert.ok(both(s.label), `${k} label`);
    assert.ok(both(s.what), `${k} what`);
    assert.ok(both(s.limits), `${k} limits`);
    assert.ok(Object.keys(ASSURANCE_LABEL).includes(s.assurance), `${k} assurance`);
    assert.ok(["yes", "partly", "no"].includes(s.chained), `${k} chained`);
    assert.ok(["project", "machine"].includes(s.scope), `${k} scope`);
    assert.ok(["yes", "partly", "no"].includes(s.timed), `${k} timed`);
  }
  // Facts from the code (review K1, K3, K4, K5, K6, K7): these must never be presented as stronger.
  assert.equal(EVIDENCE_SOURCES.attribution.assurance, "self-reported", "attribution is stated by the caller");
  assert.equal(EVIDENCE_SOURCES.decisions.assurance, "self-reported");
  assert.equal(EVIDENCE_SOURCES.irreversible.assurance, "self-reported");
  assert.equal(EVIDENCE_SOURCES.rules.assurance, "recorded", "rules are not signed");
  assert.equal(EVIDENCE_SOURCES.rules.chained, "no");
  assert.equal(EVIDENCE_SOURCES.conversations.chained, "no");
  assert.equal(EVIDENCE_SOURCES.auditors.scope, "machine");
  assert.equal(EVIDENCE_SOURCES.fidelity.assurance, "derived");
  assert.match(EVIDENCE_SOURCES.fidelity.limits.de, /Heuristik/);
  assert.doesNotMatch(JSON.stringify(EVIDENCE_SOURCES.models), /vertrauensw|trusted/i, "no claim about trusted endpoints");
  assert.doesNotMatch(JSON.stringify(ANNEX_A_CONTROLS), /lückenlos|complete,? chained/i, "no claim of a complete log");
  for (const k of ["approvals", "signatures", "canon", "reseals"]) assert.equal(EVIDENCE_SOURCES[k].assurance, "signed", k);
  assert.match(EVIDENCE_SOURCES.approvals.limits.de, /nicht an eine Freigabe gebunden/);
  // Project rules: only the person activates them (S1, review K4/K5), but they are unsigned and outside the
  // chain — the catalogue says so and never counts them as signed approvals.
  assert.match(EVIDENCE_SOURCES.rules.limits.de, /Agenten können nur vorschlagen/);
  assert.match(EVIDENCE_SOURCES.rules.limits.de, /Ein Agent mit Shell unter dem Konto der Person kann diese Wege nutzen/);
  assert.match(EVIDENCE_SOURCES.rules.limits.de, /angegebener Name, nicht geprüft/);
  assert.match(EVIDENCE_SOURCES.rules.limits.de, /Änderung direkt an der Datei bleibt unbemerkt/);
  assert.match(EVIDENCE_SOURCES.approvals.limits.de, /Projektregeln brauchen die Freigabe der Person, sind aber nicht signiert/);
  assert.match(EVIDENCE_SOURCES.rewinds.limits.de, /wer zurückgesprungen ist, wird nicht aufgezeichnet/);
  assert.match(EVIDENCE_SOURCES.canon.limits.de, /nicht als gebrochen gemeldet/);
  // The status shown for a project can also be "not covered".
  for (const k of ["evidenced", "partly", "organisational", "not_covered"]) assert.ok(both(COVERAGE_LABEL[k]), k);
  for (const k of Object.keys(ASSURANCE_LABEL)) assert.ok(both(ASSURANCE_LABEL[k]), k);
  assert.ok(both(ANNEX_A_SCOPE));
});

test("catalogue: titles are short and every text exists in German and English", () => {
  for (const c of ANNEX_A_CONTROLS) {
    assert.ok(both(c.title), `${c.id} title`);
    assert.ok(both(c.scenaria), `${c.id} scenaria`);
    assert.ok(c.title.de.length <= 60 && c.title.en.length <= 60, `${c.id}: short title`);
  }
});

test("catalogue module has no imports of any kind (shared with the dashboard)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "core", "iso42001.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const anyImport = /^\s*(import\b|export\s+(\*(\s+as\s+\w+)?|\{[^}]*\})\s+from\b)|\bimport\s*\(|\brequire\s*\(/m;
  assert.doesNotMatch(code, anyImport);
  // The check itself catches every form (review R9).
  for (const s of ['import x from "y";', 'export * from "./a.js";', 'export * as a from "./a.js";', 'export { a } from "./a.js";', 'const u = "http://x"; import("./y.js");', 'require("x");']) {
    assert.match(s, anyImport, s);
  }
});

test("catalogue facts match the engine: what is in the hash chain, and what is not recorded (review R1–R3, R7)", () => {
  const p = tempProject("iso-facts-");
  p.write("a.txt", "x");
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "t", goal: "g", projectGoal: "Goal A" });
  const c1 = s.checkpoint({ title: "c1", outputs: ["o"] });
  s.setProjectGoal("Goal B", { agent: "x" });
  p.write("a.txt", "y");
  const c2 = s.checkpoint({ title: "c2", outputs: ["o"] });
  s.verify(c2.id, { status: "failed", notes: "self", by: "agentX", origin: "agent" });
  s.addRule("Always write tests", "manual");
  const nodeFile = (id) => join(p.dir, ".scenaria", "nodes", `${id}.json`);
  const edit = (file, fn) => {
    const j = JSON.parse(readFileSync(file, "utf8"));
    fn(j);
    writeFileSync(file, JSON.stringify(j, null, 2));
  };
  const tampered = () => [...s.integrity().state].filter(([, v]) => v === "tampered").map(([k]) => k);
  assert.deepEqual(tampered(), []);

  // Not chained: project rules and the event log can be edited without any node turning tampered.
  writeFileSync(join(p.dir, ".scenaria", "memory.json"), JSON.stringify({ rules: [] }));
  const events = join(p.dir, ".scenaria", "events.jsonl");
  writeFileSync(events, readFileSync(events, "utf8") + JSON.stringify({ ts: new Date().toISOString(), type: "note", data: { message: "forged" } }) + "\n");
  assert.deepEqual(tampered(), [], "rules and events are outside the chain");
  assert.equal(EVIDENCE_SOURCES.rules.chained, "no");

  // Chained: earlier goal versions and verdicts live on nodes — editing them is detected.
  edit(nodeFile("n0"), (j) => (j.meta.goalHistory[0].goal = "Goal FORGED"));
  assert.ok(tampered().includes("n0"), "goal history is in the chain");
  assert.equal(EVIDENCE_SOURCES.goal.chained, "yes");
  edit(nodeFile(c2.id), (j) => (j.verification.status = "passed"));
  assert.ok(tampered().includes(c2.id), "verdicts are in the chain");
  assert.equal(EVIDENCE_SOURCES.verdicts.chained, "yes");

  // Who rewound is not recorded in the event.
  const q = tempProject("iso-rewind-");
  q.write("a.txt", "x");
  const t2 = Scenaria.init(q.dir);
  t2.startMission({ title: "t", goal: "g" });
  const a = t2.checkpoint({ title: "a", outputs: ["o"] });
  q.write("a.txt", "y");
  t2.checkpoint({ title: "b", outputs: ["o"] });
  t2.rewind(a.id, { lesson: "dead end", agent: "agentR", user: "bob" });
  const ev = readFileSync(join(q.dir, ".scenaria", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "rewind");
  assert.equal(ev.length, 1);
  assert.doesNotMatch(JSON.stringify(ev[0]), /agentR|bob/, "the rewind event names no actor");
});
