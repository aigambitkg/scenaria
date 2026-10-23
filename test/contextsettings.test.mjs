// Batch E3b-1: the person's values for the context-window rule — signed, outside the project, versioned, logged;
// every number names the values in force; local models (Ollama) get a window size the person enters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { callTool, TOOLS } from "../dist/tools.js";
import { CONTEXT_RULE, recompute, parseContextRule } from "../dist/core/derivation.js";
import { windowStatus, recordWindowEvents, quickFill, renderWindows } from "../dist/core/window.js";
import { contextAdvice, cutDue, cutIfDue } from "../dist/core/windowact.js";
import { readContextSettings, setContextSettings, describeSettings, CONTEXT_DEFAULTS, ruleOf } from "../dist/core/contextsettings.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ctx = { source: "mcp", agent: "claude-code" };
const KEY = "claude-code:S";
const WHO = { source: "transcript", key: KEY, agent: "claude-code" };
let clock = Date.parse("2026-10-23T10:00:00.000Z");
const at = () => new Date((clock += 60_000)).toISOString();
const sample = (tokens, ref, model = "claude-opus-5-5") => ({ kind: "sample", at: at(), tokens, model, ref });
const kev = { by: "kev", via: "terminal" };
const settingsFile = () => join(process.env.SCENARIA_HOME, "context-settings.json");

function project() {
  const p = tempProject();
  p.write("README.md", "hello\n");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Reports people can trust", title: "Q3 report", goal: "Write the report" });
  return { p, s };
}

test("E3b-1 default: the start values v1.0, exactly the rule of E3a", () => {
  const { s } = project();
  const cs = readContextSettings(s.store);
  assert.equal(cs.trust, "default");
  assert.equal(cs.rule, CONTEXT_RULE);
  assert.deepEqual(cs.values, { yellow: 50, red: 70, emergency: 85, p95start: 5, margin: 2, aModel: 200_000 });
  assert.equal(ruleOf(CONTEXT_DEFAULTS), CONTEXT_RULE, "the start values give exactly the rule string of v1.0");
  assert.equal(windowStatus(s).settings.trust, "default");
});

test("E3b-1 the person's values: signed, versioned, logged; every number names them and can be recomputed", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(124_000, "m:1")]); // 62 % of 200,000
  assert.equal(windowStatus(s).current.zone, "yellow");
  const cs = setContextSettings(s.store, { values: { red: 60, emergency: 80 } }, kev);
  assert.equal(cs.trust, "verified");
  assert.equal(cs.set.rev, 1);
  assert.match(cs.rule, /^v1\.0-p1 yellow=50 red=60 emergency=80 floor=50 p95start=5 margin=2 minSteps=20$/);
  const w = windowStatus(s).current;
  assert.equal(w.zone, "red", "62 % is red under the person's line of 60 %");
  assert.equal(w.rule, cs.rule);
  assert.equal(parseContextRule(w.fill.inputs.find((i) => i.name === "rule").value).version, "v1.0-p1");
  assert.match(w.fill.sentence.de, /Regel v1\.0-p1\./);
  assert.equal(recompute(w.fill), w.fill.value, "recomputed from its own inputs");
  // A second change: revision 2; the event log names each change.
  setContextSettings(s.store, { values: { aModel: 100_000 } }, kev);
  const w2 = windowStatus(s).current;
  assert.equal(w2.cEff, 100_000);
  assert.equal(w2.fill.value, 124, "124,000 of A_model 100,000 — more than full");
  assert.equal(w2.zone, "emergency");
  const ev = s.store.readEvents().filter((e) => e.data?.contextSettings);
  assert.deepEqual(ev.map((e) => e.data.contextSettings.rev), [1, 2]);
  assert.match(ev[1].data.message, /v1\.0-p2 by kev via terminal/);
  // The text for people names what differs from the start values.
  assert.match(windowStatus(s).settings.text.de, /^Regel v1\.0-p2, von kev gesetzt: Rot ab 60 %, Notsicherung ab 80 %, A_modell 100\.000 Tokens\.$/);
  assert.match(renderWindows(windowStatus(s), "en"), /Rule v1\.0-p2, set by kev: red from 60 %, emergency from 80 %, A_model 100,000 tokens\./);
  // Back to the start values: a new signed revision (the history is the log).
  const back = setContextSettings(s.store, { reset: true }, kev);
  assert.equal(back.set.rev, 3);
  assert.deepEqual(back.values, CONTEXT_DEFAULTS);
  assert.match(back.rule, /^v1\.0-p3 /);
});

test("E3b-1 the automatic saves follow the person's lines", () => {
  const { s } = project();
  setContextSettings(s.store, { values: { yellow: 40, red: 55, emergency: 75 } }, kev);
  recordWindowEvents(s, WHO, [sample(84_000, "m:1")]); // 42 %: yellow under the person's lines (green under v1.0)
  let a = contextAdvice(s, KEY);
  assert.equal(a.zone, "yellow", "the cheap first look uses the person's yellow line too");
  recordWindowEvents(s, WHO, [sample(112_000, "m:2")]); // 56 %
  a = contextAdvice(s, KEY);
  assert.equal(a.zone, "red");
  assert.equal(cutDue(a, "now"), true);
  const cut = cutIfDue(s, KEY, "now", { source: "hook" }).node;
  assert.match(cut.meta.contextCut.rule, /^v1\.0-p1 yellow=40 red=55/);
  assert.match(cut.outputs[0], /\(rule v1\.0-p1;/);
});

test("E3b-1 what does not count: an edited, an older, a copied or a forged setting — the start values apply and it says so", () => {
  const { p, s } = project();
  setContextSettings(s.store, { values: { red: 60, emergency: 80 } }, kev);
  const good = readFileSync(settingsFile(), "utf8");
  // Edited by hand (red raised so the agent may run longer).
  const j = JSON.parse(good);
  // This project's entry (bound to its real folder).
  const k = Object.keys(j.projects).find((x) => x.endsWith(`:${realpathSync(p.dir)}`));
  const last = j.projects[k].revisions.at(-1);
  last.red = 90;
  last.emergency = 95;
  writeFileSync(settingsFile(), JSON.stringify(j));
  let cs = readContextSettings(s.store);
  assert.equal(cs.trust, "invalid");
  assert.equal(cs.rule, CONTEXT_RULE);
  recordWindowEvents(s, WHO, [sample(150_000, "m:1")]);
  assert.equal(windowStatus(s).current.zone, "red", "75 % is red under the start values");
  assert.equal(cs.why, "signature");
  assert.match(renderWindows(windowStatus(s), "de"), /Achtung: Die Einstellung der Person zählt nicht: eine Signatur passt nicht/);
  // An older signed revision put back does not count.
  writeFileSync(settingsFile(), good);
  assert.equal(readContextSettings(s.store).trust, "verified");
  setContextSettings(s.store, { values: { red: 65 } }, kev);
  writeFileSync(settingsFile(), good);
  assert.equal(readContextSettings(s.store).trust, "invalid", "revision 1 after revision 2 was seen");
  assert.equal(readContextSettings(s.store).why, "older");
  // A forged entry without a signature.
  const f = JSON.parse(good);
  f.projects[k].revisions = [{ ...f.projects[k].revisions[0], rev: 99, sig: undefined }];
  writeFileSync(settingsFile(), JSON.stringify(f));
  assert.equal(readContextSettings(s.store).trust, "invalid");
  // After an invalid setting the person sets again: a new history begins, the revision number never goes back.
  const again = setContextSettings(s.store, { values: { red: 66 } }, kev);
  assert.equal(again.trust, "verified");
  assert.ok(again.set.rev >= 3, `revision ${again.set.rev}`);
  assert.deepEqual(again.history.map((h) => h.rev), [again.set.rev]);
  assert.equal(again.restarted.length, 1);
  assert.match(describeSettings(again).de, /Verlauf neu begonnen bei p\d+, weil der frühere nicht prüfbar war \(eine Signatur passt nicht/);
  writeFileSync(settingsFile(), good);
  assert.equal(readContextSettings(s.store).trust, "invalid", "the old revision 1 still does not count after the restart");
  setContextSettings(s.store, { values: { red: 67 } }, kev);
  // A copied project folder starts at the start values (the entry belongs to the real folder).
  const copy = mkdtempSync(join(tmpdir(), "copy-"));
  cpSync(p.dir, copy, { recursive: true });
  const c = Scenaria.open(copy);
  assert.equal(readContextSettings(c.store).trust, "default");
  assert.equal(readContextSettings(c.store).elsewhere, realpathSync(p.dir), "it says where the setting is");
  assert.match(windowStatus(c).settings.text.de, /eine Einstellung in einem anderen Ordner .*nicht übernommen/);
  // Moving the entry to the copy's folder by hand does not carry it over either (the folder is signed).
  const moved = JSON.parse(readFileSync(settingsFile(), "utf8"));
  moved.projects[k.replace(realpathSync(p.dir), realpathSync(copy))] = moved.projects[k];
  writeFileSync(settingsFile(), JSON.stringify(moved));
  assert.equal(readContextSettings(c.store).trust, "invalid");
  assert.equal(readContextSettings(c.store).why, "signature");
  assert.equal(readContextSettings(c.store).rule, CONTEXT_RULE);
  // Nothing stored in the project.
  assert.doesNotMatch(JSON.stringify(s.config()), /red|emergency|aModel/);
});

test("E3b-1 values are checked: bounds, order, one decimal, whole tokens", () => {
  const { s } = project();
  const bad = (values, code) => assert.throws(() => setContextSettings(s.store, { values }, kev), (e) => e.code === code, JSON.stringify(values));
  bad({ red: 5 }, "out_of_range");
  bad({ yellow: 80 }, "order");
  bad({ emergency: 65 }, "order");
  bad({ margin: 2.25 }, "precision");
  bad({ aModel: 120_000.5 }, "precision");
  bad({ aModel: 1000 }, "out_of_range");
  bad({ red: "72" }, "not_a_number");
  assert.equal(readContextSettings(s.store).trust, "default", "nothing was stored");
  assert.equal(setContextSettings(s.store, { values: { yellow: 47.5 } }, kev).values.yellow, 47.5);
  assert.throws(() => setContextSettings(s.store, { values: { yellow: 47.5 } }, kev), (e) => e.code === "unchanged", "no empty revisions");
  // Only the six values are stored (review L4).
  setContextSettings(s.store, { values: { red: 71, floor: 10, minSteps: 1, note: "x" } }, kev);
  const stored = JSON.stringify(JSON.parse(readFileSync(settingsFile(), "utf8")));
  assert.doesNotMatch(stored, /minSteps|"note"|"floor"/);
});

test("E3b-1 local models: the person enters the window size; a documented size is never overridden", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(20_000, "m:1", "qwen3.5:9b")]);
  assert.equal(windowStatus(s).current.why, "model-unknown");
  assert.equal(quickFill(s, KEY), null);
  setContextSettings(s.store, { models: [{ id: "Qwen3.5:9b", cMax: 32_768 }] }, kev);
  const w = windowStatus(s).current;
  assert.equal(w.measurable, true);
  assert.equal(w.cEff, 32_768, "C_eff = min(C_max entered, A_model)");
  assert.equal(w.fill.value, 61);
  assert.match(w.modelSource.source, /^entered by the person \(v1\.0-p1\)$/);
  assert.equal(quickFill(s, KEY).fill, 61);
  assert.match(renderWindows(windowStatus(s), "de"), /Fenstergröße von der Person eingetragen/);
  assert.throws(() => setContextSettings(s.store, { models: [{ id: "claude-opus-5-5", cMax: 50_000 }] }, kev), (e) => e.code === "model_documented");
  for (const alias of ["us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5@20261001", "claude-opus-5-5-latest", "azure/gpt-5", "openrouter/anthropic/claude-opus-5-5"])
    assert.throws(() => setContextSettings(s.store, { models: [{ id: alias, cMax: 10_000_000 }] }, kev), (e) => e.code === "model_documented", alias);
  // Strict on purpose: a name built on a documented model (also "gpt-5-mini") is refused — hand entries are for local
  // models; a provider's model gets its size from the documented table.
  assert.throws(() => setContextSettings(s.store, { models: [{ id: "gpt-5-mini", cMax: 8192 }] }, kev), (e) => e.code === "model_documented");
  assert.doesNotThrow(() => setContextSettings(s.store, { models: [{ id: "qwen3.5:9b", cMax: 32_768 }, { id: "llama3:8b", cMax: 8192 }] }, kev));
  assert.throws(() => setContextSettings(s.store, { models: [{ id: "x", cMax: 10 }] }, kev), (e) => e.code === "model_size");
  assert.throws(() => setContextSettings(s.store, { models: [{ id: "x", cMax: 5000 }, { id: "X", cMax: 6000 }] }, kev), (e) => e.code === "model_twice");
});

test("E3b-1 only the person: no tool takes these values; HTTP needs the approval session; the terminal needs a person", async () => {
  for (const t of TOOLS) for (const name of Object.keys(t.input ?? {})) assert.ok(!["yellow", "red", "emergency", "aModel", "margin", "p95start", "models"].includes(name), `${t.name}.${name}`);
  const { p, s } = project();
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agentH = { "x-scenaria": "1", "x-scenaria-agent": "codex" };
  const person = { "x-scenaria": "1", cookie: "scenaria_approval=sess" };
  const post = (body, h) => fetch(`${base}/api/context-settings`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  try {
    const got = await (await fetch(`${base}/api/context-settings`, { headers: agentH })).json();
    assert.equal(got.trust, "default");
    assert.deepEqual(got.defaults, CONTEXT_DEFAULTS);
    assert.deepEqual(got.bounds.red, [20, 95]);
    assert.equal(got.approval, false);
    let r = await post({ values: { red: 90, emergency: 95 } }, agentH);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "approval_required");
    assert.equal(readContextSettings(s.store).trust, "default");
    r = await post({ values: { red: 30 } }, person);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "order");
    r = await post({ values: { red: 72 }, models: [{ id: "llama3", cMax: 8192 }] }, person);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.set.via, "dashboard");
    assert.match(body.rule, /^v1\.0-p1 yellow=50 red=72/);
    assert.deepEqual(body.models, [{ id: "llama3", cMax: 8192 }]);
    assert.equal((await post({ reset: true }, person)).status, 200);
    assert.equal(readContextSettings(s.store).values.red, 70);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
  }
  // CLI: anyone may look; setting it needs an interactive terminal.
  const c = spawnSync(process.execPath, [CLI, "window", "settings"], { cwd: p.dir, encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /Context-window rule v1\.0-p2 — set by .* \(signed; 2 revisions kept\)/);
  const set = spawnSync(process.execPath, [CLI, "window", "settings", "set", "red=90", "emergency=95"], { cwd: p.dir, encoding: "utf8", input: "set\n" });
  assert.notEqual(set.status, 0);
  assert.match(set.stderr, /the person's setting: run this in an interactive terminal/);
  assert.equal(readContextSettings(s.store).values.red, 70);
  assert.equal(callTool(s, "scenaria_window", {}, ctx).data.rule, readContextSettings(s.store).rule);
});

test("E3b-1 review: the history of every revision is kept outside the project, signed; the log cannot rewrite it", () => {
  const { p, s } = project();
  setContextSettings(s.store, { values: { red: 90, emergency: 95 } }, kev);
  setContextSettings(s.store, { values: { red: 70, emergency: 85 } }, kev);
  let cs = readContextSettings(s.store);
  assert.deepEqual(cs.history.map((h) => [h.rev, h.rule.split(" ").slice(0, 3).join(" ")]), [[1, "v1.0-p1 yellow=50 red=90"], [2, "v1.0-p2 yellow=50 red=70"]]);
  // Someone rewrites the project's event log: the history outside is untouched.
  const ev = s.store.path("events.jsonl");
  writeFileSync(ev, readFileSync(ev, "utf8").split("\n").filter((l) => !l.includes("contextSettings")).join("\n"));
  assert.equal(readContextSettings(s.store).history.length, 2);
  // Removing the revision in between from the history shows.
  const j = JSON.parse(readFileSync(settingsFile(), "utf8"));
  const k = Object.keys(j.projects).find((x) => x.endsWith(`:${realpathSync(p.dir)}`));
  j.projects[k].revisions.splice(0, 1);
  writeFileSync(settingsFile(), JSON.stringify(j));
  cs = readContextSettings(s.store);
  assert.equal(cs.trust, "invalid");
  assert.equal(cs.why, "history");
});

test("E3b-1 review: a signed entry with an edited model size, another channel or a now-documented model", async () => {
  const { signRecord } = await import("../dist/core/canon.js");
  const { p, s } = project();
  setContextSettings(s.store, { values: { red: 60, emergency: 80 }, models: [{ id: "llama3", cMax: 8192 }] }, kev);
  const good = readFileSync(settingsFile(), "utf8");
  const edit = (fn) => {
    const j = JSON.parse(good);
    const k = Object.keys(j.projects).find((x) => x.endsWith(`:${realpathSync(p.dir)}`));
    fn(j.projects[k].revisions.at(-1));
    writeFileSync(settingsFile(), JSON.stringify(j));
    return readContextSettings(s.store);
  };
  assert.equal(edit((e) => (e.models[0].cMax = 1_000_000)).why, "signature", "the model size is signed");
  assert.equal(edit((e) => (e.via = "api")).why, "unreadable", "only dashboard or terminal");
  // A correctly signed revision that names a model the table documents now (a later table): that row is dropped,
  // the person's lines stay, and it is said plainly.
  const cs = edit((e) => {
    e.models = [{ id: "gpt-5", cMax: 50_000 }, { id: "llama3", cMax: 8192 }];
    const folder = realpathSync(p.dir);
    const sg = signRecord(s.store, ["context-settings/v1", folder, e.yellow, e.red, e.emergency, e.p95start, e.margin, e.aModel, e.models.map((m) => [m.id, m.cMax]), null, e.rev, e.at, e.by, e.via]);
    e.pub = sg.pub;
    e.sig = sg.sig;
  });
  assert.equal(cs.trust, "verified");
  assert.equal(cs.values.red, 60);
  assert.deepEqual(cs.dropped, ["gpt-5"]);
  assert.deepEqual(cs.models, [{ id: "llama3", cMax: 8192 }]);
  assert.match(windowStatus(s).settings.text.de, /Jetzt in der Modelltabelle belegt \(es gilt die Größe des Anbieters\): gpt-5\./);
  recordWindowEvents(s, WHO, [sample(200_000, "m:g", "gpt-5")]);
  assert.equal(windowStatus(s).current.cMax, 400_000, "the documented size, not the entry");
});

test("E3b-1 review: looser values are named; the derivation says where C_max comes from; quickFill uses A_model", () => {
  const { s } = project();
  setContextSettings(s.store, { values: { yellow: 60, red: 80, emergency: 90, p95start: 0, margin: 0, aModel: 50_000 }, models: [{ id: "qwen3.5:9b", cMax: 32_768 }] }, kev);
  const cs = readContextSettings(s.store);
  assert.deepEqual(cs.looser, ["yellow", "red", "emergency", "buffer"]);
  assert.match(windowStatus(s).settings.text.de, /Lockerer als die Startwerte: Gelb ab 60 % \(Start 50 %\), Rot ab 80 % \(Start 70 %\), Notsicherung ab 90 % \(Start 85 %\), kein Puffer/);
  recordWindowEvents(s, WHO, [sample(16_384, "m:1", "qwen3.5:9b")]);
  const w = windowStatus(s).current;
  assert.match(w.fill.inputs.find((i) => i.name === "cMaxSource").value, /^entered by the person \(rule v1\.0-p1, /);
  assert.match(w.fill.expression.de, /laut der Eingabe „Regel“/);
  assert.doesNotMatch(w.fill.expression.de, /rot ab 70 %/);
  // A_model 50,000 is larger than 32,768: C_eff is the entered size; with a smaller A_model the cheap look follows it.
  assert.equal(quickFill(s, KEY).fill, 50);
  setContextSettings(s.store, { values: { aModel: 16_384 } }, kev);
  assert.equal(quickFill(s, KEY).fill, 100, "quickFill uses the person's A_model");
  assert.match(renderWindows(windowStatus(s), "en"), /rule v1\.0-p2\./, "the footer names the revision");
});

test("E3b-1 review: the terminal checks before it asks; a no-op is refused", () => {
  const { p } = project();
  const run = (...a) => spawnSync(process.execPath, [CLI, "window", "settings", ...a], { cwd: p.dir, encoding: "utf8", input: "set\n" });
  assert.match(run("set", "red=99").stderr, /red must be between 20 and 95/);
  assert.match(run("model", "llama3", "lots").stderr, /no window size/);
  assert.match(run("model", "nothing", "remove").stderr, /No window size was entered for nothing/);
  assert.match(run("reset").stderr, /Nothing changes/);
  assert.match(run("set", "red=72").stderr, /interactive terminal/, "a valid change still needs the person");
});

test("E3b-1 review 2: an older revision rewritten shows; a restart keeps the earlier revisions apart and never reuses a number", () => {
  const { p, s } = project();
  setContextSettings(s.store, { values: { red: 95, emergency: 99 } }, kev); // p1: lenient
  setContextSettings(s.store, { values: { red: 70, emergency: 85 } }, kev); // p2
  setContextSettings(s.store, { values: { red: 66 } }, kev); // p3
  const file = () => JSON.parse(readFileSync(settingsFile(), "utf8"));
  const k = Object.keys(file().projects).find((x) => x.endsWith(`:${realpathSync(p.dir)}`));
  // Rewriting the lenient OLD revision (to hide the period) shows: every revision's signature is checked.
  let j = file();
  j.projects[k].revisions[0].red = 72;
  writeFileSync(settingsFile(), JSON.stringify(j));
  assert.equal(readContextSettings(s.store).why, "signature");
  // The marks entry is lost too; the person sets again: the history starts again, nothing is thrown away, no number is reused.
  const marks = join(process.env.SCENARIA_HOME, "context-settings.marks.json");
  const mk = JSON.parse(readFileSync(marks, "utf8"));
  delete mk.marks[k];
  writeFileSync(marks, JSON.stringify(mk));
  const cs = setContextSettings(s.store, { values: { red: 80 } }, kev);
  assert.equal(cs.set.rev, 4, "above every number in the file, verified or not");
  assert.match(cs.rule, /^v1\.0-p4 /);
  assert.deepEqual(cs.restarted.map((r) => [r.from, r.after, r.why, r.earlier]), [[4, 3, "signature", 3]]);
  j = file();
  assert.equal(j.projects[k].earlier[0].revisions.length, 3, "the earlier revisions are kept apart");
  assert.equal(j.projects[k].revisions.length, 1);
  // Removing the restart note from the new revision breaks its signature.
  j.projects[k].revisions[0].restart = undefined;
  writeFileSync(settingsFile(), JSON.stringify(j));
  assert.equal(readContextSettings(s.store).why, "signature");
});

test("E3b-1 review 2: the mark's start of history cannot point past it; the same models in another order are no change; dotted aliases", () => {
  const { p, s } = project();
  setContextSettings(s.store, { models: [{ id: "llama3", cMax: 8192 }, { id: "qwen3.5:9b", cMax: 32_768 }] }, kev);
  assert.throws(() => setContextSettings(s.store, { models: [{ id: "qwen3.5:9b", cMax: 32_768 }, { id: "llama3", cMax: 8192 }] }, kev), (e) => e.code === "unchanged");
  const marks = join(process.env.SCENARIA_HOME, "context-settings.marks.json");
  const mk = JSON.parse(readFileSync(marks, "utf8"));
  const k = Object.keys(mk.marks).find((x) => x.endsWith(`:${realpathSync(p.dir)}`));
  mk.marks[k] = { rev: 1, first: 5 };
  writeFileSync(marks, JSON.stringify(mk));
  assert.equal(readContextSettings(s.store).trust, "verified", "a start past the mark is ignored (clamped to 1)");
  mk.marks[k] = { rev: 2, first: 2 };
  writeFileSync(marks, JSON.stringify(mk));
  assert.equal(readContextSettings(s.store).trust, "invalid", "the history must start where the mark says");
  for (const alias of ["claude-opus-5.5", "anthropic/claude-opus-5.5", "openrouter/openai/gpt-5.1", "gemini_4_argon"])
    assert.throws(() => setContextSettings(s.store, { models: [{ id: alias, cMax: 9000 }] }, kev), (e) => e.code === "model_documented" || e.code === "unchanged", alias);
});

test("E3b-1 review 2: both derivations name where C_max comes from", () => {
  const { s } = project();
  recordWindowEvents(s, WHO, [sample(100_000, "m:1")]);
  const w = windowStatus(s).current;
  for (const d of [w.fill, w.soft]) assert.match(d.inputs.find((i) => i.name === "cMaxSource")?.value ?? "", /^https:\/\/platform\.claude\.com\/.* \(read 2026-10-18\)$/, d.key);
});
