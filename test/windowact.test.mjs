// Batch E3a-2: acting on the measured fill of a context window — automatic checkpoints (orange at the end of a turn,
// from red at once, also mid-turn), notices to the agent and the person, the prepared handover, the proxy's headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool, TOOLS } from "../dist/tools.js";
import { windowStatus, recordWindowEvents, quickFill } from "../dist/core/window.js";
import { contextAdvice, cutDue, cutIfDue, cutOnce, agentNotice, personNotice, prepareHandover, ZONE_RANK } from "../dist/core/windowact.js";
import { projectProgress } from "../dist/core/progress.js";
import { setupAgents, setupGlobal } from "../dist/setup.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ctx = { source: "mcp", agent: "claude-code" };
const cli = (dir, args, input, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } });
const line = (o) => JSON.stringify(o) + "\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = "claude-code:S";
const WHO = { source: "transcript", key: KEY, agent: "claude-code" };
let clock = Date.parse("2026-10-22T10:00:00.000Z");
const at = () => new Date((clock += 60_000)).toISOString();
/** A sample of `pct` % of C_eff 200,000 (claude-opus-5-5: C_max 1M, A_model 200k). */
const sample = (pct, ref, model = "claude-opus-5-5") => ({ kind: "sample", at: at(), tokens: pct * 2000, model, ref });

function project() {
  const p = tempProject();
  p.write("README.md", "hello\n");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal: "Write the report" });
  p.write("a.txt", "a");
  s.checkpoint({ title: "First draft", outputs: ["`a.txt`"], agent: "claude-code", source: "mcp" });
  return { p, s };
}

/** An answer as Claude Code writes it (one line per block, same message id and usage). */
function answer(id, pct, { blocks = ["tool_use"], model = "claude-opus-5-5" } = {}) {
  const ts = at();
  return blocks
    .map((b, i) =>
      line({
        isSidechain: false,
        type: "assistant",
        uuid: `u-${id}-${i}`,
        timestamp: ts,
        requestId: `req_${id}`,
        message: {
          id: `msg_${id}`,
          model,
          role: "assistant",
          content: [b === "tool_use" ? { type: "tool_use", name: "Bash", input: { command: "ls" } } : { type: "text", text: "Done: the summary is written." }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: pct * 2000 - 2, output_tokens: 50 },
        },
      }),
    )
    .join("");
}

function hookProject() {
  const p = tempProject();
  p.write("README.md", "x\n");
  assert.equal(cli(p.dir, ["init"]).status, 0);
  // Claude Code keeps transcripts outside the project (otherwise every answer would be a file change).
  const tr = join(mkdtempSync(join(tmpdir(), "transcripts-")), "t.jsonl");
  writeFileSync(tr, line({ type: "user", message: { role: "user", content: "Write the Q3 report" } }));
  const hook = (ev, extra = {}, sid = "S9") => {
    const r = cli(p.dir, ["hook", ev], JSON.stringify({ session_id: sid, cwd: p.dir, transcript_path: tr, ...extra }));
    assert.equal(r.status, 0, `hook ${ev} must exit 0: ${r.stderr}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const add = (text) => writeFileSync(tr, readFileSync(tr, "utf8") + text);
  return { p, tr, hook, add, open: () => Scenaria.open(p.dir) };
}
/** A live process (its pid makes a lock file look held, not stale). */
const require_spawn = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
const cutsOf = (s) => s.store.listNodes().filter((n) => n.meta?.contextCut);
/** Steps that save state (a task's goal node is created lazily with the first one and does not count here). */
const saves = (s) => s.store.listNodes().filter((n) => n.type === "checkpoint" || n.type === "autosave").length;

// ---------------------------------------------------------------- the rule

test("E3a-2 rule: nothing below yellow; orange cuts at a turn's end only; red and emergency at once; each zone once per window", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(40, "m:1")]);
  assert.equal(contextAdvice(s, KEY), null, "green: nothing");
  recordWindowEvents(s, WHO, [sample(55, "m:2")]);
  let a = contextAdvice(s, KEY);
  assert.equal(a.zone, "yellow");
  assert.equal(cutDue(a, "turn-end"), false);
  assert.equal(cutDue(a, "now"), false);
  assert.match(agentNotice(a), /55 % full \(yellow.*Do not start a new large part.*scenaria_handover/);
  recordWindowEvents(s, WHO, [sample(65, "m:3")]);
  a = contextAdvice(s, KEY);
  assert.equal(a.zone, "orange");
  assert.equal(cutDue(a, "turn-end"), true);
  assert.equal(cutDue(a, "answer"), true);
  assert.equal(cutDue(a, "now"), false, "orange waits for the end of the turn");
  const n1 = cutIfDue(s, KEY, "turn-end", { source: "hook" }).node;
  assert.equal(n1.agent, "scenaria");
  assert.deepEqual(n1.tags, ["context-cut"]);
  assert.equal(n1.meta.contextCut.zone, "orange");
  assert.equal(n1.meta.contextCut.fill, 65);
  assert.equal(n1.fulfills, undefined, "a cut claims no completion criterion");
  a = contextAdvice(s, KEY);
  assert.equal(a.cut, "orange");
  assert.equal(cutDue(a, "turn-end"), false, "orange once per window");
  recordWindowEvents(s, WHO, [sample(72, "m:4")]);
  a = contextAdvice(s, KEY);
  assert.equal(a.zone, "red");
  assert.equal(cutDue(a, "now"), true, "red: at once");
  cutIfDue(s, KEY, "now", { source: "hook" }).node;
  recordWindowEvents(s, WHO, [sample(80, "m:5")]);
  assert.equal(cutDue(contextAdvice(s, KEY), "now"), false, "red once per window");
  recordWindowEvents(s, WHO, [sample(86, "m:6")]);
  a = contextAdvice(s, KEY);
  assert.equal(a.zone, "emergency");
  assert.equal(cutDue(a, "now"), true, "emergency: once more");
  cutIfDue(s, KEY, "now", { source: "hook" }).node;
  assert.equal(cutDue(contextAdvice(s, KEY), "now"), false);
  const w = windowStatus(s).current;
  assert.deepEqual(w.cuts.map((c) => c.zone), ["orange", "red", "emergency"]);
  // A new window (compaction) starts with no cuts.
  recordWindowEvents(s, WHO, [{ kind: "boundary", at: at(), ref: "b:1", trigger: "auto" }, sample(66, "m:7")]);
  a = contextAdvice(s, KEY);
  assert.equal(a.window.id, "w2");
  assert.equal(a.cut, "green");
  assert.equal(cutDue(a, "turn-end"), true);
  // A higher cut covers the lower zones: red first, then orange is not due any more.
  const { s: s2 } = project();
  recordWindowEvents(s2, WHO, [sample(75, "m:1")]);
  cutIfDue(s2, KEY, "now", { source: "hook" }).node;
  recordWindowEvents(s2, WHO, [sample(68, "m:2")]); // fell back into orange (smaller answer)
  assert.equal(cutDue(contextAdvice(s2, KEY), "turn-end"), false);
  assert.deepEqual(Object.keys(ZONE_RANK), ["green", "yellow", "orange", "red", "emergency"]);
});

test("E3a-2 rule: no action without a checked number — unknown model, data changed outside, another conversation", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(90, "m:1", "qwen3.5:9b")]);
  assert.equal(quickFill(s, KEY), null);
  assert.equal(contextAdvice(s, KEY), null, "unknown model: the rule does not apply");
  const { s: s2 } = project();
  recordWindowEvents(s2, WHO, [sample(30, "m:1")]);
  // Someone raises the number by hand (and keeps the format): the window shows no number, nothing is cut.
  const f = s2.store.path("windows.jsonl");
  writeFileSync(f, readFileSync(f, "utf8").replace('"tokens":60000', '"tokens":180000'));
  assert.ok(quickFill(s2, KEY).fill >= 85, "the cheap look sees the raw number…");
  assert.equal(contextAdvice(s2, KEY), null, "…but only the checked measurement counts");
  // Another conversation's window is not this one's.
  const { s: s3 } = project();
  recordWindowEvents(s3, { ...WHO, key: "claude-code:OTHER" }, [sample(80, "m:1")]);
  assert.equal(contextAdvice(s3, KEY), null);
  assert.equal(contextAdvice(s3, "claude-code:OTHER").zone, "red");
});

test("E3a-2 rule: an agent cannot mark a cut itself (the tools carry no meta), so the automatic cut stays due", () => {
  const { p, s } = project();
  recordWindowEvents(s, WHO, [sample(72, "m:1")]);
  p.write("b.txt", "b");
  const r = callTool(s, "scenaria_checkpoint", { title: "x", meta: { contextCut: { window: "w1", startedAt: windowStatus(s).current.startedAt, zone: "emergency", fill: 99 } } }, ctx);
  assert.equal(r.data.meta, undefined);
  assert.equal(cutDue(contextAdvice(s, KEY), "now"), true);
});

// ---------------------------------------------------------------- Claude Code hooks

test("E3a-2 hooks: yellow notice in the reminder; orange saves the turn's end even without a file change, as Scenaria", () => {
  const { hook, add, open } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("a1", 55));
  let out = hook("user-prompt", { prompt: "Go on" });
  assert.match(out.hookSpecificOutput.additionalContext, /\[Scenaria\] project/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[Scenaria context\] window w1 is 55 % full \(yellow/);
  assert.equal(out.systemMessage, undefined, "yellow: no message to the person");
  add(answer("a2", 65, { blocks: ["text"] }));
  const before = saves(open());
  out = hook("stop");
  const s = open();
  const cut = s.head();
  assert.equal(saves(s), before + 1, "one checkpoint, though no file changed");
  assert.equal(cut.meta.contextCut.zone, "orange");
  assert.equal(cut.meta.contextCut.moment, "turn-end");
  assert.ok(cut.meta.windows, "still anchors the chain");
  assert.deepEqual(cut.tags, ["context-cut"]);
  assert.equal(cut.agent, "scenaria", "nothing changed: Scenaria's own save");
  assert.equal(cut.title, "Saved before the window change");
  assert.match(cut.outputs.at(-1), /Context window w1 65 % full \(orange\)/);
  assert.equal(out, null, "orange: no message to the person (from red on — Kev n77)");
  const ev = s.store.readEvents().filter((e) => e.data?.context);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].nodeId, cut.id);
  // The next turn's end in the same zone: no second cut.
  out = hook("stop");
  assert.equal(out, null);
  assert.equal(cutsOf(open()).length, 1);
});

test("E3a-2 hooks: from red a checkpoint at once after a tool (mid-turn), once; then the end of the turn adds none", () => {
  const { p, hook, add, open } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("b1", 40));
  assert.equal(hook("post-tool", { tool_name: "Bash", tool_input: { command: "ls" } }), null, "green: nothing");
  add(answer("b2", 72));
  p.write("half.txt", "half done");
  const out = hook("post-tool", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.match(out.hookSpecificOutput.additionalContext, /72 % full \(red.*Hand over to a new window now.*Scenaria saved step n\d+/);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.systemMessage, /Bitte jetzt ein neues Fenster öffnen/);
  const s = open();
  const cut = s.head();
  assert.equal(cut.agent, "scenaria");
  assert.equal(cut.source, "hook");
  assert.equal(cut.meta.contextCut.moment, "now");
  assert.ok(cut.changedFiles.some((f) => f.includes("half.txt")), "the files as they are mid-turn");
  assert.equal(hook("post-tool", { tool_name: "Bash", tool_input: { command: "ls" } }), null, "once");
  add(answer("b3", 74, { blocks: ["text"] }));
  assert.equal(hook("stop"), null);
  assert.equal(cutsOf(open()).length, 1);
  // The notice repeats on every new prompt while the window stays red.
  const again = hook("user-prompt", { prompt: "And now?" });
  assert.match(again.hookSpecificOutput.additionalContext, /74 % full \(red/);
  assert.equal(again.systemMessage, undefined);
  // Emergency: once more at once.
  add(answer("b4", 86));
  const em = hook("post-tool", { tool_name: "Edit", tool_input: {} });
  assert.match(em.hookSpecificOutput.additionalContext, /emergency/);
  assert.equal(cutsOf(open()).length, 2);
});

test("E3a-2 hooks: a red turn that ended without the hooks (interrupted) is saved on the next prompt; reminder off still notifies", () => {
  const { p, hook, add, open } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("c1", 71, { blocks: ["text"] }));
  const out = hook("user-prompt", { prompt: "continue" });
  assert.match(out.systemMessage, /71 % gefüllt \(rot\)/);
  assert.match(out.hookSpecificOutput.additionalContext, /Scenaria saved step n\d+/);
  assert.equal(cutsOf(open()).length, 1);
  // With the reminder switched off, the context notice still reaches the agent (alone).
  const s = open();
  const cfg = s.config();
  cfg.promptReminder = false;
  s.store.writeConfig(cfg);
  const off = hook("user-prompt", { prompt: "and?" });
  assert.doesNotMatch(off.hookSpecificOutput.additionalContext, /\[Scenaria\] project/);
  assert.match(off.hookSpecificOutput.additionalContext, /^\[Scenaria context\]/);
  void p;
});

test("E3a-2 hooks: orange with changed files — the turn's checkpoint is the cut (one node, not two); red tells the person, in English for an English person", () => {
  const { p, hook, add, open } = hookProject();
  const g = join(process.env.SCENARIA_HOME, "config.json");
  let old = null;
  try {
    old = readFileSync(g, "utf8");
  } catch {}
  writeFileSync(g, JSON.stringify({ ...(old ? JSON.parse(old) : {}), ui: { lang: "en" } }));
  try {
    hook("user-prompt", { prompt: "Write the Q3 report" });
    add(answer("d1", 64, { blocks: ["text"] }));
    p.write("report.md", "# Q3");
    const before = saves(open());
    const out = hook("stop");
    const s = open();
    assert.equal(saves(s), before + 1);
    assert.ok(s.head().changedFiles.some((f) => f.includes("report.md")));
    assert.equal(s.head().meta.contextCut.zone, "orange");
    assert.equal(out, null);
    assert.equal(s.head().agent, "claude-code", "files changed: the turn's own checkpoint carries the cut");
    // Red at a turn's end: the person's message in English.
    add(answer("d2", 71, { blocks: ["text"] }));
    const red = hook("stop");
    assert.match(red.systemMessage, /^Scenaria: the AI's memory \(context window\) is 71 % full \(red\)\. Saved as step n\d+\. Please open a new window now/);
  } finally {
    if (old === null) rmSync(g, { force: true });
    else writeFileSync(g, old);
  }
});

test("E3a-2 hooks: a new window starts with a pointer to the handover; the hooks never fail on a broken record", () => {
  const { hook, add, open, p } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("e1", 73));
  hook("post-tool", { tool_name: "Bash", tool_input: { command: "ls" } });
  const cut = cutsOf(open())[0];
  const start = hook("session-start", { source: "clear" }, "S10");
  assert.match(start.hookSpecificOutput.additionalContext, new RegExp(`\\(Handover: the previous window w1 was 73 % full \\(red\\) when Scenaria saved step ${cut.id}`));
  // An unreadable windows record (a folder) never makes a hook fail or cost the turn its checkpoint.
  const f = open().store.path("windows.jsonl");
  rmSync(f);
  mkdirSync(f);
  add(answer("e2", 90));
  assert.equal(hook("post-tool", { tool_name: "Bash", tool_input: { command: "ls" } }), null);
  p.write("z.txt", "z");
  const before = saves(open());
  hook("stop");
  assert.equal(saves(open()), before + 1);
});

// ---------------------------------------------------------------- the handover

test("E3a-2 handover: from the cut on the current line, with fill, progress and capsule; read-only; not from an abandoned branch", async () => {
  const { p, s } = project();
  assert.throws(() => prepareHandover(Scenaria.init(tempProject().dir)), /No HEAD/);
  let h = prepareHandover(s);
  assert.equal(h.window, null);
  assert.match(h.markdown, /No measured window/);
  recordWindowEvents(s, WHO, [sample(76, "m:1")]);
  const cut = cutIfDue(s, KEY, "now", { source: "hook" }).node;
  p.write("c.txt", "c");
  const later = s.checkpoint({ title: "After the cut", agent: "claude-code", source: "mcp" });
  h = prepareHandover(s);
  assert.equal(h.lastSave, cut.id);
  assert.equal(h.from, later.id, "the new window continues from the current state, not from the save (review M6)");
  assert.match(h.markdown, /^# Handover to a new window/);
  assert.match(h.markdown, /Window w1 of claude-code \(claude-opus-5-5\): 76 % full \(red\)\. 76 %: 152,000 tokens of C_eff 200,000/);
  assert.match(h.markdown, new RegExp(`Last automatic save: step ${cut.id} at 76 % \\(red\\)\\. Continue from the current state, step ${later.id} "After the cut" — do not go back`));
  assert.match(h.markdown, /## Resume capsule/);
  assert.match(h.markdown, /Reports people can trust/);
  assert.match(h.markdown, /## How to continue/);
  const tool = TOOLS.find((t) => t.name === "scenaria_handover");
  assert.equal(tool.annotations.readOnlyHint, true);
  const nodes = s.store.listNodes().length;
  const r = callTool(s, "scenaria_handover", {}, ctx);
  assert.equal(r.data.lastSave, cut.id);
  assert.equal(s.store.listNodes().length, nodes, "reading the handover writes nothing");
  assert.throws(() => callTool(s, "scenaria_handover", { window: "w9" }, ctx), /w9 is not a window/);
  // After going back to before the cut, the cut is on an abandoned line: the handover starts from HEAD.
  const first = s.store.listNodes().find((n) => n.title === "First draft");
  s.rewind(first.id, { force: true });
  h = prepareHandover(s);
  assert.equal(h.lastSave, null, "the save lies on an abandoned branch");
  assert.equal(h.from, s.head().id);
  assert.match(h.markdown, /Continue from the current state, step/);
  // CLI and HTTP.
  const c = cli(p.dir, ["handover"]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /Handover to a new window/);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const got = await fetch(`http://127.0.0.1:${server.address().port}/api/handover`, { headers: { "x-scenaria": "1" } }).then((x) => x.json());
    assert.equal(got.from, s.head().id);
    assert.match(got.markdown, /# Handover/);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
  }
});

// ---------------------------------------------------------------- the proxy

test("E3a-2 proxy: the zone in the response headers (from yellow, as after the last answer); a cut after an orange answer; nothing from an upstream", async () => {
  let n = 0;
  const fills = [55, 66, 67];
  const up = createServer(async (req, res) => {
    for await (const _ of req);
    const pct = fills[n++] ?? 40;
    // An upstream that tries to pass off a zone of its own.
    res.writeHead(200, { "content-type": "application/json", "x-scenaria-context-zone": "green" });
    res.end(JSON.stringify({ id: `msg_${n}`, model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: pct * 2000, output_tokens: 5 } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { s } = project();
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { anthropic: `http://127.0.0.1:${up.address().port}` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (extra = {}) => {
    const r = await fetch(`${base}/proxy/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk", "x-scenaria-session": "trip", ...extra },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "Plan the trip" }] }),
    });
    await r.text();
    await sleep(60);
    return r.headers;
  };
  try {
    let h = await post();
    assert.equal(h.get("x-scenaria-context-zone"), null, "first answer: nothing measured before it; the upstream's header is dropped");
    h = await post();
    assert.equal(h.get("x-scenaria-context-zone"), "yellow", "the state after the previous answer (55 %)");
    assert.equal(h.get("x-scenaria-context-fill"), "55");
    assert.match(h.get("x-scenaria-context-window"), /^w\d+$/);
    // The second answer reached 66 % (orange): Scenaria cut after it.
    let cuts = cutsOf(s);
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0].agent, "scenaria");
    assert.equal(cuts[0].source, "api");
    assert.equal(cuts[0].meta.contextCut.moment, "answer");
    h = await post();
    assert.equal(h.get("x-scenaria-context-zone"), "orange");
    assert.equal(cutsOf(s).length, 1, "orange once per window");
    // A client naming its own upstream: nothing measured, nothing cut.
    fills.push(90);
    n = 3;
    const before = cutsOf(s).length;
    await post({ "x-scenaria-upstream": `http://127.0.0.1:${up.address().port}`, "x-scenaria-session": "other" });
    assert.equal(cutsOf(s).length, before);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});

test("E3a-2 texts: plain words for the person in German and English", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(85, "m:1")]);
  const a = contextAdvice(s, KEY);
  assert.equal(a.zone, "emergency");
  assert.equal(personNotice(a, "n7", "de"), "Scenaria: Das Gedächtnis der KI (Kontextfenster) ist zu 85 % gefüllt (Notsicherung). Gesichert als Schritt n7. Bitte jetzt ein neues Fenster öffnen (Claude Code: /clear) – die Übergabe liegt bereit (scenaria handover).");
  assert.match(personNotice(a, null, "en"), /^Scenaria: the AI's memory \(context window\) is 85 % full \(emergency\)\. Please open a new window now/);
  assert.match(agentNotice(a, "n7"), /Save now — the window is far past the limit for good work\. Scenaria saved step n7/);
  // Above 100 % of the limit for good work: no confusing percentage for the person.
  recordWindowEvents(s, WHO, [sample(150, "m:2")]);
  assert.match(personNotice(contextAdvice(s, KEY), null, "de"), /ist mehr als voll \(Notsicherung\)/);
  const c = cli(s.root, ["window"], undefined, {});
  assert.equal(c.status, 0);
});

// ---------------------------------------------------------------- review E3a-2 (one test per finding)

test("E3a-2 review H1: setup installs the after-tool hook for every tool (project and global), so red saves mid-turn", () => {
  const p = tempProject();
  p.write("README.md", "x");
  Scenaria.init(p.dir);
  setupAgents(p.dir, ["claude"], { rulesFiles: false });
  const proj = JSON.parse(readFileSync(join(p.dir, ".claude", "settings.json"), "utf8"));
  const post = proj.hooks.PostToolUse.filter((m) => m.hooks.some((h) => /hook post-tool/.test(h.command)));
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, "*");
  // Re-running setup replaces the old, narrower entry (projects set up before E3a-2).
  proj.hooks.PostToolUse = [{ matcher: "AskUserQuestion|ExitPlanMode", hooks: post[0].hooks }];
  writeFileSync(join(p.dir, ".claude", "settings.json"), JSON.stringify(proj));
  setupAgents(p.dir, ["claude"], { rulesFiles: false });
  const again = JSON.parse(readFileSync(join(p.dir, ".claude", "settings.json"), "utf8")).hooks.PostToolUse;
  assert.deepEqual(again.map((m) => m.matcher), ["*"]);
  const home = mkdtempSync(join(tmpdir(), "home-"));
  setupGlobal(["claude"], home);
  const g = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(g.hooks.PostToolUse.map((m) => m.matcher), ["*"]);
});

test("E3a-2 review H2: a quiet automatic save does not lower a task the person accepted", () => {
  const { p, s } = project();
  const task = s.currentTask();
  s.proposeCanon({ text: "The report exists", kind: "future", task: task.id, weight: 100, artifact: "a.txt" }, { agent: "claude-code" });
  const k = s.canon().find((e) => e.kind === "future");
  s.decideCanon(k.id, "approve", { via: "test", user: "kev", expect: { text: "The report exists", task: task.id, weight: 100, artifact: "a.txt" } });
  s.decide({ question: "Format?", options: ["md", "pdf"], chosen: "md", agent: "claude-code", source: "mcp" });
  p.write("a.txt", "the report");
  const tip = s.checkpoint({ title: "Report done", outputs: ["`a.txt`"], fulfills: [k.id], agent: "claude-code", source: "mcp" });
  s.verify(tip.id, { status: "passed", by: "person", origin: "person", via: "test", decision: { via: "test" } });
  const before = projectProgress(s).tasks.find((t) => t.task === task.id);
  assert.equal(before.value, 100, "the person accepted the task");
  recordWindowEvents(s, WHO, [sample(72, "m:1")]);
  const cut = cutIfDue(s, KEY, "now", { source: "hook" }).node;
  assert.ok(cut);
  assert.equal(cut.changedFiles, undefined, "nothing changed");
  const after = projectProgress(s).tasks.find((t) => t.task === task.id);
  assert.equal(after.value, 100, "a quiet save is no step of the work");
  assert.equal(after.tip, before.tip);
});

test("E3a-2 review 2, T1: the check and the write of a cut happen under the project lock", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(72, "m:1")]);
  let depth = -1;
  cutOnce(s, KEY, "now", (a, due) => {
    depth = s.store.lockDepth;
    assert.equal(due, true);
    return null;
  });
  assert.ok(depth >= 1, "the write callback runs while the lock is held");
  const node = cutIfDue(s, KEY, "now", { source: "hook" }).node;
  assert.equal(node.meta.contextCut.key, KEY, "the cut names the conversation it measured");
});

test("E3a-2 review M1: parallel hooks (parallel tool calls) cut once", async () => {
  const { tr, p, add, open, hook } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("r1", 72));
  const { spawn } = await import("node:child_process");
  const run = () =>
    new Promise((res) => {
      const c = spawn(process.execPath, [CLI, "hook", "post-tool"], { cwd: p.dir, env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => res({ code, out }));
      c.stdin.end(JSON.stringify({ session_id: "S9", cwd: p.dir, transcript_path: tr, tool_name: "Read", tool_input: {} }));
    });
  const rs = await Promise.all([run(), run(), run(), run(), run(), run()]);
  assert.ok(rs.every((r) => r.code === 0));
  assert.equal(cutsOf(open()).length, 1, "one cut");
  assert.equal(rs.filter((r) => r.out.includes("systemMessage")).length, 1, "one message to the person");
});

test("E3a-2 review M2: OpenAI Responses chained with previous_response_id — headers and cuts follow the conversation", async () => {
  let n = 0;
  const up = createServer(async (req, res) => {
    for await (const _ of req);
    n++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `resp_${n}`, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: [100_000, 132_000, 150_000][n - 1] ?? 150_000 } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { s } = project();
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { openai: `http://127.0.0.1:${up.address().port}/v1` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/proxy/openai/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk" }, body: JSON.stringify({ model: "gpt-5", ...body }) });
    await r.text();
    await sleep(60);
    return r.headers;
  };
  try {
    // gpt-5: C_max 400,000 > A_model 200,000 → C_eff 200,000: 100,000 = 50 % (yellow), 132,000 = 66 % (orange), 150,000 = 75 % (red).
    let h = await post({ input: "Plan the trip" });
    assert.equal(h.get("x-scenaria-context-zone"), null, "nothing measured before the first answer");
    h = await post({ input: "And the hotel?", previous_response_id: "resp_1" });
    assert.equal(h.get("x-scenaria-context-zone"), "yellow", "the chained call is the same conversation");
    assert.equal(cutsOf(s).length, 1, "cut after the orange answer");
    h = await post({ input: "And the train?", previous_response_id: "resp_2" });
    assert.equal(h.get("x-scenaria-context-zone"), "orange");
    assert.equal(cutsOf(s).length, 2, "and after the red one");
    h = await post({ input: "And back?", previous_response_id: "resp_3" });
    assert.equal(h.get("x-scenaria-context-zone"), "red");
    assert.equal(windowStatus(s).windows.filter((w) => w.model === "gpt-5").length, 1);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});

test("E3a-2 review M3: a cut written into a node by hand counts for nothing; a cut on an abandoned branch is not this line's", () => {
  const { p, s } = project();
  recordWindowEvents(s, WHO, [sample(72, "m:1")]);
  // (a) Someone writes a cut marker into an existing node file.
  const n = s.head();
  const f = join(s.store.path("nodes"), `${n.id}.json`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.tags = ["context-cut"];
  j.meta = { ...(j.meta ?? {}), contextCut: { window: "w1", startedAt: windowStatus(s).current.startedAt, zone: "emergency", fill: 99, moment: "now" } };
  writeFileSync(f, JSON.stringify(j));
  const fresh = Scenaria.open(p.dir);
  assert.equal(fresh.integrity().state.get(n.id), "tampered");
  assert.equal(windowStatus(fresh).current.cuts.length, 0);
  assert.equal(cutDue(contextAdvice(fresh, KEY), "now"), true, "the hand-written cut suppresses nothing");
  // (b) A real cut, then back to before it: the cut is on an abandoned branch and red is due again on this line.
  const { s: s2 } = project();
  const first = s2.head();
  recordWindowEvents(s2, WHO, [sample(72, "m:1")]);
  const c1 = cutIfDue(s2, KEY, "now", { source: "hook" }).node;
  assert.ok(c1);
  s2.rewind(first.id, { force: true });
  const a = contextAdvice(s2, KEY);
  assert.equal(a.cutNode, null);
  assert.equal(cutDue(a, "now"), true);
  assert.doesNotMatch(agentNotice(a), new RegExp(`saved step ${c1.id}`));
  assert.equal(windowStatus(s2).current.cuts[0].onLine, false, "still listed for the auditor, marked off the line");
  // (c) Only nodes Scenaria wrote as cuts count (meta AND tag): a meta without the tag is no cut.
  const { s: s3 } = project();
  recordWindowEvents(s3, WHO, [sample(72, "m:1")]);
  s3.checkpoint({ title: "x", agent: "claude-code", source: "mcp", meta: { contextCut: { window: "w1", startedAt: windowStatus(s3).current.startedAt, zone: "emergency", fill: 99, moment: "now" } } });
  assert.equal(windowStatus(s3).current.cuts.length, 0);
  assert.equal(cutDue(contextAdvice(s3, KEY), "now"), true);
});

test("E3a-2 review M4: the handover is the asking agent's window, and names the other full ones", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(72, "m:1")]);
  recordWindowEvents(s, { source: "proxy", key: "proxy:x", agent: "proxy:anthropic" }, [sample(20, "r:1")]);
  assert.equal(windowStatus(s).current.agent, "proxy:anthropic", "the newest answer is the other agent's");
  const r = callTool(s, "scenaria_handover", {}, { source: "mcp", agent: "claude-code" });
  assert.equal(r.data.window.agent, "claude-code");
  assert.equal(r.data.window.zone, "red");
  const other = callTool(s, "scenaria_handover", {}, { source: "mcp", agent: "proxy:anthropic" });
  assert.equal(other.data.window.agent, "proxy:anthropic");
  assert.deepEqual(other.data.others.map((o) => [o.agent, o.zone]), [["claude-code", "red"]]);
  assert.match(other.text, /Other windows that are yellow or fuller: w1 of claude-code 72 % \(red\)/);
});

test("E3a-2 review M5: a session reads only the transcript it named first", () => {
  const { hook, add, open, p } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("s1", 30));
  hook("post-tool", { tool_name: "Bash", tool_input: {} });
  // A transcript someone else wrote, under the same session id: red numbers, a fake compaction.
  const fake = join(p.dir, "fake.jsonl");
  writeFileSync(fake, line({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" }, uuid: "fb", timestamp: at() }) + answer("f1", 80));
  assert.equal(hook("post-tool", { tool_name: "Bash", tool_input: {}, transcript_path: fake }), null);
  const ws = windowStatus(open());
  assert.equal(ws.windows.length, 1, "no fake compaction");
  assert.equal(ws.current.fill.value, 30);
  assert.equal(cutsOf(open()).length, 0);
});

test("E3a-2 review L1 and gaps: the new window's pointer names the previous window; /clear opens a new window that is cut anew; emergency repeats", () => {
  const { hook, add, open, tr } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("g1", 73));
  hook("post-tool", { tool_name: "Bash", tool_input: {} });
  // /clear: a new session with its own transcript and window.
  const tr2 = tr.replace(/t\.jsonl$/, "t2.jsonl");
  writeFileSync(tr2, line({ type: "user", message: { role: "user", content: "next" } }));
  const start = hook("session-start", { source: "clear", transcript_path: tr2 }, "S11");
  assert.match(start.hookSpecificOutput.additionalContext, /previous window w1 was 73 % full/);
  writeFileSync(tr2, readFileSync(tr2, "utf8") + answer("g2", 30));
  hook("user-prompt", { prompt: "go", transcript_path: tr2 }, "S11");
  // The newest window of the agent (w2) had no save: no pointer to an older window's save.
  assert.equal(hook("session-start", { source: "clear", transcript_path: tr2 }, "S12").hookSpecificOutput.additionalContext.includes("Handover:"), false);
  writeFileSync(tr2, readFileSync(tr2, "utf8") + answer("g3", 74));
  const red = hook("post-tool", { tool_name: "Bash", tool_input: {}, transcript_path: tr2 }, "S11");
  assert.match(red.hookSpecificOutput.additionalContext, /window w2 is 74 % full \(red/);
  writeFileSync(tr2, readFileSync(tr2, "utf8") + answer("g4", 88, { blocks: ["text"] }));
  hook("stop", { transcript_path: tr2 }, "S11");
  for (const q of ["a", "b"]) assert.match(hook("user-prompt", { prompt: q, transcript_path: tr2 }, "S11").hookSpecificOutput.additionalContext, /88 % full \(emergency/);
  assert.deepEqual(cutsOf(open()).map((n) => n.meta.contextCut.zone), ["red", "red", "emergency"]);
});

test("E3a-2 review gaps: a client naming its own upstream in the same conversation gets no zone and causes no cut", async () => {
  let n = 0;
  const up = createServer(async (req, res) => {
    for await (const _ of req);
    const tokens = [130_000, 130_000, 176_000][n++] ?? 176_000;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_x${n}`, model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: tokens } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { s } = project();
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { anthropic: `http://127.0.0.1:${up.address().port}` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  // The conversation is red already (measured from the configured provider).
  const key = "anthropic:trip";
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = async (extra) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk", "x-scenaria-session": "trip", ...extra }, body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "Plan" }] }) });
    await r.text();
    await sleep(60);
    return r.headers;
  };
  try {
    await post({});
    const cuts = cutsOf(s).length;
    assert.equal(cuts, 1, "65 %: cut after the orange answer");
    // Nothing new measured, but the zone rose (from the configured provider): with a self-named upstream nothing is
    // shown and nothing is cut, because nothing from that answer can be checked.
    const k = windowStatus(s).current.key;
    assert.equal(k, "proxy:trip");
    const before = cutsOf(s);
    // Raise the measured fill of this conversation to emergency from the trusted side, without an answer through the proxy.
    recordWindowEvents(s, { source: "proxy", key: k, agent: "proxy:anthropic" }, [{ kind: "sample", at: new Date().toISOString(), tokens: 175_000, model: "claude-sonnet-5-5", ref: "r:extra" }]);
    assert.equal(contextAdvice(s, k).zone, "emergency");
    const h = await post({ "x-scenaria-upstream": `http://127.0.0.1:${up.address().port}` });
    assert.equal(h.get("x-scenaria-context-zone"), null);
    assert.equal(cutsOf(s).length, before.length, "no cut after an answer from a self-named upstream");
    // The same call through the configured provider shows the zone and cuts.
    const h2 = await post({});
    assert.equal(h2.get("x-scenaria-context-zone"), "emergency");
    assert.equal(cutsOf(s).length, before.length + 1);
    void key;
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});

test("E3a-2 review 2, T2: real work in a cut still counts; a changed or reviewed cut is not passed over", () => {
  const setup = (verifyTip = true) => {
    const { p, s } = project();
    const task = s.currentTask();
    s.proposeCanon({ text: "The report exists", kind: "future", task: task.id, weight: 100, artifact: "a.txt" }, { agent: "claude-code" });
    const k = s.canon().find((e) => e.kind === "future");
    s.decideCanon(k.id, "approve", { via: "test", user: "kev", expect: { text: "The report exists", task: task.id, weight: 100, artifact: "a.txt" } });
    s.decide({ question: "Format?", options: ["md", "pdf"], chosen: "md", agent: "claude-code", source: "mcp" });
    p.write("a.txt", "the report");
    const tip = s.checkpoint({ title: "Report done", outputs: ["`a.txt`"], fulfills: [k.id], agent: "claude-code", source: "mcp" });
    if (verifyTip) s.verify(tip.id, { status: "passed", by: "person", origin: "person", via: "test", decision: { via: "test" } });
    recordWindowEvents(s, WHO, [sample(72, "m:1")]);
    const value = () => projectProgress(s).tasks.find((t) => t.task === task.id).value;
    if (verifyTip) assert.equal(value(), 100);
    return { p, s, value };
  };
  // Work after the person's verdict, saved by the red cut: the acceptance no longer covers the newest state.
  const a = setup();
  a.p.write("a.txt", "changed after the review");
  const cut = cutIfDue(a.s, KEY, "now", { source: "hook" }).node;
  assert.ok(cut.changedFiles.length > 0);
  assert.ok(a.value() < 100, "a cut with real changes is a step of the work");
  // A quiet cut edited by hand is not trusted, so it is not passed over either.
  const b = setup();
  const q = cutIfDue(b.s, KEY, "now", { source: "hook" }).node;
  assert.equal(b.value(), 100);
  const f = join(b.s.store.path("nodes"), `${q.id}.json`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.title = "edited";
  writeFileSync(f, JSON.stringify(j));
  const fresh = Scenaria.open(b.s.root);
  assert.ok(projectProgress(fresh).tasks[0].value < 100, "a changed cut is not passed over");
  // A verdict on the quiet cut itself counts as usual (review 2, L-b): the step before it was not reviewed.
  const c = setup(false);
  assert.ok(c.value() < 100);
  const q2 = cutIfDue(c.s, KEY, "now", { source: "hook" }).node;
  c.s.verify(q2.id, { status: "passed", by: "person", origin: "person", via: "test", decision: { via: "test" } });
  assert.equal(projectProgress(c.s).tasks[0].tip, q2.id, "a reviewed cut is a step like any other");
});

test("E3a-2 review 2, N2: a quiet cut at a turn's end is Scenaria's record; the agent's words are kept apart, labelled", () => {
  const { hook, add, open } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("q1", 66, { blocks: ["text"] }));
  hook("stop");
  const n = open().head();
  assert.equal(n.agent, "scenaria");
  assert.equal(n.outputs.length, 1);
  assert.match(n.outputs[0], /^Context window w1 66 % full \(orange\)/);
  assert.deepEqual(n.meta.agentSummary, { agent: "claude-code", outputs: ["Done: the summary is written."] });
});

test("E3a-2 review 2, N1: after an ordinary tool the hook holds nothing up — no new answer: no lock; a busy lock: it gives up quickly", () => {
  const { hook, add, open, p } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("w1", 40));
  assert.equal(hook("post-tool", { tool_name: "Read", tool_input: {} }), null);
  // Another live process holds the project lock.
  const lock = open().store.path("lock");
  const sleeper = require_spawn();
  writeFileSync(lock, `${sleeper.pid}:held`);
  try {
    // Nothing new in the transcript: returns at once, the lock is never needed.
    let t = Date.now();
    assert.equal(hook("post-tool", { tool_name: "Read", tool_input: {} }), null);
    // Opening the project waits at most 1 s for the busy lock; without a new answer nothing else waits (with the
    // after-tool wait of 1.5 s on top it would take more than 2.5 s).
    assert.ok(Date.now() - t < 2200, `no further wait without a new answer (${Date.now() - t} ms)`);
    // A new red answer while the lock is busy: gives up after about 1.5 s instead of 20 s, and exits 0.
    add(answer("w2", 75));
    t = Date.now();
    assert.equal(hook("post-tool", { tool_name: "Read", tool_input: {} }), null);
    const took = Date.now() - t;
    assert.ok(took >= 1400 && took < 6000, `gave up after ${took} ms`);
    assert.equal(cutsOf(open()).length, 0);
  } finally {
    sleeper.kill();
    rmSync(lock, { force: true });
  }
  // Free again: the next tool acts.
  add(answer("w3", 76));
  assert.match(hook("post-tool", { tool_name: "Read", tool_input: {} }).hookSpecificOutput.additionalContext, /76 % full \(red/);
  void p;
});

test("E3a-2: after a clarifying question (the hook's other path) red is saved at once too", () => {
  const { hook, add, open } = hookProject();
  hook("user-prompt", { prompt: "Write the Q3 report" });
  add(answer("aq1", 72));
  const out = hook("post-tool", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which format?", header: "Format", options: [{ label: "md" }, { label: "pdf" }] }] }, tool_response: { answers: { "Which format?": "md" } } });
  assert.match(out.hookSpecificOutput.additionalContext, /72 % full \(red/);
  const s = open();
  assert.equal(cutsOf(s).length, 1);
  assert.ok(s.store.listNodes().some((n) => n.type === "decision" && n.chosen), "the question is still recorded as a decision");
});
