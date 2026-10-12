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
  if (/ARCHIVIST of a multiverse/.test(sys(body))) return JSON.stringify({ options: [{ key: "a", past: "continues n3", refs: ["n2"] }] });
  if (/CRAFTSMAN of a multiverse/.test(sys(body))) return JSON.stringify({ options: [{ key: "a", present: "quests", trajectory: ["x"], keeps: ["streaks"], loses: [] }, { key: "b", present: "wallet", trajectory: ["y"], loses: ["streak logic"] }] });
  if (/AUDITOR \(Prüf-Experte\)/.test(sys(body))) return JSON.stringify(skeptic ?? { verdicts: [] });
  return JSON.stringify(oracle);
};
const ORACLE = {
  options: [
    { key: "a", outcome: "players return", ownAdjust: { delta: 12, why: "the reminder continues the daily quest streak counter", refs: ["n2"] }, ctxAdjust: { delta: 0 }, risks: [{ text: "fatigue", refs: [] }], canonRisks: [], confidence: 0.5 },
    { key: "b", outcome: "stall", ownAdjust: { delta: 30, why: "wallets are great", refs: ["n77"] }, ctxAdjust: { delta: -8, why: "tokens drop the streak logic of the quest table", refs: ["n2"] }, canonRisks: [], confidence: 1 },
  ],
  recommendation: { key: "b", why: "bold" },
};
const decision = (s) => s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push before a daily quest streak resets" }, { label: "Wallet", description: "crypto wallet for skins" }] });

test("oracle corrections are bounded, need a reason and existing evidence, and count Δ·confidence·γ", () => {
  const mat = { ids: new Set(["n3", "k1", "n0"]), generic: new Set(["n0"]), texts: new Map([["n3", "Daily quest backend: quest table and streak counter"]]) };
  const a = O.adjustOf({ delta: 35, why: "keeps the streak counter", refs: ["n3", "n99"] }, mat, 0.5, 1);
  assert.equal(a.proposed, 20, "bounded to ±20");
  assert.equal(a.applied, 10);
  assert.deepEqual(a.refs, ["n3"]);
  assert.deepEqual(a.dropped, ["n99"], "invented evidence is dropped");
  assert.equal(O.adjustOf({ delta: 10, why: "", refs: ["n2"] }, mat, 1, 1).applied, 0, "no reason → not counted");
  assert.equal(O.adjustOf({ delta: 10, why: "x", refs: ["n99"] }, mat, 1, 1).backed, false, "no existing evidence → not counted");
  assert.equal(O.adjustOf({ delta: -10, why: "x", refs: ["k1"] }, mat, 0.8, 0.5).applied, -4, "γ dampens");
  // K3: the ±20 bound holds after γ too
  assert.equal(O.adjustOf({ delta: 20, why: "x", refs: ["k1"] }, mat, 1, 1.5).applied, 20);
  // K2c: the project root (or the task, the decision itself) is no evidence on its own
  const g = O.adjustOf({ delta: 20, why: "serves the project", refs: ["n0"] }, mat, 1, 1);
  assert.equal(g.backed, false);
  assert.deepEqual(g.ignored, ["n0"]);
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
  const skeptic = { verdicts: [{ claim: "a.own", verdict: "supported", reason: "n2 is the streak counter" }, { claim: "b.ctx", verdict: "contradicted", reason: "n2 says nothing about tokens" }, { claim: "recommendation", verdict: "unsupported", reason: "no evidence" }] };
  const f0 = await fakeLlm(replies(ORACLE, skeptic));
  try {
    const f = await forecast(s, { node: d.id, llm: f0.llm });
    const rec = await A.deepAudit(s, f.id, { llm: f0.llm });
    const sent = user(f0.seen[f0.seen.length - 1]);
    assert.match(sent, /- n2: /, "the skeptic gets the text behind each cited id");
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
  const f0 = await fakeLlm(replies({ options: [{ key: "a", ownAdjust: { delta: -15, why: "the daily quest streak counter is at risk", refs: ["n2"] }, confidence: 1 }, { key: "b", confidence: 1 }] }));
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

test("review C2: evidence as it was cited, flags only resolved with the skeptic, large corrections need the AI check, forged audits never hide the real one", async () => {
  const { p, s } = project();
  const d = s.decide({ question: "Next feature?", options: [{ label: "Raid mode", description: "guild raids with bosses" }, { label: "Streak reminder", description: "push before a daily quest streak resets" }] });
  const oracle = {
    options: [
      { key: "a", ownAdjust: { delta: 20, why: "raids extend the daily quest backend streak counter", refs: ["n2"] }, confidence: 0.6789 },
      { key: "b", ownAdjust: { delta: 5, why: "serves the project", refs: ["n0", "n1"] }, confidence: 1 },
    ],
    recommendation: { key: "a", why: "x" },
  };
  const f0 = await fakeLlm(replies(oracle, { verdicts: [{ claim: "a.own", verdict: "supported", reason: "ok" }] }));
  try {
    const f = await forecast(s, { node: d.id, llm: f0.llm });
    const a = f.options.find((o) => o.key === "a");
    const b = f.options.find((o) => o.key === "b");
    // K5: the confidence shown is the one computed with
    assert.equal(a.universe.confidence, 0.68);
    assert.equal(a.universe.own.applied, Math.round(20 * 0.68 * 1));
    // K2c
    assert.equal(b.universe.own.backed, false);
    assert.deepEqual(b.universe.own.ignored, ["n0", "n1"]);
    // K1: the cited text is kept with the forecast (signed)
    assert.match(f.evidence.n2, /Daily quest backend/);
    s.update("n2", { title: "Raid bosses for guilds" });
    let au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "en");
    const flags = au.checks.filter((c) => c.id === "flags");
    // K2a: the oracle's evidence alone never resolves the core's warning — only the skeptic's agreement does
    if (a.quick.explain.breakRisk) {
      assert.equal(a.universe.flagResolved, true, "a candidate");
      assert.ok(flags.some((c) => c.status === "warn" && /only once the AI check confirms/.test(c.text)), JSON.stringify(flags));
    }
    assert.ok(au.checks.some((c) => c.id === "unchecked" && c.status === "warn"), "a large correction without AI check");
    assert.ok(au.checks.some((c) => c.id === "generic"));
    assert.notEqual(au.verdict, "reliable");
    await A.deepAudit(s, f.id, { llm: f0.llm });
    const sent = user(f0.seen[f0.seen.length - 1]);
    assert.match(sent, /- n2: .*Daily quest backend/, "the skeptic checks against the text as it was cited");
    assert.doesNotMatch(sent, /Raid bosses for guilds/);
    au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "en");
    assert.ok(!au.checks.some((c) => c.id === "unchecked"), "after the AI check the large correction is confirmed");
    if (a.quick.explain.breakRisk) assert.ok(au.checks.some((c) => c.id === "flags" && c.status === "ok"), "resolved once the skeptic confirmed it");
    // K4: a forged, newer audit file never hides the signed one
    const real = au.deep[0].id;
    writeFileSync(join(p.dir, ".scenaria/audits/a99.json"), JSON.stringify({ id: "a99", forecast: f.id, createdAt: "2999-01-01T00:00:00.000Z", model: "x", verdicts: [], audited: { a: 100 } }));
    au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "en");
    assert.equal(au.deep[0].id, real);
    assert.ok(au.checks.some((c) => c.id === "deepUnsigned"));
    // K7: oracle quality says "tendency" below 10 decisions
    const q = A.oracleQuality(s);
    assert.equal(q.minDecisions, 10);
    assert.equal(q.enough, false);
  } finally {
    f0.close();
  }
});

test("a warning is never resolved when the skeptic does not confirm the evidence", async () => {
  const { s } = project();
  const d = s.decide({ question: "Next?", options: [{ label: "Streak push", description: "remind before the streak counter resets" }, { label: "Xyz", description: "foo bar baz qux" }] });
  const f0 = await fakeLlm(replies({ options: [{ key: "a", confidence: 1 }, { key: "b", ownAdjust: { delta: 15, why: "Xyz is our internal name for the streak counter", refs: ["n2"] }, confidence: 1 }] }, { verdicts: [{ claim: "b.own", verdict: "unsupported", reason: "n2 does not mention Xyz" }] }));
  try {
    const f = await forecast(s, { node: d.id, llm: f0.llm });
    const b = f.options.find((o) => o.key === "b");
    assert.equal(b.quick.explain.breakRisk, true);
    assert.equal(b.universe.flagResolved, true, "a candidate only");
    await A.deepAudit(s, f.id, { llm: f0.llm });
    const au = A.auditForecast(s, listForecasts(s).find((x) => x.id === f.id), "en");
    assert.ok(au.checks.some((c) => c.id === "flags" && c.status === "warn"), JSON.stringify(au.checks));
    assert.ok(!au.checks.some((c) => c.id === "flags" && c.status === "ok"));
    assert.equal(au.deep[0].audited.b, b.universe.core, "the unsupported correction is removed");
  } finally {
    f0.close();
  }
});

test("robust oracle: a broken answer is asked again, then the forecast continues; keys, labels, order and '75' confidence are understood", async () => {
  const { s } = project();
  const d = decision(s);
  let oracleCalls = 0;
  const steps = [];
  const f0 = await fakeLlm((body) => {
    if (/ARCHIVIST of a multiverse/.test(sys(body))) return "Sorry, I cannot answer in JSON."; // twice broken
    if (/CRAFTSMAN of a multiverse/.test(sys(body))) return JSON.stringify({ results: [{ key: "A", present: "quests", trajectory: ["x"] }, { key: "B", present: "wallet", trajectory: ["y"] }] });
    oracleCalls++;
    if (oracleCalls === 1) return "```\nnot json";
    return JSON.stringify({ options: [{ key: "Streak reminder", ownAdjust: { delta: "+10", why: "continues the daily quest backend", refs: ["n2"] }, confidence: 75 }, { outcome: "stall", confidence: "0.5" }], recommendation: "Streak reminder" });
  });
  try {
    const f = await forecast(s, { node: d.id, llm: f0.llm, onStep: (st) => steps.push(st) });
    assert.deepEqual(steps, ["archivist", "craftsman", "oracle", "done"]);
    assert.ok(f.warnings.some((w) => /Archivar.*kein gültiges JSON/.test(w)), JSON.stringify(f.warnings));
    const a = f.options.find((o) => o.key === "a");
    const b = f.options.find((o) => o.key === "b");
    assert.equal(a.universe.present, "quests", "upper-case key matched");
    assert.equal(a.universe.confidence, 0.75, "75 → 0.75");
    assert.equal(a.universe.own.proposed, 10, "'+10' understood");
    assert.equal(a.universe.own.applied, 8);
    assert.equal(b.universe.outcome, "", "an entry without a name is never guessed when others are named");
    assert.ok(f.warnings.some((w) => /Orakel: 1 Antwort\(en\) ließen sich keiner Option sicher zuordnen/.test(w)), JSON.stringify(f.warnings));
    assert.equal(f.recommended.key, "a", "recommendation by label");
  } finally {
    f0.close();
  }
});

test("person: write down a decision, see progress while the model works, check a past decision as of its own time", async () => {
  const { p, s } = project();
  let release;
  const gate = new Promise((r) => (release = r));
  const f0 = await fakeLlm(replies(ORACLE));
  // slow model: the oracle waits until the test has seen the progress
  const slow = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    if (/ORACLE of a multiverse/.test(sys(body))) await gate;
    const r = await fetch(`${f0.llm.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const llm = { provider: "fake", model: "m", baseUrl: `http://127.0.0.1:${slow.address().port}/v1` };
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess", autoForecast: false });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" };
  try {
    // agents cannot write a decision through the person's endpoint
    assert.equal((await fetch(`${base}/api/forecast/decision`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ question: "Next?", options: ["A", "B"] }) })).status, 403);
    const bad = await fetch(`${base}/api/forecast/decision`, { method: "POST", headers: H, body: JSON.stringify({ question: "Next?", options: ["only one"] }) });
    assert.equal(bad.status, 400);
    const d = await (await fetch(`${base}/api/forecast/decision`, { method: "POST", headers: H, body: JSON.stringify({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push before a daily quest streak resets" }, "Wallet"] }) })).json();
    assert.equal(d.type, "decision");
    assert.equal(d.options.length, 2);
    const run = fetch(`${base}/api/forecast`, { method: "POST", headers: H, body: JSON.stringify({ node: d.id, llm }) }).then((r) => r.json());
    let prog;
    for (let i = 0; i < 50; i++) {
      prog = await (await fetch(`${base}/api/forecast/progress`)).json();
      if (prog.job?.step === "oracle") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(prog.job.kind, "multiverse");
    assert.equal(prog.job.step, "oracle");
    release();
    const f = await run;
    assert.equal(f.mode, "multiverse");
    assert.equal((await (await fetch(`${base}/api/forecast/progress`)).json()).job, null);
    // the decision is chosen and its line goes on: check it as of its own time
    s.choose(d.id, "a", "on goal");
    p.write("x1.txt", "1");
    s.checkpoint({ title: "Streak reminder push for daily quests" });
    const past = await (await fetch(`${base}/api/forecast/past`)).json();
    assert.equal(past[0].id, d.id);
    assert.equal(past[0].chosenLabel, "Streak reminder");
    assert.equal(past[0].measurable, 0, "one step is not measurable yet");
    const bt = await (await fetch(`${base}/api/forecast/oracle-backtest`, { method: "POST", headers: H, body: JSON.stringify({ decisions: [d.id], llm }) })).json();
    assert.equal(bt.run.decisions[0].id, d.id);
    assert.equal(bt.run.options.length, 2);
    const a = bt.run.options.find((o) => o.option === "a");
    assert.equal(a.chosen, true);
    assert.equal(a.actual, null, "not measurable yet — shown, not scored");
    assert.equal(bt.run.cases.length, 0, "nothing teaches γ without a measurement");
  } finally {
    app.close();
    server.close();
    slow.close();
    f0.close();
  }
});

test("auditor's area: overview with verdicts, signed/before-choice counts, and a downloadable report (read-only)", async () => {
  const { p, s } = project();
  const d = decision(s);
  const f1 = await forecast(s, { node: d.id, quick: true });
  s.choose(d.id, "a", "on goal");
  const f2 = await forecast(s, { node: d.id, quick: true }); // after the choice → not reliable
  const d2 = decision(s);
  const f3 = await forecast(s, { node: d2.id, quick: true });
  const file = join(p.dir, `.scenaria/forecasts/${f3.id}.json`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  j.options[0].score = 99;
  writeFileSync(file, JSON.stringify(j)); // changed outside → unsigned
  const o = A.auditOverview(s, "en");
  assert.equal(o.counts.forecasts, 3);
  assert.equal(o.counts.unsigned, 1);
  assert.equal(o.counts.unreliable, 2);
  assert.equal(o.counts.decisionForecasts, 3);
  assert.equal(o.counts.beforeChoice, 2, "f2 was made after the choice");
  assert.equal(o.rows.find((r) => r.id === f2.id).verdict, "unreliable");
  assert.ok(o.rows.find((r) => r.id === f1.id).verdict !== "unreliable");
  const md = A.auditReportMarkdown(o, "de");
  assert.match(md, /# Prüfbericht Prognosen/);
  assert.match(md, new RegExp(`\\| ${f3.id} ⚠ \\|`), "unsigned marked");
  assert.match(md, /Nach der Wahl erstellt|nicht belastbar/);
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess", autoForecast: false });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/audit/report?format=md&lang=en`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="scenaria-pruefbericht-.*\.md"/);
    assert.match(await r.text(), /# Forecast audit report/);
    const js = await (await fetch(`${base}/api/audit/report?format=json`)).json();
    assert.equal(js.counts.forecasts, 3);
    assert.equal((await fetch(`${base}/api/audit/overview`)).status, 200, "open to read without approval");
  } finally {
    app.close();
    server.close();
  }
});

test("review 0.9.1: answers never land on the wrong option; no usable oracle → no fake result; errors are classified; the person can stop a run", async () => {
  // K1: shortened labels in swapped order
  const opts = [{ key: "a", label: "Passkeys" }, { key: "b", label: "Magic link" }];
  let m = O.assignEntries([{ key: "Magic link", x: 1 }, { key: "Passkey", x: 2 }], opts);
  assert.equal(m.get("a").x, 2);
  assert.equal(m.get("b").x, 1);
  m = O.assignEntries([{ key: "Magic link", x: 1 }, { key: "Something else", x: 2 }], opts);
  assert.equal(m.get("b").x, 1);
  assert.equal(m.has("a"), false, "a named but unmatched entry is not given to a by order");
  m = O.assignEntries([{ x: 1 }, { x: 2 }], opts);
  assert.equal(m.get("a").x, 1, "nothing named at all → by order");
  m = O.assignEntries([{ key: "a", x: 1 }, { key: "A", x: 2 }], opts);
  assert.equal(m.get("a").x, 1);
  assert.equal(m.has("b"), false, "one entry never serves two options");
  // K3: an oracle without a usable answer → an error, nothing saved
  const { s } = project();
  const d = decision(s);
  const f0 = await fakeLlm((body) => (/ORACLE of a multiverse/.test(sys(body)) ? "I think a is better." : replies(ORACLE)(body)));
  try {
    await assert.rejects(forecast(s, { node: d.id, llm: f0.llm }), /keine brauchbare Antwort des Orakels/);
    assert.equal(listForecasts(s).filter((f) => f.mode === "multiverse").length, 0);
  } finally {
    f0.close();
  }
  // K2: classification of our own messages
  const L = await import("../dist/core/llm-errors.js");
  assert.equal(L.llmErrorCode("ollama not reachable at http://127.0.0.1:11499/v1 (is it running?)"), "unreachable");
  assert.equal(L.errorProvider("ollama not reachable at http://x (is it running?)"), "ollama");
  assert.equal(L.llmErrorCode("lmstudio did not answer within 600 s"), "timeout");
  assert.equal(L.llmErrorCode(`ollama answered HTTP 404: {"error":"model 'qwen3.5:9b' not found, try pulling it first"}`), "model_missing");
  assert.equal(L.missingModel(`model 'qwen3.5:9b' not found`), "qwen3.5:9b");
  assert.equal(L.llmErrorCode("openai answered HTTP 401: Incorrect API key provided"), "auth");
  assert.equal(L.llmErrorCode("Kein Modell eingestellt – wähle eines"), "no_model");
  assert.equal(L.llmErrorCode("Abgebrochen / cancelled by the person."), "cancelled");
  // K5: stop a running multiverse
  const { s: s2 } = project();
  const d2 = decision(s2);
  let release;
  const gate = new Promise((r) => (release = r));
  const hang = createServer(async (req, res) => {
    for await (const _ of req);
    await gate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "{}" } }] }));
  });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const app = createApp(s2, { approvalCode: "c", approvalSecret: "sess", autoForecast: false });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" };
  try {
    const run = fetch(`${base}/api/forecast`, { method: "POST", headers: H, body: JSON.stringify({ node: d2.id, llm: { provider: "fake", model: "m", baseUrl: `http://127.0.0.1:${hang.address().port}/v1` } }) });
    for (let i = 0; i < 50 && !(await (await fetch(`${base}/api/forecast/progress`)).json()).job; i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal((await fetch(`${base}/api/forecast/cancel`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: "{}" })).status, 403, "only the person stops");
    const c = await (await fetch(`${base}/api/forecast/cancel`, { method: "POST", headers: H, body: "{}" })).json();
    assert.equal(c.cancelled, true);
    const r = await run;
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /Abgebrochen/);
    assert.equal((await (await fetch(`${base}/api/forecast/progress`)).json()).job, null, "the lock is free again");
  } finally {
    release();
    app.close();
    server.close();
    hang.close();
  }
});
