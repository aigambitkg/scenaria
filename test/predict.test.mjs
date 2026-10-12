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
  assert.equal(P.backtestCases(s).cases.length, 0, "one step alone is not scored");
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
  assert.equal(P.backtestCases(s).cases.length, 1);
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
  const { cases } = P.backtestCases(s);
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

test("quality: leave-one-DECISION-out, honest band coverage, counted in decisions", () => {
  // 12 decisions, two options each; reality follows the option's own words with α ≈ 0.5.
  const cases = Array.from({ length: 24 }, (_, i) => {
    const own = 40 + ((i * 7) % 55);
    return { decision: `n${Math.floor(i / 2)}`, question: "q", option: i % 2 ? "b" : "a", label: "x", at: "", own, inContext: 80, line: 80, risk: 0, predictedBreak: i % 4 === 0, actual: Math.round(80 + (own - 80) * 0.5 + ((i * 13) % 7) - 3), actualNodes: 3, broke: i % 3 === 0, signal: "ok" };
  });
  const q = P.forecastQuality({ store: { version: () => 1 }, root: "/x" }, { cases, excluded: 2 });
  assert.equal(q.decisions, 12);
  assert.equal(q.n, 24);
  assert.equal(q.excluded, 2);
  assert.ok(q.enough, "≥ 10 decisions");
  assert.ok(q.skill > 0, `following the option beats persistence: ${q.skill}`);
  assert.ok(q.mae < q.maeBaseline);
  // every case's band comes from the OTHER decisions only
  for (const c of q.cases) {
    const others = q.cases.filter((x) => x.decision !== c.decision).map((x) => x.error).sort((a, b) => a - b);
    const expect = Math.max(3, Math.round(others[Math.min(others.length - 1, Math.floor(0.8 * others.length))]));
    assert.equal(c.band, expect);
  }
  // the two options of one decision share their weights: both left out together
  const w = P.fit(cases.filter((c) => c.decision !== "n0"));
  const shown = { alpha: Math.round(w.alpha * 100) / 100, beta: Math.round(w.beta * 100) / 100 };
  for (const c of q.cases.filter((x) => x.decision === "n0")) assert.equal(c.predicted, P.predictLinear(c, shown));
  assert.equal(q.breaks.actual, 8);
  assert.equal(q.breaks.predicted, 6);
  // few decisions (many options do not count as many cases)
  const few = P.forecastQuality({ store: { version: () => 1 }, root: "/y" }, { cases: cases.slice(0, 16), excluded: 0 });
  assert.equal(few.decisions, 8);
  assert.equal(few.enough, false);
  assert.equal(few.minDecisions, 10);
});

test("C1 review: later edits never leak into the backtest (task summary, title change, patch, choice)", () => {
  const run = (laterEdits) => {
    const { p, s } = project();
    const d = s.decide({ question: "Reminder channel?", options: [{ label: "Push notification", description: "mobile push" }, { label: "E-mail digest", description: "daily summary mail" }] });
    s.choose(d.id, "a", "players read push first");
    p.write("x.txt", "1");
    s.checkpoint({ title: "Push notification for the streak" });
    p.write("y.txt", "1");
    s.checkpoint({ title: "Push opt-out setting" });
    if (laterEdits) {
      const task = s.store.listNodes().find((n) => n.type === "goal");
      s.update(task.id, { summary: "Push notification mobile push daily summary mail done", title: "Push notification mobile push reminders" });
      s.update(s.store.listNodes().find((n) => n.title.startsWith("Daily quest backend")).id, { facts: ["Push notification mobile push wins"] });
    }
    const v = P.viewAsOf(s, d.createdAt, P.readHistory(s), d.id);
    return P.predictOption(v, v.nodes.get(d.id), v.nodes.get(d.id).options[0], P.UNCALIBRATED).explain;
  };
  const clean = run(false);
  const edited = run(true);
  assert.equal(edited.own.score, clean.own.score, "own words unaffected by later edits");
  assert.equal(edited.inContext.score, clean.inContext.score);
  assert.equal(edited.line, clean.line, "line level unaffected");
});

test("C1 review: a main goal set (and changed) after the decision is not known before it", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "Retention features", goal: "Daily quests" });
  p.write("a.txt", "1");
  s.checkpoint({ title: "Daily quest backend" });
  const d = s.decide({ question: "Next?", options: [{ label: "Streak reminder push", description: "push" }, { label: "NFT", description: "tokens" }] });
  s.setProjectGoal("Streak reminder push for daily players", { agent: "t" });
  s.setProjectGoal("Something else entirely", { agent: "t" });
  assert.equal(P.goalAt(P.readHistory(s), d.createdAt), "", "no goal at that time");
  assert.equal(P.viewAsOf(s, d.createdAt).mainGoal, "");
  assert.equal(P.goalAt(P.readHistory(s), new Date().toISOString()), "Something else entirely");
});

test("C1 review: the shown formula reproduces the number exactly", () => {
  const { p, s } = project();
  for (let i = 0; i < 6; i++) {
    const d = s.decide({ question: `Step ${i}?`, options: [{ label: `Streak reminder variant ${i}`, description: "push before the daily quest streak resets" }, { label: `Wallet ${i}`, description: "blockchain tokens" }] });
    s.choose(d.id, "a", "ok");
    p.write(`f${i}.txt`, "1");
    s.checkpoint({ title: `Streak reminder ${i} for daily quests` });
    p.write(`g${i}.txt`, "1");
    s.checkpoint({ title: `Daily quest streak metrics ${i}` });
  }
  const d = s.decide({ question: "Last?", options: [{ label: "Streak reminder", description: "push" }, { label: "NFT skins", description: "sell skins as tokens" }] });
  for (const o of quickDecision(s, d.id)) {
    const e = o.quick.explain;
    const r = e.risk.lessons + e.risk.canon;
    assert.equal(Math.max(0, Math.min(100, Math.round(e.line + e.alpha * (e.own.score - e.line) + e.beta * (e.inContext.score - e.line) - r))), e.predicted);
  }
});

test("C1 review: tampered history is left out of the backtest and counted", async () => {
  const { p, s } = project();
  const d = s.decide({ question: "Reminder channel?", options: [{ label: "Push notification", description: "mobile push" }, { label: "E-mail digest", description: "daily summary mail" }] });
  s.choose(d.id, "a", "ok");
  p.write("x.txt", "1");
  const n1 = s.checkpoint({ title: "Push notification for the streak" });
  p.write("y.txt", "1");
  s.checkpoint({ title: "Push opt-out setting" });
  assert.equal(P.backtestCases(s).cases.length, 1);
  const { readFileSync, writeFileSync } = await import("node:fs");
  const f = join(s.store.dir, "nodes", `${n1.id}.json`);
  const raw = JSON.parse(readFileSync(f, "utf8"));
  raw.title = "Push notification — edited behind Scenaria's back";
  writeFileSync(f, JSON.stringify(raw));
  const r = P.backtestCases(Scenaria.open(p.dir));
  assert.equal(r.cases.length, 0);
  assert.equal(r.excluded, 1);
});

test("C1 review: a decision contributes only the option its line took to that line's context", async () => {
  const { decisionContext } = await import("../dist/core/fidelity.js");
  const d = { id: "n9", type: "decision", title: "Which?", question: "Which storage?", options: [{ id: "a", label: "Postgres table" }, { id: "b", label: "Wallet blockchain" }], chosen: "a", createdAt: "" };
  const ctx = decisionContext(d, { id: "n10", parentId: "n9", viaOption: "b", createdAt: "" });
  assert.ok(ctx.has("wallet") && !ctx.has("postgr"), [...ctx].join(","));
  const chosen = decisionContext(d, { id: "n11", parentId: "n9", createdAt: "" });
  assert.ok(chosen.has("postgr") && !chosen.has("wallet"));
});

test("C1 review: the backtest stays fast on a larger project (cached per decision, path-only)", () => {
  const { p, s } = project();
  for (let i = 0; i < 40; i++) {
    const d = s.decide({ question: `Feature ${i}?`, options: [{ label: `Quest feature ${i}`, description: "daily quest streak" }, { label: `Other ${i}`, description: "unrelated" }] });
    s.choose(d.id, "a", "ok");
    for (let k = 0; k < 6; k++) s.checkpoint({ title: `Daily quest work ${i}.${k} streak` });
  }
  const t0 = Date.now();
  P.forecastQuality(s);
  const first = Date.now() - t0;
  s.checkpoint({ title: "one more daily quest step" });
  const t1 = Date.now();
  P.forecastQuality(s);
  const second = Date.now() - t1;
  assert.ok(second < first, `cached second run faster: ${first} ms → ${second} ms`);
  assert.ok(second < 1500, `${second} ms`);
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
