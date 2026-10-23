// Batch E3b-2: the context window in the dashboard — static checks of the UI source (the walkthrough runs the rest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../ui/src/${f}`, import.meta.url), "utf8");
const app = read("App.tsx");
const win = read("Window.tsx");
const simple = read("SimpleView.tsx");
const help = read("helpContent.ts");
const i18n = read("i18n.ts");

test("E3b-2 views: a button in Audit and Manage, a card in Simple; the form only in Manage, never as an auditor", () => {
  assert.match(app, /<WindowDialog[\s\S]*editable=\{view === "manage" && !auditView\}/);
  assert.match(app, /view !== "simple" && \([\s\S]{0,120}setWindowOpen\(true\)/);
  assert.match(simple, /<WindowCard ws=\{props\.windows \?\? null\}/);
  // The form appears only with the approval session, outside the auditor mode; the server refuses everyone else anyway.
  assert.match(win, /const canEdit = editable && approved && !readOnly && cs\.approval;/);
  assert.match(win, /<LockedNote t=\{t\} text=\{t\.cwLocked\}/);
});

test("E3b-2 the person sees what is signed before it is signed; no browser dialog", () => {
  assert.doesNotMatch(win, /window\.confirm|alert\(|prompt\(/);
  assert.match(win, /setPending\(\{ body: r, text: `\$\{t\.cwConfirmSave/);
  assert.match(win, /onClick=\{\(\) => void submit\(pending\.body\)\}/);
});

test("E3b-2 numbers are shown with their derivation; the zone is a word, not only a colour", () => {
  assert.match(win, /<Why d=\{w\.fill\}/);
  assert.match(win, /<Why d=\{w\.soft\}/);
  assert.match(win, /\{t\.cwZones\[zone\] \?\? zone\}/);
  assert.match(win, /aria-valuetext=/);
});

test("E3b-2 Scenaria's own saves read in plain words in the Simple view", () => {
  assert.match(simple, /n\.tags\?\.includes\("context-cut"\) && n\.agent === "scenaria"/);
  assert.match(i18n, /cwSavedHead: \(fill: string, zone: string\) => `Vor einem neuen Fenster gesichert/);
});

test("E3b-2 help: the window topic in German and English, wired to the dialog", () => {
  const de = help.slice(help.indexOf("const de: HelpTopic[]"), help.indexOf("const en: HelpTopic[]"));
  const en = help.slice(help.indexOf("const en: HelpTopic[]"), help.indexOf("export const HELP"));
  for (const part of [de, en]) assert.match(part, /id: "window"/);
  assert.match(help, /open: \{ action: "window"/);
  assert.match(app, /case "window":\s*setWindowOpen\(true\);/);
});

test("E3b-2 review: numbers people type — group separators in tokens, a comma as decimal mark, empty is no number", async () => {
  const { parseTokens, parsePercent } = await import("../dist/core/numbers.js");
  assert.equal(parseTokens("150.000"), 150_000);
  assert.equal(parseTokens("1.000.000"), 1_000_000);
  assert.equal(parseTokens("150,000"), 150_000);
  assert.equal(parseTokens("32 768"), 32_768);
  assert.equal(parseTokens(""), null);
  assert.equal(parseTokens("12a"), null);
  assert.equal(parsePercent("47,5"), 47.5);
  assert.equal(parsePercent("72"), 72);
  assert.equal(parsePercent(""), null, "an emptied field never becomes 0 (no buffer)");
  assert.equal(parsePercent("1.000,5"), null);
  assert.equal(parsePercent("47.5"), 47.5);
  const win = read("Window.tsx");
  assert.match(win, /parseTokens\(form\[k\] \?\? ""\) : parsePercent\(form\[k\] \?\? ""\)/);
});

test("E3b-2 review: the server names the refused field and gives the text people read", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  process.env.SCENARIA_HOME ??= mkdtempSync(join(tmpdir(), "scenaria-home-"));
  const { Scenaria } = await import("../dist/core/index.js");
  const { createApp } = await import("../dist/server.js");
  const { tempProject } = await import("./helpers.mjs");
  const p = tempProject();
  p.write("README.md", "x");
  const s = Scenaria.init(p.dir);
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess" });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const person = { "x-scenaria": "1", cookie: "scenaria_approval=sess", "content-type": "application/json" };
  try {
    const got = await (await fetch(`${base}/api/context-settings`)).json();
    assert.deepEqual(got.text, { de: "Startwerte (Regel v1.0).", en: "Start values (rule v1.0)." });
    let r = await fetch(`${base}/api/context-settings`, { method: "POST", headers: person, body: JSON.stringify({ values: { red: 99 } }) });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json().then((j) => [j.code, j.key]), ["out_of_range", "red"]);
    r = await fetch(`${base}/api/context-settings`, { method: "POST", headers: person, body: JSON.stringify({ values: { red: 75 } }) });
    const body = await r.json();
    assert.match(body.text.de, /^Regel v1\.0-p1, von .* gesetzt: Rot ab 75 %\. Lockerer als die Startwerte: Rot ab 75 % \(Start 70 %\)\.$/);
  } finally {
    app.close?.();
    server.closeAllConnections?.();
    server.close();
  }
});

test("E3b-2 review: Escape closes only the topmost dialog; numbers carry their time and refresh; the header names the zone", () => {
  const dialogs = read("Dialogs.tsx");
  assert.match(dialogs, /openModals\[openModals\.length - 1\] === id && props\.onClose\(\)/);
  const win = read("Window.tsx");
  assert.match(win, /t\.cwMeasured\(measuredAt\(w\.lastAt, lang\)\)/);
  assert.match(win, /setInterval\(/);
  assert.match(app, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible"\) api\.windows\(\)/);
  assert.match(app, /\{windows\.current\.fill\.value\} % · \{t\.cwZones\[windows\.current\.zone\]\}/);
  // A save point shows the rule it was made under (an auditor sees v1.0 next to a later v1.0-p1).
  assert.match(win, /\{pct\(c\.fill, lang\)\} % · \{ver\(c\.rule\)\}/);
  // Only saves the server counts read as Scenaria's in the Simple view.
  assert.match(simple, /n\.agent === "scenaria"\) \{[\s\S]{0,200}if \(!cutIds\?\.has\(n\.id\)\)/);
});

test("E3b-2 review 2: a typo is no number; one decimal; a trailing % and k are fine", async () => {
  const { parseTokens, parsePercent } = await import("../dist/core/numbers.js");
  for (const bad of ["200.00", "1.5", "1,5", "12.3456", "1.000.00", "k", "-5"]) assert.equal(parseTokens(bad), null, bad);
  assert.equal(parseTokens("128k"), 128_000);
  assert.equal(parseTokens("1m"), 1_000_000);
  assert.equal(parseTokens("1,5m"), 1_500_000);
  assert.equal(parseTokens("8.192"), 8192);
  for (const bad of ["1.000", "47,55", "70.", ".5", "abc"]) assert.equal(parsePercent(bad), null, bad);
  assert.equal(parsePercent("72 %"), 72);
  assert.equal(parsePercent("47,5%"), 47.5);
});

test("E3b-2 review 2: 'already saved' only with a save on the line; neutral line while loading; local times; render-order dialog ids", () => {
  const win = read("Window.tsx");
  assert.match(win, /w\?\.cuts\.some\(\(c\) => c\.onLine && \(c\.zone === "red" \|\| c\.zone === "emergency"\)\)/);
  assert.match(win, /\{saved \? t\.cwWhatNowSaved : t\.cwWhatNow\}/);
  assert.match(simple, /if \(!cutIds\?\.has\(n\.id\)\) return \{ head: t\.svAutoSaved/);
  assert.match(win, /t\.cwHistoryLine\(h\.rev, localTime\(h\.at, lang\)/);
  assert.match(win, /document\.getElementById\(`cw-f-\$\{msg\.field\}`\)\?\.focus\(\)/);
  const dialogs = read("Dialogs.tsx");
  assert.match(dialogs, /if \(!idRef\.current\) idRef\.current = \+\+modalSeq;/);
});
