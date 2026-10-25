// Batch E4b: the stop after two full windows without progress — enforced by Claude Code's PreToolUse hook (reading and
// Scenaria only), lifted only by the person (terminal or dashboard approval), told to agent and person; the problem
// note at a session start; the proxy's header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { allowedDuringStop } from "../dist/hooks.js";
import { stopState, windowProgress } from "../dist/core/windowprogress.js";
import { setupAgents } from "../dist/setup.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cli = (dir, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
const line = (o) => JSON.stringify(o) + "\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const person = { user: "kev", via: "dashboard" };
let n = 0;

/** An answer as Claude Code writes it, with the real time (progress records carry the real time). */
function answer(pct) {
  const id = ++n;
  return line({
    isSidechain: false,
    type: "assistant",
    uuid: `u-${id}`,
    timestamp: new Date().toISOString(),
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: pct * 2000 - 2, output_tokens: 50 } },
  });
}

/** A project with a task and two approved criteria (the approach decided), driven through the real hooks. */
function hookProject() {
  const p = tempProject();
  p.write("README.md", "x\n");
  assert.equal(cli(p.dir, ["init"]).status, 0);
  const s = Scenaria.open(p.dir);
  const task = s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal: "Write the quarterly report" }).id;
  s.addCanonAsUser({ kind: "future", text: "Report is written", task, weight: 50, artifact: "docs/r.md" }, person);
  s.addCanonAsUser({ kind: "future", text: "Summary is written", task, weight: 50, artifact: "docs/s.md" }, person);
  s.decide({ question: "Format of the quarterly report?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable report" });
  const trDir = mkdtempSync(join(tmpdir(), "transcripts-"));
  const hook = (ev, sid, extra = {}) => {
    const r = cli(p.dir, ["hook", ev], JSON.stringify({ session_id: sid, cwd: p.dir, transcript_path: join(trDir, `${sid}.jsonl`), ...extra }));
    assert.equal(r.status, 0, `hook ${ev} must exit 0: ${r.stderr}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const add = (sid, text) => {
    const f = join(trDir, `${sid}.jsonl`);
    let cur = "";
    try {
      cur = readFileSync(f, "utf8");
    } catch {
      cur = line({ type: "user", message: { role: "user", content: "Write the Q3 report" } });
    }
    writeFileSync(f, cur + text);
  };
  /** A session: start, a prompt, answers up to `peak` % (each followed by a tool), as Claude Code runs it. */
  const session = async (sid, peak = 60) => {
    const start = hook("session-start", sid, { source: "startup" });
    const prompt = hook("user-prompt", sid, { prompt: "Go on with the Q3 report" });
    const outs = [];
    for (const pct of [10, peak]) {
      await sleep(5);
      add(sid, answer(pct));
      outs.push(hook("post-tool", sid, { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "" }));
    }
    return { start, prompt, outs };
  };
  return { p, s, task, hook, add, session };
}

test("E4b only reading and Scenaria pass during a stop; unknown tools do not", () => {
  for (const t of ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "AskUserQuestion", "mcp__scenaria__scenaria_rewind", "mcp__scenaria__scenaria_status"]) assert.equal(allowedDuringStop(t, {}), true, t);
  for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task", "Skill", "mcp__github__create_pr", "mcp__evil__scenaria_x", "SomeNewTool", undefined, 3]) assert.equal(allowedDuringStop(t, {}), false, String(t));
  // The shell not at all — also not `scenaria …`: some of its commands write files (review 2, H1/H2/M6).
  for (const cmd of ["scenaria status", "scenaria export --out-file .scenaria/config.json", "scenaria open n3 --copy-to .", "scenaria status; rm -rf .", "scenaria status && touch x", "scenaria status | tee x", "scenaria $(rm x)", "scenaria `rm x`", "scenaria status > x", "scenaria\nrm -rf .", "rm -rf .", "ls", "scenariax status", "echo scenaria"])
    assert.equal(allowedDuringStop("Bash", { command: cmd }), false, cmd);
});

test("E4b the hooks: two full windows without progress stop the work at the next window; the person lifts it", async () => {
  const { p, hook, add, session } = hookProject();
  await session("S1");
  const s2 = await session("S2");
  // The second session starts after a full window without progress: the problem note, at once.
  assert.match(s2.start.hookSpecificOutput.additionalContext, /Problem note: the previous window w1 made 0 points of progress in total \(minimum 10/);
  assert.equal(hook("pre-tool", "S2", { tool_name: "Edit", tool_input: { file_path: "a" } }), null, "a warning blocks nothing");
  // The third session: its start says it (a stand-in view, not noted yet — review 2, H5) ...
  const start3 = hook("session-start", "S3", { source: "startup" });
  assert.match(start3.hookSpecificOutput.additionalContext, /\[Scenaria stop\] Two full context windows in a row \(w1, w2\)/);
  assert.equal(stopState(Scenaria.open(p.dir)), null, "the stand-in view at a session start notes nothing");
  // ... and its first tool is refused already: the hook before the tool reads the window's first answer.
  hook("user-prompt", "S3", { prompt: "Go on with the Q3 report" });
  await sleep(5);
  add("S3", answer(10));
  const first = hook("pre-tool", "S3", { tool_name: "Write", tool_input: { file_path: join(p.dir, "b.txt"), content: "x" } });
  assert.equal(first?.hookSpecificOutput?.permissionDecision, "deny", "the first tool of the new window");
  const st = stopState(Scenaria.open(p.dir));
  assert.ok(st, "the stop is noted outside the project");
  const s3 = { prompt: hook("user-prompt", "S3", { prompt: "Go on" }) };
  // Refused: writing, commands, sub-agents. Let through: reading, Scenaria, `scenaria …` in the shell.
  const deny = hook("pre-tool", "S3", { tool_name: "Edit", tool_input: { file_path: join(p.dir, "a.txt") } });
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /only reading and the Scenaria tools are allowed.*rewind to the last good step/);
  assert.equal(hook("pre-tool", "S3", { tool_name: "Bash", tool_input: { command: "npm test" } }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hook("pre-tool", "S3", { tool_name: "Agent", tool_input: {} }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hook("pre-tool", "S3", { tool_name: "Read", tool_input: { file_path: "README.md" } }), null);
  assert.equal(hook("pre-tool", "S3", { tool_name: "mcp__scenaria__scenaria_last_good", tool_input: {} }), null);
  assert.equal(hook("pre-tool", "S3", { tool_name: "Bash", tool_input: { command: "scenaria status" } }).hookSpecificOutput.permissionDecision, "deny");
  // The agent hears it at every prompt; the person once.
  assert.match(s3.prompt.hookSpecificOutput.additionalContext, /\[Scenaria stop\]/);
  assert.match(s3.prompt.systemMessage ?? "", /Scenaria: Stopp\. Zwei volle Kontextfenster hintereinander \(w1, w2\)/);
  const b = hook("user-prompt", "S3", { prompt: "go on" });
  assert.match(b.hookSpecificOutput.additionalContext, /\[Scenaria stop\]/);
  assert.equal(b.systemMessage, undefined, "the person is told once");
  // The terminal: anyone may look; lifting needs an interactive terminal and a reason.
  const look = cli(p.dir, ["window", "stop"]);
  assert.equal(look.status, 0, look.stderr);
  assert.match(look.stdout, /STOP since .*w1, w2 without progress on n1/);
  const noWhy = cli(p.dir, ["window", "stop", "lift"], "lift\n");
  assert.notEqual(noWhy.status, 0);
  assert.match(noWhy.stderr + noWhy.stdout, /Say why the stop is lifted/);
  const noTty = cli(p.dir, ["window", "stop", "lift", "--why", "cut smaller"], "lift\n");
  assert.notEqual(noTty.status, 0, "an agent's shell is no interactive terminal");
  assert.match(noTty.stderr + noTty.stdout, /person's action/);
  assert.ok(stopState(Scenaria.open(p.dir)), "still stopped");
  // The dashboard: the approval session only.
  const s = Scenaria.open(p.dir);
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, h) => fetch(`${base}/api/window-stop/lift`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: JSON.stringify(body) });
  try {
    const got = await (await fetch(`${base}/api/windows`, { headers: { "x-scenaria": "1" } })).json();
    assert.equal(got.progress.stop.task, "n1", "everyone may read it");
    let r = await post({ why: "cut smaller" }, { "x-scenaria-agent": "claude-code" });
    assert.equal(r.status, 403);
    r = await post({ why: "" }, { cookie: "scenaria_approval=sess" });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "why");
    r = await post({ why: "task cut into Q3a and Q3b" }, { cookie: "scenaria_approval=sess" });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.stop, null);
    assert.equal(body.lift.via, "dashboard");
    r = await post({ why: "again" }, { cookie: "scenaria_approval=sess" });
    assert.equal((await r.json()).code, "not_stopped");
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
  }
  assert.equal(hook("pre-tool", "S3", { tool_name: "Edit", tool_input: { file_path: "a" } }), null, "lifted: the AI may write again");
  const ev = Scenaria.open(p.dir).store.readEvents().find((e) => e.data?.windowStop);
  assert.match(ev.data.message, /lifted by .* via dashboard: task cut into Q3a and Q3b/);
});

test("E4b real progress in the second window: no stop; a resumed session is no window change", async () => {
  const { p, s, hook, session } = hookProject();
  await session("S1");
  p.write("docs/r.md", "# Q3\n");
  s.checkpoint({ title: "Draft of the quarterly report", outputs: ["`docs/r.md`"], fulfills: ["k1"], agent: "claude-code" });
  await session("S2");
  const s3 = await session("S3");
  assert.doesNotMatch(s3.start.hookSpecificOutput.additionalContext, /\[Scenaria stop\]/);
  assert.match(s3.start.hookSpecificOutput.additionalContext, /Problem note: the previous window w2 made 0 points/, "one window without progress: the note");
  assert.equal(stopState(Scenaria.open(p.dir)), null);
  // Resuming a session: no snapshot, no problem note (the window goes on).
  const before = readFileSync(join(p.dir, ".scenaria/windows.jsonl"), "utf8").split("\n").length;
  const r = hook("session-start", "S3", { source: "resume" });
  assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /Problem note/);
  assert.equal(readFileSync(join(p.dir, ".scenaria/windows.jsonl"), "utf8").split("\n").length, before);
  const wp = windowProgress(Scenaria.open(p.dir));
  assert.deepEqual(wp.windows.map((a) => a.state), ["running", "none", "progress"]);
});

test("E4b setup: the PreToolUse hook runs before every tool", () => {
  const p = tempProject();
  p.write("README.md", "x\n");
  Scenaria.init(p.dir);
  setupAgents(p.dir, ["claude"]);
  const settings = JSON.parse(readFileSync(join(p.dir, ".claude/settings.json"), "utf8"));
  const pre = settings.hooks.PreToolUse.find((m) => m.hooks.some((h) => /hook pre-tool/.test(h.command)));
  assert.equal(pre.matcher, "*");
});

// ---------------------------------------------------------------- notices, the handover, the proxy

/** Windows written directly (the real time), as in windowprogress.test.mjs. */
async function directWindow(s, key, peak = 60) {
  const { recordWindowEvents, recordProgressSnapshot } = await import("../dist/core/window.js");
  await sleep(3);
  recordProgressSnapshot(s);
  for (const pct of [10, peak]) {
    await sleep(3);
    recordWindowEvents(s, { source: "transcript", key, agent: "claude-code" }, [{ kind: "sample", at: new Date().toISOString(), tokens: pct * 2000, model: "claude-opus-5-5", ref: `m:${++n}` }]);
  }
}
function plainProject() {
  const p = tempProject();
  p.write("README.md", "x\n");
  const s = Scenaria.init(p.dir);
  const task = s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal: "Write the quarterly report" }).id;
  s.addCanonAsUser({ kind: "future", text: "Report is written", task, weight: 50, artifact: "docs/r.md" }, person);
  s.addCanonAsUser({ kind: "future", text: "Summary is written", task, weight: 50, artifact: "docs/s.md" }, person);
  s.decide({ question: "Format of the quarterly report?", options: ["Markdown", "Word"], chosen: "Markdown", rationale: "diffable report" });
  return { p, s, task };
}

test("E4b notices: the problem note travels with the handover; a lossy handover is told once, with the full handover", async () => {
  const { windowNotices, prepareHandover } = await import("../dist/core/windowact.js");
  const { s } = plainProject();
  await directWindow(s, "claude-code:A");
  s.checkpoint({ title: "Quarterly report: revenue section drafted", outputs: ["revenue section of the quarterly report"], agent: "claude-code" });
  await directWindow(s, "claude-code:B");
  const h = prepareHandover(s, {});
  assert.match(h.markdown, /## Problem note\n\nProblem note: the previous window w1 made 0 points of progress in total/);
  // The new window drifts off: three steps that have nothing to do with the report.
  for (const t of ["Holiday photos sorted by colour", "Weather in Lisbon looked up", "Playlist for the weekend made"]) s.checkpoint({ title: t, outputs: [`${t}, unrelated to anything`], agent: "claude-code" });
  const first = windowNotices(s, "claude-code:B", {}, "de");
  assert.ok(first.agent.some((x) => /^\[Scenaria progress\] Problem note: the previous window w1/.test(x)));
  const ho = first.agent.find((x) => x.startsWith("[Scenaria handover]"));
  assert.ok(ho, "the lossy handover is told");
  assert.match(ho, /points lost: .*more than 5 points: improve the handover.*# Handover to a new window/s);
  assert.ok(first.person.some((x) => /^Scenaria: Beim Wechsel ins neue Kontextfenster sank der Anschluss der KI an die bisherige Arbeit um \d+ Punkte? \(erlaubt: 5\)/.test(x)));
  const again = windowNotices(s, "claude-code:B", first.told, "de");
  assert.deepEqual([again.agent, again.person], [[], []], "each notice once");
});

test("E4b proxy: during a stop the response carries x-scenaria-stop; an upstream cannot set it", async () => {
  const { evaluateStop } = await import("../dist/core/windowprogress.js");
  const { s } = plainProject();
  await directWindow(s, "claude-code:A");
  await directWindow(s, "claude-code:B");
  await directWindow(s, "claude-code:C");
  assert.ok(evaluateStop(s));
  const up = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json", "x-scenaria-stop": "none" });
    res.end(JSON.stringify({ id: `msg_${++n}`, model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2000, output_tokens: 5 } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { anthropic: `http://127.0.0.1:${up.address().port}` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/proxy/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk", "x-scenaria-session": "trip" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "Plan" }] }),
    });
    await r.text();
    assert.equal(r.headers.get("x-scenaria-stop"), "task=n1; windows=w1,w2");
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});

// ---------------------------------------------------------------- review E4 round 2: every finding with a test

test("E4 review 2 H1/H2: a project made unreadable, or the shell, cannot switch the stop off", async () => {
  const { p, hook, session } = hookProject();
  await session("S1");
  await session("S2");
  await session("S3");
  assert.ok(stopState(Scenaria.open(p.dir)));
  // The shell is refused during a stop — also `scenaria export --out-file …` (it could overwrite files).
  assert.equal(hook("pre-tool", "S3", { tool_name: "Bash", tool_input: { command: "scenaria export --out-file .scenaria/config.json" } }).hookSpecificOutput.permissionDecision, "deny");
  // A broken project file (however it came about) does not let tools through: the stop is read without opening it.
  writeFileSync(join(p.dir, ".scenaria/config.json"), "{ broken");
  const r = cli(p.dir, ["hook", "pre-tool"], JSON.stringify({ session_id: "S3", cwd: p.dir, tool_name: "Edit", tool_input: { file_path: "a" } }));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("E4 review 2 H3: the agent's own pending proposal does not switch the rule off", async () => {
  const { s, task } = plainProject();
  for (const [i, key] of ["claude-code:A", "claude-code:B", "claude-code:C"].entries()) {
    await directWindow(s, key);
    s.proposeCanon({ kind: "future", text: `Extra criterion ${i}`, task, weight: 10 });
  }
  const wp = windowProgress(s);
  assert.deepEqual(wp.windows.map((a) => a.state), ["running", "none", "none"]);
  assert.ok(wp.stop);
});

test("E4 review 2 H4: an answer in an older session afterwards does not take a noted stop back", async () => {
  const { recordWindowEvents } = await import("../dist/core/window.js");
  const { s } = plainProject();
  await directWindow(s, "claude-code:A");
  await directWindow(s, "claude-code:B");
  await directWindow(s, "claude-code:C");
  assert.ok(windowProgress(s).stop);
  // The person resumes session B and the agent answers there: w2 has answers after w3's start now.
  await sleep(3);
  recordWindowEvents(s, { source: "transcript", key: "claude-code:B", agent: "claude-code" }, [{ kind: "sample", at: new Date().toISOString(), tokens: 130000, model: "claude-opus-5-5", ref: `m:${++n}` }]);
  const wp = windowProgress(s);
  assert.ok(wp.stop, "only the person lifts a stop");
  assert.ok(stopState(s));
});

test("E4 review 2 H5: parallel proxy conversations are no window change; the stand-in view notes nothing", async () => {
  const { recordWindowEvents, recordProgressSnapshot } = await import("../dist/core/window.js");
  const { s } = plainProject();
  // Two chats of one agent through the proxy, one after the other and in between: each its own window, no succession.
  for (const key of ["p1", "p2", "p3"]) {
    await sleep(3);
    recordProgressSnapshot(s);
    for (const pct of [10, 60]) {
      await sleep(3);
      recordWindowEvents(s, { source: "proxy", key, agent: "codex" }, [{ kind: "sample", at: new Date().toISOString(), tokens: pct * 2000, model: "claude-opus-5-5", ref: `r:${++n}` }]);
    }
  }
  let wp = windowProgress(s);
  assert.deepEqual(wp.windows.map((a) => a.state), ["running", "running", "running"]);
  assert.equal(wp.stop, null);
  // Claude Code: w-A full without progress, w-B running; a second terminal starts — the stand-in view sees a stop but notes nothing.
  const q = plainProject();
  await directWindow(q.s, "claude-code:A");
  await directWindow(q.s, "claude-code:B");
  await sleep(3);
  recordProgressSnapshot(q.s, "claude-code:C");
  wp = windowProgress(q.s, { pending: { source: "transcript", agent: "claude-code" } });
  assert.ok(wp.stop, "the stand-in view would see one");
  assert.equal(stopState(q.s), null, "but it is not noted (the running session is not held up)");
});

test("E4 review 2 M7: after the person's lift, redoing work after the advised rewind counts", async () => {
  const { liftStop } = await import("../dist/core/windowprogress.js");
  const { p, s } = plainProject();
  const start = s.checkpoint({ title: "start" });
  p.write("docs/r.md", "# Q3\n");
  s.checkpoint({ title: "report drafted", outputs: ["`docs/r.md`"], fulfills: ["k1"], agent: "claude-code" });
  await directWindow(s, "claude-code:A");
  await directWindow(s, "claude-code:B");
  await directWindow(s, "claude-code:C");
  assert.ok(windowProgress(s).stop);
  liftStop(s, { why: "rewind and start over smaller" }, { by: "kev", via: "terminal" });
  s.rewind(start.id, { lesson: "start over" });
  await directWindow(s, "claude-code:D");
  p.write("docs/r.md", "# Q3 new\n");
  s.checkpoint({ title: "report drafted again", outputs: ["`docs/r.md`"], fulfills: ["k1"], agent: "claude-code" });
  await directWindow(s, "claude-code:E");
  const wp = windowProgress(s);
  const d = wp.windows.find((a) => a.window === "w4");
  assert.equal(d.state, "progress", `redo after the lift counts (${d.points?.sentence.en})`);
  assert.equal(wp.stop, null);
});

test("E4 review 2 L12: a session's own start is its window's start, also long before its first answer", async () => {
  const { recordWindowEvents, recordProgressSnapshot } = await import("../dist/core/window.js");
  const { p, s } = plainProject();
  recordProgressSnapshot(s, "claude-code:A");
  // The first answer comes an hour later; meanwhile the person did work that counts for this window.
  p.write("docs/r.md", "# Q3\n");
  s.checkpoint({ title: "draft", outputs: ["`docs/r.md`"], fulfills: ["k1"], agent: "claude-code" });
  const later = Date.now() + 3600_000;
  recordWindowEvents(s, { source: "transcript", key: "claude-code:A", agent: "claude-code" }, [
    { kind: "sample", at: new Date(later).toISOString(), tokens: 20000, model: "claude-opus-5-5", ref: `m:${++n}` },
    { kind: "sample", at: new Date(later + 1000).toISOString(), tokens: 120000, model: "claude-opus-5-5", ref: `m:${++n}` },
  ]);
  const a = windowProgress(s).windows[0];
  assert.deepEqual([a.window, a.state, a.value], ["w1", "running", 25]);
});

// ---------------------------------------------------------------- review E4 round 3

test("E4 review 3 L8: only Scenaria's own server and tools pass during a stop (the list equals tools.ts)", async () => {
  const { TOOLS } = await import("../dist/tools.js");
  const { SCENARIA_TOOL_NAMES } = await import("../dist/hooks.js");
  assert.deepEqual([...SCENARIA_TOOL_NAMES].sort(), TOOLS.map((t) => t.name).sort());
  assert.equal(allowedDuringStop("mcp__scenaria-q3-report__scenaria_status", {}), true, "Claude Desktop's per-project name");
  for (const t of ["mcp__evil_scenaria_x__scenaria_status", "mcp__scenaria__scenaria_exec", "mcp__notscenaria__scenaria_status", "mcp__scenaria__scenaria_status_x"]) assert.equal(allowedDuringStop(t, {}), false, t);
});

test("E4 review 3 M3: during a stop the session start says so when the hook before every tool is not wired", async () => {
  const { preToolHookWired } = await import("../dist/hooks.js");
  const { p, hook, session } = hookProject();
  await session("S1");
  await session("S2");
  await session("S3");
  assert.ok(stopState(Scenaria.open(p.dir)));
  // `scenaria init` wired nothing for Claude Code here: the warning shows (the settings are never rewritten here).
  assert.equal(preToolHookWired(p.dir), false);
  let out = hook("session-start", "S4", { source: "startup" });
  assert.match(out.hookSpecificOutput.additionalContext, /the stop is not enforced\. Ask the person to run "scenaria start" again/);
  setupAgents(p.dir, ["claude"]);
  assert.equal(preToolHookWired(p.dir), true);
  out = hook("session-start", "S5", { source: "startup" });
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /not enforced/);
  // A matcher for the shell only (an older setup) is not enough.
  const f = join(p.dir, ".claude/settings.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  for (const m of j.hooks.PreToolUse) m.matcher = "Bash";
  writeFileSync(f, JSON.stringify(j));
  assert.equal(preToolHookWired(p.dir), false);
});

test("E4 review 3 M1: a stop from two sessions at once is marked as most likely wrong", async () => {
  const { recordWindowEvents, recordProgressSnapshot } = await import("../dist/core/window.js");
  const { evaluateStop, renderWindowProgress } = await import("../dist/core/windowprogress.js");
  const { stopPersonText } = await import("../dist/core/windowprogress.js");
  const { s } = plainProject();
  await directWindow(s, "claude-code:A");
  await directWindow(s, "claude-code:B");
  // A second terminal starts while B is still working: C's first answer is taken for the window change.
  await sleep(3);
  recordProgressSnapshot(s, "claude-code:C");
  await sleep(3);
  recordWindowEvents(s, { source: "transcript", key: "claude-code:C", agent: "claude-code" }, [{ kind: "sample", at: new Date().toISOString(), tokens: 20000, model: "claude-opus-5-5", ref: `m:${++n}` }]);
  let st = evaluateStop(s);
  assert.ok(st);
  assert.equal(st.likelyParallel, undefined);
  // B answers again: it was running alongside.
  await sleep(3);
  recordWindowEvents(s, { source: "transcript", key: "claude-code:B", agent: "claude-code" }, [{ kind: "sample", at: new Date().toISOString(), tokens: 130000, model: "claude-opus-5-5", ref: `m:${++n}` }]);
  const wp = windowProgress(s);
  assert.ok(wp.stop, "still only the person lifts it");
  assert.equal(wp.stop.likelyParallel, true);
  assert.match(stopPersonText(wp.stop, "de"), /Das sieht nach zwei gleichzeitigen Sitzungen aus – dann ist der Stopp wohl falsch; hebe ihn einfach auf\./);
  assert.match(renderWindowProgress(wp, "en"), /looks like two sessions at once/);
});

test("E4 mutation check: through the proxy the stop is computed when a window starts (no one has to ask)", async () => {
  const { s } = plainProject();
  const fills = [30, 60, 20, 60, 20, 60, 20];
  let i = 0;
  const up = createServer(async (req, res) => {
    for await (const _ of req);
    const pct = fills[i++] ?? 20;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_p${++n}`, model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: pct * 2000, output_tokens: 5 } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { anthropic: `http://127.0.0.1:${up.address().port}` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = async () => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/proxy/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk", "x-scenaria-session": "trip" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "Plan" }] }),
    });
    await r.text();
    await sleep(40);
    return r.headers;
  };
  try {
    for (let k = 0; k < 6; k++) await post();
    assert.ok(stopState(s), "noted by the proxy itself after the third window began");
    const h = await post();
    assert.match(h.get("x-scenaria-stop") ?? "", /^task=n1; windows=w1,w2$/);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});
