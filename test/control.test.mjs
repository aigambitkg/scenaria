// v0.7: settings, built-in chat with tools, canon gate per line, relay (archivist → craftsman → oracle).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { chat } from "../dist/chat.js";
import { runRelay } from "../dist/core/relay.js";
import { runGate, gateMatrix } from "../dist/core/gate.js";
import { stringPayload } from "../dist/core/workspace.js";
import { resolveLlm } from "../dist/core/analysis.js";
import { readSettings, writeSettings } from "../dist/core/settings.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));

function project() {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Gamer app that brings players back daily", title: "Backend" });
  return { p, s };
}

/** A fake model server: answers with the scripted replies in order, records the requests. */
async function fakeLlm(replies, { anthropic = false } = {}) {
  const seen = [];
  let i = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const r = typeof replies === "function" ? replies(seen[seen.length - 1], i) : replies[Math.min(i, replies.length - 1)];
    i++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(r));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}${anthropic ? "" : "/v1"}`;
  return { base, seen, close: () => server.close() };
}

const oaText = (text) => ({ model: "fake-1", choices: [{ message: { role: "assistant", content: text } }] });
const oaTools = (calls, text = "") => ({ model: "fake-1", choices: [{ message: { role: "assistant", content: text, tool_calls: calls.map((c, k) => ({ id: `call_${k}_${c.name}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });

test("an env API key is only sent to the official endpoint or to endpoints the person trusts", () => {
  process.env.OPENAI_API_KEY = "sk-secret";
  try {
    const ups = { openai: "https://api.openai.com/v1" };
    assert.equal(resolveLlm({ provider: "openai", model: "m" }, ups).key, "sk-secret");
    // a request (or a project file) pointing the provider elsewhere does not get the key
    assert.throws(() => resolveLlm({ provider: "openai", model: "m", baseUrl: "https://evil.example/v1" }, ups), /only sent to the official openai endpoint/);
    assert.throws(() => resolveLlm({ provider: "openai", model: "m" }, { openai: "https://evil.example/v1" }), /only sent to the official/);
    // a key entered for this run is fine anywhere
    assert.equal(resolveLlm({ provider: "openai", model: "m", baseUrl: "https://evil.example/v1", apiKey: "own" }, ups).key, "own");
    // other secrets cannot be named as the key variable
    process.env.AWS_SECRET_ACCESS_KEY = "aws";
    assert.notEqual(resolveLlm({ provider: "openai", model: "m", apiKeyEnv: "AWS_SECRET_ACCESS_KEY" }, ups).key, "aws");
    // the person trusts an endpoint in Settings
    writeSettings({ trustedEndpoints: ["https://proxy.my-company.example/v1"] });
    assert.equal(resolveLlm({ provider: "openai", model: "m", baseUrl: "https://proxy.my-company.example/v1/" }, ups).key, "sk-secret");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    writeSettings({ trustedEndpoints: [] });
  }
});

test("chat (OpenAI-compatible): the model operates Scenaria with tools; rewind waits for the person", async () => {
  const { p, s } = project();
  p.write("a.txt", "1");
  const cp = s.checkpoint({ title: "first version" });
  p.write("a.txt", "2");
  s.checkpoint({ title: "second version" });
  const llm = await fakeLlm([
    oaTools([{ name: "scenaria_decide", args: { question: "Database?", options: ["Postgres", "SQLite"], chosen: "Postgres", rationale: "relational data", context: "multi-user" } }]),
    oaTools([{ name: "scenaria_rewind", args: { id: cp.id, lesson: "second version was wrong" } }], "I will go back."),
    oaText("Done — back at the first version."),
  ]);
  try {
    writeSettings({ llm: { default: { provider: "fake", model: "fake-1", baseUrl: llm.base } } });
    const r1 = await chat(s, { sessionId: "t1", messages: [{ role: "user", content: "Entscheide Postgres und spring dann zurück" }], lang: "de", user: "kev" });
    // tools were offered in OpenAI format; the decision exists; rewind is pending
    assert.ok(llm.seen[0].body.tools.some((t) => t.function.name === "scenaria_decide"));
    assert.ok(llm.seen[0].body.tools.some((t) => t.function.name === "scenaria_relay"));
    assert.match(llm.seen[0].body.messages[0].content, /Scenaria assistant/);
    const dec = s.store.listNodes().find((n) => n.type === "decision" && n.question === "Database?");
    assert.ok(dec);
    assert.equal(dec.agent, "scenaria-chat");
    assert.deepEqual(r1.pending.map((c) => c.name), ["scenaria_rewind"]);
    assert.equal(p.read("a.txt"), "2", "nothing rewound before the person confirms");
    // the person approves
    const r2 = await chat(s, { sessionId: "t1", messages: r1.messages, decisions: { [r1.pending[0].id]: "approve" }, lang: "de", user: "kev" });
    assert.equal(r2.pending.length, 0);
    assert.equal(p.read("a.txt"), "1");
    assert.equal(r2.messages[r2.messages.length - 1].content, "Done — back at the first version.");
    // the tool result went back to the model as a tool message
    const last = llm.seen[llm.seen.length - 1].body.messages;
    assert.ok(last.some((m) => m.role === "tool" && /Rewound to/.test(m.content)));
    // recorded as a conversation
    const conv = s.conversations.listSessions().find((c) => c.agent === "scenaria-chat");
    assert.ok(conv);
    assert.ok(s.conversations.messages(conv.id).length >= 3);
  } finally {
    llm.close();
    writeSettings({ llm: {} });
  }
});

test("chat: a declined action is not executed; the chat cannot approve canon", async () => {
  const { p, s } = project();
  p.write("a.txt", "1");
  const cp = s.checkpoint({ title: "v1" });
  p.write("a.txt", "2");
  s.checkpoint({ title: "v2" });
  const llm = await fakeLlm([oaTools([{ name: "scenaria_rewind", args: { id: cp.id } }]), oaTools([{ name: "scenaria_canon", args: { action: "propose", kind: "past", text: "Only Postgres" } }]), oaText("ok")]);
  try {
    const r1 = await chat(s, { sessionId: "t2", messages: [{ role: "user", content: "rewind" }], llm: { provider: "fake", model: "fake-1", baseUrl: llm.base } });
    const r2 = await chat(s, { sessionId: "t2", messages: r1.messages, decisions: { [r1.pending[0].id]: "deny" }, llm: { provider: "fake", model: "fake-1", baseUrl: llm.base } });
    assert.equal(p.read("a.txt"), "2");
    assert.ok(r2.messages.some((m) => m.role === "tool" && /declined/.test(m.content)));
    assert.equal(s.canon()[0].status, "proposed", "the chat model can only propose");
  } finally {
    llm.close();
  }
});

test("chat (Anthropic): tool_use / tool_result round trip", async () => {
  const { s } = project();
  const llm = await fakeLlm(
    [
      { model: "claude-x", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1", name: "scenaria_status", input: {} }] },
      { model: "claude-x", content: [{ type: "text", text: "All good." }] },
    ],
    { anthropic: true },
  );
  try {
    const r = await chat(s, { sessionId: "t3", messages: [{ role: "user", content: "status?" }], llm: { provider: "anthropic", model: "claude-x", baseUrl: llm.base, apiKey: "test-key" } });
    assert.equal(llm.seen[0].url, "/v1/messages");
    assert.equal(llm.seen[0].headers["x-api-key"], "test-key");
    assert.ok(llm.seen[0].body.tools.some((t) => t.name === "scenaria_status" && t.input_schema));
    const second = llm.seen[1].body.messages;
    assert.equal(second[1].role, "assistant");
    assert.equal(second[1].content[1].type, "tool_use");
    assert.equal(second[2].role, "user");
    assert.equal(second[2].content[0].type, "tool_result");
    assert.equal(second[2].content[0].tool_use_id, "toolu_1");
    assert.equal(r.messages[r.messages.length - 1].content, "All good.");
  } finally {
    llm.close();
  }
});

test("relay: three isolated roles, the orchestrator cuts what breaks hard canon, an open decision for the person", async () => {
  const { s } = project();
  s.addCanonAsUser({ kind: "past", text: "Data stays in the EU" }, { user: "kev", via: "cli" });
  s.addCanonAsUser({ kind: "future", text: "10k concurrent players by 2027-03-01", due: "2027-03-01" }, { user: "kev", via: "cli" });
  const llm = await fakeLlm((req) => {
    const sys = req.body.messages[0].content;
    if (/ARCHIVIST/.test(sys)) return oaText('{"constraints": [{"text": "EU only", "refs": ["k1"], "hard": true}], "history": []}');
    if (/CRAFTSMAN/.test(sys))
      return oaText('```json\n{"options": [{"label": "Supabase EU", "plan": "Use the EU region", "respects": ["k1"], "breaks": []}, {"label": "US cloud", "plan": "Cheaper US region", "respects": [], "breaks": ["k1"]}, {"label": "SQLite", "plan": "One file", "respects": ["k1"], "breaks": []}]}\n```');
    return oaText('{"assessments": [{"option": "Supabase EU", "survives": true, "failsOn": [], "risks": ["cost"], "confidence": 0.7}, {"option": "US cloud", "survives": false, "failsOn": ["k1"], "risks": []}, {"option": "SQLite", "survives": false, "failsOn": ["k2"], "risks": ["no concurrency"]}], "recommendation": {"option": "Supabase EU", "why": "EU and scales"}}');
  });
  try {
    const r = await runRelay(s, { question: "Which database for the backend?", createDecision: true, llm: { provider: "fake", model: "m", baseUrl: llm.base } });
    assert.equal(llm.seen.length, 3);
    // isolation: the oracle does not get the dossier, the archivist gets no options
    assert.doesNotMatch(llm.seen[2].body.messages[1].content, /--- DOSSIER ---/);
    assert.match(llm.seen[0].body.messages[1].content, /--- DOSSIER ---/);
    assert.deepEqual(r.surviving, ["Supabase EU"]);
    assert.equal(r.oracle.recommendation.option, "Supabase EU");
    const d = s.node(r.decisionId);
    assert.equal(d.type, "decision");
    assert.equal(d.chosen, undefined, "the person chooses");
    assert.equal(d.options.length, 3);
    assert.match(d.options[1].description, /cut by the orchestrator/);
    assert.ok(d.tags.includes("relay"));
  } finally {
    llm.close();
  }
});

test("canon gate: checks run on every line's snapshot; a line survives only where they pass", async () => {
  const { p, s } = project();
  p.write("a.txt", "x");
  const dec = s.decide({ question: "Speed?", options: ["fast", "safe"], chosen: "fast", rationale: "r" });
  p.write("GREEN", "");
  const fast = s.checkpoint({ title: "fast way" });
  s.fork(dec.id, "safe", {});
  p.write("b.txt", "y");
  const safe = s.checkpoint({ title: "safe way without GREEN" });
  s.addCanonAsUser({ kind: "future", text: "Suite green", check: "test -e GREEN" }, { user: "kev", via: "cli" });
  await runGate(s, { by: "kev" });
  const m = gateMatrix(s);
  const row = (id) => m.rows.find((r) => r.head === id);
  assert.equal(row(fast.id).verdict, "valid");
  assert.equal(row(safe.id).verdict, "invalid");
  assert.equal(stringPayload(s, fast.id).verdict, "valid");
  assert.equal(stringPayload(s, safe.id).verdict, "invalid");
  assert.ok(p.exists("b.txt") && !p.exists("GREEN"), "the working tree is untouched by the gate");
  // a forged result is ignored and reported
  const f = join(p.dir, ".scenaria/gate.json");
  const raw = JSON.parse(readFileSync(f, "utf8"));
  raw.results.find((r) => r.node === safe.id).status = "passed";
  writeFileSync(f, JSON.stringify(raw));
  assert.equal(stringPayload(s, safe.id).verdict, "unproven");
  assert.ok(gateMatrix(s).tampered.length > 0);
});

test("settings and chat are the person's: the API token / agents cannot change them", async () => {
  const { s } = project();
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, h = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: JSON.stringify(body) });
  try {
    for (const path of ["/api/settings", "/api/settings/models", "/api/agents/connect", "/api/chat", "/api/relay"]) {
      const r = await post(path, {});
      assert.equal(r.status, 403, path);
    }
    const g = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(g.approval, false);
    assert.ok(Array.isArray(g.agents) && g.agents.some((a) => a.target === "claude"));
    assert.match(g.snippets.mcpJson, /"scenaria"/);
    const ok = await post("/api/settings", { llm: { default: { provider: "ollama", model: "llama3.3" } }, chat: { confirmDestructive: true, maxSteps: 6 } }, { cookie: "scenaria_approval=sess" });
    assert.equal(ok.status, 200);
    assert.equal(readSettings(s).effective.chat.model, "llama3.3");
    assert.equal(readSettings(s).chat.maxSteps, 6);
    const con = await (await post("/api/agents/connect", { targets: ["cursor"] }, { cookie: "scenaria_approval=sess" })).json();
    assert.ok(con.agents.find((a) => a.target === "cursor").connected);
  } finally {
    app.close();
    server.close();
    writeSettings({ llm: {} });
  }
});
