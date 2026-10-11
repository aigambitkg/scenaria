// Batch 3 (v0.8): the analyst — a fact-based expert report on a line, the project or all projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { chat } from "../dist/chat.js";
import { expertAnalysis, factSheet, listReports, adoptRecommendation, baselineReport } from "../dist/core/expert.js";
import { registerProject, listProjects } from "../dist/core/projects.js";
import { writeSettings } from "../dist/core/settings.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const ctx = { source: "mcp", agent: "claude-code" };

function project(name = "Gamer app") {
  const p = tempProject();
  const s = Scenaria.init(p.dir, { projectName: name });
  s.startMission({ projectGoal: "Gamer app that brings players back every day with daily quests", title: "Retention features", goal: "Daily quests and streaks" });
  p.write("a.txt", "1");
  s.checkpoint({ title: "Daily quest backend: quest table and streak counter" });
  const d = s.decide({ question: "Storage for streaks?", options: ["Redis", "Postgres"] });
  s.choose(d.id, "b"); // no rationale
  p.write("b.txt", "1");
  s.checkpoint({ title: "Streak counters in Postgres" });
  const d2 = s.decide({ question: "Reminder channel?", options: ["Push", "E-mail"] });
  s.choose(d2.id, "a", "players read push first");
  const d3 = s.decide({ question: "Leaderboard scope?", options: ["Friends", "Global"] });
  s.choose(d3.id, "a");
  return { p, s, d, d2, d3 };
}

async function fakeLlm(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b || "{}");
    seen.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "fake-analyst", choices: [{ message: { role: "assistant", content: handler(body) } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}

test("facts are deterministic and rule-based findings need no model", () => {
  const { s, d } = project();
  const f = factSheet(s);
  assert.equal(f.kpis.decisions, 3);
  assert.equal(f.kpis.rationaleRate, 33, "1 of 3 chosen decisions has a rationale");
  assert.equal(f.kpis.goalSet, 1);
  assert.ok(f.evidence.includes(d.id));
  assert.ok(f.lines.length >= 1 && f.lines[0].steps > 1);
  const r = baselineReport(s, { persist: false, lang: "en" });
  assert.equal(r.id, "x0");
  assert.equal(listReports(s).length, 0, "persist:false writes nothing");
  const rat = r.findings.find((x) => /rationale/i.test(x.title));
  assert.ok(rat, JSON.stringify(r.findings.map((x) => x.title)));
  assert.equal(rat.metric.value, 33);
  assert.ok(rat.verified && rat.source === "rule");
  assert.ok(r.recommendations.some((x) => x.priority === "P1"));
  assert.match(r.markdown, /# Expert analysis x0/);
  assert.match(r.markdown, /\| rationaleRate \| 33 \|/);
});

test("expert lenses: the model's findings are validated against the facts (evidence, exact KPI values)", async () => {
  const { s, d } = project();
  const llm = await fakeLlm(() =>
    JSON.stringify({
      summary: "Solid start, rationale discipline is weak.",
      maturity: { score: 52, level: "managed", reasoning: "goal set, few rationales" },
      findings: [
        { lens: "workflow", title: "Two of three decisions lack a rationale", severity: "high", evidence: [d.id, "n999"], metric: { name: "rationaleRate", value: 50 }, impact: "later agents lose the why" },
        { lens: "governance", title: "Generic advice", severity: "low", evidence: ["zz"], impact: "none" },
        { lens: "architecture", title: "Made-up KPI", severity: "medium", metric: { name: "magic", value: 3 }, impact: "x" },
      ],
      rootCauses: ["agent prompt does not ask for a rationale"],
      recommendations: [
        { title: "Enforce rationales", action: "Add 'rationale + goal link' to the agent prompt", lens: "workflow", priority: "P1", effort: "S", metric: "rationaleRate", expected: "≥ 90 %", evidence: [d.id] },
        { title: "Buy a tool", action: "something", lens: "goal", priority: "P9", effort: "XL", metric: "nonsense", evidence: [] },
      ],
      strengths: ["main goal is set"],
    }),
  );
  try {
    const r = await expertAnalysis(s, { lang: "en", llm: { provider: "fake", model: "m", baseUrl: llm.base } });
    assert.equal(llm.seen.length, 1);
    const user = llm.seen[0].messages[1].content;
    assert.match(user, /--- FACT SHEET ---/);
    assert.match(user, /"rationaleRate": 33/);
    assert.match(user, /--- DOSSIER ---/);
    assert.match(llm.seen[0].messages[0].content, /four expert lenses/);
    assert.match(llm.seen[0].messages[0].content, /ISO\/IEC 42001/);
    const f1 = r.findings.find((x) => x.title.startsWith("Two of three"));
    assert.deepEqual(f1.evidence, [d.id], "unknown ids are removed");
    assert.equal(f1.metric.value, 33, "wrong KPI values are corrected to the facts");
    assert.match(f1.note, /corrected/);
    assert.equal(f1.verified, true);
    const f2 = r.findings.find((x) => x.title === "Generic advice");
    assert.equal(f2.verified, false, "no valid evidence → unverified");
    const f3 = r.findings.find((x) => x.title === "Made-up KPI");
    assert.equal(f3.metric, undefined);
    assert.equal(f3.verified, false);
    assert.ok(r.validation.corrected >= 1 && r.validation.dropped >= 2 && r.validation.unverified >= 2, JSON.stringify(r.validation));
    const rec = r.recommendations.find((x) => x.title === "Buy a tool");
    assert.equal(rec.priority, "P2");
    assert.equal(rec.effort, "M");
    assert.equal(rec.metric, undefined);
    assert.equal(rec.verified, false);
    assert.equal(r.findings[0].verified, true, "verified findings first");
    assert.equal(r.maturity.score, 52);
    assert.equal(r.model, "fake-analyst");
    assert.equal(r.id, "x1");
    assert.ok(existsSync(join(s.store.dir, "reports", "x1.json")));
    // rule-based findings are kept alongside
    assert.ok(r.findings.some((x) => x.source === "rule"));
    // adopt a recommendation as a project rule
    const i = r.recommendations.findIndex((x) => x.title === "Enforce rationales");
    const rule = adoptRecommendation(s, r.id, i);
    assert.match(rule.text, /Enforce rationales/);
    assert.ok(s.rules().some((x) => x.id === rule.id));
    assert.deepEqual(listReports(s)[0].adopted, [i]);
  } finally {
    llm.close();
  }
});

test("scope: one line of work, and all registered projects", async () => {
  const { s, d } = project("Main");
  const other = project("Second");
  registerProject(s.root, "Main");
  registerProject(other.s.root, "Second");
  assert.ok(listProjects().some((p) => p.name === "Second"));
  // line: only nodes of that line count
  const line = await expertAnalysis(s, { scope: "line", head: d.id, noModel: true, lang: "de" });
  assert.equal(line.scope.kind, "line");
  assert.equal(line.facts[0].kpis.decisions, 1);
  assert.match(line.markdown, /Linie bis/);
  await assert.rejects(() => expertAnalysis(s, { scope: "line", head: "n999", noModel: true }));
  // all: several fact sheets, the model sees every project
  const llm = await fakeLlm(() => JSON.stringify({ summary: "two projects", findings: [{ lens: "goal", title: "Second lacks fixed points", severity: "medium", project: "Second", metric: { name: "canonActive", value: 0 } }], recommendations: [] }));
  try {
    const all = await expertAnalysis(s, { scope: "all", lang: "en", llm: { provider: "fake", model: "m", baseUrl: llm.base } });
    assert.equal(all.scope.kind, "all");
    assert.deepEqual(all.facts.map((f) => f.project).sort(), ["Main", "Second"]);
    assert.doesNotMatch(llm.seen[0].messages[1].content, /--- DOSSIER ---/, "no dossier of a single project for all projects");
    const f = all.findings.find((x) => x.project === "Second" && x.source === "expert");
    assert.ok(f.verified);
    assert.match(all.markdown, /\| KPI \| Main \| Second \|/);
  } finally {
    llm.close();
  }
});

test("dashboard: reading is open, running and adopting are the person's; agents read the report via MCP", async () => {
  const { s } = project();
  const app = createApp(s, { approvalCode: "c", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b, h = {}) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: JSON.stringify(b) });
  try {
    const g = await (await fetch(`${base}/api/expert`)).json();
    assert.equal(g.reports.length, 0);
    assert.equal(g.facts.kpis.decisions, 3);
    assert.equal((await post("/api/expert", { noModel: true })).status, 403, "an agent cannot run it");
    const r = await (await post("/api/expert", { noModel: true, lang: "en" }, { cookie: "scenaria_approval=sess" })).json();
    assert.equal(r.id, "x1");
    assert.equal((await post("/api/expert/adopt", { id: r.id, index: 0 })).status, 403, "an agent cannot adopt rules");
    const ok = await post("/api/expert/adopt", { id: r.id, index: 0 }, { cookie: "scenaria_approval=sess" });
    assert.equal(ok.status, 200);
    const rep = await (await fetch(`${base}/api/expert/report?id=${r.id}`)).json();
    assert.deepEqual(rep.adopted, [0]);
    assert.equal((await fetch(`${base}/api/expert/report?id=../x`)).status, 404);
    // agents read the latest report (read-only tool)
    const t = callTool(s, "scenaria_expert", {}, ctx);
    assert.match(t.text, /Report x1/);
    assert.match(t.text, /\(adopted as rule\)/);
  } finally {
    app.close();
    server.close();
  }
});

test("MCP tool gives a baseline without storing anything when no report exists", () => {
  const { s } = project();
  const t = callTool(s, "scenaria_expert", {}, ctx);
  assert.match(t.text, /Baseline \(rule-based, not stored\)/);
  assert.equal(listReports(s).length, 0);
});

test("chat: the expert analysis waits for the person's click", async () => {
  const { s } = project();
  writeSettings({ llm: {} });
  const tc = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    res.writeHead(200, { "content-type": "application/json" });
    const last = body.messages[body.messages.length - 1];
    if (last.role === "tool") return res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "Done." } }] }));
    res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "", tool_calls: [{ id: "x", type: "function", function: { name: "scenaria_expert_analysis", arguments: JSON.stringify({ noModel: true }) } }] } }] }));
  });
  await new Promise((r) => tc.listen(0, "127.0.0.1", r));
  const llm = { provider: "fake", model: "m", baseUrl: `http://127.0.0.1:${tc.address().port}/v1` };
  try {
    const first = await chat(s, { sessionId: "x", messages: [{ role: "user", content: "analyse my project" }], llm });
    assert.equal(first.pending?.length, 1, "waits for the person");
    assert.match(first.pending[0].summary ?? first.pending[0].describe ?? JSON.stringify(first.pending[0]), /rule-based|regelbasiert/);
    assert.equal(listReports(s).length, 0);
    const second = await chat(s, { sessionId: "x", messages: first.messages, decisions: { [first.pending[0].id]: "approve" }, llm });
    const tool = second.messages.find((m) => m.role === "tool");
    assert.match(tool.content, /Expert analysis x1/);
    assert.equal(listReports(s).length, 1);
  } finally {
    tc.close();
  }
});
