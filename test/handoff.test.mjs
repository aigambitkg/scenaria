// v0.5: context fidelity, integrity ledger, global workspace, references,
// theory-of-mind deltas, predictive coding (expectations), confidence per statement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { ledgerAnchorFile } from "../dist/core/seal.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { applyBlocks } from "../dist/core/blocks.js";
import { tempProject } from "./helpers.mjs";

const ctx = { source: "mcp", agent: "a" };

function project() {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "Invoice SaaS for freelancers with PDF export and payment reminders", title: "PDF export", goal: "Export invoices as PDF files" });
  const d = s.decide({ question: "Which PDF library for invoice export?", options: ["pdfkit", "puppeteer"], chosen: "pdfkit", rationale: "small footprint for invoice PDF export", context: "invoices must render on small VMs", servesGoal: "PDF export for freelancers", confidence: 0.8 });
  p.write("pdf.ts", "x");
  const c = s.checkpoint({ title: "Invoice PDF export works", outputs: ["`pdf.ts` renders invoice PDF"], facts: [{ text: "pdfkit renders an invoice PDF in 300 ms", confidence: 0.9, basedOn: [d.id] }, { text: "fonts embed correctly in invoice PDF", confidence: 0.5 }] });
  return { p, s, d, c };
}

test("integrity ledger: edits outside Scenaria and an edited ledger are detected", () => {
  const { p, s, d } = project();
  assert.deepEqual([...s.integrity().state.values()].filter((x) => x !== "ok"), []);
  // Legitimate changes through Scenaria keep the ledger in sync.
  s.choose(d.id, "puppeteer", "need HTML templates");
  s.verify(d.id, { status: "passed" });
  assert.equal(s.integrity().state.get(d.id), "ok");
  // Hand edit of a node file → tampered, and the health check reports it.
  const f = join(p.dir, ".scenaria/nodes", `${d.id}.json`);
  const n = JSON.parse(readFileSync(f, "utf8"));
  n.rationale = "the boss said so";
  writeFileSync(f, JSON.stringify(n));
  assert.equal(s.integrity().state.get(d.id), "tampered");
  const h = callTool(s, "scenaria_health", {}, ctx);
  assert.match(h.text, /changed outside Scenaria/);
  const fid = s.fidelity().points;
  assert.ok(fid[d.id].flags.includes("tampered") && fid[d.id].score <= 25);
  const later = s.store.listNodes().find((x) => x.type === "checkpoint");
  assert.ok(fid[later.id].flags.includes("builtOnTampered"));
  // Editing the ledger itself breaks its chain.
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  const lines = readFileSync(lf, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.hash = "0".repeat(32);
  lines[0] = JSON.stringify(first);
  writeFileSync(lf, lines.join("\n") + "\n");
  assert.equal(s.integrity().ledgerBrokenAt, 1);
});

test("existing projects are sealed once on upgrade (no false alarms)", () => {
  const { p } = project();
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  rmSync(lf); // pretend: project from before the ledger (so this machine never anchored one either)
  rmSync(join(p.dir, ".scenaria/ledger.sealed"));
  rmSync(ledgerAnchorFile(p.dir), { force: true });
  const s2 = Scenaria.open(p.dir);
  assert.ok([...s2.integrity().state.values()].every((x) => x === "ok"));
  assert.match(readFileSync(lf, "utf8"), /"op":"seal"/);
});

test("a deleted ledger is reported, never resealed silently; reseal keeps the old ledger", () => {
  const { p, d } = project();
  rmSync(join(p.dir, ".scenaria/ledger.jsonl"));
  const s = Scenaria.open(p.dir);
  const i = s.integrity();
  assert.equal(i.ledgerMissing, true);
  assert.match(callTool(s, "scenaria_health", {}, ctx).text, /ledger was deleted/);
  s.verify(d.id, { status: "passed" }); // a later write must not hide the gap for the other nodes
  assert.equal(s.integrity().ledgerMissing, false);
  assert.ok([...s.integrity().state.values()].includes("unsealed") || [...s.integrity().state.values()].includes("tampered"));
  assert.equal(s.integrity().ledgerReplaced, true, "the recreated ledger is not the anchored one");
  assert.throws(() => s.reseal({ user: "kev" }), /person's action/);
  const r = s.reseal({ kind: "person", via: "terminal" }, { user: "kev" });
  assert.ok(r.nodes > 0);
  assert.equal(r.record.verified, true);
  const after = s.integrity();
  assert.ok([...after.state.values()].every((x) => x === "ok"));
  assert.equal(after.ledgerReplaced, false);
  assert.deepEqual(after.resealsUnproven, []);
});

test("ledger: a torn line from an interrupted write is no alarm; verification edits count as tampering", () => {
  const { p, s, d } = project();
  const lf = join(p.dir, ".scenaria/ledger.jsonl");
  writeFileSync(lf, readFileSync(lf, "utf8") + '{"ts":"2026-10-11T10:00:00Z","id":"n2","ha'); // torn, no newline
  s.update(d.id, { title: "PDF library" });
  const i = s.integrity();
  assert.equal(i.ledgerBrokenAt, null);
  assert.equal(i.torn, 1);
  assert.ok([...i.state.values()].every((x) => x === "ok"));
  // flipping a verdict by hand is manipulation too
  s.verify(d.id, { status: "failed", notes: "wrong" });
  const f = join(p.dir, ".scenaria/nodes", `${d.id}.json`);
  const n = JSON.parse(readFileSync(f, "utf8"));
  n.verification.status = "passed";
  writeFileSync(f, JSON.stringify(n));
  assert.equal(s.integrity().state.get(d.id), "tampered");
});

test("context fidelity: a step unrelated to goal and path is a break; a goal change is marked", () => {
  const { p, s, c } = project();
  const fid0 = s.fidelity().points;
  assert.ok(fid0[c.id].score >= 70, `on-topic checkpoint ${fid0[c.id].score}`);
  assert.ok(!fid0[c.id].flags.includes("break"));
  const off = s.decide({ question: "Which colour should the office coffee machine be?", options: ["red", "black"], chosen: "red", rationale: "matches the carpet" });
  const fid1 = s.fidelity().points;
  assert.ok(fid1[off.id].flags.includes("break"), JSON.stringify(fid1[off.id]));
  assert.ok(fid1[off.id].flags.includes("drift"));
  assert.ok(fid1[off.id].score < fid1[c.id].score - 25);
  // explicit references restore continuity
  p.write("r.ts", "1");
  const ref = s.checkpoint({ title: "Reminder emails scheduled", basedOn: [c.id], facts: ["payment reminders go out after 14 days"] });
  assert.ok(s.fidelity().points[ref.id].continuity >= 0.95);
  // goal change between two steps is flagged on the next step
  s.setProjectGoal("Invoice SaaS for agencies");
  p.write("r2.ts", "1");
  const after = s.checkpoint({ title: "Agency invoices", outputs: ["agency invoice template"] });
  assert.ok(s.fidelity().points[after.id].flags.includes("goalChanged"));
});

test("global workspace: sections, references, confidence; reader deltas send only the gap and invalidate after a rewind", () => {
  const { p, s, d, c } = project();
  const full = callTool(s, "scenaria_workspace", { sections: ["facts", "decisions"] }, ctx);
  assert.match(full.text, new RegExp(`${c.id}\\.f1: pdfkit renders an invoice PDF in 300 ms \\(90 %\\) ← ${d.id}`));
  assert.match(full.text, new RegExp(`${c.id}\\.f2: fonts embed correctly in invoice PDF \\(50 % — verify\\)`));
  assert.doesNotMatch(full.text, /## rules/, "only subscribed sections");
  // asking for one section never invalidates the others
  callTool(s, "scenaria_workspace", { reader: "agent-C" }, ctx);
  const onlyDec = callTool(s, "scenaria_workspace", { reader: "agent-C", sections: ["decisions"] }, ctx).data;
  assert.deepEqual(onlyDec.invalidated, []);
  assert.equal(callTool(s, "scenaria_workspace", { reader: "agent-C" }, ctx).data.items.length, 0, "nothing re-sent afterwards");
  // reader B: first read = everything, second read = nothing new
  const r1 = callTool(s, "scenaria_workspace", { reader: "agent-B" }, ctx).data;
  assert.equal(r1.mode, "full");
  const r2 = callTool(s, "scenaria_workspace", { reader: "agent-B" }, ctx).data;
  assert.equal(r2.mode, "delta");
  assert.equal(r2.items.length, 0);
  assert.ok(r2.unchanged > 3);
  // a new fact → only that one arrives
  p.write("x.ts", "1");
  const c2 = s.checkpoint({ title: "Reminder job", facts: ["reminders use a cron job"] });
  const r3 = callTool(s, "scenaria_workspace", { reader: "agent-B" }, ctx).data;
  assert.deepEqual(r3.items.map((i) => i.ref), [`${c2.id}.f1`]);
  // after a rewind the reader is told which known items are no longer valid
  s.rewind(c.id);
  const r4 = callTool(s, "scenaria_workspace", { reader: "agent-B" }, ctx);
  assert.ok(r4.data.invalidated.some((i) => i.ref === `${c2.id}.f1`));
  assert.match(r4.text, /invalidated/);
  // references resolve to just their content
  const res = callTool(s, "scenaria_get_node", { refs: [`${c.id}.f2`, d.id, "r9", "../x"] }, ctx).data;
  assert.equal(res[0].text, "fonts embed correctly in invoice PDF");
  assert.equal(res[0].confidence, 0.5);
  assert.equal(res[1].section, "decision");
  assert.match(res[2].error, /no such rule/);
  assert.match(res[3].error, /unknown reference/);
  // reference capsule is much shorter than the full capsule
  const refs = callTool(s, "scenaria_context", { mode: "refs" }, ctx).text;
  assert.match(refs, new RegExp(`${c.id}\\.f2 \\?|${c.id}\\.f2: .* \\?`));
  assert.ok(refs.length < s.context().markdown.length);
});

test("predictive coding: expectations come back as deviations only", () => {
  const { s, d, c } = project();
  const r = callTool(s, "scenaria_expect", {
    expectations: [
      `${d.id} = pdfkit`,
      `${d.id} = puppeteer`,
      `${c.id}.f1`,
      "PDF library is puppeteer",
      "pdfkit renders an invoice PDF in 300 ms",
      "fonts embed correctly in invoice PDF",
      "the API has rate limits",
      `${c.id} verified`,
      "pdfkit does not render an invoice PDF in 300 ms",
      "We use pdfkit, not puppeteer",
      "pdfkit renders an invoice PDF",
    ],
  }, ctx);
  const st = r.data.map((x) => x.status);
  // last one: names the option taken in a topical decision (n2 took pdfkit) → confirmed by the decision, not by word overlap
  // #5 says more than the choice (performance) → unknown; #11 essentially names the taken option → confirmed
  assert.deepEqual(st, ["confirmed", "contradicted", "confirmed", "contradicted", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "confirmed"]);
  assert.match(r.text, /^3\/11 expectations confirmed\. Deviations:/);
  const opposite = callTool(s, "scenaria_expect", { expectations: ["pdfkit was dropped", "pdfkit replaced by puppeteer for invoice PDF"] }, ctx).data;
  assert.deepEqual(opposite.map((x) => x.status), ["unknown", "unknown"], "change verbs never confirm");
  assert.match(r.text, /took pdfkit, not puppeteer/);
  assert.match(r.text, /low-confidence/);
  assert.match(r.text, /with a negation; check it/, "negated claims are never confirmed");
  const partial = callTool(s, "scenaria_expect", { expectations: ["fonts embed correctly"] }, ctx).data[0];
  assert.equal(partial.status, "unknown", "word overlap alone never confirms");
});

test("replacing facts drops their old confidence", () => {
  const { s, c } = project();
  s.update(c.id, { facts: ["Server listens on port 8080"] });
  assert.equal(s.node(c.id).factInfo, undefined);
});

test("capsule shows fact references and flags low confidence; chat blocks carry confidence", () => {
  const { s, c } = project();
  const md = s.context().markdown;
  assert.match(md, new RegExp(`${c.id}\\.f2: fonts embed correctly in invoice PDF \\(confidence 50 % — verify`));
  const r = applyBlocks(s, '```scenaria\n{"checkpoint": {"title": "chat step", "facts": [{"text": "VAT is 19 %", "confidence": 0.4}, "plain fact"], "basedOn": ["' + c.id + '.f1"]}}\n```', { agent: "chatgpt" });
  assert.deepEqual(r.errors, []);
  const n = r.created[0];
  assert.deepEqual(n.facts, ["VAT is 19 %", "plain fact"]);
  assert.equal(n.factInfo[0].confidence, 0.4);
  assert.deepEqual(n.basedOn, [`${c.id}.f1`]);
});

test("HTTP: fidelity, workspace, resolve, expect", async () => {
  const { s, d, c } = project();
  const app = createApp(s);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const f = await (await fetch(`${base}/api/fidelity`)).json();
    assert.equal(typeof f.points[c.id].score, "number");
    assert.equal(f.ledgerBrokenAt, null);
    assert.equal((await fetch(`${base}/api/v1/workspace?reader=x`)).status, 405, "reader mode is never a plain GET (CSRF)");
    const w = await (await fetch(`${base}/api/v1/workspace`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ sections: ["facts"], reader: "http-1" }) })).json();
    assert.equal(w.mode, "full");
    assert.ok(w.items.every((i) => i.section === "facts"));
    const r = await (await fetch(`${base}/api/v1/resolve?refs=${c.id}.f1,${d.id}`)).json();
    assert.equal(r.length, 2);
    const e = await (await fetch(`${base}/api/v1/expect`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ expectations: [`${d.id} = pdfkit`] }) })).json();
    assert.equal(e[0].status, "confirmed");
  } finally {
    app.close();
    server.close();
  }
});
