// Batch 5 (v0.8): help area and onboarding — content parity and wiring (static checks on the UI source).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../ui/src/helpContent.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
const de = src.slice(src.indexOf("const de: HelpTopic[]"), src.indexOf("const en: HelpTopic[]"));
const en = src.slice(src.indexOf("const en: HelpTopic[]"), src.indexOf("export const HELP"));
const ids = (x) => [...x.matchAll(/^\s{4}id: "([\w-]+)"/gm)].map((m) => m[1]);

test("help: every topic exists in German and English, in the same order", () => {
  assert.ok(ids(de).length >= 12, `topics: ${ids(de)}`);
  assert.deepEqual(ids(de), ids(en));
});

test("help covers every function the request named, incl. the terms the checker asked for", () => {
  for (const id of ["start", "goal", "fidelity", "decisions", "forecasts", "canon", "chat", "relay", "analysis", "projects", "agents", "settings", "history", "privacy", "cli"]) assert.ok(ids(de).includes(id), id);
  for (const term of ["Schnellprognose", "Multiversum", "Kontext gehalten", "Trefferquote", "Fixpunkt-Chip", "vor der Wahl erstellt", "widerspricht den Fakten", "Was bleibt"]) assert.ok(de.includes(term), term);
});

test("every help/onboarding action is handled by the dashboard", () => {
  const actions = [...new Set([...src.matchAll(/action: "(\w+)"/g)].map((m) => m[1]))];
  const declared = src.match(/export type HelpAction = ([^;]+);/)[1];
  for (const a of actions) {
    assert.ok(declared.includes(`"${a}"`), `declared: ${a}`);
    assert.ok(app.includes(`case "${a}":`), `handled in App: ${a}`);
  }
  for (const a of [...declared.matchAll(/"(\w+)"/g)].map((m) => m[1])) assert.ok(app.includes(`case "${a}":`), `handled: ${a}`);
});

test("onboarding progress lives only in the browser and never breaks without storage", () => {
  const help = readFileSync(new URL("../ui/src/Help.tsx", import.meta.url), "utf8");
  assert.match(help, /localStorage\.getItem\(ONBOARDED\)/);
  assert.match(help, /catch \{\s*return true;/, "no storage → never nag");
  assert.doesNotMatch(help, /api\.(save|write)Settings|onboard.*\/api\//);
});
