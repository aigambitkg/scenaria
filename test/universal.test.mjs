// Vendor-neutral integration paths: schemas, HTTP v1 API, token mode, CLI call,
// multi-agent setup, watch mode, export and the Python client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenaria } from "../dist/core/index.js";
import { createApp, startServer } from "../dist/server.js";
import { TOOLS, callTool, toolSchemas } from "../dist/tools.js";
import { tempProject } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PY_CLIENT_DIR = fileURLToPath(new URL("../clients/python", import.meta.url));
const cli = (dir, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });

async function serve(s, opts = {}) {
  const app = createApp(s, opts);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => (app.close(), server.closeAllConnections?.(), server.close()) };
}

function deepFind(obj, pred, path = "") {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (pred(k, v)) return `${path}.${k}`;
      const r = deepFind(v, pred, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

test("function-calling schemas for every major LLM API", () => {
  const openai = toolSchemas("openai");
  assert.equal(openai.length, TOOLS.length);
  assert.ok(openai.every((t) => t.type === "function" && t.function.parameters.type === "object"));
  assert.ok(!JSON.stringify(openai).includes("$schema"));
  const anthropic = toolSchemas("anthropic");
  assert.ok(anthropic.every((t) => t.input_schema?.type === "object"));
  const responses = toolSchemas("openai-responses");
  assert.ok(responses.every((t) => t.type === "function" && t.name && t.parameters));
  const gemini = toolSchemas("gemini");
  assert.equal(deepFind(gemini, (k) => k === "anyOf" || k === "additionalProperties"), null);
  assert.equal(deepFind(gemini, (k, v) => k === "type" && Array.isArray(v)), null);
  assert.equal(gemini.find((t) => t.name === "scenaria_status").parameters, undefined);
});

test("callTool validates arguments with a readable error", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  assert.throws(() => callTool(s, "scenaria_decide", { question: "q" }, { source: "api" }), /Invalid arguments for scenaria_decide: options/);
  assert.throws(() => callTool(s, "nope", {}, { source: "api" }), /Unknown tool/);
  const r = callTool(s, "start_mission", { title: "short name works" }, { source: "api", agent: "x", model: "m1" });
  assert.equal(r.data.model, "m1");
});

test("CLI call works for shell agents and records agent/model attribution", () => {
  const p = tempProject();
  assert.equal(cli(p.dir, ["init"]).status, 0);
  const r1 = cli(p.dir, ["call", "scenaria_start_mission", '{"title":"Refactor","goal":"JWT"}', "--agent", "aider", "--model", "gpt-5", "--user", "kev"]);
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = cli(p.dir, ["call", "decide", '{"question":"Lib?","options":["jose",{"label":"jsonwebtoken"}],"chosen":2}', "--json"]);
  assert.equal(JSON.parse(r2.stdout).chosen, "b");
  const bad = cli(p.dir, ["call", "decide", "not json"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /JSON object/);
  const n1 = Scenaria.open(p.dir).node("n1");
  assert.deepEqual([n1.agent, n1.model, n1.user], ["aider", "gpt-5", "kev"]);
});

test("init --for all wires every agent idempotently and respects foreign config", () => {
  const p = tempProject();
  p.write(".codex/config.toml", 'model = "o4"\n');
  p.write(".cursor/mcp.json", JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  for (let i = 0; i < 2; i++) assert.equal(cli(p.dir, ["init", "--for", "all"]).status, 0);
  const cursor = JSON.parse(p.read(".cursor/mcp.json"));
  assert.ok(cursor.mcpServers.other && cursor.mcpServers.scenaria.env.SCENARIA_AGENT === "cursor");
  assert.equal(JSON.parse(p.read(".vscode/mcp.json")).servers.scenaria.env.SCENARIA_AGENT, "vscode-copilot");
  assert.equal(JSON.parse(p.read(".gemini/settings.json")).mcpServers.scenaria.env.SCENARIA_AGENT, "gemini-cli");
  const toml = p.read(".codex/config.toml");
  assert.ok(toml.startsWith('model = "o4"'));
  assert.equal(toml.match(/\[mcp_servers\.scenaria\]/g).length, 1);
  for (const f of ["AGENTS.md", "GEMINI.md", "CLAUDE.md"]) assert.equal(p.read(f).match(/scenaria:start/g).length, 1, f);
  assert.doesNotMatch(p.read("AGENTS.md"), /captured automatically/);
  assert.match(p.read("CLAUDE.md"), /captured automatically/);

  const q = tempProject();
  q.write(".codex/config.toml", '[mcp_servers.scenaria]\ncommand = "mine"\n');
  const r = cli(q.dir, ["init", "--for", "codex"]);
  assert.match(r.stdout, /left unchanged/);
  assert.equal(q.read(".codex/config.toml"), '[mcp_servers.scenaria]\ncommand = "mine"\n');
  assert.notEqual(cli(q.dir, ["init", "--for", "notepad"]).status, 0);
});

test("HTTP v1 API: schemas, tool calls, OpenAI-style string arguments, errors, export", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const { base, close } = await serve(s);
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/v1/health`)).json()).ok, true);
    const schemas = await (await fetch(`${base}/api/v1/tools?format=anthropic`)).json();
    assert.ok(schemas[0].input_schema);
    const r1 = await (await post("/api/v1/tools/scenaria_start_mission", { title: "n8n flow" }, { "x-scenaria-agent": "n8n", "x-scenaria-model": "mistral-large" })).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.data.agent, "n8n");
    assert.equal(r1.data.model, "mistral-large");
    const r2 = await (await post("/api/v1/tools/scenaria_decide", { arguments: JSON.stringify({ question: "Q", options: ["A", "B"], chosen: "B" }) })).json();
    assert.equal(r2.data.chosen, "b");
    const bad = await post("/api/v1/tools/scenaria_decide", { question: "Q" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /options/);
    const noHeader = await fetch(`${base}/api/v1/tools/scenaria_status`, { method: "POST", body: "{}" });
    assert.equal(noHeader.status, 403);
    const exp = await (await fetch(`${base}/api/v1/export`)).json();
    assert.equal(exp.format, "scenaria-export");
    assert.equal(exp.nodes.length, 2);
  } finally {
    close();
  }
});

test("team mode: token required (bearer or cookie), off-localhost needs a token", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const { base, close } = await serve(s, { token: "s3cret-token" });
  try {
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 401);
    const ok = await fetch(`${base}/api/v1/tools/scenaria_status`, { method: "POST", headers: { authorization: "Bearer s3cret-token" }, body: "{}" });
    assert.equal(ok.status, 200);
    const wrong = await fetch(`${base}/api/v1/health`, { headers: { authorization: "Bearer nope-nope-no" } });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${base}/?token=s3cret-token`, { redirect: "manual" });
    assert.equal(login.status, 302);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
    const viaCookie = await fetch(`${base}/api/graph`, { headers: { cookie } });
    assert.equal(viaCookie.status, 200);
    const cookieNoHeader = await fetch(`${base}/api/checkpoint`, { method: "POST", headers: { cookie }, body: "{}" });
    assert.equal(cookieNoHeader.status, 403, "cookie-auth POST still needs X-Scenaria (CSRF)");
  } finally {
    close();
  }
  await assert.rejects(startServer(s, { host: "0.0.0.0", port: 0 }), /requires a token/);
});

test("autoCheckpoint and watch mode capture work from agents without tools", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  assert.equal(s.autoCheckpoint(), null);
  p.write("notes.md", "draft");
  const n = s.autoCheckpoint({ agent: "chatgpt-desktop" });
  assert.match(n.title, /Auto-save: notes\.md/);
  assert.equal(n.agent, "chatgpt-desktop");
  assert.equal(n.source, "watch");

  const w = spawn(process.execPath, [CLI, "watch", "--interval", "1", "--quiet", "1", "--agent", "aider"], { cwd: p.dir });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    p.write("src/new.ts", "export {}");
    await new Promise((r) => setTimeout(r, 4500));
  } finally {
    w.kill();
  }
  const last = Scenaria.open(p.dir).head();
  assert.match(last.title, /src\/new\.ts/);
  assert.equal(last.agent, "aider");
});

test("export as JSON and Markdown via CLI", () => {
  const p = tempProject();
  cli(p.dir, ["init"]);
  cli(p.dir, ["mission", "Audit me"]);
  const j = JSON.parse(cli(p.dir, ["export"]).stdout);
  assert.equal(j.nodes[0].title, "Audit me");
  assert.match(cli(p.dir, ["export", "--format", "md"]).stdout, /# Scenaria protocol/);
  const out = join(p.dir, "audit.json");
  assert.equal(cli(p.dir, ["export", "--out-file", out]).status, 0);
  assert.ok(p.exists("audit.json"));
});

test("Python client (stdlib only) drives a full cycle against the HTTP API", { skip: spawnSync("python3", ["--version"]).status !== 0 && "python3 not available" }, async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const { base, close } = await serve(s);
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY_CLIENT_DIR)})
from scenaria_client import ScenariaClient, ScenariaError
sc = ScenariaClient(${JSON.stringify(base)}, agent="crewai", model="llama3.3")
assert sc.health()["ok"]
sc.start_mission("Python run", goal="Prove the client works")
d = sc.decide("Approach?", ["fast", {"label": "safe", "description": "with tests"}], chosen="safe", confidence=0.9)
assert d["chosen"] == "b", d
open(${JSON.stringify(join(p.dir, "out.txt"))}, "w").write("x")
c = sc.checkpoint("wrote out.txt", outputs=["\`out.txt\` written"])
assert c["changedFiles"] == ["+ out.txt"], c
txt = sc.run_tool_call("scenaria_verify", json.dumps({"id": c["id"]}))
assert "passed" in txt, txt
err = sc.run_tool_call("scenaria_decide", "{}")
assert err.startswith("ERROR"), err
assert len(sc.tool_schemas("openai")) == ${TOOLS.length}
r = sc.rewind(d["id"], lesson="test")
assert r["target"]["id"] == d["id"]
assert "Prove the client works" in sc.context()
print("PY-OK", sc.export()["nodes"][0]["model"])
`;
  try {
    const r = await new Promise((resolve) => {
      const child = spawn("python3", ["-c", script]);
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (errOut += d));
      child.on("close", (code) => resolve({ code, out, errOut }));
    });
    assert.equal(r.code, 0, r.errOut);
    assert.match(r.out, /PY-OK llama3\.3/);
    assert.equal(p.exists("out.txt"), false, "rewind removed the file");
  } finally {
    close();
  }
});

// ---------------------------------------------------------------- review-2 regressions
import { connect } from "node:net";
import { readdirSync } from "node:fs";

test("malformed cookie or URL never crashes the server", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  for (const token of ["s3cret-token", undefined]) {
    const { base, close } = await serve(s, token ? { token } : {});
    try {
      const r = await fetch(`${base}/api/v1/health`, { headers: { cookie: "scenaria_token=%E0%A4%A" } });
      assert.ok([200, 401].includes(r.status));
      const port = new URL(base).port;
      const raw = await new Promise((resolve) => {
        const sock = connect(Number(port), "127.0.0.1", () => sock.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
        let d = "";
        sock.on("data", (c) => (d += c));
        sock.on("close", () => resolve(d));
        sock.on("error", () => resolve(d));
        setTimeout(() => sock.destroy(), 500);
      });
      assert.ok(!raw || /^HTTP\/1\.1 4\d\d/.test(raw));
      assert.ok((await fetch(`${base}/api/v1/health`, token ? { headers: { authorization: `Bearer ${token}` } } : {})).ok, "still alive");
    } finally {
      close();
    }
  }
});

test("team cookie is SameSite=Lax and unknown schema formats are rejected", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const { base, close } = await serve(s, { token: "tok-tok-tok" });
  try {
    const login = await fetch(`${base}/?token=tok-tok-tok`, { redirect: "manual" });
    assert.match(login.headers.get("set-cookie"), /SameSite=Lax/);
    const bad = await fetch(`${base}/api/v1/tools?format=cobol`, { headers: { authorization: "Bearer tok-tok-tok" } });
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
  assert.throws(() => toolSchemas("cobol"), /Unknown format/);
});

test("setup: invalid JSON aborts before any write; commented JSONC is left untouched with a note", () => {
  const p = tempProject();
  p.write(".vscode/mcp.json", "{ broken");
  const r = cli(p.dir, ["init", "--for", "all"]);
  assert.notEqual(r.status, 0);
  assert.equal(p.exists(".mcp.json"), false, "nothing written");
  assert.equal(p.exists(".cursor/mcp.json"), false);

  const q = tempProject();
  const commented = '{\n  // my servers\n  "servers": { "x": { "command": "y" } },\n}\n';
  q.write(".vscode/mcp.json", commented);
  const r2 = cli(q.dir, ["init", "--for", "vscode,cursor"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(q.read(".vscode/mcp.json"), commented);
  assert.match(r2.stdout, /contains comments/);
  assert.ok(q.exists(".cursor/mcp.json"));
});

test("setup: codex duplicates are detected in every TOML form", async () => {
  const { codexDefinesScenaria } = await import("../dist/setup.js");
  assert.ok(codexDefinesScenaria('[mcp_servers]\nscenaria = { command = "mine" }\n'));
  assert.ok(codexDefinesScenaria('mcp_servers.scenaria.command = "mine"\n'));
  assert.ok(codexDefinesScenaria('[mcp_servers."scenaria"]\ncommand = "x"\n'));
  assert.ok(codexDefinesScenaria('[mcp_servers.scenaria.env]\nA = "1"\n'));
  assert.ok(!codexDefinesScenaria('[mcp_servers.other]\ncommand = "scenaria"\n[profiles]\nscenaria = 1\n'));
});

test("hook commands quote paths safely and are still recognised as ours", async () => {
  const { hookCommand } = await import("../dist/setup.js");
  const cmd = hookCommand("stop");
  if (process.platform !== "win32") assert.match(cmd, /^'.+' '.+cli\.js' hook stop$/);
  const p = tempProject();
  for (let i = 0; i < 2; i++) cli(p.dir, ["init", "--for", "claude"]);
  const stop = JSON.parse(p.read(".claude/settings.json")).hooks.Stop.flatMap((m) => m.hooks);
  assert.equal(stop.length, 1);
  // the quoted command actually runs through a shell
  const r = spawnSync("sh", ["-c", stop[0].command], { cwd: p.dir, input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("watch fingerprint writes no git objects while idle", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("big.txt", "x".repeat(200_000));
  const objects = () => readdirSync(join(p.dir, ".scenaria/shadow.git/objects")).length;
  const before = objects();
  const f1 = s.repo.fingerprint();
  p.write("big.txt", "y".repeat(200_000));
  const f2 = s.repo.fingerprint();
  assert.notEqual(f1, f2);
  assert.equal(objects(), before);
});

test("Python client run_tool_call never raises on bad model output", { skip: spawnSync("python3", ["--version"]).status !== 0 && "python3 not available" }, async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const { base, close } = await serve(s);
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(PY_CLIENT_DIR)})
from scenaria_client import ScenariaClient
sc = ScenariaClient(${JSON.stringify(base)})
for bad in ["null", "[1]", "{bad", '{"tool": 1}']:
    out = sc.run_tool_call("scenaria_status", bad)
    assert out.startswith("ERROR") or out.startswith("project:"), (bad, out)
dead = ScenariaClient("http://127.0.0.1:9", timeout=2)
assert dead.run_tool_call("scenaria_status", "{}").startswith("ERROR")
print("PY-ROBUST")
`;
  try {
    const r = await new Promise((resolve) => {
      const child = spawn("python3", ["-c", script]);
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (errOut += d));
      child.on("close", (code) => resolve({ code, out, errOut }));
    });
    assert.equal(r.code, 0, r.errOut);
    assert.match(r.out, /PY-ROBUST/);
  } finally {
    close();
  }
});
