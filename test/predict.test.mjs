// C1 (v0.9): forecast core v2 — the forecast predicts the SAME quantity that is measured afterwards,
// every number can be retraced, quality is measured honestly against a naive baseline (backtest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { quickDecision, quickPrompt } from "../dist/core/forecast.js";
import * as P from "../dist/core/predict.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));

function project() {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Gamer app that brings players back every day with daily quests", title: "Retention features", goal: "Daily quests and streaks that bring players back" });
  p.write("a.txt", "1");
  s.checkpoint({ title: "Daily quest backend: quest table and streak counter", facts: ["Streaks reset at midnight"] });
  return { p, s };
}

test("same quantity: the predicted next step uses exactly the fidelity formula of the measurement", () => {
  const { p, s } = project();
  const head = s.store.readState().head;
  const text = "Streak reminder push for daily quests before the streak resets";
  const pred = P.predictPrompt(P.viewNow(s), head, text, P.UNCALIBRATED).explain;
  p.write("b.txt", "1");
  const n = s.checkpoint({ title: text });
  const real = s.fidelity().points[n.id];
  assert.equal(pred.own.anchor, real.anchor, "anchor = closeness to the goals, same formula");
  assert.equal(pred.own.continuity, real.continuity, "continuity = connection to the path, same formula");
});

test("derivation: the shown formula reproduces the number", () => {
  const { s } = project();
  const d = s.decide({ question: "What next?", options: [{ label: "Streak reminder", description: "push before a daily quest streak resets" }, { label: "NFT marketplace", description: "sell skins as blockchain tokens" }] });
  for (const o of quickDecision(s, d.id)) {
    const e = o.quick.explain;
    assert.ok(e, "every quick forecast carries its derivation");
    const r = e.risk.lessons + e.risk.canon;
    const byHand = Math.round(Math.max(0, Math.min(100, e.line + e.alpha * (e.own.score - e.line) + e.beta * (e.inContext.score - e.line) - r)));
    assert.ok(Math.abs(byHand - o.score) <= 1, `${o.key}: ${byHand} vs ${o.score}`);
    assert.equal(o.score, e.predicted);
    assert.ok(e.band > 0);
    assert.match(P.explainText(e, "de"), /P = L \+ α·\(own − L\) \+ β·\(context − L\) − risk = /);
  }
  const [on, off] = quickDecision(s, d.id);
  assert.ok(on.score > off.score, `on-goal option first: ${on.score} vs ${off.score}`);
  assert.equal(off.quick.explain.breakRisk, true, "the drifting option's own words are flagged");
  // prompts too
  const q = quickPrompt(s, "Continue the daily quest backend: streak reminder push for players");
  assert.ok(q.explain && q.score > 0);
});

test("measurement: steps without content are skipped, a new task ends the line, one step is not enough", () => {
  const { p, s } = project();
  const d = s.decide({ question: "Storage?", options: [{ label: "Postgres table", description: "streak counters in the quest table" }, { label: "Redis", description: "counters in redis" }] });
  s.choose(d.id, "a", "durable");
  p.write("c.txt", "1");
  s.checkpoint({ title: "Streak counters in the Postgres quest table" });
  let v = P.viewNow(s);
  const b = P.branchOf(v, v.nodes.get(d.id), "a");
  assert.equal(P.measureLine(v, b.id).nodes, 1);
  assert.equal(P.backtestCases(s).length, 0, "one step alone is not scored");
  p.write("d.txt", "2");
  s.checkpoint({ title: "Auto-save: d.txt" }); // no content
  p.write("e.txt", "3");
  s.checkpoint({ title: "Index on streak counters in the quest table" });
  s.startMission({ title: "Marketing site", goal: "Landing page for the launch" });
  p.write("f.txt", "4");
  s.checkpoint({ title: "Landing page hero text" });
  v = P.viewNow(s);
  const m = P.measureLine(v, b.id);
  assert.equal(m.nodes, 2, `content steps within the task only: ${m.ids}`);
  assert.ok(!m.ids.some((id) => v.nodes.get(id).title.startsWith("Auto-save")));
  assert.equal(P.backtestCases(s).length, 1);
});

test("backtest without knowledge of the future: later lessons, rationale and goal changes are invisible", () => {
  const { p, s } = project();
  const d = s.decide({ question: "Reminder channel?", options: [{ label: "Push notification", description: "mobile push before the streak resets" }, { label: "E-mail digest", description: "daily summary mail" }] });
  const t = d.createdAt;
  s.choose(d.id, "a", "players read push first — and NFT tokens later");
  p.write("x.txt", "1");
  s.checkpoint({ title: "Push notification before the streak resets" });
  p.write("y.txt", "1");
  s.checkpoint({ title: "Push opt-out setting for daily quests" });
  s.rewind(d.id, { lesson: "E-mail digest was ignored by players", restoreFiles: false });
  s.setProjectGoal("Completely different goal about tax software", { agent: "t" });
  const past = P.viewAsOf(s, t);
  const dd = past.nodes.get(d.id);
  assert.equal(dd.chosen, undefined, "not decided yet at that time");
  assert.equal(dd.rationale, undefined);
  assert.ok(!past.lessons.some((l) => /E-mail digest was ignored/.test(l.text)), "a later lesson is not known");
  assert.match(past.mainGoal, /Gamer app/, "the goal of that time");
  const now = P.viewNow(s);
  assert.ok(now.lessons.some((l) => /E-mail digest was ignored/.test(l.text)));
  const cases = P.backtestCases(s);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].risk, 0, "no lesson penalty from the future");
});

test("weights: least squares recovers α and β, stays in range and is shrunk with few cases", () => {
  const mk = (a, b, n) =>
    Array.from({ length: n }, (_, i) => {
      const own = 40 + ((i * 37) % 60);
      const inContext = 50 + ((i * 53) % 50);
      const line = 70 + ((i * 11) % 25);
      return { own, inContext, line, risk: 0, actual: line + a * (own - line) + b * (inContext - line) };
    });
  const big = P.fit(mk(0.6, 0.3, 400));
  assert.ok(Math.abs(big.alpha - 0.6) < 0.03 && Math.abs(big.beta - 0.3) < 0.03, JSON.stringify(big));
  const small = P.fit(mk(0.6, 0.3, 4));
  assert.ok(small.alpha < 0.6 && small.alpha > P.DEFAULT_ALPHA, "shrunk towards the default");
  const wild = P.fit(mk(3, 2, 200));
  assert.ok(wild.alpha >= 0 && wild.beta >= 0 && wild.alpha + wild.beta <= 1.0001, JSON.stringify(wild));
  assert.deepEqual(P.fit([]), { alpha: P.DEFAULT_ALPHA, beta: P.DEFAULT_BETA });
});

test("quality: honest metrics against the naive forecast, leave-one-out, band and breaks", () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({ decision: `n${i}`, question: "q", option: "a", label: "x", at: "", own: 50 + i * 3, inContext: 80, line: 80, risk: 0, predictedBreak: i % 4 === 0, actual: 80 + Math.round((50 + i * 3 - 80) * 0.5), actualNodes: 3, broke: i % 3 === 0, signal: "ok" }));
  const q = P.forecastQuality({ store: { version: () => 1 }, root: "/x" }, cases);
  assert.equal(q.n, 12);
  assert.ok(q.enough);
  assert.ok(q.skill > 0, `the forecast that follows the option beats persistence: ${q.skill}`);
  assert.ok(q.mae < q.maeBaseline);
  assert.equal(q.calibration.calibrated, true);
  assert.ok(q.calibration.band >= 3);
  assert.equal(q.breaks.actual, 4);
  assert.equal(q.breaks.predicted, 3);
  assert.equal(q.breaks.hits, 1);
  // too few cases: said so, default band
  const few = P.forecastQuality({ store: { version: () => 1 }, root: "/y" }, cases.slice(0, 3));
  assert.equal(few.enough, false);
  assert.equal(few.calibration.calibrated, false);
  assert.equal(few.calibration.band, 20);
});

test("test bench: clear cases ranked right, no false alarm on most neutral cases, limits reported", async () => {
  const b = await P.benchmark();
  assert.equal(b.clear.ranking, b.clear.n, JSON.stringify(b.results.filter((r) => r.kind === "clear" && !r.passed)));
  assert.ok(b.clear.flagged >= b.clear.n - 1, `drift flagged: ${b.clear.flagged}/${b.clear.n}`);
  assert.ok(b.neutral.falseAlarms <= 1, `false alarms: ${b.neutral.falseAlarms}`);
  assert.ok(b.mae < 15, `mean error ${b.mae}`);
  assert.ok(b.limits.length >= 2 && b.limits.every((r) => r.limit));
});

test("dashboard: quality is open to read, the test bench is the person's", async () => {
  const { s } = project();
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const q = await (await fetch(`${base}/api/forecast/quality`)).json();
    assert.equal(q.model, 2);
    assert.equal(q.enough, false);
    const deny = await fetch(`${base}/api/forecast/benchmark`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: "{}" });
    assert.equal(deny.status, 403);
    const ok = await (await fetch(`${base}/api/forecast/benchmark`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: "{}" })).json();
    assert.equal(ok.clear.n, 8);
    assert.ok(ok.calibration);
  } finally {
    app.close();
    server.close();
  }
});
