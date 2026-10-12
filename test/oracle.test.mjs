// C2 (v0.9): the traceable oracle (bounded, evidence-backed corrections of the core) and the
// Prüf-Experte (checklist, skeptic, oracle backtest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { forecast, listForecasts } from "../dist/core/forecast.js";
import * as O from "../dist/core/oracle.js";
import * as A from "../dist/core/auditor.js";
import * as P from "../dist/core/predict.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const ctx = { source: "mcp", agent: "claude-code" };

function project() {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Gamer app that brings players back every day with daily quests", title: "Retention features", goal: "Daily quests and streaks that bring players back" });
  p.write("a.txt", "1");
  s.checkpoint({ title: "Daily quest backend: quest table and streak counter", facts: ["Streaks reset at midnight"] });
  return { p, s };
}

async function fakeLlm(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b || "{}");
    seen.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "fake-1", choices: [{ message: { role: "assistant", content: handler(body) } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { llm: { provider: "fake", model: "m", baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, seen, close: () => server.close() };
}

const sys = (b) => b.messages[0].content;
const user = (b) => b.messages[1].content;
const replies = (oracle, skeptic) => (body) => {
  if (/ARCHIVIST of a multiverse/.test(sys(body))) return JSON.stringify({ options: [{ key: "a", past: "continues n3", refs: ["n3"] }] });
  if (/CRAFTSMAN of a multiverse/.test(sys(body))) return JSON.stringify({ options: [{ key: "a", present: "quests", trajectory: ["x"], keeps: ["streaks"], loses: [] }, { key: "b", present: "wallet", trajectory: ["y"], loses: ["streak logic"] }] });
  if (/AUDITOR \(Prüf-Experte\)/.test(sys(body))) return JSON.stringify(skeptic ?? { verdicts: [] });
  return JSON.stringify(oracle);
};
const ORACLE = {
  options: [
    { key: "a", outcome: "players return", ownAdjust: { delta: 12, why: "the reminder continues the daily quest streak counter", refs: ["n3"] }, ctxAdjust: { delta: 0 }, risks: [{ text: "fatigue", refs: [] }], canonRisks: [], confidence: 0.5 },
    { key: "b", outcome: "stall", ownAdjust: { delta: 30, why: "wallets are great", refs: ["n77"] }, ctxAdjust: { delta: -8, why: "tokens drop the streak logic of the quest table", refs: ["n3"] }, canonRisks: [], confidence: 1 },
  ],
  recommendation: { key: "b", why: "bold" },
};
const decision = (s) => s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push before a daily quest streak resets" }, { label: "Wallet", description: "crypto wallet for skins" }] });

test("oracle corrections are bounded, need a reason and existing evidence, and count Δ·confidence·γ", () => {
  const mat = { ids: new Set(["n3", "k1"]), texts: new Map([["n3", "Daily quest backend: quest table and streak counter"]]) };
  const a = O.adjustOf({ delta: 35, why: "keeps the streak counter", refs: ["n3", "n99"] }, mat, 0.5, 1);
  assert.equal(a.proposed, 20, "bounded to ±20");
  assert.equal(a.applied, 10);
  assert.deepEqual(a.refs, ["n3"]);
  assert.deepEqual(a.dropped, ["n99"], "invented evidence is dropped");
  assert.equal(O.adjustOf({ delta: 10, why: "", refs: ["n3"] }, mat, 1, 1).applied, 0, "no reason → not counted");
  assert.equal(O.adjustOf({ delta: 10, why: "x", refs: ["n99"] }, mat, 1, 1).backed, false, "no existing evidence → not counted");
  assert.equal(O.adjustOf({ delta: -10, why: "x", refs: ["k1"] }, mat, 0.8, 0.5).applied, -4, "γ dampens");
  assert.equal(O.reasonFitsEvidence("keeps the streak counter", ["n3"], mat), true);
  assert.equal(O.reasonFitsEvidence("wallets are great", ["n3"], mat), false);
});

test("the corrected number uses the core's own formula; a hard fixed point at risk caps it at 40", () => {
  const e = { own: { score: 60 }, inContext: { score: 70 }, line: 72, alpha: 0.3, beta: 0.4, risk: { lessons: 6, canon: 0 } };
  const r = O.applyOracle(e, { applied: 10 }, { applied: -5 }, false);
  assert.equal(r.ownAfter, 70);
  assert.equal(r.ctxAfter, 65);
  assert.equal(r.predicted, Math.round(72 + 0.3 * (70 - 72) + 0.4 * (65 - 72) - 6));
  assert.equal(O.applyOracle({ ...e, own: { score: 95 }, inContext: { score: 95 } }, { applied: 0 }, { applied: 0 }, true).predicted, 40);
});

test("γ is learned: helpful corrections keep trust, harmful ones lower it; cases without a correction say nothing", () => {
  const base = { own: 50, inContext: 50, line: 50, risk: 0, alpha: 0.5, beta: 0.5, rawCtx: 0, capped: false };
  const helpful = Array.from({ length: 20 }, () => ({ ...base, rawOwn: 10, actual: 55 }));
  const harmful = Array.from({ length: 20 }, () => ({ ...base, rawOwn: 10, actual: 45 }));
  const silent = Array.from({ length: 20 }, () => ({ ...base, rawOwn: 0, actual: 80 }));
  const g1 = O.fitGamma(helpful);
  const g2 = O.fitGamma(harmful);
  assert.ok(g1.gamma > 0.9, JSON.stringify(g1));
  assert.ok(g2.gamma < 0.3, JSON.stringify(g2));
  assert.deepEqual(O.fitGamma(silent), { gamma: 1, n: 0 });
  assert.equal(O.fitGamma([...harmful, ...silent]).n, 20);
});

test("multiverse v2 end to end: traceable corrections, the checklist flags unbacked ones and the inconsistent recommendation", async () => {
  const { s } = project();
  const d = decision(s);
  const f0 = await fakeLlm(replies(ORACLE));
  try {
    const f = await forecast(s, { node: d.id, llm: f0.llm });
    const a = f.options.find((o) => o.key === "a");
    const b = f.options.find((o) => o.key === "b");
    assert.equal(a.universe.own.applied, 6, "12 × 0.5 × γ 1");
    assert.equal(b.universe.own.backed, false, "an invented id is not evidence");
    assert.deepEqual(b.universe.own.dropped, ["n77"]);
    assert.equal(b.universe.ctx.applied, -8);
    const au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "de");
    const by = (id) => au.checks.filter((c) => c.id === id);
    assert.equal(by("timing")[0].status, "ok");
    assert.equal(by("signature")[0].status, "ok");
    assert.equal(by("evidence")[0].status, "warn", JSON.stringify(by("evidence")));
    assert.match(by("evidence")[0].text, /1 von 3 Korrekturen/);
    assert.equal(by("consistency")[0].status, "warn", "the oracle recommends b, the numbers favour a");
    assert.equal(by("trust")[0].status, "info");
    assert.notEqual(au.verdict, "reliable");
    // MCP tool shows the corrections and the verdict
    const mcp = callTool(s, "scenaria_forecast", { id: d.id }, ctx).text;
    assert.match(mcp, /core \d+% → oracle \d+%/);
    assert.match(mcp, /unbacked correction, not counted/);
    assert.match(mcp, /Auditor f\d+: (with caution|not reliable)/);
  } finally {
    f0.close();
  }
});

test("checklist: a forecast made after the choice is not a fair test; a forecast edited outside is not reliable", async () => {
  const { p, s } = project();
  const d = decision(s);
  s.choose(d.id, "a", "on goal");
  const f = await forecast(s, { node: d.id, quick: true });
  let au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "en");
  assert.equal(au.checks.find((c) => c.id === "timing").status, "fail");
  assert.equal(au.verdict, "unreliable");
  const d2 = decision(s);
  const f2 = await forecast(s, { node: d2.id, quick: true });
  const file = join(p.dir, `.scenaria/forecasts/${f2.id}.json`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  j.options[1].score = 99;
  writeFileSync(file, JSON.stringify(j));
  au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f2.id), "en");
  assert.equal(au.checks.find((c) => c.id === "signature").status, "fail");
  assert.equal(au.verdict, "unreliable");
});

test("the skeptic: only supported corrections stay in the audited forecast; the record is signed", async () => {
  const { p, s } = project();
  const d = decision(s);
  const skeptic = { verdicts: [{ claim: "a.own", verdict: "supported", reason: "n3 is the streak counter" }, { claim: "b.ctx", verdict: "contradicted", reason: "n3 says nothing about tokens" }, { claim: "recommendation", verdict: "unsupported", reason: "no evidence" }] };
  const f0 = await fakeLlm(replies(ORACLE, skeptic));
  try {
    const f = await forecast(s, { node: d.id, llm: f0.llm });
    const rec = await A.deepAudit(s, f.id, { llm: f0.llm });
    const sent = user(f0.seen[f0.seen.length - 1]);
    assert.match(sent, /- n3: /, "the skeptic gets the text behind each cited id");
    assert.match(sent, /b\.own: .*\[no evidence given\]/, "an unbacked claim is shown without evidence");
    assert.equal(rec.verdicts.find((v) => v.claim === "a.own").verdict, "supported");
    assert.equal(rec.verdicts.find((v) => v.claim === "b.own").verdict, "unsupported", "a claim without evidence can never be supported");
    const a = f.options.find((o) => o.key === "a");
    const b = f.options.find((o) => o.key === "b");
    assert.equal(rec.audited.a, a.score, "a's supported correction stays");
    assert.equal(rec.audited.b, b.universe.core, "b's contradicted correction is removed → back to the core");
    const au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "en");
    assert.equal(au.deep[0].id, rec.id);
    assert.equal(au.deep[0].verified, true);
    // edited outside → unsigned
    const file = join(p.dir, `.scenaria/audits/${rec.id}.json`);
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.audited.b = 99;
    writeFileSync(file, JSON.stringify(j));
    assert.equal(A.listDeepAudits(s, f.id)[0].verified, false);
    // a quick forecast has no oracle claims to check
    const q = await forecast(s, { node: d.id, quick: true });
    await assert.rejects(A.deepAudit(s, q.id, { llm: f0.llm }), /Multiversum|multiverse/);
  } finally {
    f0.close();
  }
});

test("oracle backtest: a past decision forecast again as of its own time — the roles never see later nodes", async () => {
  const { p, s } = project();
  const d = decision(s);
  s.choose(d.id, "a", "on goal");
  p.write("b.txt", "1");
  s.checkpoint({ title: "Streak reminder push for daily quests" });
  p.write("c.txt", "1");
  s.checkpoint({ title: "Streak reminder opt-out for daily quests" });
  s.decide({ question: "SECRETLATER which push provider?", options: [{ label: "FCM" }, { label: "APNs" }] });
  assert.ok(P.backtestCases(s).cases.length >= 1);
  const f0 = await fakeLlm(replies({ options: [{ key: "a", ownAdjust: { delta: -15, why: "the daily quest streak counter is at risk", refs: ["n3"] }, confidence: 1 }, { key: "b", confidence: 1 }] }));
  try {
    const run = await A.oracleBacktest(s, { limit: 3, llm: f0.llm });
    assert.equal(f0.seen.length, 3, "3 calls for the one measurable decision");
    for (const b of f0.seen) assert.doesNotMatch(user(b), /SECRETLATER|Streak reminder opt-out/, "nothing after the decision's time");
    assert.equal(run.cases.length, 1);
    const c = run.cases[0];
    assert.equal(c.option, "a");
    assert.ok(c.oracle < c.core, `${c.oracle} < ${c.core}`);
    assert.equal(run.verified, true);
    assert.ok(readdirSync(join(p.dir, ".scenaria/forecast-backtests")).includes(`${run.id}.json`));
    const q = A.oracleQuality(s);
    assert.equal(q.backtest.n, 1);
    assert.equal(q.backtest.runs, 1);
    assert.equal(typeof q.backtest.maeCore, "number");
    assert.equal(A.oracleTrust(s).n, 1, "the backtest teaches γ");
  } finally {
    f0.close();
  }
});

test("server, chat and CLI: the checklist is open to read, the skeptic and the backtest are the person's", async () => {
  const { p, s } = project();
  const d = decision(s);
  const f = await forecast(s, { node: d.id, quick: true });
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess", autoForecast: false });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = await fetch(`${base}/api/forecast/audit?id=${f.id}&lang=en`);
    assert.equal(g.status, 200);
    assert.match(JSON.stringify(await g.json()), /"verdict"/);
    assert.equal((await fetch(`${base}/api/forecast/oracle`)).status, 200);
    for (const path of ["/api/forecast/audit", "/api/forecast/oracle-backtest"]) {
      const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ id: f.id }) });
      assert.equal(r.status, 403, path);
    }
  } finally {
    app.close();
    server.close();
  }
  const cli = join(process.cwd(), "dist/cli.js");
  const out = execFileSync(process.execPath, [cli, "forecast", "--audit", f.id, "--root", p.dir], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.match(out, /Prüf-Experte f\d+: (belastbar|mit Vorsicht|nicht belastbar)/);
  assert.throws(() => execFileSync(process.execPath, [cli, "forecast", "--audit", f.id, "--deep", "--root", p.dir], { encoding: "utf8", stdio: "pipe" }), /interactive terminal/);
  assert.throws(() => execFileSync(process.execPath, [cli, "forecast", "--oracle-backtest", "--root", p.dir], { encoding: "utf8", stdio: "pipe" }), /interactive terminal/);
});
