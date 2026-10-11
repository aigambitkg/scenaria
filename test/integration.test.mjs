import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Scenaria } from "../dist/core/index.js";
import { classifyCommand, extractAnswers, summaryToBullets } from "../dist/hooks.js";
import { createApp } from "../dist/server.js";
import { createServer } from "node:http";
import { tempProject } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function cli(dir, args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
}

test("init --claude wires MCP, hooks, permissions, verifier and CLAUDE.md idempotently", () => {
  const p = tempProject();
  p.write("CLAUDE.md", "# My rules\n");
  p.write(".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
  assert.equal(cli(p.dir, ["init", "--claude"]).status, 0);
  assert.equal(cli(p.dir, ["init", "--claude"]).status, 0); // twice → no duplicates
  const mcp = JSON.parse(p.read(".mcp.json"));
  assert.deepEqual(mcp.mcpServers.scenaria.args.slice(-1), ["mcp"]);
  const settings = JSON.parse(p.read(".claude/settings.json"));
  const stopCmds = settings.hooks.Stop.flatMap((m) => m.hooks.map((h) => h.command));
  assert.equal(stopCmds.filter((c) => c === "echo mine").length, 1, "user hook kept");
  assert.equal(stopCmds.filter((c) => c.includes("hook stop")).length, 1, "our hook once");
  assert.ok(settings.permissions.allow.includes("mcp__scenaria__scenaria_checkpoint"));
  assert.ok(!settings.permissions.allow.includes("mcp__scenaria__scenaria_rewind"), "rewind still asks");
  assert.ok(p.exists(".claude/agents/scenaria-verifier.md"));
  const md = p.read("CLAUDE.md");
  assert.ok(md.startsWith("# My rules"));
  assert.equal(md.match(/scenaria:start/g).length, 1);
});

test("hooks capture prompt, clarifying question, risky command and turn end", () => {
  const p = tempProject();
  cli(p.dir, ["init"]);
  const hook = (event, payload) => {
    const r = cli(p.dir, ["hook", event], JSON.stringify({ session_id: "s1", cwd: p.dir, ...payload }));
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const reminder = JSON.parse(hook("user-prompt", { prompt: "Build a todo app with React" }));
  assert.equal(reminder.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(reminder.hookSpecificOutput.additionalContext, /ONE project tree/);
  hook("post-tool", {
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Storage?", header: "Storage", multiSelect: false, options: [{ label: "localStorage" }, { label: "SQLite" }] }] },
    tool_response: { answers: { "Storage?": "SQLite" } },
  });
  hook("pre-tool", { tool_name: "Bash", tool_input: { command: "git push origin main" } });
  const transcript = join(p.dir, "transcript.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "x" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done:\n- created `App.tsx`\n- added SQLite schema" }] } }),
    ].join("\n"),
  );
  p.write("App.tsx", "export {}");
  hook("stop", { transcript_path: transcript });
  const out = hook("session-start", { source: "resume", session_id: "s2" });

  const s = Scenaria.open(p.dir);
  const nodes = s.store.listNodes();
  // One project tree: n0 project root → n1 the session's task → decision → checkpoint.
  assert.deepEqual(nodes.map((n) => n.type), ["mission", "goal", "decision", "checkpoint"]);
  assert.equal(nodes[0].id, "n0");
  assert.equal(nodes[1].goal, "Build a todo app with React");
  assert.deepEqual(nodes.map((n) => n.parentId), [null, "n0", "n1", "n2"]);
  assert.ok(nodes.every((n) => n.scenarioId === "s1"), "a straight line stays one scenario");
  assert.equal(nodes[2].options[nodes[2].options.findIndex((o) => o.id === nodes[2].chosen)].label, "SQLite");
  assert.match(nodes[2].context, /Clarifying question/);
  assert.equal(nodes[2].trigger, "Build a todo app with React");
  assert.deepEqual(nodes[3].irreversible, ["git push origin main"]);
  assert.deepEqual(nodes[3].outputs, ["created `App.tsx`", "added SQLite schema"]);
  assert.ok(nodes[3].meta.transcriptTokens > 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /SQLite/);
  assert.equal(p.exists(".scenaria/hook-errors.log"), false);
});

test("hooks stay silent outside initialized projects and on bad input", () => {
  const p = tempProject();
  const r = cli(p.dir, ["hook", "stop"], "not json");
  assert.equal(r.status, 0);
  assert.equal(p.exists(".scenaria"), false);
});

test("hook helpers", () => {
  assert.equal(classifyCommand("git push --force"), "external");
  assert.equal(classifyCommand("rm -rf dist"), "destructive");
  assert.equal(classifyCommand("git reset --hard HEAD~1"), "destructive");
  assert.equal(classifyCommand("curl -X POST https://x"), "external");
  assert.equal(classifyCommand("ls -la"), null);
  assert.equal(classifyCommand("npm test"), null);
  assert.deepEqual(extractAnswers({}, 'User has answered your questions: "Which DB?"="Postgres".'), { "Which DB?": "Postgres" });
  assert.deepEqual(summaryToBullets("Summary:\n- one\n- two"), ["one", "two"]);
});

test("MCP server exposes tools and runs a full decision cycle", async () => {
  const p = tempProject();
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: p.dir, env: { ...process.env, SCENARIA_ROOT: p.dir } }));
  try {
    const { tools } = await client.listTools();
    for (const name of ["scenaria_decide", "scenaria_checkpoint", "scenaria_rewind", "scenaria_fork", "scenaria_verify", "scenaria_context"]) {
      assert.ok(tools.some((t) => t.name === name), name);
    }
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError };
    };
    const started = await call("scenaria_start_mission", { title: "API", goal: "Todo REST API" });
    assert.match(started.text, /main goal is not set/);
    const noWhy = await call("scenaria_decide", { question: "DB?", options: ["Postgres", "SQLite"], chosen: "SQLite" });
    assert.ok(noWhy.isError, "a chosen option needs a rationale");
    assert.match(noWhy.text, /rationale is required/);
    const d = await call("scenaria_decide", { question: "DB?", options: ["Postgres", { label: "SQLite" }], chosen: "SQLite", rationale: "single user, zero ops", confidence: 0.6 });
    assert.match(d.text, /missing context, servesGoal/);
    p.write("schema.sql", "create table t();");
    const cp = await call("scenaria_checkpoint", { title: "schema", outputs: ["`schema.sql` created"] });
    assert.match(cp.text, /Checkpoint saved/);
    const v = await call("scenaria_verify", { id: "n3" });
    assert.match(v.text, /passed/);
    const f = await call("scenaria_fork", { decisionId: "n2", option: "Postgres", lesson: "need multi-user" });
    assert.match(f.text, /New branch n4/);
    assert.equal(p.exists("schema.sql"), false);
    const r = await call("scenaria_rewind", { id: "n3" });
    assert.match(r.text, /Rewound to n3/);
    assert.equal(p.exists("schema.sql"), true);
    const err = await call("scenaria_get_node", { id: "nope" });
    assert.ok(err.isError);
  } finally {
    await client.close();
  }
});

test("dashboard API serves graph and requires header for writes", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("a", "1");
  const cp = s.checkpoint({ title: "c" });
  const app = createApp(s);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = await (await fetch(`${base}/api/graph`)).json();
    assert.equal(g.nodes.length, 3);
    const ctx = await (await fetch(`${base}/api/node/${cp.id}/context`)).json();
    assert.ok(ctx.tokens > 0);
    const denied = await fetch(`${base}/api/rewind`, { method: "POST", body: JSON.stringify({ id: "n1" }) });
    assert.equal(denied.status, 403);
    const ok = await fetch(`${base}/api/rewind`, { method: "POST", headers: { "x-scenaria": "1" }, body: JSON.stringify({ id: "n1" }) });
    assert.equal(ok.status, 200);
    assert.equal(p.exists("a"), false);
  } finally {
    app.close();
    server.close();
  }
});
