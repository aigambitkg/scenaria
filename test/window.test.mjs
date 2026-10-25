// Batch E3a-1: measuring the context window — model table, the formulas context-fill/1 and context-soft/1, zones,
// reading Claude Code transcripts (usage, sub-agents, compaction) and proxy answers, window records with a chain,
// rewrites that show, the tool, the CLI and the HTTP route. Transcript lines are anonymised copies of real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool, TOOLS } from "../dist/tools.js";
import { derive, recompute, expand, contextZone, contextNextLimit, p95Of, CONTEXT_RULE } from "../dist/core/derivation.js";
import { lookupModel, A_MODEL_DEFAULT } from "../dist/core/models.js";
import { windowStatus, windowsHead, recordWindowEvents, claudeCodeWindowEvents, renderWindows } from "../dist/core/window.js";
import { ingestClaudeTranscript } from "../dist/ingest.js";
import { responseId, usageTokens } from "../dist/proxy.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ctx = { source: "mcp", agent: "claude-code" };
const plain = (x) => String(x).replace(/\x1b\[[0-9;]*m/g, "");
const cli = (dir, args, input, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } });
const line = (o) => JSON.stringify(o) + "\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project() {
  const p = tempProject();
  p.write("README.md", "hello\n");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal: "Write the report" });
  return { p, s };
}

/** An answer as Claude Code writes it: one line per content block, the same message id and usage on each. */
function answer(id, at, { input = 2, write = 0, read = 0, out = 100, model = "claude-opus-5-5", sidechain = false, blocks = ["thinking", "tool_use"] } = {}) {
  return blocks
    .map((b, i) =>
      line({
        parentUuid: `p-${id}-${i}`,
        isSidechain: sidechain,
        type: "assistant",
        uuid: `u-${id}-${i}`,
        timestamp: at,
        requestId: `req_${id}`,
        message: {
          id: `msg_${id}`,
          model,
          role: "assistant",
          content: [b === "tool_use" ? { type: "tool_use", name: "Bash", input: { command: "ls" } } : b === "text" ? { type: "text", text: "ok" } : { type: b, thinking: "" }],
          usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out },
        },
      }),
    )
    .join("");
}
const boundary = (uuid, at, pre = 784583) =>
  line({ parentUuid: null, logicalParentUuid: "x", isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", compactMetadata: { trigger: "auto", preTokens: pre, postTokens: 16352 }, uuid, timestamp: at });
const summary = (at) => line({ type: "user", isCompactSummary: true, isMeta: false, message: { role: "user", content: "This session is being continued …" }, uuid: "sum", timestamp: at });

// ---------------------------------------------------------------- model table

test("E3 model table v1: documented sizes with source and date; anything else is unknown", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) assert.equal(lookupModel(id)?.cMax, 1_000_000, id);
  assert.equal(lookupModel("gpt-5")?.cMax, 400_000);
  assert.equal(lookupModel("gpt-5-2025-08-07")?.cMax, 400_000, "a dated snapshot counts");
  assert.equal(lookupModel("claude-opus-5-5-20261001")?.cMax, 1_000_000);
  assert.equal(lookupModel("anthropic/claude-opus-5-5")?.cMax, 1_000_000);
  assert.equal(lookupModel("claude-opus-5-5[1m]")?.cMax, 1_000_000);
  assert.equal(lookupModel("gemini-4-argon")?.cMax, 1_000_000);
  // Not documented / not verified: no value from memory.
  for (const id of ["claude-sonnet-4-5", "gpt-5-mini", "gpt-6", "gemini-3-pro", "qwen3.5:9b", "llama3", "", null, "claude-opus-5-5x", "claude-opus-5-55"]) assert.equal(lookupModel(id), null, String(id));
  for (const id of ["claude-opus-5-5", "gpt-5", "gemini-4-argon"]) {
    const row = lookupModel(id);
    assert.match(row.source, /^https:\/\//);
    assert.match(row.read, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(A_MODEL_DEFAULT, 200_000, "Kev n79");
});

// ---------------------------------------------------------------- formulas and zones

test("E3 context-fill/1: percent of C_eff = min(C_max, A_model), rounded down; every zone line", () => {
  const fill = (tokens, soft = 63, cMax = 1_000_000) => derive("context.fill", "context-fill/1", { tokens, cMax, aModel: 200_000, soft, rule: CONTEXT_RULE });
  const cases = [
    [99_999, 49.9, "green"],
    [100_000, 50, "yellow"],
    [125_999, 62.9, "yellow"],
    [126_000, 63, "orange"],
    [139_999, 69.9, "orange"],
    [140_000, 70, "red"],
    [169_999, 84.9, "red"],
    [170_000, 85, "emergency"],
    [400_000, 200, "emergency"],
  ];
  for (const [tokens, value, zone] of cases) {
    const d = fill(tokens);
    assert.equal(d.value, value, `${tokens}`);
    assert.equal(contextZone(d.value, 63), zone, `${tokens}`);
    assert.equal(recompute(d), value);
    assert.match(d.sentence.de, new RegExp(`Zone ${{ green: "grün", yellow: "gelb", orange: "orange", red: "rot", emergency: "Notsicherung" }[zone]}\\.`));
  }
  // 69.96 % never shows as 70 % while it is still below the red line.
  assert.equal(fill(139_920).value, 69.9);
  // A smaller window than A_model: C_eff = C_max.
  const small = fill(64_000, 63, 128_000);
  assert.equal(small.value, 50);
  assert.match(small.sentence.de, /C_eff 128\.000 \(C_max; C_max 128\.000, A_modell 200\.000\)/);
  assert.match(fill(140_000).sentence.en, /140,000 tokens of C_eff 200,000 \(A_model; C_max 1,000,000, A_model 200,000\)\. Zone red\. Next line: 85 % \(emergency\)\. Rule v1\.0\./);
  // A changed value shows on recompute; the short form expands to the same value.
  assert.equal(recompute({ ...fill(140_000), value: 40 }), 70);
  assert.equal(expand({ key: "context.fill", value: 1, formula: "context-fill/1", inputs: { tokens: 140_000, cMax: 1_000_000, aModel: 200_000, soft: 63, rule: CONTEXT_RULE } }).value, 70);
  // Without a window size the rule does not apply.
  assert.equal(derive("x", "context-fill/1", { tokens: 5, rule: CONTEXT_RULE }).value, 0);
  assert.match(derive("x", "context-fill/1", { tokens: 5, rule: CONTEXT_RULE }).sentence.de, /greift die Regel nicht/);
});

test("E3 context-soft/1: 70 % minus the buffer; P95 start value until 20 steps; never below 50 %", () => {
  const soft = (steps, handover = 0) => derive("context.soft", "context-soft/1", { cMax: 1_000_000, aModel: 200_000, steps: steps.map(String), handover, rule: CONTEXT_RULE });
  // Start value: P95 = 5 % of 200,000 = 10,000; margin 2 % = 4,000 → buffer 7 % → 63 %.
  const start = soft([]);
  assert.equal(start.value, 63);
  assert.match(start.sentence.de, /P95-Startwert 5 % = 10\.000 \(erst 0 von 20 Schritten gemessen\)/);
  // 19 steps: still the start value.
  assert.equal(soft(Array.from({ length: 19 }, () => 1000)).value, 63);
  // 20 steps 1,000 … 20,000: P95 by nearest rank = 19,000 → buffer (19,000 + 4,000) / 200,000 = 11.5 % → 58.5 %.
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000);
  assert.equal(p95Of(twenty), 19_000);
  const m = soft(twenty);
  assert.equal(m.value, 58.5);
  assert.match(m.sentence.de, /P95 aus 20 gemessenen Schritten 19\.000/);
  // Handover cost counts: 2,000 tokens = 1 % more buffer.
  assert.equal(soft(twenty, 2000).value, 57.5);
  // Large steps: the floor.
  const big = soft(Array.from({ length: 20 }, () => 60_000));
  assert.equal(big.value, 50);
  assert.match(big.sentence.de, /nie unter 50 %/);
  // Not numbers / negative entries are not steps.
  assert.equal(soft(["x", "-5", "1.5"]).value, 63);
  assert.equal(recompute(m), 58.5);
  assert.equal(recompute({ ...m, inputs: m.inputs.map((i) => (i.name === "steps" ? { ...i, value: twenty.slice(1).map(String) } : i)) }), 63, "removing a step changes the value");
});

test("E3 zones: a soft threshold at 50 % leaves no yellow zone; the next line skips empty zones", () => {
  assert.equal(contextZone(50, 50), "orange");
  assert.equal(contextZone(49.9, 50), "green");
  assert.deepEqual(contextNextLimit(40, 50), { at: 50, zone: "orange" });
  assert.deepEqual(contextNextLimit(40, 63), { at: 50, zone: "yellow" });
  assert.deepEqual(contextNextLimit(55, 63), { at: 63, zone: "orange" });
  assert.deepEqual(contextNextLimit(63, 63), { at: 70, zone: "red" });
  assert.deepEqual(contextNextLimit(70, 63), { at: 85, zone: "emergency" });
  assert.equal(contextNextLimit(85, 63), null);
  // A soft threshold above 70 % (other rule values) never moves the red line.
  assert.equal(contextZone(69, 75), "yellow");
  assert.equal(contextZone(70, 75), "red");
});

// ---------------------------------------------------------------- reading transcripts

test("E3 transcript: fill = input + cache write + cache read of the last main-line answer; one answer counts once", () => {
  const ev = claudeCodeWindowEvents(
    (answer("a1", "2026-10-18T10:00:00.000Z", { input: 2, write: 14_413, read: 139_470 }) + answer("s1", "2026-10-18T10:00:01.000Z", { input: 5, read: 900_000, sidechain: true }) + line({ type: "assistant", timestamp: "2026-10-18T10:00:02.000Z", message: { id: "msg_x", model: "<synthetic>", usage: { input_tokens: 0 } } }) + answer("a2", "2026-10-18T10:00:03.000Z", { input: 2, write: 2291, read: 153_883 }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
  );
  // Two lines each for a1 and a2 (thinking + tool use) → the reader hands over both, recording drops the second.
  assert.deepEqual(
    ev.map((e) => [e.kind, e.tokens, e.ref]),
    [
      ["sample", 153_885, "m:msg_a1"],
      ["sample", 153_885, "m:msg_a1"],
      ["sample", 156_176, "m:msg_a2"],
      ["sample", 156_176, "m:msg_a2"],
    ],
  );
  const { s } = project();
  assert.equal(recordWindowEvents(s, { source: "transcript", key: "claude-code:S", agent: "claude-code" }, ev), 2);
  const ws = windowStatus(s);
  assert.equal(ws.windows.length, 1);
  assert.equal(ws.current.samples, 2);
  assert.equal(ws.current.tokens, 156_176);
  assert.equal(ws.current.fill.value, 78);
  assert.equal(ws.current.zone, "red");
});

test("E3 transcript: a compaction starts a new window; re-reading the transcript adds nothing", () => {
  const { p, s } = project();
  const tr = join(p.dir, "t.jsonl");
  writeFileSync(tr, line({ type: "user", message: { role: "user", content: "Build it" }, timestamp: "2026-10-18T09:59:00.000Z" }) + answer("a1", "2026-10-18T10:00:00.000Z", { read: 120_000 }) + answer("a2", "2026-10-18T10:05:00.000Z", { read: 175_000 }));
  ingestClaudeTranscript(s, tr, "S");
  writeFileSync(tr, readFileSync(tr, "utf8") + boundary("b-1", "2026-10-18T10:06:00.000Z") + summary("2026-10-18T10:06:01.000Z") + answer("a3", "2026-10-18T10:07:00.000Z", { write: 16_000, read: 4000 }));
  ingestClaudeTranscript(s, tr, "S");
  let ws = windowStatus(s);
  assert.deepEqual(
    ws.windows.map((w) => [w.id, w.start, w.end, w.samples, w.tokens, w.zone]),
    [
      ["w2", "compact", undefined, 1, 20_002, "green"],
      ["w1", "new-session", "compact", 2, 175_002, "emergency"],
    ],
  );
  assert.equal(ws.windows[0].trigger, "auto");
  assert.equal(ws.windows[0].preTokens, 784_583);
  assert.equal(ws.windows[1].maxTokens, 175_002);
  // Re-read from the start (the file was rewritten): nothing new.
  const before = readFileSync(join(p.dir, ".scenaria", "windows.jsonl"), "utf8");
  writeFileSync(tr, readFileSync(tr, "utf8").split("\n").slice(1).join("\n"));
  ingestClaudeTranscript(s, tr, "S");
  assert.equal(readFileSync(join(p.dir, ".scenaria", "windows.jsonl"), "utf8"), before);
  // Another session is its own window.
  const tr2 = join(p.dir, "t2.jsonl");
  writeFileSync(tr2, answer("b1", "2026-10-18T11:00:00.000Z", { read: 1000 }));
  ingestClaudeTranscript(s, tr2, "T");
  ws = windowStatus(s);
  assert.equal(ws.current.id, "w3");
  assert.equal(ws.current.key, "claude-code:T");
  assert.equal(ws.windows.length, 3);
});

test("E3 hooks: SessionStart after /clear names the start; the end-of-turn checkpoint anchors the chain; the hook never fails", () => {
  const p = tempProject();
  p.write("README.md", "x\n");
  cli(p.dir, ["init"]);
  const tr = join(p.dir, "t.jsonl");
  writeFileSync(tr, line({ type: "user", message: { role: "user", content: "Build a todo app" } }));
  const hook = (ev, extra = {}) => cli(p.dir, ["hook", ev], JSON.stringify({ session_id: "S2", cwd: p.dir, transcript_path: tr, ...extra }));
  assert.equal(hook("session-start", { source: "clear" }).status, 0);
  hook("user-prompt", { prompt: "Build a todo app" });
  writeFileSync(tr, readFileSync(tr, "utf8") + answer("c1", new Date().toISOString(), { read: 50_000, blocks: ["text"] }));
  p.write("app.js", "x");
  assert.equal(hook("stop").status, 0);
  const s = Scenaria.open(p.dir);
  const ws = windowStatus(s);
  assert.equal(ws.current.start, "clear");
  assert.equal(ws.current.fill.value, 25);
  const cp = s.head();
  // E4: the session start records the progress (one line); the window's opening adds none (nothing answered since).
  assert.equal(cp.meta.windows.lines, 3);
  assert.match(cp.meta.windows.head, /^[0-9a-f]{32}$/);
  // A broken transcript line or a missing file never makes the hook fail.
  writeFileSync(tr, readFileSync(tr, "utf8") + "{not json\n");
  assert.equal(hook("stop").status, 0);
  assert.equal(cli(p.dir, ["hook", "stop"], JSON.stringify({ session_id: "S3", transcript_path: join(p.dir, "missing.jsonl") })).status, 0);
});

// ---------------------------------------------------------------- what cannot be trusted

const WHO = { source: "transcript", key: "claude-code:S", agent: "claude-code" };
const sampleAt = (at, tokens, ref) => ({ kind: "sample", at, tokens, model: "claude-opus-5-5", ref });
/** Rewrite the records with a correct chain (what someone who knows the format can do). */
function rechain(text, change) {
  let prev = "";
  return (
    text
      .trim()
      .split("\n")
      .map((l) => change(JSON.parse(l)))
      .map(({ c, ...rest }) => {
        const nc = createHash("sha256").update(`${prev}|${JSON.stringify(rest)}`).digest("hex").slice(0, 32);
        prev = nc;
        return JSON.stringify({ ...rest, c: nc });
      })
      .join("\n") + "\n"
  );
}
const anchorFile = () => {
  const dir = join(process.env.SCENARIA_HOME, "anchors");
  // The newest one: this test's project wrote last.
  const f = readdirSync(dir)
    .filter((x) => x.endsWith(".windows.json"))
    .map((x) => ({ x, t: statSync(join(dir, x)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].x;
  return join(dir, f);
};

test("E3 window records: a changed line shows — chain, outside anchor, anchored checkpoint (review H1, H2)", () => {
  const { p, s } = project();
  recordWindowEvents(s, WHO, [sampleAt("2026-10-18T10:00:00.000Z", 150_000, "m:1"), sampleAt("2026-10-18T10:01:00.000Z", 160_000, "m:2")]);
  recordWindowEvents(s, { ...WHO, key: "claude-code:T" }, [sampleAt("2026-10-18T10:02:00.000Z", 20_000, "m:3")]);
  const f = join(p.dir, ".scenaria", "windows.jsonl");
  const good = readFileSync(f, "utf8");
  assert.equal(windowStatus(s).changed, null);
  const byId = (ws, id) => ws.windows.find((w) => w.id === id);
  // A half-written line carries no data and is no change.
  writeFileSync(f, good + '{"t":"sample","w":"w1","at":"2026');
  assert.equal(windowStatus(s).changed, null);
  assert.equal(byId(windowStatus(s), "w1").fill.value, 80);
  // Lower the fill by hand: the chain no longer fits.
  writeFileSync(f, good.replace('"tokens":160000', '"tokens":60000'));
  let ws = windowStatus(s);
  assert.equal(ws.changed.by, "chain");
  assert.equal(byId(ws, "w1").measurable, false);
  assert.equal(byId(ws, "w1").why, "changed-outside");
  assert.equal(byId(ws, "w1").tokens, null);
  assert.equal(byId(ws, "w1").fill, undefined);
  assert.match(renderWindows(ws, "de"), /außerhalb von Scenaria geändert/);
  // The last line changed but its hash kept: the outside anchor still fits (same hash), the chain shows it.
  writeFileSync(f, good.replace('"tokens":20000', '"tokens":2000'));
  ws = windowStatus(s);
  assert.equal(ws.changed.by, "chain");
  assert.equal(byId(ws, "w2").why, "changed-outside");
  assert.equal(byId(ws, "w2").tokens, null);
  // A window's first line changed, its hash kept: the breaking line itself counts for nothing.
  writeFileSync(f, good.replace('"key":"claude-code:T","agent":"claude-code","start":"new-session"', '"key":"claude-code:T","agent":"claude-code","start":"resume"'));
  ws = windowStatus(s);
  assert.equal(ws.changed.by, "chain");
  assert.equal(byId(ws, "w2").why, "changed-outside");
  // H1: the same change with the line's own hash redone breaks the NEXT line — the changed line still counts for nothing.
  const one = good.trim().split("\n");
  const prevC = JSON.parse(one[1]).c;
  const { c: _c, ...rest } = { ...JSON.parse(one[2]), tokens: 60_000 };
  one[2] = JSON.stringify({ ...rest, c: createHash("sha256").update(`${prevC}|${JSON.stringify(rest)}`).digest("hex").slice(0, 32) });
  writeFileSync(f, one.join("\n") + "\n");
  ws = windowStatus(s);
  assert.equal(byId(ws, "w1").why, "changed-outside");
  // The whole chain redone: the outside anchor shows it.
  writeFileSync(f, rechain(good, (l) => (l.tokens === 160_000 ? { ...l, tokens: 60_000 } : l)));
  ws = windowStatus(s);
  assert.equal(ws.changed.by, "anchor");
  assert.ok(ws.windows.every((w) => !w.measurable && w.why === "changed-outside"));
  // Lines added by someone else (with a correct chain) are not Scenaria's: they count for nothing.
  writeFileSync(f, rechain(good + JSON.stringify({ t: "sample", w: "w1", at: "2026-10-18T10:03:00.000Z", tokens: 10_000, model: "claude-opus-5-5", ref: "m:x", c: "" }) + "\n", (l) => l));
  ws = windowStatus(s);
  assert.equal(ws.changed.by, "anchor");
  assert.equal(byId(ws, "w1").why, "changed-outside");
  assert.equal(byId(ws, "w2").fill.value, 10, "the other conversation's window is untouched");
  // Deleting the file shows too.
  writeFileSync(f, "");
  assert.equal(windowStatus(s).changed.by, "anchor");
  // The anchored checkpoint: even with the outside anchor rewritten to match, the checkpoint in the ledger shows it.
  writeFileSync(f, good);
  s.checkpoint({ title: "turn end", meta: { windows: { lines: 3, head: JSON.parse(good.trim().split("\n")[2]).c } } });
  const fake = rechain(good, (l) => (l.tokens === 160_000 ? { ...l, tokens: 60_000 } : l));
  writeFileSync(f, fake);
  const af = anchorFile();
  const a = JSON.parse(readFileSync(af, "utf8"));
  a.chain.sig = JSON.parse(fake.trim().split("\n").pop()).c;
  writeFileSync(af, JSON.stringify(a));
  ws = windowStatus(s);
  assert.deepEqual(ws.changed, { by: "checkpoint", node: s.head().id });
  assert.equal(byId(ws, "w1").why, "changed-outside");
  assert.match(renderWindows(ws, "en"), /no longer matches step/);
  // H2: and editing that checkpoint to match does not help — it is then changed itself (integrity ledger).
  const nf = join(p.dir, ".scenaria", "nodes", `${s.head().id}.json`);
  const node = JSON.parse(readFileSync(nf, "utf8"));
  node.meta.windows.head = JSON.parse(fake.trim().split("\n")[2]).c;
  writeFileSync(nf, JSON.stringify(node, null, 2));
  ws = windowStatus(s);
  assert.equal(ws.changed?.by, "checkpoint");
  assert.equal(byId(ws, "w1").why, "changed-outside");
});

test("E3 window records: a deleted outside anchor confirms nothing; a forged reset line hides nothing (review 2, N1, N2)", () => {
  const { p, s } = project();
  recordWindowEvents(s, WHO, [sampleAt("2026-10-18T10:00:00.000Z", 175_000, "m:1")]);
  const f = join(p.dir, ".scenaria", "windows.jsonl");
  const good = readFileSync(f, "utf8");
  // The end-of-turn checkpoint records the chain (as the hook does).
  s.checkpoint({ title: "turn end", meta: { windows: windowsHead(s) } });
  assert.equal(windowStatus(s).current.fill.value, 87.5);
  // N1: anchor deleted, a low sample appended with a correct chain.
  const af = anchorFile();
  rmSync(af);
  writeFileSync(f, rechain(good + JSON.stringify({ t: "sample", w: "w1", at: "2026-10-18T10:01:00.000Z", tokens: 20_000, model: "claude-opus-5-5", ref: "m:x", c: "" }) + "\n", (l) => l));
  let ws = windowStatus(s);
  assert.equal(ws.changed.by, "anchor");
  assert.equal(ws.current.why, "changed-outside");
  assert.equal(ws.current.fill, undefined);
  // N2: the file rewritten as reset lines and a fake window: the checkpoint's anchor is still checked.
  const reset = (i) => JSON.stringify({ t: "reset", at: `2026-10-18T10:0${i}:00.000Z`, why: "chain", lines: 0, c: "" });
  const fakeWin = JSON.stringify({ t: "open", w: "w9", at: "2026-10-18T10:05:00.000Z", source: "transcript", key: "claude-code:S", agent: "claude-code", start: "restart", c: "" });
  const fakeSample = JSON.stringify({ t: "sample", w: "w9", at: "2026-10-18T10:06:00.000Z", tokens: 20_000, model: "claude-opus-5-5", ref: "m:y", c: "" });
  writeFileSync(f, rechain([reset(1), reset(2), reset(3), fakeWin, fakeSample].join("\n"), (l) => l));
  ws = windowStatus(s);
  assert.equal(ws.windows.find((w) => w.id === "w9").why, "changed-outside");
  assert.equal(ws.changed.by, "checkpoint");
  // Even with a fitting outside anchor written by hand, the checkpoint shows it.
  const lines = readFileSync(f, "utf8").trim().split("\n");
  writeFileSync(af, JSON.stringify({ chain: { rev: 99, status: String(lines.length), sig: JSON.parse(lines.pop()).c } }));
  ws = windowStatus(s);
  assert.deepEqual(ws.changed, { by: "checkpoint", node: s.head().id });
  assert.equal(ws.windows.find((w) => w.id === "w9").why, "changed-outside");
});

test("E3 window records: after a real reset, the next end-of-turn checkpoint confirms it and the measurement lives again", () => {
  const { p, s } = project();
  recordWindowEvents(s, WHO, [sampleAt("2026-10-18T10:00:00.000Z", 150_000, "m:1")]);
  s.checkpoint({ title: "turn 1", meta: { windows: windowsHead(s) } });
  const f = join(p.dir, ".scenaria", "windows.jsonl");
  writeFileSync(f, rechain(readFileSync(f, "utf8"), (l) => (l.tokens ? { ...l, tokens: 50_000 } : l)));
  // Scenaria's next append finds the change and starts again after a reset line …
  recordWindowEvents(s, WHO, [sampleAt("2026-10-18T10:05:00.000Z", 152_000, "m:2")]);
  let ws = windowStatus(s);
  // … the old checkpoint's anchor no longer fits, and nothing confirms the reset yet: no number.
  assert.equal(ws.changed.by, "checkpoint");
  assert.equal(ws.current.why, "changed-outside");
  // The next end-of-turn checkpoint names the reset: the new window counts, the old one never again.
  s.checkpoint({ title: "turn 2", meta: { windows: windowsHead(s) } });
  ws = windowStatus(s);
  assert.equal(ws.changed.by, "restarted");
  assert.equal(ws.current.start, "restart");
  assert.equal(ws.current.fill.value, 76);
  assert.equal(ws.windows.find((w) => w.id === "w1").why, "changed-outside");
});

test("E3 window records: after a change outside, the next append starts the measurement again; old windows stay without a number", () => {
  const { p, s } = project();
  recordWindowEvents(s, WHO, [sampleAt("2026-10-18T10:00:00.000Z", 150_000, "m:1")]);
  const f = join(p.dir, ".scenaria", "windows.jsonl");
  writeFileSync(f, rechain(readFileSync(f, "utf8"), (l) => (l.tokens ? { ...l, tokens: 50_000 } : l)));
  recordWindowEvents(s, WHO, [sampleAt("2026-10-18T10:05:00.000Z", 152_000, "m:2"), sampleAt("2026-10-18T10:06:00.000Z", 154_000, "m:1")]);
  const ws = windowStatus(s);
  assert.equal(ws.changed.by, "restarted");
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // E4: each opening records the progress (a "progress" line after the window's first lines).
  assert.deepEqual(lines.map((l) => l.t), ["open", "sample", "progress", "reset", "open", "sample", "progress"], "the already recorded answer m:1 is not taken again");
  assert.equal(lines[3].why, "rewritten");
  assert.equal(ws.current.id, "w2");
  assert.equal(ws.current.start, "restart");
  assert.equal(ws.current.fill.value, 76);
  assert.equal(ws.windows.find((w) => w.id === "w1").why, "changed-outside");
  assert.match(renderWindows(ws, "de"), /Messung wurde neu begonnen, weil frühere Fenster-Daten nicht bestätigt werden konnten/);
});

test("E3 hook: an unreadable windows record never costs the turn its checkpoint (review M1)", () => {
  const p = tempProject();
  p.write("README.md", "x\n");
  cli(p.dir, ["init"]);
  mkdirSync(join(p.dir, ".scenaria", "windows.jsonl"));
  const tr = join(p.dir, "t.jsonl");
  writeFileSync(tr, line({ type: "user", message: { role: "user", content: "Go" } }) + answer("d1", new Date().toISOString(), { read: 50_000, blocks: ["text"] }));
  const hook = (ev, extra = {}) => cli(p.dir, ["hook", ev], JSON.stringify({ session_id: "S4", cwd: p.dir, transcript_path: tr, ...extra }));
  hook("user-prompt", { prompt: "Go" });
  p.write("app.js", "x");
  assert.equal(hook("stop").status, 0);
  const s = Scenaria.open(p.dir);
  assert.equal(s.head().type, "checkpoint");
  assert.equal(s.head().meta?.windows, undefined);
  assert.equal(windowStatus(s).changed.by, "unreadable");
});

test("E3 P95: only the window's own agent cuts steps; checkpoints without a new answer between them are one cut (review M2)", async () => {
  const { s } = project();
  for (let i = 0; i <= 21; i++) {
    recordWindowEvents(s, WHO, [{ kind: "sample", at: new Date().toISOString(), tokens: 10_000 + i * 5000, model: "claude-opus-5-5", ref: `m:${i}` }]);
    await sleep(3);
    s.checkpoint({ title: `step ${i}`, agent: "claude-code" });
    // A burst of checkpoints without an answer in between …
    for (let k = 0; k < 3; k++) s.checkpoint({ title: `burst ${i}.${k}`, agent: "claude-code" });
    await sleep(3);
    // … and, after an answer in the middle of the step, a checkpoint of another agent.
    recordWindowEvents(s, WHO, [{ kind: "sample", at: new Date().toISOString(), tokens: 12_500 + i * 5000, model: "claude-opus-5-5", ref: `m:${i}.5` }]);
    await sleep(3);
    s.checkpoint({ title: `other ${i}`, agent: "codex" });
    await sleep(3);
  }
  const steps = windowStatus(s).current.soft.inputs.find((x) => x.name === "steps").value;
  // 22 own checkpoints, each followed by an answer: 21 steps of 5,000 (not 2,500: the other agent's checkpoint cuts nothing).
  assert.equal(steps.length, 21);
  assert.ok(steps.every((x) => x === "5000"), steps.join(","));
});

test("E3 many answers in one window; the soft-threshold sentence adds up (review M3, M4)", () => {
  const { s } = project();
  const evs = Array.from({ length: 130_000 }, (_, i) => sampleAt(new Date(Date.UTC(2026, 9, 18, 0, 0, 0) + i * 1000).toISOString(), 1000 + i, `m:${i}`));
  recordWindowEvents(s, WHO, evs);
  const ws = windowStatus(s);
  assert.equal(ws.current.samples, 130_000);
  assert.equal(ws.current.maxTokens, 130_999);
  // 76 tokens handover: buffer 7.04 % shown as 7.1 % (rounded up), so 70 − 7.1 = 62.9 exactly as stated.
  const d = derive("context.soft", "context-soft/1", { cMax: 1_000_000, aModel: 200_000, steps: [], handover: 76, rule: CONTEXT_RULE });
  assert.equal(d.value, 62.9);
  assert.match(d.sentence.de, /^62,9 %: 70 % minus Puffer 7,1 %/);
  assert.match(d.sentence.en, /^62.9 %: 70 % minus a buffer of 7.1 %/);
  // A window size below 1,000 tokens is none (review L3).
  const tiny = derive("x", "context-fill/1", { tokens: 5, cMax: 1e-300, aModel: 200_000, soft: 63, rule: CONTEXT_RULE });
  assert.equal(tiny.value, 0);
  assert.match(tiny.sentence.de, /Ohne Fenstergröße greift die Regel nicht/);
  assert.equal(derive("x", "context-fill/1", { tokens: 5000, cMax: 128_000, aModel: 1e-300, soft: 63, rule: CONTEXT_RULE }).value, 3.9, "without A_model: C_max alone");
  assert.equal(derive("x", "context-fill/1", { tokens: 5, cMax: 1e-300, aModel: 0, soft: 63, rule: CONTEXT_RULE }).value, 0);
  assert.equal(recompute(expand({ key: "x", value: 1, formula: "context-fill/1", inputs: { tokens: 5, cMax: 1e-300, aModel: 1e-300, soft: 63, rule: CONTEXT_RULE } })), 0);
  const huge = derive("x", "context-fill/1", { tokens: 5, cMax: 1e307, aModel: 1e307, soft: 63, rule: CONTEXT_RULE });
  assert.equal(huge.value, 0);
  assert.match(huge.sentence.en, /without a window size the rule does not apply/);
});

test("E3 windows: the conversation an agent asks for; resume; a compaction without an answer yet (review L2)", () => {
  const { s } = project();
  recordWindowEvents(s, { ...WHO, startReason: "resume" }, [sampleAt("2026-10-18T10:00:00.000Z", 120_000, "m:1")]);
  recordWindowEvents(s, { ...WHO, key: "claude-code:T" }, [sampleAt("2026-10-18T10:05:00.000Z", 20_000, "m:2")]);
  let ws = windowStatus(s);
  assert.equal(ws.current.key, "claude-code:T");
  assert.equal(windowStatus(s, { key: "claude-code:S" }).current.start, "resume");
  assert.equal(windowStatus(s, { key: "claude-code:S" }).current.fill.value, 60);
  assert.equal(windowStatus(s, { key: "nope" }).current, null);
  recordWindowEvents(s, WHO, [{ kind: "boundary", at: "2026-10-18T10:06:00.000Z", ref: "b:1", trigger: "manual", preTokens: 120_000 }]);
  ws = windowStatus(s, { key: "claude-code:S" });
  assert.equal(ws.current.start, "compact");
  assert.equal(ws.current.why, "no-sample");
  assert.equal(ws.current.trigger, "manual");
  assert.match(renderWindows(ws, "de"), /noch keine Antwort mit Token-Zahlen/);
});

test("E3 not measurable: unknown model, no tokens, MCP alone — no number, a plain reason", () => {
  const { s } = project();
  let ws = windowStatus(s);
  assert.equal(ws.current, null);
  assert.match(renderWindows(ws, "de"), /Hier nicht messbar: Scenaria hat noch keine Token-Zahlen gesehen/);
  recordWindowEvents(s, { source: "proxy", key: "proxy:ollama:abc", agent: "proxy:ollama" }, [{ kind: "sample", at: "2026-10-18T10:00:00.000Z", tokens: 3000, model: "qwen3.5:9b", ref: "p:1" }]);
  ws = windowStatus(s);
  assert.equal(ws.current.measurable, false);
  assert.equal(ws.current.why, "model-unknown");
  assert.equal(ws.current.fill, undefined);
  assert.match(renderWindows(ws, "de"), /Modell nicht in der Modelltabelle – die Regel greift nicht \(3\.000 Tokens\)/);
  // Zero or broken token counts are no sample.
  assert.equal(recordWindowEvents(s, { source: "proxy", key: "proxy:x", agent: "a" }, [{ kind: "sample", at: "", tokens: 0, ref: "p:2" }, { kind: "sample", at: "", tokens: "lots", ref: "p:3" }]), 0);
});

test("E3 P95 is measured from the steps once there are 20: growth of the fill between two checkpoints", async () => {
  const { s } = project();
  const who = { source: "transcript", key: "claude-code:S", agent: "claude-code" };
  for (let i = 0; i <= 21; i++) {
    recordWindowEvents(s, who, [{ kind: "sample", at: new Date().toISOString(), tokens: 10_000 + i * 3000 + (i >= 20 ? 5000 : 0), model: "claude-opus-5-5", ref: `m:${i}` }]);
    await sleep(3);
    s.checkpoint({ title: `step ${i}`, agent: "claude-code" });
    await sleep(3);
  }
  const ws = windowStatus(s);
  const steps = ws.current.soft.inputs.find((x) => x.name === "steps").value;
  // Steps lie between the window's first and last answer: 21 checkpoints there, 20 steps (19 × 3,000, 1 × 8,000).
  assert.equal(steps.length, 20);
  assert.equal(steps.filter((x) => x === "3000").length, 19);
  assert.ok(steps.includes("8000"));
  // P95 by nearest rank = 3,000 → buffer (3,000 + handover + 4,000) / 200,000.
  const handover = ws.current.soft.inputs.find((x) => x.name === "handover").value;
  assert.ok(handover > 0, "the capsule's size is the handover cost");
  assert.equal(ws.current.soft.value, Math.floor((70 - (100 * (3000 + handover + 4000)) / 200_000) * 10 + 1e-9) / 10);
  assert.match(ws.current.soft.sentence.de, /P95 aus 20 gemessenen Schritten 3\.000/);
});

// ---------------------------------------------------------------- proxy

test("E3 proxy usage: Anthropic (JSON, stream), OpenAI chat (JSON, stream with include_usage), OpenAI responses", () => {
  assert.equal(usageTokens("anthropic", JSON.stringify({ usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } }), false), 60);
  const sse = (evs) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  assert.equal(usageTokens("anthropic", sse([{ type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 1000 } } }, { type: "message_delta", usage: { output_tokens: 9 } }]), true), 1007);
  assert.equal(usageTokens("anthropic", sse([{ type: "message_start", message: { usage: { input_tokens: 7 } } }, { type: "message_delta", usage: { input_tokens: 8, cache_read_input_tokens: 2000, output_tokens: 9 } }]), true), 2008);
  assert.equal(usageTokens("openai-chat", JSON.stringify({ usage: { prompt_tokens: 1234, completion_tokens: 5 } }), false), 1234);
  assert.equal(usageTokens("openai-chat", `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4321 } })}\n\ndata: [DONE]\n\n`, true), 4321);
  assert.equal(usageTokens("openai-chat", `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\ndata: [DONE]\n\n`, true), null, "a stream without include_usage has no number");
  assert.equal(usageTokens("openai-responses", JSON.stringify({ usage: { input_tokens: 99 } }), false), 99);
  assert.equal(usageTokens("openai-responses", `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 77 } } })}\n\n`, true), 77);
  assert.equal(usageTokens("anthropic", "not json", false), null);
  // The id a later request names in previous_response_id (OpenAI Responses only).
  assert.equal(responseId("openai-responses", JSON.stringify({ id: "resp_1", usage: { input_tokens: 1 } }), false), "resp_1");
  assert.equal(responseId("openai-responses", `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_x" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_2" } })}\n\n`, true), "resp_2");
  assert.equal(responseId("openai-responses", JSON.stringify({ id: "../../x" }), false), null);
  assert.equal(responseId("openai-chat", JSON.stringify({ id: "chatcmpl-1" }), false), null);
  assert.equal(usageTokens("other", JSON.stringify({ usage: { prompt_tokens: 3 } }), false), null);
});

test("E3 proxy: each answer's usage is a sample of its conversation; a sharp drop starts a new window", async () => {
  let next = 150_000;
  const up = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: next } }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { s } = project();
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { openai: `http://127.0.0.1:${up.address().port}/v1` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (n) => {
    next = n;
    const r = await fetch(`${base}/proxy/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-user", "x-scenaria-session": "conv-1" }, body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "Write notes" }] }) });
    await r.text();
    await sleep(50);
  };
  try {
    await ask(150_000);
    await ask(180_000);
    let ws = windowStatus(s);
    assert.equal(ws.current.source, "proxy");
    assert.equal(ws.current.model, "gpt-5");
    assert.equal(ws.current.samples, 2);
    assert.equal(ws.current.fill.value, 90, "180,000 of C_eff 200,000 (gpt-5: C_max 400,000)");
    await ask(20_000);
    ws = windowStatus(s);
    assert.equal(ws.current.id, "w2");
    assert.equal(ws.current.start, "drop");
    assert.equal(ws.windows.find((w) => w.id === "w1").end, "drop");
    // The route is read-only.
    const j = await (await fetch(`${base}/api/windows`, { headers: { "x-scenaria": "1" } })).json();
    assert.equal(j.current.fill.formula, "context-fill/1");
    assert.equal(j.current.soft.formula, "context-soft/1");
    assert.equal(recompute(j.current.fill), j.current.fill.value);
    const post = await fetch(`${base}/api/windows`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ tokens: 1 }) });
    assert.ok(post.status >= 400);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});

test("E3 proxy end to end: Anthropic stream, OpenAI Responses with previous_response_id, an answer without text (review L1)", async () => {
  let n = 0;
  const up = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b || "{}");
    n++;
    if (req.url.endsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { model: body.model, usage: { input_tokens: 10, cache_read_input_tokens: 150_000 } } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } });
      ev("message_delta", { usage: { output_tokens: 5 } });
      ev("message_stop", {});
      return res.end();
    }
    if (req.url.endsWith("/responses")) {
      res.writeHead(200, { "content-type": "application/json" });
      // A tool call only: no text in the answer.
      return res.end(JSON.stringify({ id: `resp_${n}`, output: [{ type: "function_call", name: "f", arguments: "{}" }], usage: { input_tokens: 20_000 * n } }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { s } = project();
  const cfg = s.config();
  cfg.proxy = { ...(cfg.proxy ?? {}), upstreams: { anthropic: `http://127.0.0.1:${up.address().port}`, openai: `http://127.0.0.1:${up.address().port}/v1` }, autoCheckpoint: false };
  s.store.writeConfig(cfg);
  const app = createApp(s, {});
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk" }, body: JSON.stringify(body) });
    await r.text();
    await sleep(50);
  };
  try {
    await post("/proxy/anthropic/v1/messages", { model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "Hi" }] });
    let ws = windowStatus(s);
    assert.equal(ws.current.tokens, 150_010);
    assert.equal(ws.current.fill.value, 75);
    await post("/proxy/openai/v1/responses", { model: "gpt-5", input: "Plan the trip" });
    await post("/proxy/openai/v1/responses", { model: "gpt-5", input: "And the hotel?", previous_response_id: "resp_2" });
    await post("/proxy/openai/v1/responses", { model: "gpt-5", input: "And the train?", previous_response_id: "resp_3" });
    ws = windowStatus(s);
    const resp = ws.windows.filter((w) => w.model === "gpt-5");
    assert.equal(resp.length, 1, "previous_response_id keeps the conversation in one window");
    assert.equal(resp[0].samples, 3);
    assert.equal(resp[0].tokens, 80_000);
    assert.equal(resp[0].fill.value, 40);
    // N4: an upstream the client names itself could report any number: nothing is recorded from it.
    const before = windowStatus(s).windows.length;
    const r = await fetch(`${base}/proxy/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk", "x-scenaria-upstream": `http://127.0.0.1:${up.address().port}` }, body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "Other" }] }) });
    await r.text();
    await sleep(50);
    assert.equal(windowStatus(s).windows.length, before);
    // Another client naming someone's response id does not join that conversation.
    await fetch(`${base}/proxy/openai/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk", "x-scenaria-agent": "intruder" }, body: JSON.stringify({ model: "gpt-5", input: "x", previous_response_id: "resp_4" }) }).then((x) => x.text());
    await sleep(50);
    const gpt = windowStatus(s).windows.filter((w) => w.model === "gpt-5");
    assert.equal(gpt.length, 2);
    assert.equal(gpt.find((w) => w.agent === "intruder").samples, 1);
    assert.equal(gpt.find((w) => w.agent !== "intruder").samples, 3);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
    up.close();
  }
});

// ---------------------------------------------------------------- tool and CLI

test("E3 scenaria_window and scenaria window: read-only, the zone and how it is computed", () => {
  const { p, s } = project();
  recordWindowEvents(s, { source: "transcript", key: "claude-code:S", agent: "claude-code" }, [{ kind: "sample", at: "2026-10-18T10:00:00.000Z", tokens: 130_000, model: "claude-opus-5-5", ref: "m:1" }]);
  const tool = TOOLS.find((t) => t.name === "scenaria_window");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys(tool.input), ["window"], "nothing to set");
  const r = callTool(s, "scenaria_window", {}, ctx);
  assert.match(r.text, /w1 · claude-code · claude-opus-5-5 · start: new session/);
  assert.match(r.text, /65 %: 130,000 tokens of C_eff 200,000/);
  assert.equal(r.data.current.zone, "orange");
  assert.equal(r.data.current.fill.formula, "context-fill/1");
  assert.equal(r.data.current.fill.sentence, undefined, "agents get the short form");
  assert.equal(recompute(r.data.current.fill), 65);
  assert.throws(() => callTool(s, "scenaria_window", { window: "w9" }, ctx), /not a window/);
  const c = spawnSync(process.execPath, [CLI, "window", "--root", p.dir, "--lang", "de"], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  assert.match(plain(c.stdout), /65 %: 130\.000 Tokens von C_eff 200\.000 \(A_modell; C_max 1\.000\.000, A_modell 200\.000\)\. Zone orange\. Nächste Grenze: 70 % \(rot\)\./);
  assert.match(plain(c.stdout), /Ab Orange sichert Scenaria automatisch einen Schritt/);
  const cj = spawnSync(process.execPath, [CLI, "window", "w1", "--root", p.dir, "--json"], { encoding: "utf8" });
  assert.equal(cj.status, 0, cj.stderr);
  assert.equal(JSON.parse(cj.stdout).windows[0].fill.value, 65);
});
