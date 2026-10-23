// Batch E2a: progress — completion criteria (future fixed points with task, weight, file), levels from evidence,
// gates, the formulas progress/1 and progress-project/1, the tool, the CLI and the HTTP route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { applyBlocks } from "../dist/core/blocks.js";
import { artifactMatches, validateArtifact } from "../dist/core/canon.js";
import { derive, recompute, expand } from "../dist/core/derivation.js";
import { projectProgress, taskProgress, renderProgress, progressForAgents } from "../dist/core/progress.js";
import { tempProject } from "./helpers.mjs";
import { contentHash as contentHashOf } from "../dist/core/ledger.js";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ctx = { source: "mcp", agent: "claude-code" };
const plain = (x) => String(x).replace(/\x1b\[[0-9;]*m/g, "");

function project(goal = "Write the quarterly report") {
  const p = tempProject();
  p.write("README.md", "hello\n");
  const s = Scenaria.init(p.dir);
  const task = s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal });
  return { p, s, task: task.id };
}
const person = { user: "kev", via: "dashboard" };
const crit = (s, task, o) => s.addCanonAsUser({ kind: "future", text: o.text, task, weight: o.weight, artifact: o.artifact, check: o.check }, person);
const tp = (s, task) => taskProgress(s, task);
const lv = (t, id) => t.criteria.find((c) => c.id === id);

test("E2 model: criteria carry task, weight and file; they are validated", () => {
  const { s, task } = project();
  const r = callTool(s, "scenaria_canon", { action: "propose", kind: "future", text: "Report is written", task, weight: 60, artifact: "./docs/report.md" }, ctx);
  assert.match(r.text, /k1 proposed/);
  const k1 = s.canon()[0];
  assert.deepEqual([k1.task, k1.weight, k1.artifact, k1.status], [task, 60, "docs/report.md", "proposed"]);
  // Validation: only future, a real task, a weight 1–100, a file inside the project.
  assert.throws(() => s.proposeCanon({ kind: "past", text: "Only TypeScript", task }), /future fixed points/);
  assert.throws(() => s.proposeCanon({ kind: "future", text: "Report done", task: "n99" }), /does not exist/);
  assert.throws(() => s.proposeCanon({ kind: "future", text: "Report done", task: "n0" }), /not a task/);
  assert.throws(() => s.proposeCanon({ kind: "future", text: "Report done", task, weight: 0 }), /1 to 100/);
  assert.throws(() => s.proposeCanon({ kind: "future", text: "Report done", task, weight: 2.5 }), /1 to 100/);
  assert.throws(() => s.proposeCanon({ kind: "future", text: "Report done", weight: 5 }), /needs the task/);
  for (const bad of ["../x.md", "/etc/passwd", "~/x", "C:/x", "a\\b", "a//b", ".scenaria/canon.json", "docs/[ab].md", "x\u202e.md"])
    assert.throws(() => s.proposeCanon({ kind: "future", text: `Report ${bad}`, task, artifact: bad }), /artifact/, bad);
  assert.throws(() => callTool(s, "scenaria_canon", { action: "propose", kind: "future", text: "Report done", task, weight: 101 }, ctx), /Invalid arguments/);
  // Same words in another task: another criterion (not collapsed into k1).
  s.checkpoint({ title: "work" });
  const other = s.startMission({ title: "Q4 report", goal: "Write the next one" }).id;
  const k2 = s.proposeCanon({ kind: "future", text: "Report is written", task: other, weight: 50 });
  assert.equal(k2.id, "k2");
  assert.equal(s.proposeCanon({ kind: "future", text: "report is written", task: other }).id, "k2");
});

test("E2 signature: criteria are signed as canon/v3; hand edits of task, weight or file are tampering", () => {
  const { p, s, task } = project();
  s.proposeCanon({ kind: "future", text: "Report is written", task, weight: 60, artifact: "docs/report.md" });
  // The person may change the weight on approval — approving exactly what was shown (review M3).
  const shown = { text: "Report is written", task, weight: 60, artifact: "docs/report.md" };
  assert.throws(() => s.decideCanon("k1", "approve", { ...person, weight: 70 }), /approving it needs what you were shown/);
  assert.throws(() => s.decideCanon("k1", "approve", { ...person, expect: { ...shown, weight: 50 } }), /changed since you saw it/);
  const ev = s.decideCanon("k1", "approve", { ...person, weight: 70, expect: shown });
  assert.ok(ev.approvedAt && ev.approvedAt >= ev.createdAt, "evidence counts from the approval");
  assert.deepEqual([ev.status, ev.weight], ["active", 70]);
  assert.equal(s.canonState().events[0].trust, "verified");
  const f = join(p.dir, ".scenaria/canon.json");
  const good = readFileSync(f, "utf8");
  const edit = (fn) => {
    const j = JSON.parse(good);
    fn(j.events[0]);
    writeFileSync(f, JSON.stringify(j));
    return Scenaria.open(p.dir).canonState().events[0].status;
  };
  assert.equal(edit((e) => (e.weight = 100)), "tampered");
  assert.equal(edit((e) => (e.weight = "70")), "tampered", "a weight of another type is dropped, which changes the payload");
  assert.equal(edit((e) => (e.artifact = "docs/other.md")), "tampered");
  assert.equal(edit((e) => (e.task = "n0")), "tampered");
  assert.equal(edit((e) => (e.approvedAt = "2000-01-01T00:00:00.000Z")), "tampered", "the time from which changes count is signed");
  assert.equal(edit((e) => (e.approvedAt = "yesterday")), "tampered", "a malformed time is dropped, which changes the payload");
  assert.equal(edit((e) => (delete e.task, delete e.weight, delete e.artifact)), "tampered", "stripping all criterion fields (v3 → v2) does not verify");
  writeFileSync(f, good);
  assert.equal(Scenaria.open(p.dir).canonState().events[0].status, "active");
  // A plain fixed point without criterion fields stays canon/v2; adding a weight by hand breaks it.
  s.addCanonAsUser({ kind: "future", text: "10k users by 2027-01-01" }, person);
  const j = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(Scenaria.open(p.dir).canonState().events[1].status, "active");
  j.events[1].task = task;
  j.events[1].weight = 50;
  writeFileSync(f, JSON.stringify(j));
  assert.equal(Scenaria.open(p.dir).canonState().events[1].status, "tampered");
});

test("E2 reweigh: a new weight is a new signed revision; only for active criteria; the check must run again", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Tests pass", weight: 40, check: "true" });
  await s.checkCanon(["k1"], "kev");
  const before = s.canon()[0];
  assert.equal(before.lastCheck.status, "passed");
  const ev = s.decideCanon("k1", "reweigh", { ...person, weight: 55, reason: "bigger than thought" });
  assert.equal(ev.weight, 55);
  assert.ok(ev.rev > before.rev);
  assert.equal(s.canon()[0].lastCheck, undefined, "the check result belonged to the old revision");
  assert.equal(s.canonState().events[0].trust, "verified");
  assert.throws(() => s.decideCanon("k1", "reweigh", { ...person, weight: 55 }), /already has the weight/);
  assert.throws(() => s.decideCanon("k1", "reweigh", { ...person }), /needs a weight/);
  assert.throws(() => s.decideCanon("k1", "retire", { ...person, weight: 3 }), /approve or reweigh/);
  s.addCanonAsUser({ kind: "past", text: "Only TypeScript" }, person);
  assert.throws(() => s.decideCanon("k2", "reweigh", { ...person, weight: 3 }), /not a completion criterion/);
  // Agents have no way to reweigh (the tool knows list/suggest/propose only).
  assert.throws(() => callTool(s, "scenaria_canon", { action: "reweigh", id: "k1", weight: 1 }, ctx), /Invalid arguments/);
  // CLI: only in an interactive terminal (a person).
  const r = spawnSync(process.execPath, [CLI, "canon", "reweigh", "k1", "--weight", "10", "--root", p.dir], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(plain(r.stderr + r.stdout), /interactive terminal/);
});

test("E2 fulfills: only approved future fixed points; unknown ones are an error for the tool", () => {
  const { s, task } = project();
  crit(s, task, { text: "Report is written", weight: 60, artifact: "docs/report.md" });
  s.proposeCanon({ kind: "future", text: "Charts are added", task, weight: 40 });
  s.addCanonAsUser({ kind: "past", text: "Only Markdown" }, person);
  assert.throws(() => callTool(s, "scenaria_checkpoint", { title: "x", fulfills: ["k2"] }, ctx), /not approved completion criterion "k2"/);
  assert.throws(() => callTool(s, "scenaria_checkpoint", { title: "x", fulfills: ["k3"] }, ctx), /not approved completion criterion "k3"/);
  const n = s.checkpoint({ title: "draft", fulfills: ["k1", "k2", "k3", "k9"] });
  assert.deepEqual(n.fulfills, ["k1"], "the engine keeps only approved future fixed points");
  // Chat blocks pass it on the same way.
  const r = applyBlocks(s, '```scenaria\n{"checkpoint": {"title": "more", "fulfills": ["k1", "k2"]}}\n```', { source: "ui" });
  assert.deepEqual(r.created[0].fulfills, ["k1"]);
  s.checkpoint({ title: "after" });
  assert.match(s.context().markdown, /reports criteria k1 as implemented \(counts with evidence only\)/);
});

test("E2 levels and gates: from 0 to 100 only with evidence; 90 and 100 need the person", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 60, artifact: "docs/report.md", check: "test -s docs/report.md" });
  crit(s, task, { text: "Numbers are reconciled", weight: 40, check: "true" });
  let t = tp(s, task);
  assert.deepEqual(t.criteria.map((c) => c.level), [0, 0]);
  assert.deepEqual(t.gates.filter((g) => g.met).map((g) => g.cap), [10]);
  assert.equal(t.value, 0);
  assert.match(t.nextAgent, /Decide the approach/);
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  t = tp(s, task);
  assert.deepEqual(t.gates.filter((g) => g.met).map((g) => g.cap), [10, 20]);
  assert.match(t.nextAgent, /Create a first result file: k1 docs\/report.md/);
  // The file exists and is reported: implemented (0.5), first results (40).
  p.write("docs/report.md", "# Q3\n");
  s.checkpoint({ title: "draft", fulfills: ["k1"] });
  t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how, lv(t, "k1").fileChanged], [0.5, "implemented", true]);
  assert.equal(t.value, 30);
  assert.equal(t.derivation.formula, "progress/1");
  assert.equal(recompute(t.derivation), t.value);
  // A claim without evidence: the step changed no file → only 0.25.
  s.checkpoint({ title: "numbers done", fulfills: ["k2"] });
  t = tp(s, task);
  assert.deepEqual([lv(t, "k2").level, lv(t, "k2").how], [0.25, "claimed"]);
  assert.match(lv(t, "k2").notes[0].en, /changed no file/);
  // With a changed file it counts: all ≥ 0.5 → gate 60.
  p.write("data/numbers.csv", "a,b\n1,2\n");
  s.checkpoint({ title: "numbers reconciled", fulfills: ["k2"] });
  t = tp(s, task);
  assert.equal(lv(t, "k2").level, 0.5);
  assert.equal(t.value, 50);
  assert.ok(t.gates.find((g) => g.cap === 60).met);
  // Checks pass (the person starts them): 0.75 → gate 80.
  await s.checkCanon(undefined, "kev");
  t = tp(s, task);
  assert.deepEqual(t.criteria.map((c) => [c.level, c.how]), [[0.75, "checked"], [0.75, "checked"]]);
  assert.equal(t.value, 75);
  // The file changes after the check: the check is stale, back to implemented.
  p.write("docs/report.md", "# Q3\n\nMore.\n");
  s.checkpoint({ title: "more text" });
  t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how], [0.5, "implemented"]);
  assert.match(lv(t, "k1").notes.map((n) => n.en).join(" "), /stale/);
  await s.checkCanon(["k1"], "kev");
  // The person confirms both: 1.0 each, all accepted → 90 (not 100 yet).
  s.decideCanon("k1", "confirm", person);
  s.decideCanon("k2", "confirm", person);
  t = tp(s, task);
  assert.deepEqual(t.criteria.map((c) => [c.level, c.how]), [[1, "confirmed"], [1, "confirmed"]]);
  assert.equal(t.value, 90);
  assert.match(t.nextAgent, /The person reviews the task's last step/);
  // An agent's own "passed" on the last step does not make it 100 (rule 11).
  s.verify(t.tip, { status: "passed", notes: "all good", by: "claude" });
  assert.equal(tp(s, task).value, 90);
  // The person's verdict on the last step: 100.
  s.verify(t.tip, { status: "passed", origin: "person", via: "dashboard", by: "kev" });
  t = tp(s, task);
  assert.equal(t.value, 100);
  assert.equal(t.next, null);
  assert.equal(recompute(t.derivation), 100);
});

test("E2 a failed check caps the criterion at 0.5 (Kev: höchstens 0,5); a stale one does not count", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md", check: "false" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  const n = s.checkpoint({ title: "draft", fulfills: ["k1"] });
  await s.checkCanon(["k1"], "kev");
  let t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how], [0.5, "implemented"]);
  // Even the person's verdict on the claiming step does not lift it while the failed check stands.
  s.verify(n.id, { status: "passed", origin: "person", via: "dashboard", by: "kev" });
  t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how], [0.5, "check-failed"]);
  assert.match(lv(t, "k1").notes.map((x) => x.en).join(" "), /check command failed/);
  // The file changes after the failed check: the failure is stale; the verdict is older than the change too.
  p.write("docs/report.md", "# Q3 fixed\n");
  s.checkpoint({ title: "fix", fulfills: ["k1"] });
  t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how], [0.5, "implemented"]);
});

test("E2 the person's verdict on the claiming step accepts a criterion; an agent's own does not", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  p.write("docs/report.md", "# Q3\n");
  const n = s.checkpoint({ title: "draft", fulfills: ["k1"] });
  s.verify(n.id, { status: "passed", by: "claude" });
  assert.equal(lv(tp(s, task), "k1").level, 0.5);
  s.verify(n.id, { status: "passed", origin: "person", via: "dashboard", by: "kev" });
  let t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how, lv(t, "k1").evidence.includes(n.id)], [1, "verdict", true]);
  // A later change of the file makes the verdict stale for this criterion.
  p.write("docs/report.md", "# Q3 v2\n");
  s.checkpoint({ title: "v2" });
  t = tp(s, task);
  assert.equal(lv(t, "k1").level, 0.5);
});

test("E2 an old file is no result; an abandoned attempt and a step changed outside Scenaria are no evidence", () => {
  const { p, s, task } = project();
  p.write("docs/report.md", "# old\n");
  s.checkpoint({ title: "old file" });
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  let t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how, lv(t, "k1").fileChanged], [0.25, "file", false]);
  assert.equal(t.gates.find((g) => g.cap === 40).met, false, "a file from before the criterion is no first result");
  // An attempt that is abandoned by a rewind does not count.
  const back = s.head().id;
  p.write("docs/report.md", "# new attempt\n");
  s.checkpoint({ title: "attempt", fulfills: ["k1"] });
  assert.equal(lv(tp(s, task), "k1").level, 0.5);
  s.rewind(back, { lesson: "wrong angle", restoreFiles: true });
  t = tp(s, task);
  assert.equal(lv(t, "k1").level, 0.25, "the claim is on the abandoned line");
  // A step changed outside Scenaria is no evidence.
  p.write("docs/report.md", "# second attempt\n");
  const n = s.checkpoint({ title: "attempt 2", fulfills: ["k1"] });
  assert.equal(lv(tp(s, task), "k1").level, 0.5);
  const f = join(p.dir, `.scenaria/nodes/${n.id}.json`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.title = "edited";
  writeFileSync(f, JSON.stringify(j));
  // Neither the claim nor the file in that changed state counts (review M4: no file counts as there).
  assert.equal(lv(taskProgress(Scenaria.open(p.dir), task), "k1").level, 0);
});

test("E2 unsettled criteria (proposed, changed outside) block gate 20 and are listed; no weight keeps gate 20 open", () => {
  const { p, s, task } = project();
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  s.proposeCanon({ kind: "future", text: "Report is written", task, artifact: "docs/report.md" });
  const shown = { text: "Report is written", task, artifact: "docs/report.md" };
  let t = tp(s, task);
  assert.equal(t.criteria.length, 0);
  assert.deepEqual(t.unsettled.map((u) => [u.id, u.status]), [["k1", "proposed"]]);
  assert.equal(t.value, 0);
  assert.match(t.nextAgent, /Propose a completion criterion/);
  s.decideCanon("k1", "approve", { ...person, expect: shown }); // approved without a weight
  t = tp(s, task);
  assert.equal(lv(t, "k1").weight, null);
  assert.equal(t.gates.find((g) => g.cap === 20).met, false);
  assert.match(t.nextAgent, /Set a weight for k1/);
  s.decideCanon("k1", "reweigh", { ...person, weight: 30 });
  crit(s, task, { text: "Numbers are reconciled", weight: 70 });
  assert.equal(tp(s, task).gates.find((g) => g.cap === 20).met, true);
  // A criterion changed outside Scenaria does not count and blocks gate 20 until the person decides.
  const f = join(p.dir, ".scenaria/canon.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.events[1].weight = 1;
  writeFileSync(f, JSON.stringify(j));
  t = taskProgress(Scenaria.open(p.dir), task);
  assert.deepEqual(t.unsettled.map((u) => [u.id, u.status]), [["k2", "tampered"]]);
  assert.equal(t.gates.find((g) => g.cap === 20).met, false);
  assert.match(t.nextAgent, /The person decides on k2/);
});

test("E2 project progress: mean over tasks with criteria; tasks without criteria do not count; abandoned ones still do (review M2)", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  s.checkpoint({ title: "draft", fulfills: ["k1"] });
  const t2 = s.startMission({ title: "Slides", goal: "Slides for the board" }).id;
  s.checkpoint({ title: "outline" });
  const t3 = s.startMission({ title: "Housekeeping", goal: "Tidy up" }).id;
  crit(s, t3, { text: "Old files removed", weight: 10 });
  let pr = projectProgress(s);
  assert.deepEqual(pr.tasks.map((t) => [t.task, t.value]), [[task, 50], [t3, 0]]);
  assert.deepEqual(pr.without.map((w) => w.task), [t2]);
  assert.equal(pr.value, 25);
  assert.equal(pr.derivation.formula, "progress-project/1");
  assert.equal(recompute(pr.derivation), 25);
  assert.match(pr.derivation.sentence.de, /Mittelwert über 2 Aufgaben mit Kriterien.*1 Aufgabe ohne Kriterien zählt nicht mit/);
  // An agent can mark a task abandoned (node update); that must not lift the project: it still counts until the
  // person retires its criteria.
  const n3 = s.store.readNode(t3);
  n3.status = "abandoned";
  s["save"](n3);
  pr = projectProgress(s);
  assert.deepEqual(pr.abandoned, [t3]);
  assert.equal(pr.value, 25);
  let txt = renderProgress(pr, "de");
  assert.match(txt, /Projekt: 25 %/);
  assert.match(txt, /aufgegeben – zählt mit, bis die Person die Kriterien ausmustert/);
  s.decideCanon("k2", "retire", person);
  pr = projectProgress(s);
  assert.equal(pr.value, 50, "retired by the person: the task no longer has criteria");
  txt = renderProgress(pr, "de");
  assert.match(txt, /Projekt: 50 %/);
  assert.match(txt, new RegExp(`Ohne Kriterien \\(nicht messbar\\): ${t2}, ${t3}`));
});

test("E2 formulas: the value is recomputed from the inputs; malformed inputs are ignored, never trusted", () => {
  const gates = (n) => [10, 20, 40, 60, 80, 90, 100].map((c) => `${c} ${c <= n ? "met" : "open"}`);
  const d = derive("p", "progress/1", { criteria: ["k1 w=60 s=1 confirmed", "k2 w=40 s=0.5 implemented"], gates: gates(60) });
  assert.equal(d.value, 60, "raw 80, capped at 60");
  assert.match(d.sentence.de, /gewichtet zu 80 % erfüllt; gedeckelt auf 60 %, weil das Tor „alle Kriterien geprüft“ noch offen ist/);
  assert.match(d.sentence.en, /capped at 60 %/);
  // Gates count only in order: a later gate met without an earlier one does not lift the cap.
  assert.equal(derive("p", "progress/1", { criteria: ["k1 w=1 s=1 x"], gates: ["10 met", "20 open", "40 met", "60 met", "80 met", "90 met", "100 met"] }).value, 10);
  assert.equal(derive("p", "progress/1", { criteria: ["k1 w=1 s=1 x"], gates: ["20 met"] }).value, 0);
  // Malformed items are left out: level 0.6, weight 0 or 500, missing parts.
  assert.equal(derive("p", "progress/1", { criteria: ["k1 w=50 s=0.6 x", "k2 w=0 s=1", "k3 w=500 s=1", "k4", 7, "k5 w=10 s=0.5 x"], gates: gates(100) }).value, 50);
  assert.equal(derive("p", "progress/1", { criteria: [], gates: gates(100) }).value, 0);
  assert.match(derive("p", "progress/1", { criteria: [], gates: [] }).sentence.en, /no approved criterion/);
  // A forged value does not survive recompute; the short form expands to the same.
  const forged = { ...d, value: 95 };
  assert.notEqual(recompute(forged), 95);
  assert.equal(expand({ key: "p", value: 1, formula: "progress/1", inputs: { criteria: ["k1 w=1 s=0.5 x"], gates: gates(60) } }).value, 50);
  // Project: mean of p, malformed ignored.
  const pd = derive("pp", "progress-project/1", { tasks: ["n1 p=50", "n2 p=0", "n3 p=101", "n4"], without: ["n9"] });
  assert.equal(pd.value, 25);
  assert.equal(derive("pp", "progress-project/1", { tasks: [], without: [] }).value, 0);
});

test("E2 file patterns: *, ** and ? — never above the project", () => {
  assert.equal(validateArtifact("./docs/report.md"), "docs/report.md");
  assert.equal(validateArtifact(""), undefined);
  assert.ok(artifactMatches("docs/report.md", "docs/report.md"));
  assert.ok(!artifactMatches("docs/report.md", "docs/report.mdx"));
  assert.ok(!artifactMatches("docs/report.md", "docsXreport.md"), "a dot is a dot");
  assert.ok(artifactMatches("docs/*.md", "docs/a.md"));
  assert.ok(!artifactMatches("docs/*.md", "docs/sub/a.md"));
  assert.ok(artifactMatches("test/**/*.test.mjs", "test/a.test.mjs"));
  assert.ok(artifactMatches("test/**/*.test.mjs", "test/x/y/a.test.mjs"));
  assert.ok(artifactMatches("src/**", "src/a/b.ts"));
  assert.ok(artifactMatches("v?.txt", "v1.txt"));
  assert.ok(!artifactMatches("v?.txt", "v12.txt"));
  assert.ok(artifactMatches("a+b(c).md", "a+b(c).md"), "regex characters are literal");
});

test("E2 tool, CLI and HTTP: read-only progress for agents and the dashboard", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  callTool(s, "scenaria_checkpoint", { title: "draft", fulfills: ["k1"] }, ctx);
  const r = callTool(s, "scenaria_progress", {}, ctx);
  assert.match(r.text, /Project: 50 %/);
  assert.match(r.text, new RegExp(`${task} Q3 report: 50 %`));
  assert.match(r.text, /k1 \[implemented, implemented\] w=50 docs\/report.md/);
  assert.match(r.text, /Next: Get the check command to pass|Next: /);
  assert.equal(r.data.why.formula, "progress-project/1");
  assert.equal(recompute(r.data.tasks[0].why), 50);
  assert.equal(r.data.tasks[0].derivation, undefined, "agents get the short form");
  assert.throws(() => callTool(s, "scenaria_progress", { task: "n0" }, ctx), /not a task/);
  assert.equal(callTool(s, "scenaria_progress", { task }, ctx).data.tasks.length, 1);
  // CLI
  const c = spawnSync(process.execPath, [CLI, "progress", "--root", p.dir, "--lang", "de"], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  assert.match(plain(c.stdout), /Projekt: 50 %/);
  const cj = spawnSync(process.execPath, [CLI, "progress", task, "--root", p.dir, "--json"], { encoding: "utf8" });
  assert.equal(cj.status, 0, cj.stderr);
  assert.equal(JSON.parse(cj.stdout).value, 50);
  // HTTP
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const j = await (await fetch(`${base}/api/progress`, { headers: { "x-scenaria": "1" } })).json();
    assert.equal(j.value, 50);
    assert.equal(j.tasks[0].derivation.formula, "progress/1");
    assert.equal(recompute(j.tasks[0].derivation), j.tasks[0].value);
    // The dashboard's reweigh goes through the person's approval.
    const agent = await fetch(`${base}/api/canon/decide`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-agent": "codex" }, body: JSON.stringify({ id: "k1", action: "reweigh", weight: 20 }) });
    assert.equal(agent.status, 403);
    const ok = await fetch(`${base}/api/canon/decide`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: JSON.stringify({ id: "k1", action: "reweigh", weight: 20 }) });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal((await ok.json()).weight, 20);
    const add = await fetch(`${base}/api/canon`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: JSON.stringify({ kind: "future", text: "Charts added", task, weight: 30, artifact: "docs/charts/*.png" }) });
    assert.equal(add.status, 200, await add.clone().text());
    const added = await add.json();
    assert.deepEqual([added.status, added.task, added.weight, added.artifact], ["active", task, 30, "docs/charts/*.png"]);
    const listed = (await (await fetch(`${base}/api/canon`, { headers: { "x-scenaria": "1" } })).json()).events.find((e) => e.id === added.id);
    assert.equal(listed.trust, "verified");
  } finally {
    server.close();
  }
  assert.equal(progressForAgents(projectProgress(s)).tasks[0].why.formula, "progress/1");
});

// ------------------------------------------------------------------ E2a review: one test per finding

test("E2a review H1: removing, moving or renaming an open criterion by hand never raises progress", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  crit(s, task, { text: "Numbers are reconciled", weight: 50 });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  s.checkpoint({ title: "draft", fulfills: ["k1"] });
  s.decideCanon("k1", "confirm", person);
  const base = tp(s, task).value;
  assert.equal(base, 40);
  const f = join(p.dir, ".scenaria/canon.json");
  const good = readFileSync(f, "utf8");
  const cases = {
    deleted: (j) => (j.events = j.events.filter((e) => e.id !== "k2")),
    "moved to a bogus task": (j) => (j.events[1].task = "x"),
    "moved to an unknown task": (j) => (j.events[1].task = "n9999"),
    "made a past fixed point": (j) => (j.events[1].kind = "past"),
    renamed: (j) => (j.events[1].id = "kx"),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const j = JSON.parse(good);
    fn(j);
    writeFileSync(f, JSON.stringify(j));
    const t = taskProgress(Scenaria.open(p.dir), task);
    assert.ok(t.value <= base, `${name}: ${t.value}`);
    assert.ok(t.unsettled.some((u) => u.id === "k2"), `${name}: k2 is held back`);
    assert.equal(t.gates.find((g) => g.cap === 20).met, false, name);
  }
  writeFileSync(f, good);
  assert.equal(tp(s, task).value, 40);
  // Retired by the person: no longer held back.
  s.decideCanon("k2", "retire", person);
  assert.deepEqual(tp(s, task).unsettled, []);
});

test("E2a review H2/H3: check results and confirmations count only on the line they were made on", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md", check: "test -s docs/report.md" });
  const d = s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  const draft = s.checkpoint({ title: "draft" });
  s.verify(draft.id, { status: "passed", origin: "person", via: "dashboard", by: "kev" }); // the person liked the draft
  p.write("docs/report.md", "# Q3 final\n");
  s.checkpoint({ title: "final", fulfills: ["k1"] });
  await s.checkCanon(["k1"], "kev");
  assert.deepEqual([lv(tp(s, task), "k1").level, lv(tp(s, task), "k1").how], [0.75, "checked"]);
  // Fork to the other option (no report there): the check result belongs to the abandoned line.
  s.fork(d.id, "Word", { restoreFiles: true });
  let t = tp(s, task);
  assert.ok(lv(t, "k1").level <= 0.25, JSON.stringify(lv(t, "k1")));
  assert.match(lv(t, "k1").notes.map((n) => n.en).join(" "), /belongs to another line/);
  // Back on the Markdown line the person confirms; rewinding to the verified draft does not keep the confirmation.
  s.fork(d.id, "Markdown", { restoreFiles: true });
  p.write("docs/report.md", "# Q3 final\n");
  s.checkpoint({ title: "final again", fulfills: ["k1"] });
  s.decideCanon("k1", "confirm", person);
  assert.equal(tp(s, task).value, 90);
  s.rewind(draft.id, { lesson: "back to the draft", restoreFiles: true });
  t = tp(s, task);
  assert.equal(t.tip, draft.id);
  assert.ok(t.value < 90, `rewound to a verified step: ${t.value}`);
  assert.notEqual(t.value, 100);
});

test("E2a review H3: a check the person runs after the task (HEAD in a later task) still counts for it", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md", check: "test -s docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  s.checkpoint({ title: "draft", fulfills: ["k1"] });
  s.startMission({ title: "Slides", goal: "Slides" });
  p.write("slides.md", "# slides\n");
  s.checkpoint({ title: "slides" });
  await s.checkCanon(["k1"], "kev");
  assert.deepEqual([lv(tp(s, task), "k1").level, lv(tp(s, task), "k1").how], [0.75, "checked"]);
});

test("E2a review M1: a change saved while the check runs makes the result stale (order of steps, not clocks)", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md", check: "sleep 1; test -s docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  s.checkpoint({ title: "draft", fulfills: ["k1"] });
  const run = s.checkCanon(["k1"], "kev");
  p.write("docs/report.md", "broken");
  s.checkpoint({ title: "broke it while the check ran" });
  await run;
  const t = tp(s, task);
  assert.ok(lv(t, "k1").level <= 0.5, JSON.stringify(lv(t, "k1")));
  assert.match(lv(t, "k1").notes.map((n) => n.en).join(" "), /stale/);
});

test("E2a review M3: an agent's edit of a proposal before approval is refused; evidence counts from the approval", () => {
  const { p, s, task } = project();
  p.write("docs/old.md", "# old\n");
  s.checkpoint({ title: "old work" });
  s.proposeCanon({ kind: "future", text: "Report is written", task, weight: 10, artifact: "docs/report.md" });
  const shown = { text: "Report is written", task, weight: 10, artifact: "docs/report.md" };
  // The agent edits the proposal after the person looked at it.
  const f = join(p.dir, ".scenaria/canon.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  Object.assign(j.events[0], { createdAt: "", artifact: "docs/*.md", weight: 100 });
  writeFileSync(f, JSON.stringify(j));
  assert.throws(() => s.decideCanon("k1", "approve", { ...person, expect: shown }), /changed since you saw it/);
  // Approved as it now is (the person saw the new version): old files are no evidence of new work.
  s.decideCanon("k1", "approve", { ...person, expect: { ...shown, artifact: "docs/*.md", weight: 100 } });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  const t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how, lv(t, "k1").fileChanged], [0.25, "file", false]);
  assert.equal(t.gates.find((g) => g.cap === 40).met, false);
  // Chat-approved criteria are refused (the card does not show task, weight and file).
  s.proposeCanon({ kind: "future", text: "Charts are added", task, weight: 5 });
  assert.throws(() => s.decideCanon("k2", "approve", { user: "kev (chat, confirmed)", via: "chat" }), /approving it needs what you were shown/);
});

test("E2a review M4: a newest step changed outside Scenaria never shows a file as there (no older state either)", () => {
  const { p, s, task } = project();
  p.write("docs/report.md", "# Q3\n");
  const a = s.checkpoint({ title: "with report" });
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  const t0 = tp(s, task);
  assert.equal(lv(t0, "k1").how, "file");
  const f = join(p.dir, `.scenaria/nodes/${t0.tip}.json`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.title = "edited";
  writeFileSync(f, JSON.stringify(j));
  assert.equal(lv(taskProgress(Scenaria.open(p.dir), task), "k1").level, 0, "the tampered newest state: nothing counts as there");
  void a;
});

test("E2a review LOW: chat blocks carry task, weight and file; one criterion reads in the singular", () => {
  const { s, task } = project();
  const r = applyBlocks(s, `\`\`\`scenaria\n{"canon": {"kind": "future", "text": "Report is written", "task": "${task}", "weight": 40, "artifact": "docs/report.md"}}\n\`\`\``, { source: "ui" });
  assert.deepEqual(r.errors, []);
  const k = s.canon()[0];
  assert.deepEqual([k.status, k.task, k.weight, k.artifact], ["proposed", task, 40, "docs/report.md"]);
  const d = derive("p", "progress/1", { criteria: ["k1 w=1 s=0.5 x"], gates: ["10 met", "20 met", "40 met", "60 met"] });
  assert.match(d.sentence.de, /^50 %: Das eine Kriterium ist gewichtet zu 50 % erfüllt\. Nächstes Tor: alle Kriterien geprüft \(80 %\)\.$/);
  assert.match(d.sentence.en, /^50 %: the one criterion is 50 % met, weighted\./);
  // 60.4 % rounds to 60: not "capped at 60".
  const g = derive("p", "progress/1", { criteria: ["k1 w=5 s=0.75 x", "k2 w=7 s=0.5 x"], gates: ["10 met", "20 met", "40 met", "60 met"] });
  assert.equal(g.value, 60);
  assert.doesNotMatch(g.sentence.de, /gedeckelt/);
  assert.match(g.sentence.de, /zu 60 % erfüllt\. Nächstes Tor/);
});

// ------------------------------------------------------------------ E2a review 2: one test per finding

test("E2a review 2 H-1: rewinding to the task itself (or before it) leaves no evidence of the abandoned attempt", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  const n = s.checkpoint({ title: "draft", fulfills: ["k1"] });
  s.decideCanon("k1", "confirm", person);
  s.verify(n.id, { status: "passed", origin: "person", via: "dashboard", by: "kev" });
  assert.equal(tp(s, task).value, 100);
  s.rewind(task, { lesson: "start over", restoreFiles: true });
  const t = tp(s, task);
  assert.deepEqual([t.tip, t.value, t.offLine], [task, 0, false]);
  assert.equal(lv(t, "k1").level, 0);
});

test("E2a review 2 H-2: a check or confirmation from a later task does not count after a rewind back into the task", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md", check: "test -s docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3 BAD\n");
  const tipA = s.checkpoint({ title: "draft", fulfills: ["k1"] });
  s.startMission({ title: "Fix-ups", goal: "Polish" });
  p.write("docs/report.md", "# Q3 good\n");
  s.checkpoint({ title: "fixed the report in the next task" });
  await s.checkCanon(["k1"], "kev");
  s.decideCanon("k1", "confirm", person);
  assert.equal(lv(tp(s, task), "k1").how, "confirmed");
  s.rewind(tipA.id, { lesson: "back", restoreFiles: true });
  const t = tp(s, task);
  assert.deepEqual([lv(t, "k1").level, lv(t, "k1").how], [0.5, "implemented"]);
  assert.match(lv(t, "k1").notes.map((x) => x.en).join(" "), /the confirmation of .* belongs to another line/);
});

test("E2a review 2 M-1: a task node deleted or changed by hand still counts as 0 % for its criteria", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  s.checkpoint({ title: "draft", fulfills: ["k1"] });
  const t2 = s.startMission({ title: "Slides", goal: "Slides" }).id;
  crit(s, t2, { text: "Slides exist", weight: 10 });
  assert.equal(projectProgress(s).value, 25);
  const f = join(p.dir, `.scenaria/nodes/${t2}.json`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.type = "checkpoint";
  writeFileSync(f, JSON.stringify(j));
  let pr = projectProgress(Scenaria.open(p.dir));
  const m = pr.tasks.find((t) => t.task === t2);
  assert.deepEqual([m.status, m.value, m.unsettled.map((u) => [u.id, u.status])], ["missing", 0, [["k2", "missing"]]]);
  assert.ok(pr.value <= 25, String(pr.value));
  assert.match(renderProgress(pr, "en"), new RegExp(`${t2} \\(task missing\\): 0 %`));
  assert.match(m.nextAgent, /retires its criteria \(k2\)/);
  // Deleted altogether: still counted.
  writeFileSync(f, "{}");
  pr = projectProgress(Scenaria.open(p.dir));
  assert.ok(pr.value <= 25, String(pr.value));
});

test("E2a review 2 M-2: the person can let go of a criterion that vanished from canon.json; it never comes back silently", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50 });
  crit(s, task, { text: "Numbers are reconciled", weight: 50 });
  const f = join(p.dir, ".scenaria/canon.json");
  const good = readFileSync(f, "utf8");
  const j = JSON.parse(good);
  j.events = j.events.filter((e) => e.id !== "k1");
  writeFileSync(f, JSON.stringify(j));
  let t = taskProgress(Scenaria.open(p.dir), task);
  assert.deepEqual(t.unsettled, [{ id: "k1", text: "Report is written", status: "missing" }]);
  assert.throws(() => s.decideCanon("k1", "approve", person), /Unknown canon event/);
  const ev = s.decideCanon("k1", "retire", { ...person, reason: "merged away" });
  assert.equal(ev.status, "retired");
  t = tp(s, task);
  assert.deepEqual(t.unsettled, []);
  assert.deepEqual(s.canonState().missing, []);
  // Restoring the old record later does not revive it.
  writeFileSync(f, good);
  assert.equal(Scenaria.open(p.dir).canonState().events.find((e) => e.id === "k1").status, "tampered");
});

test("E2a review 2 M-3: without git the person's confirmation and verdict still count (with a note)", () => {
  const code = `
    import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
    const { Scenaria } = await import(${JSON.stringify(new URL("../dist/core/index.js", import.meta.url).href)});
    const { taskProgress } = await import(${JSON.stringify(new URL("../dist/core/progress.js", import.meta.url).href)});
    const dir = mkdtempSync(join(tmpdir(), "scenaria-nogit-"));
    const s = Scenaria.init(dir);
    const task = s.startMission({ projectGoal: "Reports", title: "Q3", goal: "Write it" }).id;
    s.addCanonAsUser({ kind: "future", text: "Report is written", task, weight: 50, artifact: "docs/report.md" }, { user: "kev", via: "cli" });
    s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/report.md"), "# Q3");
    const n = s.checkpoint({ title: "draft", fulfills: ["k1"] });
    const before = taskProgress(s, task);
    // The person's verdict on the reporting step alone (re-check 2026-10-18: this path had no test of its own).
    s.verify(n.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
    const verdictOnly = taskProgress(s, task).criteria[0];
    s.decideCanon("k1", "confirm", { user: "kev", via: "cli" });
    s.verify(n.id, { status: "passed", origin: "person", via: "terminal", by: "kev" });
    const after = taskProgress(s, task);
    console.log(JSON.stringify({ repo: Boolean(s.repo), before: before.criteria[0].level, verdictOnly: [verdictOnly.level, verdictOnly.how], after: after.value, notes: after.criteria[0].notes.map((x) => x.en) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(o.repo, false);
  assert.equal(o.before, 0.25, "a claim without file states is not backed: only started");
  assert.deepEqual(o.verdictOnly, [1, "verdict"]);
  assert.equal(o.after, 100);
  assert.match(o.notes.join(" "), /no file snapshots/);
});

// ------------------------------------------------------------------ E2b: dashboard wiring (static checks on the UI source)

test("E2b dashboard: progress in all three views with its derivation; criteria approved exactly as shown", () => {
  const ui = (f) => readFileSync(new URL(`../ui/src/${f}`, import.meta.url), "utf8");
  const app = ui("App.tsx");
  const prog = ui("Progress.tsx");
  const dialogs = ui("Dialogs.tsx");
  const control = ui("Control.tsx");
  const simple = ui("SimpleView.tsx");
  // Simple view: the current task's card; Audit and Manage: the header button (view !== "simple") and the dialog.
  assert.match(simple, /<ProgressCard p=\{props\.progress \?\? null\} task=\{currentTask\}/);
  assert.match(app, /view !== "simple" && \(\s*<button className="btn" onClick=\{\(\) => setProgressOpen\(true\)\}/);
  assert.match(app, /case "progress":\s*setProgressOpen\(true\)/);
  // Every number shown carries its derivation, recomputed in the browser (Why).
  assert.equal((prog.match(/<Why d=\{/g) ?? []).length, 3);
  assert.match(prog, /role="progressbar"/);
  assert.doesNotMatch(prog, /api\.(decideCanon|addCanon|verify)/, "the progress view changes nothing");
  // Approve sends what the person saw; reweigh and let go exist; the chat card sends its own view.
  assert.match(dialogs, /api\.decideCanon\(e\.id, "approve", \{ \.\.\.\(adopt\[e\.id\] \? \{ adoptCheck: adopt\[e\.id\] \} : \{\}\), expect: shownAs\(e\)/);
  // E2b review: an empty or unreadable weight never counts as "unchanged"; the buttons stay off; fields locked without approval.
  assert.match(dialogs, /x\.target\.validity\.badInput \? "\?" : x\.target\.value/);
  assert.match(dialogs, /disabled=\{locked \|\| \(Boolean\(e\.task\) && typedWeight\(e\) === null\)\}/);
  assert.match(dialogs, /inputMode="numeric"\s+disabled=\{locked\}/);
  // After a refused action the dialog shows what is stored now.
  assert.match(dialogs, /setErr\(String\(e\?\.message \?\? e\)\);\s+\/\/ Show what is stored now[^\n]*\n\s+await reload\(\)/);
  // Progress inputs are shown in the reader's language.
  assert.match(ui("Why.tsx"), /t\.pgWhyCrit\(/);
  assert.match(app, /Object\.entries\(t\.errCanon\)/);
  assert.match(dialogs, /api\.decideCanon\(e\.id, "reweigh", \{ weight: w \}\)/);
  assert.match(dialogs, /api\.decideCanon\(g\.id, "retire"\)/);
  assert.match(control, /api\.decideCanon\(data\.id, "approve", \{ expect: \{ text: String\(data\.text/);
  // German and English keys exist for the new texts.
  const i18n = ui("i18n.ts");
  for (const k of ["pgButton", "pgIntro", "pgNoTasks", "pgSimpleTitle", "pgSimpleNone", "canonCriterionOf", "canonReweigh", "canonLetGo", "canonLetGoHint"]) assert.equal((i18n.match(new RegExp(`\\n  ${k}: `, "g")) ?? []).length, 2, k);
});

test("E2b review: the dashboard's next step names who acts; agents get their own wording; errors carry codes", async () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  let t = tp(s, task);
  assert.match(t.next.de, /^Die KI entscheidet den Lösungsweg/);
  assert.match(t.next.en, /^The AI decides the approach/);
  assert.match(t.nextAgent, /^Decide the approach \(a decision with a chosen option in the task\)\.$/);
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  t = tp(s, task);
  assert.match(t.next.de, /^Die KI legt die erste Ergebnis-Datei an: k1 docs\/report\.md\.$/);
  assert.doesNotMatch(JSON.stringify(t.next), /fulfills|checkpoint/i, "no tool words for people");
  // The level 1 is called "confirmed" everywhere, like the button "Confirm as met".
  assert.match(t.derivation.expression.de, /1 bestätigt/);
  assert.equal(t.gates.find((g) => g.cap === 90).name.de, "alle Kriterien bestätigt");
  // HTTP: refused approvals carry a code the dashboard translates.
  s.proposeCanon({ kind: "future", text: "Charts are added", task, weight: 20 });
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body) => fetch(`${base}/api/canon/decide`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: JSON.stringify(body) });
    let r = await post({ id: "k2", action: "approve", expect: { text: "Charts are added", task, weight: 99 } });
    assert.deepEqual([r.status, (await r.json()).code], [409, "canon_changed"]);
    r = await post({ id: "k2", action: "approve", weight: 150, expect: { text: "Charts are added", task, weight: 20 } });
    assert.deepEqual([r.status, (await r.json()).code], [400, "canon_weight"]);
    // A missing criterion comes with its words, so the person sees what they let go.
    const f = join(p.dir, ".scenaria/canon.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.events = j.events.filter((e) => e.id !== "k1");
    writeFileSync(f, JSON.stringify(j));
    const c = await (await fetch(`${base}/api/canon`, { headers: { "x-scenaria": "1" } })).json();
    assert.deepEqual(c.letGo, [{ id: "k1", text: "Report is written" }]);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ re-check 2026-10-18 (Kev: verify what is claimed as fixed)

test("re-check E2a H2: rewinding to a person-verified step that reports a criterion does not give 100 %", () => {
  // The reviewer's exact scenario (review-e2a/r2.mjs): the draft step itself reports k1 and the person verified it.
  const { p, s, task } = project();
  s.decide({ question: "How?", options: ["a", "b"], chosen: "a", rationale: "r" });
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  p.write("docs/report.md", "v1\n");
  const mid = s.checkpoint({ title: "first draft", fulfills: ["k1"] });
  s.verify(mid.id, { status: "passed", origin: "person", via: "dashboard", by: "kev" });
  p.write("docs/report.md", "v2 final\n");
  s.checkpoint({ title: "final", fulfills: ["k1"] });
  s.decideCanon("k1", "confirm", person);
  assert.equal(tp(s, task).value, 90);
  callTool(s, "scenaria_rewind", { id: mid.id }, ctx);
  const t = taskProgress(Scenaria.open(p.dir), task);
  assert.equal(t.tip, mid.id);
  assert.notEqual(t.value, 100, "the verdict on the draft was not the acceptance of the task");
  assert.equal(t.gates.find((g) => g.cap === 100).met, false);
  // The person verifies the newest state: now it is 100.
  s.verify(mid.id, { status: "passed", origin: "person", via: "dashboard", by: "kev", notes: "draft is fine after all" });
  assert.equal(tp(s, task).value, 100);
});

test("re-check E2a LOW: steps in ledger lines this machine did not write are no evidence", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50, artifact: "docs/report.md" });
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  p.write("docs/report.md", "# Q3\n");
  const n = s.checkpoint({ title: "draft" });
  assert.equal(lv(tp(s, task), "k1").level, 0.25, "the file is there, nobody reported it");
  // An agent adds the claim by hand and extends the hash chain itself: the chain is intact, but this machine did not write it.
  const f = join(p.dir, ".scenaria/nodes", `${n.id}.json`);
  const raw = JSON.parse(readFileSync(f, "utf8"));
  raw.fulfills = ["k1"];
  writeFileSync(f, JSON.stringify(raw));
  s.ledger.append([{ id: n.id, hash: contentHashOf(raw), op: "write" }]);
  const s2 = Scenaria.open(p.dir);
  assert.deepEqual(s2.integrity().unseenWrites, [n.id]);
  const t = taskProgress(s2, task);
  // Neither the hand-made claim nor that step's file state counts (it is the newest state: no file counts as there).
  assert.equal(lv(t, "k1").level, 0, "the hand-made claim does not count");
  assert.deepEqual(lv(t, "k1").evidence, []);
});

test("re-check E2a LOW: `scenaria progress <task> --json` returns only that task", () => {
  const { p, s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50 });
  s.checkpoint({ title: "work" });
  const t2 = s.startMission({ title: "Slides", goal: "Slides" }).id;
  crit(s, t2, { text: "Slides exist", weight: 10 });
  const all = spawnSync(process.execPath, [CLI, "progress", "--root", p.dir, "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(all.stdout).tasks.length, 2);
  const one = spawnSync(process.execPath, [CLI, "progress", t2, "--root", p.dir, "--json"], { encoding: "utf8" });
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(JSON.parse(one.stdout).tasks.map((t) => t.task), [t2]);
});

test("E2b M3 (completed 2026-10-18): every refused change to the fixed points carries a code the dashboard says in German and English", async () => {
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const canon = src("core/canon.ts");
  const engine = src("core/engine.ts");
  assert.doesNotMatch(canon, /throw new Error\(/, "canon.ts refuses only with a code");
  const codes = new Set([...`${canon}\n${engine}`.matchAll(/new CanonError\("([a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(codes.size >= 30, String(codes.size));
  const i18n = readFileSync(new URL("../ui/src/i18n.ts", import.meta.url), "utf8");
  const blocks = [...i18n.matchAll(/\n  errCanon: \{([\s\S]*?)\n  \} as Record<string, string>,/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, "one block in English, one in German");
  for (const b of blocks) for (const c of codes) assert.match(b, new RegExp(`\\n    ${c}: "`), c);
  // Over HTTP the code comes along; the person's actions only.
  const { s, task } = project();
  crit(s, task, { text: "Report is written", weight: 50 });
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: JSON.stringify(body) });
    const expectCode = async (r, status, code) => assert.deepEqual([r.status, (await r.json()).code], [status, code]);
    await expectCode(await post("/api/canon", { kind: "future", text: "Charts added", task, weight: 10, artifact: "../x.png" }), 400, "canon_artifact_dots");
    await expectCode(await post("/api/canon", { kind: "future", text: "Charts added", task: "n99", weight: 10 }), 400, "canon_task_unknown");
    await expectCode(await post("/api/canon", { kind: "past", text: "Only TypeScript", task, weight: 10 }), 400, "canon_criterion_past");
    await expectCode(await post("/api/canon/decide", { id: "k1", action: "reweigh", weight: 50 }), 400, "canon_weight_same");
    await expectCode(await post("/api/canon/decide", { id: "k9", action: "retire" }), 404, "canon_unknown");
    await expectCode(await post("/api/canon/decide", { id: "k1", action: "approve" }), 400, "canon_not_proposal");
  } finally {
    server.close();
  }
  // The dashboard maps every code (not only two).
  assert.match(readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8"), /for \(const \[code, text\] of Object\.entries\(t\.errCanon\)\) errorTexts\[code\] = text;/);
});
