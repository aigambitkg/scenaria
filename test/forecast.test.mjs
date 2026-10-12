// Batch 1 (v0.8): forecasts — every decision predicted before a choice; multiverse of archivist/craftsman/oracle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { chat } from "../dist/chat.js";
import { forecast, quickDecision, quickPrompt, evaluateForecasts, listForecasts } from "../dist/core/forecast.js";
import { writeSettings } from "../dist/core/settings.js";
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
    seen.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    const text = handler(body, seen.length);
    res.end(JSON.stringify({ model: "fake-1", choices: [{ message: { role: "assistant", content: text } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}

const roles = (body) => body.messages[0].content;
const multiverseReplies = (body) => {
  const sys = roles(body);
  if (/ARCHIVIST of a multiverse/.test(sys)) return JSON.stringify({ options: [{ key: "a", past: "continues the quest backend (n3)", refs: ["n2"] }, { key: "b", past: "nothing in the history points to NFTs" }] });
  if (/CRAFTSMAN of a multiverse/.test(sys)) return JSON.stringify({ options: [{ key: "a", present: "extend quests", trajectory: ["quest UI", "streak reminder", "push"], loses: [] }, { key: "b", present: "new wallet integration", trajectory: ["wallet SDK", "smart contract"], loses: ["daily quest focus", "streak logic"] }] });
  return JSON.stringify({
    options: [
      { key: "a", outcome: "players return daily", ownAdjust: { delta: 10, why: "the reminder continues the streak counter of the daily quest backend", refs: ["n2"] }, ctxAdjust: { delta: 0 }, risks: [{ text: "notification fatigue", refs: [] }], canonRisks: [], confidence: 0.8 },
      { key: "b", outcome: "quests stall", ownAdjust: { delta: -10, why: "tokens on a blockchain are excluded", refs: ["k1", "n99"] }, ctxAdjust: { delta: 15, why: "trust me" }, risks: [{ text: "legal", refs: ["k1"] }], canonRisks: ["k1"], confidence: 0.7 },
    ],
    recommendation: { key: "a", why: "keeps the daily-quest line" },
  });
};

test("quick forecast: every option of a decision is predicted before a choice — no model needed", () => {
  const { s } = project();
  const d = s.decide({ question: "What next?", options: [{ label: "Streak reminder for daily quests", description: "push notification when a streak is about to reset" }, { label: "NFT marketplace", description: "sell skins as tokens on a blockchain" }] });
  const q = quickDecision(s, d.id);
  assert.equal(q.length, 2);
  assert.ok(q[0].score > q[1].score, `on-goal option should score higher: ${q[0].score} vs ${q[1].score}`);
  assert.ok(q[0].quick.goal > q[1].quick.goal);
  // the decide tool shows the forecast right away for open decisions
  const r = callTool(s, "scenaria_decide", { question: "Which reminder channel?", options: ["Push", "E-mail"] }, ctx);
  assert.match(r.text, /Forecast \(context kept, before choosing\): a \d+%/);
  // and agents can read it
  assert.match(callTool(s, "scenaria_forecast", { id: d.id }, ctx).text, /a Streak reminder.*context \d+%/);
});

test("quick forecast warns with earlier lessons and shows how an explored option really went", () => {
  const { p, s } = project();
  const d = s.decide({ question: "Storage for streaks?", options: [{ label: "Redis cache only", description: "keep streak counters in redis" }, { label: "Postgres table", description: "streak counters in the quest table" }] });
  s.choose(d.id, "a", "fast");
  p.write("b.txt", "1");
  s.checkpoint({ title: "Redis streak counters" });
  s.rewind(d.id, { lesson: "Redis cache only lost streak counters after a restart" });
  const q = quickDecision(s, d.id);
  assert.ok(q[0].quick.warnings.some((w) => /lost streak counters/.test(w)), JSON.stringify(q[0].quick.warnings));
  assert.ok(q[0].quick.explored, "the explored option shows its measured fidelity");
  // prompts too
  const good = quickPrompt(s, "Continue the daily quest backend from n3: add the streak reminder push for players");
  const bad = quickPrompt(s, "do it");
  assert.ok(good.score > bad.score);
});

test("multiverse: archivist (past), craftsman (present), oracle (future) — isolated context; the oracle only corrects the core, traceably", async () => {
  const { s } = project();
  s.addCanonAsUser({ kind: "past", text: "No blockchain or crypto features (legal)" }, { user: "kev", via: "cli" });
  const d = s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push before a streak resets" }, { label: "NFT skins", description: "sell skins as tokens" }] });
  const llm = await fakeLlm(multiverseReplies);
  try {
    const f = await forecast(s, { node: d.id, llm: { provider: "fake", model: "m", baseUrl: llm.base } });
    assert.equal(llm.seen.length, 3);
    const [arch, craft, oracle] = llm.seen.map((x) => x.body.messages[1].content);
    assert.match(arch, /--- PAST ---/, "the archivist reads the past");
    assert.doesNotMatch(arch, /CURRENT LINE|CORE/);
    assert.doesNotMatch(craft, /--- PAST ---/);
    assert.match(craft, /--- CURRENT LINE ---/, "the craftsman works on the current line");
    assert.doesNotMatch(oracle, /--- CURRENT LINE ---|--- PAST ---/, "the oracle sees goal, future, the core and the two findings");
    assert.match(oracle, /MAIN GOAL: Gamer app/);
    assert.match(oracle, /CORE \(word-based/);
    assert.equal(f.oracle, 2);
    const a = f.options.find((o) => o.key === "a");
    const b = f.options.find((o) => o.key === "b");
    assert.ok(a.universe && b.universe);
    assert.deepEqual(b.universe.loses, ["daily quest focus", "streak logic"]);
    // a: backed correction, applied = Δ·confidence·γ (γ = 1 without history)
    assert.equal(a.universe.own.backed, true);
    assert.equal(a.universe.own.applied, 8);
    assert.equal(a.universe.ownAfter, Math.min(100, a.quick.explain.own.score + 8));
    assert.equal(a.universe.core, a.quick.score);
    // the final number = the core formula with the corrected parts (traceable)
    const e = a.quick.explain;
    const P = Math.round(e.line + e.alpha * (a.universe.ownAfter - e.line) + e.beta * (a.universe.ctxAfter - e.line) - e.risk.lessons - e.risk.canon);
    assert.equal(a.score, Math.max(0, Math.min(100, P)));
    // b: an invented evidence id is dropped, a reason without evidence counts 0, a hard fixed point caps at 40
    assert.deepEqual(b.universe.own.refs, ["k1"]);
    assert.deepEqual(b.universe.own.dropped, ["n99"]);
    assert.equal(b.universe.ctx.backed, false);
    assert.equal(b.universe.ctx.applied, 0);
    assert.ok(b.score <= 40, `hard canon risk caps at 40: ${b.score}`);
    assert.deepEqual(b.universe.canonRisks, ["k1"]);
    assert.ok(f.warnings.some((w) => /ohne Grund oder gültige Belege/.test(w)), JSON.stringify(f.warnings));
    assert.equal(f.recommended.key, "a");
    assert.equal(s.node(d.id).chosen, undefined, "a forecast never chooses");
    assert.equal(listForecasts(s)[0].id, f.id);
  } finally {
    llm.close();
  }
});

test("multiverse for a prompt with variants: which wording keeps the context", async () => {
  const { s } = project();
  const llm = await fakeLlm((body) => {
    const sys = roles(body);
    if (/ARCHIVIST/.test(sys)) return JSON.stringify({ options: [{ key: "p", past: "-" }, { key: "v1", past: "-" }] });
    if (/CRAFTSMAN/.test(sys)) return JSON.stringify({ options: [{ key: "p", present: "agent guesses", trajectory: ["rewrite everything"], loses: ["streak logic"] }, { key: "v1", present: "agent continues n3", trajectory: ["add reminder"], loses: [] }] });
    return JSON.stringify({ options: [{ key: "p", outcome: "drifts", ownAdjust: { delta: -5, why: "make better is not tied to the daily quest backend", refs: ["n2"] }, confidence: 0.6 }, { key: "v1", outcome: "stays on track", ctxAdjust: { delta: 5, why: "continues the daily quest backend n3", refs: ["n2"] }, confidence: 0.7 }], recommendation: { key: "v1", why: "references the line" } });
  });
  try {
    const f = await forecast(s, { prompt: "make the app better", variants: ["Continue n3: add the streak reminder for daily quests"], llm: { provider: "fake", model: "m", baseUrl: llm.base } });
    assert.equal(f.subject.kind, "prompt");
    assert.deepEqual(f.options.map((o) => o.key), ["p", "v1"]);
    assert.ok(f.options[1].score > f.options[0].score);
    assert.equal(f.recommended.key, "v1");
  } finally {
    llm.close();
  }
});

test("evaluation: a forecast is checked against the branch that was really taken", async () => {
  const { p, s } = project();
  const d = s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push before a streak resets" }, { label: "NFT skins", description: "sell skins as tokens" }] });
  const f = await forecast(s, { node: d.id, quick: true });
  s.choose(d.id, "a", "keeps the quest line");
  p.write("c.txt", "1");
  s.checkpoint({ title: "Streak reminder push for daily quests", facts: ["Reminder 2h before the streak resets"] });
  // one step alone is too noisy to score a forecast (MIN_STEPS = 2)
  assert.equal(evaluateForecasts(s).forecasts.find((x) => x.id === f.id).actual, undefined);
  p.write("c2.txt", "1");
  s.checkpoint({ title: "Streak reminder opt-out for daily quests" });
  const ev = evaluateForecasts(s);
  const mine = ev.forecasts.find((x) => x.id === f.id);
  assert.ok(mine.actual?.length === 1, JSON.stringify(mine.actual));
  assert.equal(mine.actual[0].option, "a");
  assert.equal(typeof mine.actual[0].error, "number");
  assert.equal(ev.calibration.evaluated, 1);
});

test("open decisions get a multiverse forecast automatically while the dashboard runs (person's setting)", async () => {
  const { s } = project();
  const llm = await fakeLlm(multiverseReplies);
  writeSettings({ llm: { default: { provider: "fake", model: "m", baseUrl: llm.base } }, forecast: { auto: true } });
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push" }, { label: "NFT skins", description: "tokens" }] });
    for (let i = 0; i < 40 && !listForecasts(s).length; i++) await new Promise((r) => setTimeout(r, 200));
    const f = listForecasts(s)[0];
    assert.ok(f, "auto forecast created");
    assert.equal(f.trigger, "auto");
    assert.equal(f.subject.node, d.id);
    // reading is open, starting a forecast is the person's (uses their model)
    const g = await (await fetch(`${base}/api/forecasts`)).json();
    assert.equal(g.forecasts.length, 1);
    const q = await (await fetch(`${base}/api/forecast/quick?node=${d.id}`)).json();
    assert.equal(q.options.length, 2);
    const denied = await fetch(`${base}/api/forecast`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ node: d.id }) });
    assert.equal(denied.status, 403);
  } finally {
    app.close();
    server.close();
    llm.close();
    writeSettings({ llm: {}, forecast: { auto: true } });
  }
});

test("chat: the multiverse is a chat tool", async () => {
  const { s } = project();
  const d = s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push" }, { label: "NFT skins", description: "tokens" }] });
  let n = 0;
  const llm = await fakeLlm((body) => {
    if (body.tools) {
      n++;
      return n === 1 ? "" : "Option a keeps the context.";
    }
    return multiverseReplies(body);
  });
  // first chat turn: a tool call (OpenAI format needs tool_calls, so patch the reply via a second server)
  llm.close();
  const tc = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    res.writeHead(200, { "content-type": "application/json" });
    if (!body.tools) return res.end(JSON.stringify({ model: "m", choices: [{ message: { content: multiverseReplies(body) } }] }));
    const last = body.messages[body.messages.length - 1];
    if (last.role === "tool") return res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "Option a keeps the context." } }] }));
    const call = /AUDIT/.test(JSON.stringify(body.messages)) ? { name: "scenaria_audit_forecast", arguments: JSON.stringify({ id: "f1" }) } : { name: "scenaria_multiverse", arguments: JSON.stringify({ node: d.id }) };
    res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "", tool_calls: [{ id: "x", type: "function", function: call }] } }] }));
  });
  await new Promise((r) => tc.listen(0, "127.0.0.1", r));
  try {
    const r = await chat(s, { sessionId: "mv", messages: [{ role: "user", content: "forecast it" }], llm: { provider: "fake", model: "m", baseUrl: `http://127.0.0.1:${tc.address().port}/v1` } });
    const tool = r.messages.find((m) => m.role === "tool");
    assert.match(tool.content, /Forecast f1 \(multiverse\)/);
    assert.match(tool.content, /Recommended: a/);
    assert.match(tool.content, /core \d+% → with oracle \d+%/, "the corrections are visible to the chat model");
    assert.match(tool.content, /Prüf-Experte f1: /, "with the auditor's verdict");
    assert.equal(r.messages[r.messages.length - 1].content, "Option a keeps the context.");
    // the auditor is a chat tool too
    const r2 = await chat(s, { sessionId: "au", messages: [{ role: "user", content: "AUDIT f1" }], lang: "en", llm: { provider: "fake", model: "m", baseUrl: `http://127.0.0.1:${tc.address().port}/v1` } });
    const t2 = r2.messages.find((m) => m.role === "tool");
    assert.equal(t2.toolName, "scenaria_audit_forecast");
    assert.match(t2.content, /Auditor f1: (reliable|with caution|not reliable)/);
  } finally {
    tc.close();
  }
});

test("review fixes: automatic multiverse is opt-in, uses only the person's model, has a daily limit and skips abandoned lines", async () => {
  const { p, s } = project();
  const llm = await fakeLlm(multiverseReplies);
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess" });
  try {
    // 1. default: off — even with a model in the agent-writable project config
    const cfg = s.config();
    cfg.analysis = { provider: "fake", model: "m", baseUrl: llm.base };
    s.store.writeConfig(cfg);
    writeSettings({ llm: {} });
    s.decide({ question: "Next feature?", options: [{ label: "Streak reminder", description: "push" }, { label: "NFT skins", description: "tokens" }] });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(listForecasts(s).filter((f) => f.mode === "multiverse").length, 0, "no spending without the person's opt-in");
    // 2. opted in, but only the project file has a model → still nothing
    writeSettings({ forecast: { auto: true, dailyLimit: 1 } });
    s.checkpoint({ title: "tick" });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(llm.seen.length, 0, "never the project's model for automatic forecasts");
    // 3. the person's model + opt-in → exactly one (daily limit 1; the budget is one for all projects,
    //    so start today's count fresh — earlier tests in this file spent from it)
    (await import("node:fs")).rmSync(join(process.env.SCENARIA_HOME, "forecast-budget"), { recursive: true, force: true });
    writeSettings({ llm: { default: { provider: "fake", model: "m", baseUrl: llm.base } }, forecast: { auto: true, dailyLimit: 1 } });
    const d2 = s.decide({ question: "Reminder channel?", options: [{ label: "Push notification", description: "mobile push" }, { label: "E-mail digest", description: "daily mail" }] });
    for (let i = 0; i < 40 && !listForecasts(s).some((f) => f.mode === "multiverse"); i++) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 1500));
    const mv = listForecasts(s).filter((f) => f.mode === "multiverse");
    assert.equal(mv.length, 1, `daily limit 1: ${mv.map((f) => f.subject.node)}`);
    assert.ok(mv[0].verified);
    void d2;
  } finally {
    app.close();
    llm.close();
    writeSettings({ llm: {}, forecast: { auto: false, dailyLimit: 20 } });
  }
  // abandoned decisions (rewound away) are not candidates
  const { openWithoutForecast } = await import("../dist/core/forecast.js");
  const x = project();
  const dd = x.s.decide({ question: "Abandoned?", options: [{ label: "One way", description: "first" }, { label: "Other way", description: "second" }] });
  x.s.rewind("n1", {});
  assert.ok(!openWithoutForecast(x.s).includes(dd.id));
});

test("review fixes: forged forecast files are unverified and never count; prompts are evaluated after use", async () => {
  const { p, s } = project();
  const d = s.decide({ question: "Next?", options: [{ label: "Streak reminder", description: "push" }, { label: "NFT skins", description: "tokens" }] });
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(p.dir, ".scenaria/forecasts"), { recursive: true });
  writeFileSync(join(p.dir, ".scenaria/forecasts/f9.json"), JSON.stringify({ id: "f9", subject: { kind: "decision", node: d.id, question: "Next?" }, createdAt: new Date().toISOString(), mode: "multiverse", trigger: "person", models: {}, options: [], recommended: { key: "b", why: "trust me" }, warnings: [] }));
  const forged = listForecasts(s).find((f) => f.id === "f9");
  assert.equal(forged.verified, false);
  const { openWithoutForecast } = await import("../dist/core/forecast.js");
  assert.ok(openWithoutForecast(s).includes(d.id), "a forged file does not suppress the real forecast");
  assert.doesNotMatch(callTool(s, "scenaria_forecast", { id: d.id }, ctx).text, /trust me/);
  // prompt forecast: evaluated against the line after it, for the variant the person used
  const f = await forecast(s, { prompt: "Continue n2: the streak reminder push for daily quests", variants: ["do stuff"], quick: true });
  const { markUsed } = await import("../dist/core/forecast.js");
  markUsed(s, f.id, "p");
  s.choose(d.id, "a", "keeps the line");
  p.write("z.txt", "1");
  s.checkpoint({ title: "Streak reminder push for daily quests done" });
  p.write("z2.txt", "1");
  s.checkpoint({ title: "Streak reminder metrics for daily quests" });
  const ev = evaluateForecasts(s).forecasts.find((x) => x.id === f.id);
  assert.ok(ev.verified);
  assert.ok(ev.actualLine?.nodes >= 1, JSON.stringify(ev));
  assert.equal(ev.actual?.[0].option, "p");
});

test("review fixes: low-signal options are flagged; fixed points at stake are shown; session keys stay with their provider", async () => {
  const { s } = project();
  s.addCanonAsUser({ kind: "future", text: "Quest launch in November", due: "2026-11-30" }, { user: "kev", via: "cli" });
  const d = s.decide({ question: "Move the quest launch?", options: ["Ja", "Nein"] });
  const q = quickDecision(s, d.id);
  assert.ok(q.every((o) => o.quick.signal === "low"));
  const { quickSummary } = await import("../dist/core/forecast.js");
  assert.match(quickSummary(q, "de"), /nicht unterscheidbar ohne Modell/);
  const d2 = s.decide({ question: "Plan?", options: [{ label: "Postpone the quest launch to February", description: "more time" }, { label: "Finish the quest launch in November", description: "on time" }] });
  const q2 = quickDecision(s, d2.id);
  assert.ok(q2.some((o) => o.quick.canonHints.some((h) => /k1 \(hard, future, by 2026-11-30\)/.test(h))), JSON.stringify(q2.map((o) => o.quick.canonHints)));
  const { effectiveLlm } = await import("../dist/core/settings.js");
  writeSettings({ llm: { default: { provider: "openai", model: "gpt" }, roles: { oracle: { provider: "anthropic", model: "claude" } } } });
  try {
    assert.equal(effectiveLlm(s, "oracle", { apiKey: "sk-openai", keyFor: "openai" }).apiKey, undefined, "an OpenAI session key never goes to the Anthropic oracle");
    assert.equal(effectiveLlm(s, "archivist", { apiKey: "sk-openai", keyFor: "openai" }).apiKey, "sk-openai");
  } finally {
    writeSettings({ llm: {} });
  }
});

test("review fixes 2: malformed forecast files are skipped; fakes do not use up the daily budget; relay craftsman sees no future canon", async () => {
  const { p, s } = project();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(p.dir, ".scenaria/forecasts"), { recursive: true });
  writeFileSync(join(p.dir, ".scenaria/forecasts/f1.json"), "{}");
  writeFileSync(join(p.dir, ".scenaria/forecasts/f2.json"), JSON.stringify({ id: "f2", options: "x" }));
  for (let i = 3; i < 30; i++) writeFileSync(join(p.dir, `.scenaria/forecasts/f${i}.json`), JSON.stringify({ id: `f${i}`, subject: { kind: "decision", node: "n9", question: "?" }, createdAt: new Date().toISOString(), mode: "multiverse", trigger: "auto", models: {}, options: [], warnings: [] }));
  assert.equal(listForecasts(s).filter((f) => f.verified).length, 0);
  const r = callTool(s, "scenaria_decide", { question: "Which channel?", options: ["Push notification for streaks", "E-mail digest for quests"] }, ctx);
  assert.match(r.text, /Forecast \(context kept/, "decide still forecasts with junk in the folder");
  assert.ok(listForecasts(s).some((f) => f.verified && f.mode === "quick"));
  // relay: the craftsman gets past canon only
  s.addCanonAsUser({ kind: "future", text: "10k players by 2027-01-01", due: "2027-01-01" }, { user: "kev", via: "cli" });
  const llm = await fakeLlm((body) => {
    const sys = roles(body);
    if (/ARCHIVIST/.test(sys)) return '{"constraints": []}';
    if (/CRAFTSMAN/.test(sys)) return '{"options": [{"label": "A", "plan": "p"}]}';
    return '{"assessments": [{"option": "A", "survives": true, "failsOn": []}]}';
  });
  try {
    const { runRelay } = await import("../dist/core/relay.js");
    await runRelay(s, { question: "What to build next?", llm: { provider: "fake", model: "m", baseUrl: llm.base } });
    const craft = llm.seen.find((x) => /CRAFTSMAN/.test(roles(x.body))).body.messages[1].content;
    assert.doesNotMatch(craft, /10k players/);
  } finally {
    llm.close();
  }
});
