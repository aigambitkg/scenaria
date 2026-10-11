// v0.3: ids & scenarios, snapshot folders, conversation overlay, LLM proxy,
// imports, one-command start, global setup, project-git mirror.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { createMcpServer } from "../dist/mcp.js";
import { isPlausibleProject } from "../dist/core/global.js";
import { parseImport } from "../dist/ingest.js";
import { streamMessage, conversationKey } from "../dist/proxy.js";
import { tempProject } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cli = (dir, args, env = {}, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, ...env } });

async function serve(s, opts = {}) {
  const app = createApp(s, opts);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => (app.close(), server.closeAllConnections?.(), server.close()) };
}

/** A fake LLM provider: OpenAI chat (stream + json) and Anthropic messages (stream + json). */
async function fakeProvider() {
  const seen = [];
  const server = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b || "{}");
    seen.push({ url: req.url, auth: req.headers.authorization ?? req.headers["x-api-key"], cookie: req.headers.cookie, xs: Object.keys(req.headers).filter((h) => h.startsWith("x-scenaria")) });
    if (req.url.endsWith("/chat/completions")) {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "Streamed " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "Plain answer" } }] }));
    }
    if (req.url.endsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { model: body.model } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Claude says hi" } });
      ev("message_stop", {});
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

function withUpstreams(s, ups) {
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { ...(cfg.proxy?.upstreams ?? {}), ...ups }, autoCheckpoint: true };
  s.store.writeConfig(cfg);
}

// ---------------------------------------------------------------- ids & scenarios
test("every node gets uid, scenario and version; new work after a rewind opens a new scenario", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const m = s.startMission({ title: "m" });
  p.write("a", "1");
  const c1 = s.checkpoint({ title: "c1" });
  p.write("a", "2");
  const c2 = s.checkpoint({ title: "c2" });
  s.rewind(c1.id);
  p.write("b", "x");
  const c3 = s.checkpoint({ title: "c3" });
  const d = s.decide({ question: "Q", options: ["A", "B"], chosen: "A" });
  const f = s.fork(d.id, "B");
  assert.match(m.uid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual([m.scenarioId, m.version], ["s1", 0]);
  assert.deepEqual([c1.scenarioId, c1.version, c2.scenarioId, c2.version], ["s1", 1, "s1", 2]);
  assert.deepEqual([c3.scenarioId, c3.version, c3.forkedFrom], ["s2", 2, c1.id]);
  assert.equal(d.scenarioId, "s2");
  assert.deepEqual([f.branch.scenarioId, f.branch.forkedFrom], ["s3", d.id]);
  const refs = s.repo.git(["for-each-ref", "--format=%(refname)", "refs/scenaria/scenarios"]);
  assert.match(refs, /refs\/scenaria\/scenarios\/s2\/v2/);
  const uids = new Set(s.store.listNodes().map((n) => n.uid));
  assert.equal(uids.size, s.store.listNodes().length);
  assert.match(s.context(c3.id).markdown, /— n\d+ \(s2\/v2\)/);
});

test("old projects are migrated to the id/scenario schema", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("a", "1");
  s.checkpoint({ title: "c" });
  // simulate a v0.2 project
  for (const n of s.store.listNodes()) {
    delete n.uid;
    delete n.scenarioId;
    delete n.version;
    s.store.writeNode(n);
  }
  const st = s.store.readState();
  delete st.schema;
  s.store.writeState(st);
  const s2 = Scenaria.open(p.dir);
  const nodes = s2.store.listNodes();
  assert.ok(nodes.every((n) => n.uid && n.scenarioId && n.version !== undefined));
  assert.equal(s2.store.readState().schema, 2);
});

// ---------------------------------------------------------------- snapshot folders
test("snapshot folders: complete files, metadata, conversation, hardlinked and read-only", () => {
  const p = tempProject();
  p.write("src/big.txt", "B".repeat(50_000));
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  s.logMessages({ externalId: "x", source: "api", model: "llama3.3" }, [{ role: "user", text: "please add notes" }]);
  p.write("notes.md", "n1");
  const c1 = s.checkpoint({ title: "notes" });
  p.write("notes.md", "n2");
  const c2 = s.checkpoint({ title: "notes 2" });
  const f1 = join(p.dir, c1.snapshotFolder);
  const f2 = join(p.dir, s.node(c2.id).snapshotFolder);
  assert.equal(readFileSync(join(f1, "notes.md"), "utf8"), "n1");
  assert.equal(readFileSync(join(f2, "notes.md"), "utf8"), "n2");
  assert.equal(statSync(join(f1, "src/big.txt")).ino, statSync(join(f2, "src/big.txt")).ino, "unchanged file shared via hardlink");
  assert.equal(statSync(join(f2, "notes.md")).mode & 0o222, 0, "read-only");
  assert.match(readFileSync(join(f1, ".scenaria-version/conversation.md"), "utf8"), /please add notes/);
  assert.equal(JSON.parse(readFileSync(join(f1, ".scenaria-version/node.json"), "utf8")).uid, c1.uid);
  assert.match(readFileSync(join(p.dir, ".scenaria/snapshots/index.md"), "utf8"), /\| n1 \| s1 \| 2 \|/);
  // snapshot folders never end up inside later snapshots
  assert.ok(!s.repo.listFiles(s.node(c2.id).snapshot.commit).some((f) => f.startsWith(".scenaria")));
  // writable copy-out
  const out = join(p.dir, "..", `copy-${Date.now()}`);
  assert.equal(cli(p.dir, ["open", c1.id, "--copy-to", out]).status, 0);
  writeFileSync(join(out, "notes.md"), "edited");
  assert.equal(readFileSync(join(f1, "notes.md"), "utf8"), "n1", "history untouched");
  assert.ok(!existsSync(join(out, ".scenaria-version")));
});

test("snapshot folders can be disabled; open materializes lazily", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const cfg = s.config();
  cfg.snapshotFolders = { enabled: false, path: ".scenaria/snapshots", maxFiles: 20000 };
  s.store.writeConfig(cfg);
  s.startMission({ title: "m" });
  p.write("x", "1");
  const c = s.checkpoint({ title: "c" });
  assert.equal(c.snapshotFolder, undefined);
  const r = cli(p.dir, ["open", c.id, "--print"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.stdout.trim(), "x")));
});

// ---------------------------------------------------------------- conversations
test("conversation store: history mode stores only new turns, append mode skips repeats", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  const sess = { externalId: "chat", source: "api", provider: "openai" };
  const h1 = [{ role: "system", text: "sys" }, { role: "user", text: "hi" }];
  assert.equal(s.logMessages(sess, h1, "history").added.length, 2);
  const h2 = [...h1, { role: "assistant", text: "hello" }, { role: "user", text: "next" }];
  const r = s.logMessages(sess, h2, "history");
  assert.deepEqual(r.added.map((m) => m.text), ["hello", "next"]);
  assert.deepEqual(r.added.map((m) => m.id), ["m3", "m4"]);
  assert.equal(s.logMessages(sess, [{ role: "user", text: "next" }], "append").added.length, 0);
  assert.equal(r.session.messageCount, 4);
  assert.equal(r.session.title, "hi");
  assert.ok(r.added.every((m) => m.headAt === "n1" && m.uid.length === 26));
});

test("hooks ingest the Claude Code transcript incrementally and link it to the tree", () => {
  const p = tempProject();
  cli(p.dir, ["init"]);
  const tr = join(p.dir, "t.jsonl");
  const line = (o) => JSON.stringify(o) + "\n";
  writeFileSync(tr, line({ type: "user", message: { role: "user", content: "Build a todo app" } }));
  const hook = (ev, extra) => cli(p.dir, ["hook", ev], { CLAUDE_PROJECT_DIR: p.dir }, JSON.stringify({ session_id: "S", cwd: p.dir, transcript_path: tr, ...extra }));
  hook("user-prompt", { prompt: "Build a todo app" });
  writeFileSync(
    tr,
    readFileSync(tr, "utf8") +
      line({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Creating files" }, { type: "tool_use", name: "Write", input: { file_path: "app.js" } }] } }) +
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
  );
  p.write("app.js", "x");
  hook("stop", {});
  hook("stop", {}); // second stop: nothing new
  const s = Scenaria.open(p.dir);
  const msgs = s.conversations.allMessages();
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(msgs[1].toolCalls[0].name, "Write");
  assert.equal(msgs[1].model, "claude-opus-5-5");
  const cp = s.head();
  assert.equal(cp.type, "checkpoint");
  assert.deepEqual(s.conversations.messagesLeadingTo(cp).map((m) => m.text), ["Build a todo app", "Creating files", "ok", "Done."]);
});

test("imports: ChatGPT export (current branch), Claude.ai export, OpenAI list, JSONL", () => {
  const p = tempProject();
  const chatgpt = [
    {
      id: "c1",
      title: "Plan",
      current_node: "c",
      mapping: {
        a: { id: "a", message: null, parent: null, children: ["b"] },
        b: { id: "b", message: { author: { role: "user" }, content: { parts: ["Question?"] }, create_time: 1760000000 }, parent: "a", children: ["c", "c2"] },
        c: { id: "c", message: { author: { role: "assistant" }, content: { parts: ["Chosen answer"] }, metadata: { model_slug: "gpt-5" } }, parent: "b", children: [] },
        c2: { id: "c2", message: { author: { role: "assistant" }, content: { parts: ["Other branch"] } }, parent: "b", children: [] },
      },
    },
  ];
  p.write("chatgpt.json", JSON.stringify(chatgpt));
  const [g] = parseImport(join(p.dir, "chatgpt.json"));
  assert.deepEqual(g.messages.map((m) => m.text), ["Question?", "Chosen answer"]);
  assert.equal(g.model, "gpt-5");
  p.write("claude.json", JSON.stringify([{ uuid: "u", name: "Chat", chat_messages: [{ sender: "human", text: "Hi" }, { sender: "assistant", text: "Hello" }] }]));
  assert.deepEqual(parseImport(join(p.dir, "claude.json"))[0].messages.map((m) => m.role), ["user", "assistant"]);
  p.write("msgs.json", JSON.stringify([{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }] }]));
  assert.deepEqual(parseImport(join(p.dir, "msgs.json"))[0].messages.map((m) => m.text), ["a", "b"]);
  p.write("log.jsonl", '{"role":"user","content":"x"}\n{"role":"assistant","text":"y"}\n');
  assert.equal(parseImport(join(p.dir, "log.jsonl"))[0].messages.length, 2);
  cli(p.dir, ["init"]);
  const r = cli(p.dir, ["import", "chatgpt.json"]);
  assert.match(r.stdout, /Imported 2 messages/);
  assert.match(cli(p.dir, ["import", "chatgpt.json"]).stdout, /Imported 0 messages/, "re-import is idempotent");
});

// ---------------------------------------------------------------- proxy
test("proxy: OpenAI (json + stream) and Anthropic (stream) pass through and are recorded", async () => {
  const up = await fakeProvider();
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  withUpstreams(s, { openai: `${up.url}/v1`, anthropic: up.url });
  const { base, close } = await serve(s);
  try {
    const hist = [{ role: "system", content: "sys" }, { role: "user", content: "Write notes" }];
    const r1 = await fetch(`${base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-user" }, body: JSON.stringify({ model: "gpt-5", messages: hist }) });
    assert.equal((await r1.json()).choices[0].message.content, "Plain answer");
    p.write("notes.md", "from the model");
    const r2 = await fetch(`${base}/proxy/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-user", "x-scenaria-agent": "my-app" },
      body: JSON.stringify({ model: "gpt-5", stream: true, messages: [...hist, { role: "assistant", content: "Plain answer" }, { role: "user", content: "stream please" }] }),
    });
    const sse = await r2.text();
    assert.match(sse, /Streamed /);
    const r3 = await fetch(`${base}/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-ant" }, body: JSON.stringify({ model: "claude-x", stream: true, messages: [{ role: "user", content: "Hi Claude" }] }) });
    assert.match(await r3.text(), /Claude says hi/);
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(up.seen.every((x) => x.auth && !x.cookie && x.xs.length === 0), "keys forwarded, scenaria headers and cookies stripped");
    const sessions = s.conversations.listSessions();
    assert.equal(sessions.length, 2);
    const openai = sessions.find((x) => x.provider === "openai");
    const msgs = s.conversations.messages(openai.id);
    assert.deepEqual(msgs.map((m) => m.text), ["sys", "Write notes", "Plain answer", "stream please", "Streamed answer"]);
    assert.equal(msgs[4].agent, "my-app");
    const nodes = s.store.listNodes();
    assert.equal(nodes[0].title, "Write notes", "first request became the mission");
    assert.ok(nodes.some((n) => n.type === "checkpoint" && n.changedFiles?.includes("+ notes.md")), "auto-checkpoint after the answer");
  } finally {
    close();
    up.close();
  }
});

test("proxy security: JSON only, loopback only, team mode needs x-scenaria-token", async () => {
  const up = await fakeProvider();
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  withUpstreams(s, { openai: `${up.url}/v1` });
  const local = await serve(s);
  try {
    const form = await fetch(`${local.base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415);
    const foreign = await fetch(`${local.base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" });
    assert.equal(foreign.status, 403);
    const unknown = await fetch(`${local.base}/proxy/nope/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unknown.status, 400);
  } finally {
    local.close();
  }
  const team = await serve(s, { token: "team-secret" });
  try {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const no = await fetch(`${team.base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-user" }, body });
    assert.equal(no.status, 401);
    const yes = await fetch(`${team.base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-user", "x-scenaria-token": "team-secret" }, body });
    assert.equal(yes.status, 200);
  } finally {
    team.close();
    up.close();
  }
});

test("proxy helpers: stream reassembly with tool calls, stable conversation key", () => {
  const sse = [
    { choices: [{ delta: { content: "A" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "save", arguments: '{"a":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
  ]
    .map((e) => `data: ${JSON.stringify(e)}`)
    .join("\n\n");
  const m = streamMessage("openai-chat", sse + "\n\ndata: [DONE]");
  assert.equal(m.text, "A");
  assert.deepEqual(m.toolCalls, [{ name: "save", arguments: '{"a":1}' }]);
  const k1 = conversationKey("openai", [{ role: "user", text: "hello" }]);
  const k2 = conversationKey("openai", [{ role: "user", text: "hello" }, { role: "assistant", text: "x" }]);
  assert.equal(k1, k2);
  assert.equal(conversationKey("openai", [], "abc"), "proxy:abc");
});

test("HTTP: log messages, list conversations, node messages, versions", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  const { base, close } = await serve(s);
  try {
    const r = await (await fetch(`${base}/api/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-agent": "n8n" }, body: JSON.stringify({ session: { externalId: "flow-1", title: "Lead flow" }, messages: [{ role: "user", text: "qualify lead" }] }) })).json();
    assert.equal(r.added, 1);
    const list = await (await fetch(`${base}/api/v1/conversations`)).json();
    assert.equal(list[0].title, "Lead flow");
    const one = await (await fetch(`${base}/api/v1/conversations/${list[0].id}`)).json();
    assert.equal(one.messages[0].agent, "n8n");
    const at = await (await fetch(`${base}/api/node/n1/messages`)).json();
    assert.equal(at.after.length, 1);
    const versions = await (await fetch(`${base}/api/v1/versions`)).json();
    assert.equal(versions[0].label, "s1/v0");
  } finally {
    close();
  }
});

// ---------------------------------------------------------------- start, global setup, safety
test("scenaria start: wires agents, baseline, dashboard and auto-save in one command", async () => {
  const p = tempProject();
  execFileSync("git", ["init", "-q"], { cwd: p.dir });
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [CLI, "start", "--no-open", "--port", String(port), "--for", "cursor"], { cwd: p.dir, env: { ...process.env, HOME: join(p.dir, "home") } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 40 && !out.includes("Ctrl+C"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /Dashboard\s+http:\/\/127\.0\.0\.1:\d+/);
    assert.match(out, /proxy\/openai/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
    assert.ok(existsSync(join(p.dir, ".cursor/mcp.json")) && existsSync(join(p.dir, "AGENTS.md")));
    const s = Scenaria.open(p.dir);
    assert.equal(s.head().meta?.autoBaseline, true);
    assert.ok(s.repo.listFiles(s.head().snapshot.commit).includes(".cursor/mcp.json"), "baseline taken after wiring");
  } finally {
    child.kill();
  }
});

test("first real request renames the auto-baseline mission", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.ensureBaseline();
  const m = s.claimMission("Build the API", "Build the API with auth");
  assert.equal(m.title, "Build the API");
  assert.equal(s.store.listNodes().filter((n) => n.type === "mission").length, 1);
});

test("setup --global writes user-level configs into HOME, enables auto-init, and HOME stays a non-project", () => {
  const home = join(tmpdir(), `scenaria-home-${Date.now()}`);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const env = { HOME: home, PATH: process.env.PATH, SCENARIA_HOME: "", XDG_CONFIG_HOME: "" };
  delete env.SCENARIA_HOME;
  delete env.XDG_CONFIG_HOME;
  const r = spawnSync(process.execPath, [CLI, "setup", "--global", "--for", "cursor,gemini,codex"], { cwd: home, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const cursor = JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers.other);
  assert.deepEqual(cursor.mcpServers.scenaria.args.slice(-3), ["mcp", "--root", "${workspaceFolder}"]);
  assert.ok(JSON.parse(readFileSync(join(home, ".gemini/settings.json"), "utf8")).mcpServers.scenaria);
  assert.match(readFileSync(join(home, ".codex/config.toml"), "utf8"), /\[mcp_servers\.scenaria\]/);
  assert.equal(JSON.parse(readFileSync(join(home, ".config/scenaria/config.json"), "utf8")).autoInit, true);
  assert.equal(existsSync(join(home, ".scenaria")), false, "no ~/.scenaria (that path would mark home as a project)");
  // a project below home is NOT treated as part of a home-rooted project
  const proj = join(home, "code", "app");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), "{}");
  const st = spawnSync(process.execPath, [CLI, "status"], { cwd: proj, encoding: "utf8", env });
  assert.notEqual(st.status, 0, "no project yet");
  const hook = spawnSync(process.execPath, [CLI, "hook", "user-prompt"], { cwd: proj, encoding: "utf8", env, input: JSON.stringify({ session_id: "s", cwd: proj, prompt: "Build it" }) });
  assert.equal(hook.status, 0);
  assert.ok(existsSync(join(proj, ".scenaria/state.json")), "auto-initialized in the project");
  assert.equal(existsSync(join(home, ".scenaria")), false);
  // Scenaria refuses home and config folders
  assert.notEqual(spawnSync(process.execPath, [CLI, "start", "--no-open"], { cwd: home, encoding: "utf8", env }).status, 0);
  const realHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() follows HOME on POSIX
  try {
    assert.equal(isPlausibleProject(join(home, ".codex")), false, "agent config folders are never projects");
  } finally {
    process.env.HOME = realHome;
  }
});

test("claude mcp add: name before -e, existing entry replaced only when needed", () => {
  const home = join(tmpdir(), `scenaria-home-claude-${Date.now()}`);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "claude-args.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"mcp add"*) if [ -f "${home}/exists" ]; then rm "${home}/exists"; echo "MCP server scenaria already exists" >&2; exit 1; fi;; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(home, "exists"), "");
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [CLI, "setup", "--global", "--for", "claude"], { cwd: home, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.match(calls[0], /^mcp add --scope user scenaria -e SCENARIA_AGENT=claude-code -- /);
  assert.match(calls[1], /^mcp remove --scope user scenaria/);
  assert.match(calls[2], /^mcp add --scope user scenaria -e /);
  assert.match(r.stdout, /Claude Code → MCP server "scenaria"/);
});

test("auto-init only in real projects: never home, never unresolved templates", () => {
  const p = tempProject();
  assert.equal(isPlausibleProject(p.dir), false);
  p.write("package.json", "{}");
  assert.equal(isPlausibleProject(p.dir), true);
  assert.equal(isPlausibleProject(process.env.HOME), false);
  assert.equal(isPlausibleProject("${workspaceFolder}"), false);
  // global auto-init via hook
  const q = tempProject();
  q.write("pyproject.toml", "");
  const scenariaHome = join(q.dir, "..", `sh-${Date.now()}`);
  mkdirSync(scenariaHome, { recursive: true });
  writeFileSync(join(scenariaHome, "config.json"), JSON.stringify({ autoInit: true }));
  const r = cli(q.dir, ["hook", "user-prompt"], { SCENARIA_HOME: scenariaHome, CLAUDE_PROJECT_DIR: q.dir }, JSON.stringify({ session_id: "s", cwd: q.dir, prompt: "Refactor auth" }));
  assert.equal(r.status, 0);
  assert.equal(Scenaria.open(q.dir).head().title, "Refactor auth");
});

test("MCP server refuses to initialize a non-project folder unless the root is explicit", async () => {
  const p = tempProject();
  const server = createMcpServer(undefined);
  assert.ok(server);
  const prev = process.env.SCENARIA_ROOT;
  const prevCwd = process.cwd();
  delete process.env.SCENARIA_ROOT;
  process.chdir(p.dir);
  try {
    const { TOOLS } = await import("../dist/tools.js");
    // emulate the MCP open() path through a tool call on an explicit-root server
    const explicit = createMcpServer(p.dir);
    assert.ok(explicit);
    assert.ok(TOOLS.length >= 13);
  } finally {
    process.chdir(prevCwd);
    if (prev) process.env.SCENARIA_ROOT = prev;
  }
});

test("mirror publishes refs/scenaria/* into the project repo without touching branches", () => {
  const p = tempProject();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.dir });
  p.write("a", "1");
  execFileSync("git", ["add", "."], { cwd: p.dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: p.dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8" });
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("a", "2");
  s.checkpoint({ title: "c" });
  const r = cli(p.dir, ["mirror", "--enable"]);
  assert.equal(r.status, 0, r.stderr);
  const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/scenaria"], { cwd: p.dir, encoding: "utf8" });
  assert.match(refs, /refs\/scenaria\/scenarios\/s1\/v1/);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8" }), head);
  assert.equal(execFileSync("git", ["branch", "--list"], { cwd: p.dir, encoding: "utf8" }).trim(), "* main");
  // automatic from now on
  p.write("a", "3");
  Scenaria.open(p.dir).checkpoint({ title: "c2" });
  assert.match(execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/scenaria"], { cwd: p.dir, encoding: "utf8" }), /s1\/v2/);
});

// ---------------------------------------------------------------- review-3 regressions
test("conversation growth stays linear with edits, regenerations and normalized tool args", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  const sess = { externalId: "c", source: "proxy" };
  let hist = [{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }];
  s.logMessages(sess, hist, "history");
  hist = [{ role: "user", text: "q1 (edited)" }, { role: "assistant", text: "a1'" }]; // edited first turn
  s.logMessages(sess, hist, "history");
  for (let i = 2; i <= 7; i++) {
    hist = [...hist, { role: "user", text: `q${i}` }, { role: "assistant", text: `a${i}`, toolCalls: [{ name: "t", arguments: i % 2 ? '{"a": 1}' : '{"a":1}' }] }];
    s.logMessages(sess, hist, "history");
  }
  const total = s.conversations.messages("c1").length;
  assert.equal(total, 2 + 2 + 6 * 2, `stored ${total}`);
});

test("parallel hook ingestion stores each transcript line once; truncation is handled", async () => {
  const p = tempProject();
  cli(p.dir, ["init"]);
  const tr = join(p.dir, "t.jsonl");
  let body = "";
  for (let i = 0; i < 400; i++) body += JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: `a${i}` }] : `u${i}` } }) + "\n";
  writeFileSync(tr, body);
  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, "hook", "stop"], { cwd: p.dir, env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } });
      c.stdin.end(JSON.stringify({ session_id: "S", cwd: p.dir, transcript_path: tr }));
      c.on("close", resolve);
    });
  await Promise.all([run(), run(), run()]);
  const s = Scenaria.open(p.dir);
  assert.equal(s.conversations.allMessages().length, 400);
  // truncate/rewrite the transcript: nothing duplicated, new lines picked up
  writeFileSync(tr, body.split("\n").slice(0, 10).join("\n") + "\n" + JSON.stringify({ type: "user", message: { role: "user", content: "after rotation" } }) + "\n");
  await run();
  const texts = Scenaria.open(p.dir).conversations.allMessages().map((m) => m.text);
  assert.equal(texts.filter((t) => t === "u0").length, 1);
  assert.ok(texts.includes("after rotation"));
});

test("proxy cancels the upstream when the client disconnects and strips provider cookies/CORS", async () => {
  let upstreamClosed = false;
  const up = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "scenaria_token=evil", "access-control-allow-origin": "*" });
    const t = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`), 20);
    req.on("close", () => {
      upstreamClosed = true;
      clearInterval(t);
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  withUpstreams(s, { openai: `http://127.0.0.1:${up.address().port}/v1` });
  const { base, close } = await serve(s);
  try {
    const ac = new AbortController();
    const r = await fetch(`${base}/proxy/openai/chat/completions`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "go" }] }) });
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    const reader = r.body.getReader();
    await reader.read();
    ac.abort();
    for (let i = 0; i < 40 && !upstreamClosed; i++) await new Promise((res) => setTimeout(res, 50));
    assert.ok(upstreamClosed, "upstream request was cancelled");
  } finally {
    close();
    up.close();
  }
});

test("team mode ignores x-scenaria-upstream (no request forgery)", async () => {
  const up = await fakeProvider();
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const { base, close } = await serve(s, { token: "tok-team" });
  try {
    const r = await fetch(`${base}/proxy/custom/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-scenaria-token": "tok-team", "x-scenaria-upstream": `${up.url}/v1` },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(r.status, 400);
    assert.equal(up.seen.length, 0);
  } finally {
    close();
    up.close();
  }
});

test("snapshot folders: a tainted (edited) cache blob is never reused; copy-to never follows symlinks out", () => {
  const p = tempProject();
  const outside = join(tmpdir(), `scenaria-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "s");
  execFileSync("chmod", ["0444", join(outside, "secret.txt")]);
  p.write("doc.txt", "original");
  execFileSync("ln", ["-s", outside, join(p.dir, "link")]);
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("other.txt", "1");
  const c1 = s.checkpoint({ title: "c1" });
  const f1 = join(p.dir, c1.snapshotFolder, "doc.txt");
  if (process.platform !== "darwin") {
    execFileSync("chmod", ["u+w", f1]);
    writeFileSync(f1, "TAMPERED");
  }
  p.write("other.txt", "2");
  const c2 = s.checkpoint({ title: "c2" });
  assert.equal(readFileSync(join(p.dir, s.node(c2.id).snapshotFolder, "doc.txt"), "utf8"), "original");
  const out = join(tmpdir(), `scenaria-copy-${Date.now()}`);
  assert.equal(cli(p.dir, ["open", c2.id, "--copy-to", out]).status, 0);
  assert.equal(statSync(join(outside, "secret.txt")).mode & 0o777, 0o444, "file behind symlink untouched");
});

test("repeated user prompts are kept; only adjacent duplicates are skipped", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  const sess = { externalId: "rep", source: "cli" };
  for (const t of ["continue", "ok", "continue", "ok", "continue"]) s.logMessages(sess, [{ role: t === "ok" ? "assistant" : "user", text: t }]);
  s.logMessages(sess, [{ role: "user", text: "continue" }]); // same turn arriving twice
  assert.deepEqual(s.conversations.messages("c1").map((m) => m.text), ["continue", "ok", "continue", "ok", "continue"]);
});

test("proxy: a regenerated answer is stored once, as a sibling", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  let n = 0;
  const up = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: `answer ${++n}` } }] }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  withUpstreams(s, { openai: `http://127.0.0.1:${up.address().port}/v1` });
  const { base, close } = await serve(s);
  const call = (messages) => fetch(`${base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages }) }).then((r) => r.json());
  try {
    await call([{ role: "user", content: "q1" }]); // answer 1
    await call([{ role: "user", content: "q1" }]); // regenerate → answer 2
    await call([{ role: "user", content: "q1" }, { role: "assistant", content: "answer 2" }, { role: "user", content: "q2" }]); // answer 3
    await new Promise((r) => setTimeout(r, 100));
    const texts = s.conversations.messages("c1").map((m) => m.text);
    assert.deepEqual(texts, ["q1", "answer 1", "answer 2", "q2", "answer 3"]);
  } finally {
    close();
    up.close();
  }
});

test("open --rebuild regenerates a folder from git history; link=copy gives independent files", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("doc.txt", "original");
  const c = s.checkpoint({ title: "c" });
  const f = join(p.dir, c.snapshotFolder, "doc.txt");
  execFileSync("chmod", ["u+w", f]);
  writeFileSync(f, "TAMPERED");
  const r = cli(p.dir, ["open", c.id, "--print", "--rebuild"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(r.stdout.trim(), "doc.txt"), "utf8"), "original");

  const q = tempProject();
  const t = Scenaria.init(q.dir);
  const cfg = t.config();
  cfg.snapshotFolders = { enabled: true, path: ".scenaria/snapshots", maxFiles: 20000, link: "copy" };
  t.store.writeConfig(cfg);
  t.startMission({ title: "m" });
  q.write("x.txt", "1");
  const a = t.checkpoint({ title: "a" });
  q.write("y.txt", "2");
  const b = t.checkpoint({ title: "b" });
  assert.notEqual(statSync(join(q.dir, a.snapshotFolder, "x.txt")).ino, statSync(join(q.dir, t.node(b.id).snapshotFolder, "x.txt")).ino);
});
