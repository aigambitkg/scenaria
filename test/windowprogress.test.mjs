// Batch E4: progress per window (window-progress/1), the handover check (handover-loss/1), the stop after two full
// windows without progress, the person's lift, the escalation of Kev's row 4, and the person's values for both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { callTool } from "../dist/tools.js";
import { derive, recompute, windowVerdict, WINDOW_PROGRESS_RULE } from "../dist/core/derivation.js";
import { recordWindowEvents, recordProgressSnapshot, windowStatus } from "../dist/core/window.js";
import { windowProgress, liftStop, readLifts, stopState, evaluateStop, renderWindowProgress } from "../dist/core/windowprogress.js";
import { readContextSettings, setContextSettings } from "../dist/core/contextsettings.js";
import { signRecord } from "../dist/core/canon.js";
import { globalConfigPath } from "../dist/core/global.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const ctx = { source: "mcp", agent: "claude-code" };
const person = { user: "kev", via: "dashboard" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

/**
 * A project with task n1 and two approved criteria, k1 (docs/r.md) and k2 (docs/s.md), weight 50 each, the approach
 * decided. `single`: k1 alone, weight 100.
 */
function project({ decided = true, single = false } = {}) {
  const p = tempProject();
  p.write("README.md", "hello\n");
  const s = Scenaria.init(p.dir);
  const task = s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal: "Write the quarterly report" }).id;
  s.addCanonAsUser({ kind: "future", text: "Report is written", task, weight: single ? 100 : 50, artifact: "docs/r.md" }, person);
  if (!single) s.addCanonAsUser({ kind: "future", text: "Summary is written", task, weight: 50, artifact: "docs/s.md" }, person);
  if (decided) s.decide({ question: "Format of the quarterly report?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable report" });
  return { p, s, task };
}

/** One answer of `pct` % of C_eff 200,000 in conversation `key`, at the real time (snapshots carry the real time). */
async function answer(s, key, pct, agent = "claude-code") {
  await sleep(3);
  const at = new Date().toISOString();
  await sleep(3);
  recordWindowEvents(s, { source: "transcript", key, agent }, [{ kind: "sample", at, tokens: pct * 2000, model: "claude-opus-5-5", ref: `m:${++n}` }]);
}
/** A window: a session start (snapshot), then answers up to `peak` %. */
async function window(s, key, peak = 60) {
  await sleep(3);
  recordProgressSnapshot(s);
  await answer(s, key, 10);
  await answer(s, key, peak);
}
/** Real work on k1: the file and a claim → +25 points (k1 level 0.5, gate 40; k2 still the agent's to do). */
function work(p, s, text = "# Q3\n") {
  p.write("docs/r.md", text);
  return s.checkpoint({ title: "Draft of the quarterly report written", outputs: ["`docs/r.md` with the quarterly report"], fulfills: ["k1"], agent: "claude-code" });
}
const states = (wp) => Object.fromEntries(wp.windows.map((a) => [a.window, a.why ? `${a.state}:${a.why}` : a.state]));

test("E4 formulas: window-progress/1 sums per task, the verdict follows Kev's table; handover-loss/1", () => {
  const v = { start: ["n1 p=20", "n2 p=50"], end: ["n1 p=32", "n3 p=10"], focus: "n1", waiting: false, peak: 60, yellow: 50, compacted: false, rule: WINDOW_PROGRESS_RULE };
  const d = derive("window.progress", "window-progress/1", v);
  assert.equal(d.value, 22, "n1 +12, n3 new +10 (start 0); n2 no longer has criteria: not counted");
  assert.equal(recompute(d), 22);
  assert.match(d.sentence.de, /\+22 Punkte \(n1 20 → 32 %; n3 0 → 10 %\); mindestens 10 Punkte: Fortschritt\. Regel v1\.0\./);
  const low = { ...v, end: ["n1 p=25"] };
  assert.equal(windowVerdict(low, 5), "none");
  assert.match(derive("w", "window-progress/1", low).sentence.de, /in einem vollen Fenster \(höchste Füllung 60 %, Gelb ab 50 %\): ohne Fortschritt/, "why the window counts as full is in the sentence (review L10)");
  assert.equal(windowVerdict({ ...low, peak: 40 }, 5), "not-full");
  assert.equal(windowVerdict({ ...low, peak: 40, compacted: true }, 5), "none", "a compacted window is full");
  assert.equal(windowVerdict({ ...low, peak: null }, 5), "no-fill", "an unknown fill is said as such (review L10)");
  assert.equal(windowVerdict({ ...low, waiting: true }, 5), "waiting", "the person's turn (review M5)");
  assert.equal(windowVerdict({ ...low, focus: "" }, 5), "no-criteria");
  assert.equal(windowVerdict({ ...low, peak: 10, waiting: true }, 12), "progress", "from the minimum on always progress");
  // Only progress above the best level so far counts (review H4): back to where it was is 0.
  const redo = derive("w", "window-progress/1", { ...v, start: ["n1 p=0"], best: ["n1 p=50"], end: ["n1 p=50"] });
  assert.equal(redo.value, 0);
  assert.match(redo.sentence.de, /n1 0 → 50 %, bisher bestes 50 %/);
  assert.equal(derive("w", "window-progress/1", { ...v, start: ["n1 p=0"], best: ["n1 p=50"], end: ["n1 p=62"] }).value, 12);
  assert.match(derive("w", "window-progress/1", { ...v, end: ["n1 p=21"] }).sentence.de, /^\+1 Punkt /, "one point (review L12)");
  assert.equal(windowVerdict({ ...low, rule: "v1.0-p2 min=30 tolerance=5 k=3" }, 22), "none", "the rule in force decides");
  assert.equal(derive("w", "window-progress/1", { ...v, end: ["n1 p=10"] }).value, -10, "a drop is negative");

  const h = derive("window.handover", "handover-loss/1", { before: ["n9 a=0.8 c=0.6"], after: ["n10 a=0.6 c=0.5", "n11 a=0.7 c=0.4", "n12 a=- c=0.5"], rule: WINDOW_PROGRESS_RULE });
  // T(n9) = 70; T(n10) = 55, T(n11) = 55, T(n12) = 50 (no goal: the connection alone); mean 53.3 → loss 17.
  assert.equal(h.value, 17);
  assert.match(h.sentence.de, /17 Punkte Verlust: n9 \(70\) → n10, n11, n12 \(Mittel 53,3\); mehr als 5 Punkte: Übergabe verbessern/);
  const gain = derive("w", "handover-loss/1", { before: ["n9 a=0.5 c=0.5"], after: ["n10 a=0.8 c=0.8"], rule: WINDOW_PROGRESS_RULE });
  assert.equal(gain.value, -30);
  assert.match(gain.sentence.en, /^30 points gained: .*only 1 of 3 steps so far; at most 5 points: the handover is fine/);
  assert.match(derive("w", "handover-loss/1", { before: [], after: ["n10 a=0.8 c=0.8"], rule: WINDOW_PROGRESS_RULE }).sentence.en, /not measurable/);
  // Inputs that are not steps are ignored, never a crash.
  assert.equal(derive("w", "handover-loss/1", { before: ["n9 a=2 c=0.5"], after: ["x"], rule: WINDOW_PROGRESS_RULE }).value, 0);
});

test("E4 two full windows without progress on the same task stop the work; the person lifts the stop", async () => {
  const { p, s, task } = project();
  await window(s, "claude-code:A");
  await window(s, "claude-code:B");
  let wp = windowProgress(s);
  assert.deepEqual(states(wp), { w1: "none", w2: "running" });
  assert.equal(wp.warning?.window, "w1", "one window without progress: a warning (problem note)");
  assert.equal(wp.stop, null);
  await window(s, "claude-code:C");
  wp = windowProgress(s);
  assert.deepEqual(states(wp), { w1: "none", w2: "none", w3: "running" });
  assert.ok(wp.stop, "two in a row: stop");
  assert.equal(wp.stop.task, task);
  assert.equal(wp.stop.windows.length, 2);
  assert.match(wp.stop.windows[0], /^w1@/);
  assert.equal(stopState(s)?.task, task, "the hook's check agrees");
  const pts = wp.windows.find((a) => a.window === "w1").points;
  assert.equal(recompute(pts), 0);
  assert.match(renderWindowProgress(wp, "de"), /STOPP seit \d{4}-\d\d-\d\d \d\d:\d\d: w1, w2 ohne Fortschritt an n1/);
  assert.match(renderWindowProgress(wp, "de"), /w3 · claude-code: 0 Punkte – läuft \(bisher\)\n {4}0 Punkte bisher \(n1 0 → 0 %\); das Fenster läuft noch/);
  // The agent's tool shows it.
  const r = callTool(s, "scenaria_window", {}, ctx);
  assert.match(r.text, /STOP since/);
  assert.equal(r.data.progress.stop.task, task);

  // Lifting needs a reason; work done during the stop does not lift it (only the person does).
  assert.throws(() => liftStop(s, { why: "  " }, { by: "kev", via: "terminal" }), (e) => e.code === "why");
  work(p, s);
  await answer(s, "claude-code:C", 70);
  assert.ok(windowProgress(s).stop, "progress made during the stop does not lift it");
  const after = liftStop(s, { why: "task cut smaller" }, { by: "kev", via: "terminal" });
  assert.equal(after.stop, null);
  assert.equal(after.lift.why, "task cut smaller");
  assert.equal(readLifts(s.store).length, 1);
  assert.ok(after.windows.filter((a) => a.window !== "w3").every((a) => a.lifted), "windows that ended before the lift no longer count");
  assert.throws(() => liftStop(s, { why: "again" }, { by: "kev", via: "terminal" }), (e) => e.code === "not_stopped");
  assert.equal(stopState(s), null);
  // A lift changed by hand does not count: the stop is back.
  const f = join(dirname(globalConfigPath()), "window-stops.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  for (const rec of Object.values(j.projects)) rec.lifts[0].why = "someone else";
  writeFileSync(f, JSON.stringify(j));
  assert.ok(windowProgress(s).stop, "a lift that does not verify does not count");
});

test("E4 a window with real progress breaks the row; a window that was not full does not count either way", async () => {
  const { p, s } = project();
  await window(s, "claude-code:A");
  await window(s, "claude-code:B");
  work(p, s);
  await window(s, "claude-code:C");
  let wp = windowProgress(s);
  assert.deepEqual(states(wp), { w1: "none", w2: "progress", w3: "running" });
  assert.equal(wp.windows.find((a) => a.window === "w2").points.value, 25);
  assert.equal(wp.stop, null);
  assert.equal(wp.warning, null, "the newest ended window made progress: no warning");
  // w3 is short (never yellow) and makes no progress: not assessed — and the row goes on across it.
  await window(s, "claude-code:D", 40);
  wp = windowProgress(s);
  assert.equal(states(wp).w3, "none", "w3 reached 60 %");
  await window(s, "claude-code:E");
  wp = windowProgress(s);
  assert.equal(states(wp).w4, "skipped:not-full", "w4 stayed at 40 %");
  assert.equal(wp.stop, null);
  assert.equal(wp.warning?.window, "w3", "the newest assessed window had no progress");
  await window(s, "claude-code:F");
  wp = windowProgress(s);
  assert.equal(states(wp).w5, "none");
  assert.ok(wp.stop, "w3 and w5 without progress, w4 in between not assessed: stop");
  assert.deepEqual(wp.stop.windows.map((x) => x.split("@")[0]), ["w3", "w5"]);
});

test("E4 not assessed: a task without criteria, a window with a rewind, another task breaks the row", async () => {
  // Without criteria (Kev 2026-10-24): the rule does not apply.
  {
    const p = tempProject();
    p.write("README.md", "x\n");
    const s = Scenaria.init(p.dir);
    s.startMission({ projectGoal: "Reports", title: "Q3", goal: "Write it" });
    await window(s, "claude-code:A");
    await window(s, "claude-code:B");
    await window(s, "claude-code:C");
    const wp = windowProgress(s);
    assert.deepEqual(states(wp), { w1: "skipped:no-criteria", w2: "skipped:no-criteria", w3: "running" });
    assert.equal(wp.stop, null);
  }
  // Going back and doing the same work again is no progress (review H4): a rewind (also one to HEAD itself) no longer
  // exempts a window; the redo only counts above the best level so far.
  {
    const { p, s } = project();
    const good = s.checkpoint({ title: "before the draft" });
    await window(s, "claude-code:A");
    work(p, s);
    await window(s, "claude-code:B");
    s.rewind(good.id, { lesson: "the draft went the wrong way" });
    s.rewind(s.head().id, { lesson: "a rewind to HEAD itself" });
    await window(s, "claude-code:C");
    work(p, s, "# Q3 again\n");
    await window(s, "claude-code:D");
    const wp = windowProgress(s);
    assert.deepEqual(states(wp), { w1: "progress", w2: "none", w3: "none", w4: "running" });
    assert.equal(wp.windows.find((a) => a.window === "w2").value, -25, "the rewind dropped progress");
    assert.equal(wp.windows.find((a) => a.window === "w3").value, 0, "back to the best level so far: no new progress");
    assert.ok(wp.stop, "do, rewind, redo across windows is stopped");
  }
  // Two windows without progress on different tasks: no stop (Kev's table: the task is too large or cut wrong).
  {
    const { s } = project();
    await window(s, "claude-code:A");
    await window(s, "claude-code:B");
    // w2 moves on to another task (with a criterion): its end is on Q4, w1's end on Q3.
    s.checkpoint({ title: "switch" });
    const t2 = s.startMission({ title: "Q4 report", goal: "Write the next report" }).id;
    s.addCanonAsUser({ kind: "future", text: "Q4 written", task: t2, weight: 100 }, person);
    s.checkpoint({ title: "start Q4" });
    await window(s, "claude-code:C");
    const wp = windowProgress(s);
    assert.deepEqual(states(wp), { w1: "none", w2: "none", w3: "running" });
    assert.notEqual(wp.windows.find((a) => a.window === "w1").focus, wp.windows.find((a) => a.window === "w2").focus);
    assert.equal(wp.stop, null);
    assert.equal(wp.warning?.window, "w2");
  }
});

test("E4 a compacted window is full; another agent's windows are a line of their own; changed records do not count", async () => {
  const { p, s } = project();
  await window(s, "claude-code:A", 30);
  // Compaction: a new window of the same conversation — the old one counts as full.
  await sleep(3);
  recordWindowEvents(s, { source: "transcript", key: "claude-code:A", agent: "claude-code" }, [{ kind: "boundary", at: new Date().toISOString(), ref: `b:${++n}` }]);
  await sleep(3);
  recordProgressSnapshot(s);
  await answer(s, "claude-code:A", 20);
  await answer(s, "claude-code:A", 30);
  // Another agent through the proxy: its own line.
  await sleep(3);
  recordWindowEvents(s, { source: "proxy", key: "p1", agent: "codex" }, [{ kind: "sample", at: new Date().toISOString(), tokens: 120000, model: "claude-opus-5-5", ref: `r:${++n}` }]);
  let wp = windowProgress(s);
  const a = wp.windows.find((x) => x.window === "w1");
  assert.equal(a.full, true);
  assert.equal(a.state, "none");
  assert.equal(a.next, "w2");
  assert.equal(wp.windows.find((x) => x.window === "w3").state, "running");
  // A progress line changed by hand (the start of w1, made to look like 100 %) breaks the chain: it is not used.
  const f = join(p.dir, ".scenaria/windows.jsonl");
  const lines = readFileSync(f, "utf8").trim().split("\n");
  const i = lines.findIndex((l) => JSON.parse(l).t === "progress");
  const o = JSON.parse(lines[i]);
  o.tasks[0].criteria = o.tasks[0].criteria.map((c) => c.replace(/s=0\b/, "s=1"));
  o.tasks[0].gates = o.tasks[0].gates.map((g) => g.replace("open", "met"));
  lines[i] = JSON.stringify(o);
  writeFileSync(f, lines.join("\n") + "\n");
  wp = windowProgress(Scenaria.open(p.dir));
  assert.equal(wp.changed?.by, "chain", "the change shows");
  const w1 = wp.windows.find((x) => x.window === "w1");
  assert.deepEqual([w1.state, w1.why], ["skipped", "no-measure"], "the changed line is not taken as the start of w1 (it would make it −100)");
});

test("E4 the person's values: min and tolerance are signed with the zone values; a setting signed before E4 still counts", async () => {
  const { s } = project();
  let cs = readContextSettings(s.store);
  assert.equal(cs.progressRule, "v1.0 min=10 tolerance=5 k=3");
  cs = setContextSettings(s.store, { progress: { minProgress: 30 } }, { by: "kev", via: "terminal" });
  assert.equal(cs.trust, "verified");
  assert.deepEqual(cs.progress, { minProgress: 30, tolerance: 5 });
  assert.equal(cs.progressRule, "v1.0-p1 min=30 tolerance=5 k=3");
  assert.match(cs.rule, /^v1\.0-p1 /);
  assert.throws(() => setContextSettings(s.store, { progress: { minProgress: 0 } }, { by: "kev", via: "terminal" }), (e) => e.code === "out_of_range" && e.key === "minProgress");
  assert.throws(() => setContextSettings(s.store, { progress: { tolerance: 2.5 } }, { by: "kev", via: "terminal" }), (e) => e.code === "precision");
  assert.throws(() => setContextSettings(s.store, { progress: { minProgress: 30 } }, { by: "kev", via: "terminal" }), (e) => e.code === "unchanged");
  cs = setContextSettings(s.store, { progress: { minProgress: 5, tolerance: 9 } }, { by: "kev", via: "terminal" });
  assert.deepEqual(cs.looser, ["minProgress", "tolerance"], "fewer points, more loss: said plainly");
  // The values are signed: changing one by hand makes the whole setting invalid (start values apply).
  const f = join(dirname(globalConfigPath()), "context-settings.json");
  const good = readFileSync(f, "utf8");
  const j = JSON.parse(good);
  for (const rec of Object.values(j.projects)) rec.revisions[rec.revisions.length - 1].minProgress = 1;
  writeFileSync(f, JSON.stringify(j));
  cs = readContextSettings(s.store);
  assert.deepEqual([cs.trust, cs.why, cs.progress.minProgress], ["invalid", "signature", 10]);
  writeFileSync(f, good);
  assert.equal(readContextSettings(s.store).trust, "verified");
});

test("E4 a revision signed before E4 (context-settings/v1) verifies and carries the start values for min and tolerance", () => {
  const { p, s } = project();
  // Write a v1 revision exactly as 0.9.20 did.
  setContextSettings(s.store, { values: { yellow: 45 } }, { by: "kev", via: "terminal" });
  const f = join(dirname(globalConfigPath()), "context-settings.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  const [key, rec] = Object.entries(j.projects).find(([k]) => k.includes(p.dir.split("/").pop()));
  const e = rec.revisions[0];
  delete e.minProgress;
  delete e.tolerance;
  const realFolder = key.slice(key.indexOf(":") + 1);
  const parts = ["context-settings/v1", realFolder, e.yellow, e.red, e.emergency, e.p95start, e.margin, e.aModel, e.models.map((m) => [m.id, m.cMax]), null, e.rev, e.at, e.by, e.via];
  const sig = signRecord(s.store, parts);
  e.pub = sig.pub;
  e.sig = sig.sig;
  writeFileSync(f, JSON.stringify(j));
  const cs = readContextSettings(s.store);
  assert.equal(cs.trust, "verified");
  assert.equal(cs.values.yellow, 45);
  assert.deepEqual(cs.progress, { minProgress: 10, tolerance: 5 });
  assert.equal(cs.progressRule, "v1.0-p1 min=10 tolerance=5 k=3");
});

test("E4 the minimum in force decides: with min=30 a +25 window has no progress", async () => {
  const { p, s } = project({ single: true });
  setContextSettings(s.store, { progress: { minProgress: 30 } }, { by: "kev", via: "terminal" });
  await window(s, "claude-code:A");
  // The file alone (no claim): level 0.25 → +25 points.
  p.write("docs/r.md", "# Q3\n");
  s.checkpoint({ title: "Outline of the quarterly report", outputs: ["`docs/r.md` outline"], agent: "claude-code" });
  await window(s, "claude-code:B");
  const wp = windowProgress(s);
  const a = wp.windows.find((x) => x.window === "w1");
  assert.deepEqual([a.state, a.points.value], ["none", 25]);
  assert.match(a.points.sentence.de, /weniger als 30 Punkte in einem vollen Fenster \(höchste Füllung 60 %, Gelb ab 50 %\): ohne Fortschritt\. Regel v1\.0-p1\./);
});

test("E4 handover check: the old window's last step against the first 3 steps of the new one", async () => {
  const { p, s } = project();
  await window(s, "claude-code:A");
  p.write("docs/r.md", "# Q3\n");
  s.checkpoint({ title: "Quarterly report: revenue section drafted", outputs: ["`docs/r.md` revenue section of the quarterly report"], agent: "claude-code" });
  await window(s, "claude-code:B");
  s.checkpoint({ title: "Quarterly report: cost section drafted", outputs: ["`docs/r.md` cost section of the quarterly report"], agent: "claude-code" });
  let h = windowProgress(s).handovers[0];
  assert.equal(h.from, "w1");
  assert.equal(h.to, "w2");
  assert.equal(h.final, false, "only 1 of 3 steps so far");
  assert.equal(h.loss.formula, "handover-loss/1");
  assert.equal(recompute(h.loss), h.loss.value);
  s.checkpoint({ title: "Holiday photos sorted by colour", outputs: ["`pics/` sorted, unrelated to anything"], agent: "claude-code" });
  s.checkpoint({ title: "Weather in Lisbon looked up", outputs: ["sunny tomorrow, nothing to do with the work"], agent: "claude-code" });
  h = windowProgress(s).handovers[0];
  assert.equal(h.final, true);
  assert.ok(h.loss.value > 5, `drift in the new window shows as a loss (${h.loss.value})`);
  assert.equal(h.ok, false);
  assert.equal(h.loss.inputs.find((i) => i.name === "after").value.length, 3);
  // Scenaria's own saves and automatic saves are no steps of the work.
  assert.ok(!h.loss.inputs.find((i) => i.name === "after").value.some((x) => /^n\d+ /.test(x) && x.includes("scenaria")));

  // A tolerance set later never changes an earlier check (E5 review L9).
  await sleep(5);
  setContextSettings(s.store, { progress: { tolerance: 50 } }, { by: "kev", via: "terminal" });
  const later = windowProgress(s).handovers[0];
  assert.equal(later.ok, false, "judged by the tolerance in force at the window change");
  assert.match(later.loss.inputs.find((i) => i.name === "rule").value, /tolerance=5\b/);
});

test("E4 Kev's row 4: the first window of a task at red with gate 20 open escalates; without criteria a hint", async () => {
  const { s, task } = project({ decided: false });
  await window(s, "claude-code:A", 72);
  let wp = windowProgress(s);
  assert.deepEqual(wp.escalation && [wp.escalation.window, wp.escalation.task], ["w1", task]);
  assert.equal(wp.stop, null);
  s.decide({ question: "Format?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable" });
  assert.equal(windowProgress(s).escalation, null, "gate 20 met: no escalation");
  // Without criteria at red: the hint to set criteria.
  const p = tempProject();
  p.write("README.md", "x\n");
  const s2 = Scenaria.init(p.dir);
  s2.startMission({ projectGoal: "Reports", title: "Q3", goal: "Write it" });
  await window(s2, "claude-code:A", 75);
  wp = windowProgress(s2);
  assert.equal(wp.escalation, null);
  assert.equal(wp.noCriteria?.window, "w1");
});

test("E4 a snapshot keeps only inputs: the value is computed again on reading", async () => {
  const { p, s } = project();
  work(p, s);
  recordProgressSnapshot(s);
  const snap = windowStatus(s).snapshots.at(-1);
  assert.equal(snap.by, "session-start");
  assert.equal(snap.tasks[0].value, 25);
  const raw = readFileSync(join(p.dir, ".scenaria/windows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.t === "progress");
  assert.equal(raw.value, undefined);
  assert.equal(raw.tasks[0].value, undefined, "no bare value is stored");
  assert.ok(raw.tasks[0].criteria.length && raw.tasks[0].gates.length);
});

// ------------------------------------------------------------------ review E4a: every finding with a test

test("E4a review H1: malformed lines from outside never make the reading fail; the tool keeps working", async () => {
  const { p, s } = project();
  await window(s, "claude-code:A");
  await window(s, "claude-code:B");
  await window(s, "claude-code:C");
  assert.ok(windowProgress(s).stop);
  const f = join(p.dir, ".scenaria/windows.jsonl");
  const bad = [
    { t: "open", w: "w98", at: 3, source: "transcript", key: "k2", agent: "claude-code", start: "new-session", c: "x" },
    { t: "sample", w: "w98", at: 4, tokens: 1, ref: "r2", c: "y" },
    { t: "open", w: "w99", at: 5, source: "transcript", key: "k3", agent: "claude-code", start: "new-session", c: "x" },
    { t: "sample", w: "w99", at: 6, tokens: 1, ref: "r3", c: "y" },
    { t: "progress", at: 7, tasks: "x", focus: 3, c: "z" },
    { t: "progress", at: "2030-01-01T00:00:00.000Z", tasks: [{ task: "n1", criteria: 5, gates: null }], c: "z" },
  ];
  // Chained and anchored like Scenaria's own lines: the records are intact, only these lines are not what Scenaria writes.
  const { createHash } = await import("node:crypto");
  const { windowAnchor } = await import("../dist/core/canon.js");
  const old = readFileSync(f, "utf8").trim().split("\n");
  let prev = JSON.parse(old[old.length - 1]).c;
  const text = bad.map(({ c, ...l }) => {
    const h = createHash("sha256").update(`${prev}|${JSON.stringify(l)}`).digest("hex").slice(0, 32);
    prev = h;
    return JSON.stringify({ ...l, c: h });
  });
  writeFileSync(f, old.join("\n") + "\n" + text.join("\n") + "\n");
  const a = windowAnchor(s.store).read();
  windowAnchor(s.store).raise(a.count + 1, old.length + bad.length, prev);
  const s2 = Scenaria.open(p.dir);
  const wp = windowProgress(s2);
  assert.ok(wp.stop, "the stop holds (noted outside the project)");
  assert.equal(wp.windows.length, 3, "the malformed lines are no windows; the real ones are still assessed");
  assert.deepEqual(windowStatus(s2).windows.map((w) => w.id).sort(), ["w1", "w2", "w3"], "lines with fields Scenaria never writes are no records");
  assert.equal(wp.stop.recorded, undefined, "computed from the records, not only from the note");
  assert.doesNotThrow(() => callTool(s2, "scenaria_window", {}, ctx));
  assert.ok(stopState(s2));
});

test("E4a review H2: a stop stays when the window records are changed or deleted — until the person lifts it", async () => {
  const { p, s } = project();
  await window(s, "claude-code:A");
  await window(s, "claude-code:B");
  await window(s, "claude-code:C");
  assert.ok(windowProgress(s).stop);
  const f = join(p.dir, ".scenaria/windows.jsonl");
  rmSync(f);
  const s2 = Scenaria.open(p.dir);
  let wp = windowProgress(s2);
  assert.ok(wp.stop, "deleting the records does not end the stop");
  assert.equal(wp.stop.recorded, true);
  assert.match(renderWindowProgress(wp, "de"), /zeigen das nicht mehr .*der Stopp bleibt trotzdem/);
  assert.ok(stopState(s2), "the hook's check holds it too");
  // A line with a wrong chain: the same.
  await answer(s2, "claude-code:D", 10);
  writeFileSync(f, readFileSync(f, "utf8") + JSON.stringify({ t: "reset", at: new Date().toISOString(), why: "chain", lines: 0, c: "x" }) + "\n");
  assert.ok(windowProgress(Scenaria.open(p.dir)).stop);
  // The person lifts it: gone.
  wp = liftStop(Scenaria.open(p.dir), { why: "records were cleaned up by me" }, { by: "kev", via: "terminal" });
  assert.equal(wp.stop, null);
  assert.equal(stopState(Scenaria.open(p.dir)), null);
});

test("E4a review H3: the check before every tool call is cheap, whatever the length of the records", async () => {
  const { p, s } = project();
  // 120 windows of 30 answers each, with a snapshot per change, written directly (fast).
  const lines = [];
  let t = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = () => new Date((t += 1000)).toISOString();
  for (let w = 1; w <= 120; w++) {
    lines.push({ t: "progress", at: iso(), by: "session-start", tasks: [{ task: "n1", criteria: ["k1 w=50 s=0 open", "k2 w=50 s=0 open"], gates: ["10 met", "20 met", "40 open", "60 open", "80 open", "90 open", "100 open"] }], focus: "n1" });
    lines.push({ t: "open", w: `w${w}`, at: iso(), source: "transcript", key: `claude-code:K${w}`, agent: "claude-code", start: "new-session" });
    for (let i = 1; i <= 30; i++) lines.push({ t: "sample", w: `w${w}`, at: iso(), tokens: i * 2000 + 40000, model: "claude-opus-5-5", ref: `m:${w}-${i}` });
  }
  // Chain them as Scenaria does, and raise the outside anchor.
  const { createHash } = await import("node:crypto");
  let prev = "";
  const text = lines.map((l) => {
    const c = createHash("sha256").update(`${prev}|${JSON.stringify(l)}`).digest("hex").slice(0, 32);
    prev = c;
    return JSON.stringify({ ...l, c });
  });
  writeFileSync(join(p.dir, ".scenaria/windows.jsonl"), text.join("\n") + "\n");
  const { windowAnchor } = await import("../dist/core/canon.js");
  windowAnchor(s.store).raise(1, lines.length, prev);
  // The check before every tool call reads only the note outside the project — whatever the length of the records.
  assert.equal(stopState(s), null, "nothing computed yet: nothing noted");
  assert.ok(evaluateStop(s), "computed when a window starts: the long row of windows without progress is a stop");
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) assert.ok(stopState(Scenaria.open(p.dir)));
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 30, `the hook's check took ${ms.toFixed(1)} ms`);
});

test("E4a review M5: a window whose task waits for the person is not judged; M6: rows are per agent", async () => {
  // All criteria implemented: the next gate (checked) is the person's — the agent cannot show progress alone.
  {
    const { p, s } = project({ single: true });
    work(p, s);
    await window(s, "claude-code:A");
    await window(s, "claude-code:B");
    await window(s, "claude-code:C");
    const wp = windowProgress(s);
    assert.deepEqual(states(wp), { w1: "skipped:waiting", w2: "skipped:waiting", w3: "running" });
    assert.equal(wp.stop, null);
  }
  // A Claude Code window and a proxy agent's window, one after the other, both without progress: two lines, no stop.
  {
    const { s } = project();
    await window(s, "claude-code:A");
    await sleep(3);
    recordProgressSnapshot(s);
    for (const pct of [10, 60]) {
      await sleep(3);
      recordWindowEvents(s, { source: "proxy", key: "p1", agent: "codex" }, [{ kind: "sample", at: new Date().toISOString(), tokens: pct * 2000, model: "claude-opus-5-5", ref: `r:${++n}` }]);
    }
    await window(s, "claude-code:B");
    await sleep(3);
    recordProgressSnapshot(s);
    for (const pct of [10, 60]) {
      await sleep(3);
      // The same conversation: the fill falls below half (the client compacted) — a new window of that line.
      recordWindowEvents(s, { source: "proxy", key: "p1", agent: "codex" }, [{ kind: "sample", at: new Date().toISOString(), tokens: pct * 2000, model: "claude-opus-5-5", ref: `r:${++n}` }]);
    }
    const wp = windowProgress(s);
    // claude-code: w1 ended (none), w3 running; codex: w2 ended by the drop (none), w4 running.
    assert.equal(wp.windows.filter((a) => a.state === "none").length, 2);
    assert.equal(wp.stop, null, "one window without progress per agent is a warning, not a stop");
    assert.ok(wp.warning);
  }
});

test("E4a review M7: each window is judged by the values in force when it ended", async () => {
  const { p, s } = project();
  await window(s, "claude-code:A");
  work(p, s); // +25
  await window(s, "claude-code:B");
  p.write("docs/s.md", "# Summary\n");
  s.checkpoint({ title: "Summary of the quarterly report", outputs: ["`docs/s.md`"], fulfills: ["k2"], agent: "claude-code" }); // +25
  await window(s, "claude-code:C");
  assert.deepEqual(states(windowProgress(s)), { w1: "progress", w2: "progress", w3: "running" });
  // The person sets min = 30 today: windows that ended before keep their verdict — no stop out of the past.
  setContextSettings(s.store, { progress: { minProgress: 30 } }, { by: "kev", via: "terminal" });
  const wp = windowProgress(s);
  assert.deepEqual(states(wp), { w1: "progress", w2: "progress", w3: "running" });
  assert.equal(wp.stop, null);
  assert.match(wp.windows.find((a) => a.window === "w1").points.sentence.de, /Regel v1\.0\./, "named with the rule of its time");
  assert.equal(wp.rule, "v1.0-p1 min=30 tolerance=5 k=3", "the current rule for what comes");
});

test("E4a review L11 and note: one snapshot per change; the first window does not start from a record of long ago", async () => {
  const { p, s } = project();
  // A second task with only a proposal (no approved criterion): it is not recorded (no progress to measure).
  s.checkpoint({ title: "switch" });
  const notes = s.startMission({ title: "Notes", goal: "Keep notes" }).id;
  s.proposeCanon({ kind: "future", text: "Notes are kept", task: notes, weight: 10 });
  await window(s, "claude-code:A");
  const kinds = readFileSync(join(p.dir, ".scenaria/windows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).t);
  assert.deepEqual(kinds, ["progress", "open", "sample", "sample"], "the session start recorded it; the opening adds no second record");
  const raw = JSON.parse(readFileSync(join(p.dir, ".scenaria/windows.jsonl"), "utf8").split("\n")[0]);
  assert.ok(raw.tasks.every((t) => t.criteria.length > 0), "only tasks with criteria are recorded");
  // A record of an hour before the first window of a line is not its start.
  const q = project();
  recordProgressSnapshot(q.s);
  const later = new Date(Date.now() + 3600_000).toISOString();
  recordWindowEvents(q.s, { source: "proxy", key: "p9", agent: "codex" }, [{ kind: "sample", at: later, tokens: 20000, model: "claude-opus-5-5", ref: `r:${++n}` }]);
  const a = windowProgress(q.s).windows[0];
  assert.deepEqual([a.window, a.state, a.value], ["w1", "running", null]);
});

test("E4a review note: the handover check stays within one task", async () => {
  const { s } = project();
  await window(s, "claude-code:A");
  s.checkpoint({ title: "Quarterly report: revenue section drafted", outputs: ["revenue section of the quarterly report"], agent: "claude-code" });
  await window(s, "claude-code:B");
  const t2 = s.startMission({ title: "Holiday planning", goal: "Plan the team holiday" }).id;
  void t2;
  s.checkpoint({ title: "Holiday dates collected", outputs: ["dates of the team holiday"], agent: "claude-code" });
  const h = windowProgress(s).handovers[0];
  assert.equal(h.loss, null, "work that moved to another task is a new start, not a handover");
});

test("E4 mutation check: a record written for a window only counts as its start when the window answered after it", async () => {
  const { s } = project();
  // Through the proxy: w1 has ONE answer (its opening record comes after it), then the fill drops (a new window).
  for (const pct of [60, 20, 60]) {
    await sleep(3);
    recordWindowEvents(s, { source: "proxy", key: "p1", agent: "codex" }, [{ kind: "sample", at: new Date(Date.now() - 2).toISOString(), tokens: pct * 2000, model: "claude-opus-5-5", ref: `r:${++n}` }]);
  }
  const w1 = windowProgress(s).windows.find((a) => a.window === "w1");
  assert.deepEqual([w1.state, w1.why], ["skipped", "no-measure"], "no record before or during w1's work");
});

test("E4 mutation check: a signed setting with min/tolerance out of bounds does not count", () => {
  const { p, s } = project();
  setContextSettings(s.store, { progress: { minProgress: 20 } }, { by: "kev", via: "terminal" });
  const f = join(dirname(globalConfigPath()), "context-settings.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  const [key, rec] = Object.entries(j.projects).find(([k]) => k.includes(p.dir.split("/").pop()));
  const e = rec.revisions[0];
  e.minProgress = 0;
  const folder = key.slice(key.indexOf(":") + 1);
  const sig = signRecord(s.store, ["context-settings/v2", folder, e.yellow, e.red, e.emergency, e.p95start, e.margin, e.aModel, e.minProgress, e.tolerance, e.models.map((m) => [m.id, m.cMax]), null, e.rev, e.at, e.by, e.via]);
  e.pub = sig.pub;
  e.sig = sig.sig;
  writeFileSync(f, JSON.stringify(j));
  const cs = readContextSettings(s.store);
  assert.deepEqual([cs.trust, cs.why, cs.progress.minProgress], ["invalid", "values", 10]);
});

test("E5 formulas: a window without a work step and a window held at a gate are not assessed (Kev 2026-10-25)", () => {
  const v = { start: ["n1 p=10"], end: ["n1 p=10"], focus: "n1", waiting: false, peak: 60, yellow: 50, compacted: false, rule: WINDOW_PROGRESS_RULE };
  assert.equal(windowVerdict(v, 0), "none");
  assert.equal(windowVerdict({ ...v, steps: 0 }, 0), "no-work");
  assert.equal(windowVerdict({ ...v, steps: 3 }, 0), "none");
  assert.equal(windowVerdict({ ...v, steps: 0 }, 12), "progress", "from the minimum on always progress");
  const held = { ...v, steps: 4, rawStart: "n1 r=25", rawEnd: "n1 r=50", gate: 20 };
  assert.equal(windowVerdict(held, 0), "capped");
  const d = derive("w", "window-progress/1", held);
  assert.match(d.sentence.de, /die Arbeit stieg um 25 Punkte ohne Deckel; das offene Tor „.+“ \(20 %\) hält den Wert: wird nicht bewertet/);
  assert.match(d.sentence.en, /the open gate ".+" \(20 %\) holds the value: not assessed/);
  assert.equal(windowVerdict({ ...held, rawEnd: "n1 r=30" }, 0), "none", "a rise below the minimum is no excuse");
  assert.equal(windowVerdict({ ...held, waiting: true }, 0), "waiting", "the person's turn comes first");
});

test("E5 review M2: a window whose work a gate holds is not assessed, the gate is named; no stop, no warning", async () => {
  const { p, s, task } = project({ decided: false });
  // Window 1: k1 drafted (25 % without the cap) — capped at 10 % (gate 20, approach not decided): +10, progress.
  await window(s, "claude-code:A");
  work(p, s);
  // Window 2: k2 drafted as well (50 % without the cap) — still 10 %: held by gate 20.
  await window(s, "claude-code:B");
  p.write("docs/s.md", "# Summary\n");
  s.checkpoint({ title: "Summary written", outputs: ["`docs/s.md`"], fulfills: ["k2"], agent: "claude-code" });
  await window(s, "claude-code:C");
  const wp = windowProgress(s);
  assert.deepEqual(states(wp), { w1: "progress", w2: "skipped:capped", w3: "running" });
  const w2 = wp.windows.find((a) => a.window === "w2");
  assert.equal(w2.gate, 20);
  assert.equal(w2.rise, 25);
  assert.equal(w2.focus, task);
  assert.equal(wp.warning, null);
  assert.equal(wp.capped?.window, "w2");
  assert.match(renderWindowProgress(wp, "de"), /von einem offenen Tor gedeckelt – wird nicht bewertet \(Tor „.+“, 20 %\)/);
  const { noteAgentText } = await import("../dist/core/windowprogress.js");
  assert.match(noteAgentText(wp), /in the previous window w2 task n1 rose by 25 points, but the open gate ".+" \(20 %\) holds its progress/);
});

test("E5 review L8: the stop names the task's title, also when read from the note outside the project", async () => {
  const { s } = project();
  await window(s, "claude-code:A");
  await window(s, "claude-code:B");
  await window(s, "claude-code:C");
  const wp = windowProgress(s);
  assert.equal(wp.stop?.title, "Q3 report");
  const { stopAgentText, stopPersonText } = await import("../dist/core/windowprogress.js");
  const st = stopState(Scenaria.open(s.store.root));
  assert.equal(st.title, "Q3 report");
  assert.match(stopAgentText(st), /on task n1 "Q3 report"/);
  assert.match(stopPersonText(st, "de"), /an der Aufgabe n1 „Q3 report“/);
});

test("E5 review M2: after a window without progress, a window held at a gate gives the gate note, not the problem note", async () => {
  const { p, s } = project({ decided: false });
  work(p, s); // k1 drafted before: 25 % without the cap, 10 % with it (gate 20 open)
  await window(s, "claude-code:A"); // nothing: no progress
  await window(s, "claude-code:B");
  p.write("docs/s.md", "# Summary\n");
  s.checkpoint({ title: "Summary written", outputs: ["`docs/s.md`"], fulfills: ["k2"], agent: "claude-code" });
  await window(s, "claude-code:C");
  const wp = windowProgress(s);
  assert.deepEqual(states(wp), { w1: "none", w2: "skipped:capped", w3: "running" });
  assert.equal(wp.warning, null, "the newest ended window was held at a gate: no problem note");
  assert.equal(wp.capped?.window, "w2");
  assert.equal(wp.stop, null);
});

test("E5 re-check N2: the window list and the assessment measure an ended window at the same time point", async () => {
  const { s } = project();
  await window(s, "claude-code:A");
  await sleep(5);
  // Seen red, the value changed, then a new session — the change lies between w1's last answer and w2's start.
  setContextSettings(s.store, { values: { aModel: 400_000, yellow: 65 } }, { by: "kev", via: "terminal" });
  await window(s, "claude-code:B");
  await window(s, "claude-code:C");
  const listed = windowStatus(s, { limit: 50 }).windows.find((w) => w.id === "w1");
  const a = windowProgress(s).windows.find((x) => x.window === "w1");
  assert.equal(listed.peak, 60);
  assert.equal(a.points.inputs.find((i) => i.name === "peak").value, listed.peak, "one fill for both");
  assert.equal(a.state, "none", "full at its time: judged, not 'not full'");
});

test("E5 re-check N5: version suffixes are cleaned only on Claude names", async () => {
  const { normaliseModel } = await import("../dist/core/models.js");
  assert.equal(normaliseModel("us.anthropic.claude-opus-5-5-v1:0"), "claude-opus-5-5");
  assert.equal(normaliseModel("claude-opus-5-5@20261001"), "claude-opus-5-5");
  assert.equal(normaliseModel("deepseek-v2"), "deepseek-v2");
  assert.notEqual(normaliseModel("deepseek-v3"), normaliseModel("deepseek-v2"));
  assert.equal(normaliseModel("mymodel@q4"), "mymodel@q4");
});
