// v0.4: one project tree with a main goal, decision context, chat capture,
// token-budgeted capsules, recall, analysis with any LLM, project rules, prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { TOOLS, callTool } from "../dist/tools.js";
import { recall } from "../dist/core/recall.js";
import { applyBlocks, extractBlocks } from "../dist/core/blocks.js";
import { metrics, parseInsights, runAnalysis, acceptRule, dossier } from "../dist/core/analysis.js";
import { agentPrompt, promptReminder } from "../dist/core/prompts.js";
import { tempProject } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cli = (dir, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const A = { agent: "test-agent", model: "llama3.3", source: "mcp" };

async function serve(s, opts = {}) {
  const app = createApp(s, opts);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => (app.close(), server.closeAllConnections?.(), server.close()) };
}

/** A long project: many tasks, each with decisions and checkpoints. */
function longProject(tasks = 25) {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Ship a reliable invoicing SaaS for freelancers", ...A });
  for (let i = 1; i <= tasks; i++) {
    s.startMission({ title: `Task ${i}: module ${i}`, goal: `Build module ${i} with tests`, ...A });
    s.decide({ question: `Storage for module ${i}?`, options: ["Postgres table", "JSON file"], chosen: "Postgres table", rationale: `module ${i} needs queries and joins`, context: `module ${i} stores invoices`, servesGoal: "reliability", confidence: 0.8, ...A });
    p.write(`src/m${i}.ts`, `export const m = ${i};`);
    s.checkpoint({ title: `Module ${i} done`, outputs: [`\`src/m${i}.ts\` created`, `tests for module ${i} pass`], facts: [`module ${i} uses table m${i}`], ...A });
  }
  return { p, s };
}

// ---------------------------------------------------------------- token economy
test("capsule stays within its token budget on a long project and points to recall", () => {
  const { s } = longProject(30);
  const small = s.context(undefined, { budget: 600 });
  assert.ok(small.tokens <= 760, `capsule ${small.tokens} tokens`);
  assert.ok(small.omitted > 0, "older parts were left out");
  assert.match(small.markdown, /Main goal: Ship a reliable invoicing SaaS/);
  assert.match(small.markdown, /Current task n\d+: Task 30/);
  assert.match(small.markdown, /scenaria_recall/);
  assert.match(small.markdown, /Task 29/, "the newest earlier task survives as a rollup");
  assert.doesNotMatch(small.markdown, /Task 1: module 1 \[/, "the oldest rollups are dropped first");
  const big = s.context(undefined, { budget: 6000 });
  assert.ok(big.tokens > small.tokens);
  assert.match(big.markdown, /Task 1: module 1/);
  // Rollups: one line per earlier task instead of every step.
  const lines = big.markdown.split("\n").filter((l) => /◉ Task \d+/.test(l));
  assert.equal(lines.length, 29);
  // The text tree folds finished tasks to one line each.
  const tree = s.treeText();
  assert.ok(tree.split("\n").length < 40, tree);
  assert.match(tree, /expand: scenaria tree n\d+/);
  assert.ok(s.treeText(undefined, { full: true }).split("\n").length > 80);
});

test("recall finds old details by keywords and marks other branches", () => {
  const { p, s } = longProject(6);
  const d = s.store.listNodes().find((n) => n.question === "Storage for module 3?");
  const hits = recall(s.store.listNodes(), s.conversations.allMessages(), "module 3 joins", { limit: 3, pathIds: new Set(s.path(s.head().id).map((n) => n.id)) });
  assert.equal(hits[0].id, d.id);
  assert.match(hits[0].snippet, /joins/);
  // A fork makes the original line "another branch".
  s.fork(d.id, "JSON file", { lesson: "try flat files" });
  p.write("flat.json", "{}");
  s.checkpoint({ title: "flat files tried", ...A });
  const later = s.store.listNodes().filter((n) => n.title === "Module 6 done")[0];
  const r = callTool(s, "scenaria_recall", { query: "Module 6 done" }, { source: "mcp" });
  assert.match(r.text, new RegExp(`${later.id} \\[checkpoint [^\\]]*\\] \\(other branch\\)`));
});

// ---------------------------------------------------------------- decision context & quality
test("decisions carry context: explicit fields, the triggering request, and quality hints", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.logMessages({ externalId: "chat", source: "api" }, [{ role: "user", text: "We need PDF export for invoices" }]);
  const t = callTool(s, "scenaria_start_mission", { title: "PDF export", goal: "Invoices as PDF" }, { source: "mcp" });
  assert.match(t.text, /main goal is not set/);
  const r = callTool(s, "scenaria_decide", { question: "PDF library?", options: ["pdfkit", "puppeteer"], chosen: "pdfkit", rationale: "no headless browser", context: "runs on small VMs", servesGoal: "keeps hosting cheap", expectedOutcome: "PDF in < 1 s" }, { source: "mcp" });
  const n = r.data;
  assert.deepEqual([n.context, n.servesGoal, n.expectedOutcome, n.trigger], ["runs on small VMs", "keeps hosting cheap", "PDF in < 1 s", "We need PDF export for invoices"]);
  assert.doesNotMatch(r.text, /quality: missing/);
  const v = s.verify(n.id);
  assert.equal(v.verification.checks.find((c) => c.name === "decision context").status, "passed");
  const weak = callTool(s, "scenaria_decide", { question: "Font?", options: ["Inter"], chosen: "Inter", rationale: "default" }, { source: "mcp" });
  assert.match(weak.text, /missing servesGoal, alternatives/);
  assert.throws(() => callTool(s, "scenaria_decide", { question: "X?", options: ["a", "b"], chosen: "a" }, { source: "mcp" }), /rationale is required/);
  // Teams that do not want the strict rule can switch it off.
  const cfg = s.config();
  cfg.requireRationale = false;
  s.store.writeConfig(cfg);
  assert.ok(callTool(s, "scenaria_decide", { question: "X?", options: ["a", "b"], chosen: "a" }, { source: "mcp" }).data.chosen);
});

// ---------------------------------------------------------------- chat capture
test("```scenaria blocks become decisions, tasks, checkpoints, lessons and the main goal — once", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const answer = `Here is my plan.

\`\`\`scenaria
[{"projectGoal": "A calm budgeting app"},
 {"task": {"title": "Onboarding flow", "goal": "3 screens"}},
 {"decision": {"question": "Navigation?", "options": ["Tabs", "Drawer"], "chosen": "Tabs", "rationale": "thumb reach", "context": "mobile first", "servesGoal": "calm, simple UI", "confidence": 0.7,}}]
\`\`\`
More text.
\`\`\`scenaria
{"checkpoint": {"title": "Screens drafted", "outputs": ["3 wireframes"]}}
\`\`\`
\`\`\`scenaria
{"lesson": "Ask for brand colours first"}
\`\`\``;
  const r = applyBlocks(s, answer, { agent: "chatgpt", model: "gpt-5", source: "api" }, { key: "chat:x", title: "Plan the app" });
  assert.deepEqual(r.errors, []);
  assert.equal(s.project().goal, "A calm budgeting app");
  const types = s.store.listNodes().map((n) => n.type);
  assert.deepEqual(types, ["mission", "goal", "decision", "checkpoint"]);
  const dec = s.store.listNodes().find((n) => n.type === "decision");
  assert.deepEqual([dec.rationale, dec.context, dec.servesGoal, dec.model], ["thumb reach", "mobile first", "calm, simple UI", "gpt-5"]);
  assert.match(s.head().lessons[0], /brand colours/);
  // The same answer again (resent history) changes nothing.
  const again = applyBlocks(s, answer, {});
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped, 5);
  assert.equal(extractBlocks("```scenaria\n{oops\n```").errors.length, 1);
});

test("proxy: a plain chat model that writes ```scenaria blocks gets its decisions recorded", async () => {
  const llm = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "llama3.3", choices: [{ message: { role: "assistant", content: 'Use SQLite.\n```scenaria\n{"decision": {"question": "DB?", "options": ["SQLite", "Postgres"], "chosen": "SQLite", "rationale": "single user"}}\n```' } }] }));
  });
  await new Promise((r) => llm.listen(0, "127.0.0.1", r));
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const cfg = s.config();
  cfg.proxy = { ...cfg.proxy, upstreams: { ...cfg.proxy.upstreams, ollama: `http://127.0.0.1:${llm.address().port}/v1` } };
  s.store.writeConfig(cfg);
  const { base, close } = await serve(s);
  try {
    const r = await fetch(`${base}/proxy/ollama/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "llama3.3", messages: [{ role: "user", content: "Which DB for my notes app?" }] }) });
    assert.equal(r.status, 200);
    await r.text();
    await new Promise((r) => setTimeout(r, 150));
    const nodes = s.store.listNodes();
    const task = nodes.find((n) => n.type === "goal");
    const dec = nodes.find((n) => n.type === "decision");
    assert.equal(task.title, "Which DB for my notes app?");
    assert.deepEqual([dec.parentId, dec.question, dec.rationale, dec.trigger], [task.id, "DB?", "single user", "Which DB for my notes app?"]);
  } finally {
    close();
    llm.close();
  }
});

test("hooks: Claude Code answers with ```scenaria blocks are captured at turn end", () => {
  const p = tempProject();
  cli(p.dir, ["init"]);
  const tr = join(p.dir, "t.jsonl");
  writeFileSync(tr, [JSON.stringify({ type: "user", message: { role: "user", content: "pick a test runner" } }), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: 'Vitest.\n```scenaria\n{"decision": {"question": "Test runner?", "options": ["Vitest", "Jest"], "chosen": "Vitest", "rationale": "faster with Vite"}}\n```' }] } })].join("\n"));
  const hook = (ev, extra) => cli(p.dir, ["hook", ev], JSON.stringify({ session_id: "S", cwd: p.dir, transcript_path: tr, ...extra }));
  hook("user-prompt", { prompt: "pick a test runner" });
  hook("stop", {});
  const s = Scenaria.open(p.dir);
  const dec = s.store.listNodes().find((n) => n.type === "decision");
  assert.equal(dec?.question, "Test runner?");
  assert.equal(s.node(dec.parentId).title, "pick a test runner");
});

// ---------------------------------------------------------------- analysis
test("health check finds a missing goal, undocumented decisions and work built on failures", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "API", ...A });
  s.decide({ question: "Auth?", options: ["JWT"], chosen: "JWT", ...A });
  p.write("a.ts", "1");
  const bad = s.checkpoint({ title: "auth done", ...A });
  s.verify(bad.id, { status: "failed", notes: "tokens never expire" });
  p.write("b.ts", "1");
  s.checkpoint({ title: "more work", ...A });
  const m = metrics(s.store.listNodes(), s.store.readState().head);
  const codes = m.issues.map((i) => i.code);
  for (const c of ["goal_missing", "no_rationale", "single_option", "built_on_failure"]) assert.ok(codes.includes(c), c);
  assert.ok(m.health < 60, `health ${m.health}`);
  assert.equal(m.byModel["llama3.3"].decisions, 1);
  assert.equal(m.decisions[0].outcome, "failed");
  const r = callTool(s, "scenaria_health", {}, { source: "mcp" });
  assert.match(r.text, /main goal MISSING/);
  assert.match(r.text, /\[high\]/);
  // Fixing the goal raises the score.
  s.setProjectGoal("Secure API");
  assert.ok(metrics(s.store.listNodes(), s.store.readState().head).health > m.health);
});

test("LLM analysis works with any provider (OpenAI-compatible and Anthropic); rules flow back into capsules and prompts", async () => {
  const seen = [];
  const reply = {
    summary: "Decisions follow the goal; storage choices repeat.",
    goalAlignment: { score: 82, notes: "aligned" },
    patterns: [{ title: "Postgres chosen every time", kind: "good", evidence: ["n3"] }],
    issues: [{ title: "No load tests", severity: "medium", evidence: ["n4"], fix: "add k6" }],
    rules: [{ text: "Add a load test before each release", why: "no perf data", evidence: ["n4"] }],
    tokenTips: ["Summaries per task are enough"],
  };
  const llm = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    seen.push({ url: req.url, auth: req.headers.authorization ?? req.headers["x-api-key"], body });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/chat") res.end(JSON.stringify({ model: body.model, message: { content: "<think>hm</think>```json\n" + JSON.stringify(reply) + "\n```" } }));
    else if (req.url.endsWith("/chat/completions")) res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "```json\n" + JSON.stringify(reply) + "\n```" } }] }));
    else res.end(JSON.stringify({ model: body.model, content: [{ type: "text", text: "Here:\n" + JSON.stringify(reply) }] }));
  });
  await new Promise((r) => llm.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${llm.address().port}`;
  try {
    const { s } = longProject(3);
    const rec = await runAnalysis(s, { provider: "ollama", model: "llama3.3", baseUrl: `${url}/v1`, lang: "de" });
    assert.equal(rec.parsed, true);
    assert.equal(rec.insights.goalAlignment.score, 82);
    assert.match(seen[0].body.messages[1].content, /MAIN GOAL: Ship a reliable invoicing SaaS/);
    assert.match(seen[0].body.messages[1].content, /D n\d+ task=n\d+ by=test-agent\/llama3\.3/);
    assert.match(seen[0].body.messages[0].content, /German/);
    // Anthropic: x-api-key from the request (never stored), /v1/messages
    const rec2 = await runAnalysis(s, { provider: "anthropic", model: "claude-sonnet-5-5", baseUrl: url, apiKey: "sk-test", lang: "en" });
    assert.equal(seen[1].url, "/v1/messages");
    assert.equal(seen[1].auth, "sk-test");
    assert.equal(rec2.insights.rules[0].text, "Add a load test before each release");
    assert.doesNotMatch(JSON.stringify(s.config()), /sk-test/, "keys are never written to config");
    // Missing key for a remote provider → clear error, no request.
    await assert.rejects(runAnalysis(s, { provider: "openai", model: "gpt-5", baseUrl: "https://api.example.com/v1", apiKeyEnv: "SCENARIA_TEST_NO_SUCH_KEY" }), /No API key/);
    // Accepting a recommendation makes it a project rule everywhere.
    const rule = acceptRule(s, rec.id, 0);
    assert.equal(rule.source, "analysis");
    assert.match(s.context().markdown, /Project rules \(always follow\)\n- r1: Add a load test/);
    assert.match(agentPrompt(s, { kind: "mcp", lang: "de" }), /Projektregeln[\s\S]*Add a load test/);
    assert.match(promptReminder(s), /Rules: Add a load test/);
    const d = dossier(s, { maxTokens: 1500 });
    assert.ok(d.tokens <= 1700);
  } finally {
    llm.close();
  }
});

test("parseInsights tolerates prose and fences, rejects non-JSON", () => {
  assert.equal(parseInsights('Sure!\n```json\n{"summary": "ok", "rules": ["be brief"]}\n```').insights.rules[0].text, "be brief");
  assert.equal(parseInsights('prefix {"summary": "x"} suffix').parsed, true);
  assert.equal(parseInsights("no json here").parsed, false);
});

// ---------------------------------------------------------------- prompts, API, CLI
test("ready-made prompts for MCP agents, shell agents and plain chats (DE/EN)", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Faster onboarding", title: "Signup", ...A });
  const mcp = agentPrompt(s, { kind: "mcp", lang: "de" });
  assert.match(mcp, /Hauptziel: Faster onboarding/);
  assert.match(mcp, /genau EINEN Projektbaum/);
  assert.match(mcp, /scenaria_decide/);
  assert.match(agentPrompt(s, { kind: "cli", lang: "en" }), /scenaria call scenaria_decide/);
  const chat = agentPrompt(s, { kind: "chat", lang: "en", withContext: true });
  assert.match(chat, /```scenaria\n\{"decision"/);
  assert.match(chat, /Scenaria capsule/);
  const { base, close } = await serve(s);
  try {
    const r = await (await fetch(`${base}/api/v1/prompt?kind=chat&lang=de`)).json();
    assert.match(r.text, /Halte jede echte Entscheidung/);
    assert.equal((await fetch(`${base}/api/v1/prompt?kind=nope`)).status, 400);
    // goal, rules and node updates need the X-Scenaria header (CSRF)
    assert.equal((await fetch(`${base}/api/goal`, { method: "POST", body: JSON.stringify({ goal: "x" }) })).status, 403);
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify(body) }).then((x) => x.json());
    assert.equal((await post("/api/goal", { goal: "Onboarding in 2 minutes" })).goal, "Onboarding in 2 minutes");
    // Project rules are the person's (S1): without the approval mode the API refuses; the person's rule shows up.
    assert.equal((await post("/api/rules", { text: "Measure before optimising" })).code, "approval_required");
    const rule = s.addRule("Measure before optimising", "manual", undefined, { by: "kev", via: "terminal" });
    assert.equal((await (await fetch(`${base}/api/rules`)).json())[0].id, rule.id);
    const task = s.store.listNodes().find((n) => n.type === "goal");
    assert.equal((await post("/api/node/update", { id: task.id, status: "done", summary: "signup works", agent: "x" })).status, "done");
    const ing = await post("/api/v1/ingest-text", { text: '```scenaria\n{"decision": {"question": "Q?", "options": ["a", "b"], "chosen": "a", "rationale": "r"}}\n```' });
    assert.equal(ing.created.length, 1);
    const m = await (await fetch(`${base}/api/analysis`)).json();
    assert.ok(typeof m.health === "number");
    const d = await (await fetch(`${base}/api/analysis/dossier?lang=en`)).json();
    assert.match(d.text, /--- DOSSIER ---/);
    const hits = await (await fetch(`${base}/api/v1/recall?q=signup`)).json();
    assert.ok(hits.length > 0);
  } finally {
    close();
  }
  assert.match(cli(p.dir, ["prompt", "--kind", "chat", "--lang", "en"]).stdout, /```scenaria/);
  assert.match(cli(p.dir, ["goal"]).stdout, /Onboarding in 2 minutes/);
  assert.match(cli(p.dir, ["analyze"]).stdout, /Health \d+\/100/);
  assert.match(cli(p.dir, ["recall", "signup"]).stdout, /signup/i);
  // Without a person's terminal (like here, or an agent's shell) adding a rule is refused (S1).
  assert.notEqual(cli(p.dir, ["rules", "add", "Keep PRs small"]).status, 0);
  assert.doesNotMatch(cli(p.dir, ["rules"]).stdout, /Keep PRs small/);
  assert.match(cli(p.dir, ["rules"]).stdout, /Measure before optimising/);
  const ingest = cli(p.dir, ["ingest-text"], '```scenaria\n{"checkpoint": {"title": "via stdin"}}\n```');
  assert.match(ingest.stdout, /1 node\(s\) recorded/);
});

test("tool registry: 17 tools incl. recall, health, workspace, expect; start_mission never creates a second root", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(names.length, 22);
  assert.ok(names.includes("scenaria_auditor_request") && names.includes("scenaria_auditor_submit"));
  assert.ok(names.includes("scenaria_recall") && names.includes("scenaria_health"));
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  for (const title of ["A", "B", "C"]) {
    callTool(s, "scenaria_start_mission", { title }, { source: "mcp" });
    p.write(`${title}.txt`, title);
    callTool(s, "scenaria_checkpoint", { title: `${title} done` }, { source: "mcp" });
  }
  const nodes = s.store.listNodes();
  assert.equal(nodes.filter((n) => !n.parentId).length, 1);
  assert.deepEqual(nodes.filter((n) => n.type === "goal").map((n) => n.status), ["done", "done", "active"]);
  assert.ok(nodes.every((n) => n.scenarioId === "s1"), "a straight project line is one scenario");
  assert.throws(() => callTool(s, "scenaria_start_mission", {}, { source: "mcp" }), /task title/);
});

// ---------------------------------------------------------------- review regressions (v0.4)
import { cpSync, mkdirSync, readFileSync, existsSync } from "node:fs";

function oldProject(extraNodes = []) {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const t = (m) => new Date(Date.UTC(2026, 9, 1, 10, 0, m)).toISOString();
  const nodes = [
    { id: "n1", type: "mission", missionId: "n1", parentId: null, title: "First", createdAt: t(0), source: "mcp" },
    { id: "n2", type: "checkpoint", missionId: "n1", parentId: "n1", title: "c", createdAt: t(1), source: "mcp" },
    { id: "n3", type: "mission", missionId: "n3", parentId: null, title: "Second", createdAt: t(2), source: "mcp" },
    { id: "n4", type: "checkpoint", missionId: "n3", parentId: "n3", title: "d", createdAt: t(3), source: "mcp" },
    ...extraNodes,
  ];
  for (const n of nodes) s.store.writeNode(n);
  writeFileSync(join(p.dir, ".scenaria/events.jsonl"), ["mission:n1", "checkpoint:n2", "mission:n3", "checkpoint:n4"].map((x, i) => JSON.stringify({ ts: t(i), type: x.split(":")[0], nodeId: x.split(":")[1] })).join("\n") + "\n");
  s.store.writeState({ head: "n4", activeMission: "n3", counter: 9, schema: 2, scenarioCounter: 2 });
  return p;
}

test("an interrupted migration is rolled back from its backup and redone", () => {
  const p = oldProject();
  // Simulate a crash in the middle: backup + marker written, some nodes already rewritten.
  const sc = join(p.dir, ".scenaria");
  mkdirSync(join(sc, "backups/schema2-crash"), { recursive: true });
  cpSync(join(sc, "nodes"), join(sc, "backups/schema2-crash/nodes"), { recursive: true });
  cpSync(join(sc, "state.json"), join(sc, "backups/schema2-crash/state.json"));
  const st = JSON.parse(readFileSync(join(sc, "state.json"), "utf8"));
  writeFileSync(join(sc, "state.json"), JSON.stringify({ ...st, migrating: "backups/schema2-crash" }));
  writeFileSync(join(sc, "nodes/n0.json"), JSON.stringify({ id: "n0", type: "mission", missionId: "n0", parentId: null, title: "half", createdAt: st.ts ?? new Date().toISOString(), source: "api" }));
  const n3 = JSON.parse(readFileSync(join(sc, "nodes/n3.json"), "utf8"));
  writeFileSync(join(sc, "nodes/n3.json"), JSON.stringify({ ...n3, type: "goal", parentId: "n0" }));

  const s = Scenaria.open(p.dir);
  const all = s.store.listNodes();
  const by = Object.fromEntries(all.map((n) => [n.id, n]));
  assert.equal(all.filter((n) => !n.parentId).length, 1, "one root after redo");
  assert.deepEqual([by.n1.type, by.n1.parentId, by.n3.type, by.n3.parentId], ["goal", "n0", "goal", "n2"]);
  assert.equal(s.store.readState().migrating, undefined);
  assert.equal(s.store.readState().schema, 3);
});

test("migration keeps orphans' types and is fast on large projects", () => {
  const t0 = Date.UTC(2026, 9, 1, 9);
  const many = [{ id: "n5", type: "decision", missionId: "n3", parentId: "n999", title: "orphan", question: "Q?", options: [{ id: "a", label: "A" }], createdAt: new Date(t0 + 4e6).toISOString(), source: "mcp" }];
  for (let i = 6; i < 1506; i++) many.push({ id: `n${i}`, type: "checkpoint", missionId: "n3", parentId: i === 6 ? "n4" : `n${i - 1}`, title: `step ${i}`, createdAt: new Date(t0 + 5e6 + i * 1000).toISOString(), source: "watch" });
  const p = oldProject(many);
  const start = Date.now();
  const s = Scenaria.open(p.dir);
  const ms = Date.now() - start;
  assert.ok(ms < 15_000, `migration took ${ms} ms`);
  assert.equal(s.node("n5").type, "decision", "an orphan is re-attached, not turned into a task");
  assert.equal(s.store.listNodes().filter((n) => !n.parentId).length, 1);
  assert.equal(s.node("n1505").scenarioId, "s1");
  assert.ok(existsSync(join(p.dir, ".scenaria/kb/n1505.md")));
});

test("node ids from APIs cannot escape the nodes folder", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.ensureBaseline();
  assert.throws(() => s.update("../state", { title: "x" }), /Invalid node id/);
  const { base, close } = await serve(s);
  try {
    const r = await fetch(`${base}/api/node/update`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ id: "../state", title: "x" }) });
    assert.equal(r.status, 400);
    assert.equal((await fetch(`${base}/api/graph`)).status, 200);
  } finally {
    close();
  }
});

test("lazy tasks: a second explicit task is not duplicated; rewind before a task starts a new one; parallel sessions do not ping-pong", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  // A session starts, the agent splits its work into two explicit tasks.
  s.noteTask("cc:S", "please do A and B");
  const a = s.startMission({ title: "Task A" });
  p.write("a", "1");
  s.checkpoint({ title: "A done", task: { key: "cc:S", title: "please do A and B" } });
  const b = s.startMission({ title: "Task B" });
  p.write("b", "1");
  s.checkpoint({ title: "B done", task: { key: "cc:S", title: "please do A and B" } });
  let goals = s.store.listNodes().filter((n) => n.type === "goal");
  assert.deepEqual(goals.map((g) => g.title), ["Task A", "Task B"]);
  assert.equal(s.node(b.id).status, "active");
  // Rewind to before both tasks: the session's next step is a new task there (new scenario).
  s.rewind("n0");
  p.write("c", "1");
  const c = s.checkpoint({ title: "C", task: { key: "cc:S", title: "please do A and B" } });
  const t3 = s.node(c.parentId);
  assert.deepEqual([t3.type, t3.parentId], ["goal", "n0"]);
  assert.notEqual(t3.scenarioId, "s1");
  assert.equal(s.currentTask().id, t3.id);
  // Two conversations alternating on one line: each gets one task, no duplicates.
  for (let i = 0; i < 3; i++) {
    for (const k of ["X", "Y"]) {
      p.write(`${k}${i}`, "1");
      s.checkpoint({ title: `${k}${i}`, task: { key: `proxy:${k}`, title: `conversation ${k}` } });
    }
  }
  goals = s.store.listNodes().filter((n) => n.type === "goal" && n.title.startsWith("conversation"));
  assert.equal(goals.length, 2);
  void a;
});

test("a task summary written on one branch never leaks into a capsule on another branch", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "T1" });
  const d = s.decide({ question: "Cache?", options: ["Redis", "None"], chosen: "Redis", rationale: "speed" });
  p.write("redis.ts", "1");
  s.checkpoint({ title: "Redis wired", taskDone: true, summary: "SECRET-BRANCH Redis cache wired" });
  s.startMission({ title: "T2" });
  p.write("t2", "1");
  s.checkpoint({ title: "t2" });
  assert.match(s.context().markdown, /SECRET-BRANCH/, "on its own path the summary is used");
  s.fork(d.id, "None", { lesson: "no cache needed" });
  p.write("plain.ts", "1");
  s.checkpoint({ title: "plain" });
  s.startMission({ title: "T3" });
  p.write("t3", "1");
  s.checkpoint({ title: "t3" });
  const ctx = s.context().markdown;
  assert.doesNotMatch(ctx, /SECRET-BRANCH/);
  assert.match(ctx, /T1 \[done\] — 1 decision\(s\): Cache\? → None/);
});
