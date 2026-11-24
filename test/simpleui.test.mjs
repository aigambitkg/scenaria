// 0.9.24 — a dashboard without loose ends: the introduction with pictures and an example to try out,
// functions that need a language model shown only once one is set up, no empty boxes in the Simple view,
// and the engine's English texts in German where people meet them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";
import { Scenaria } from "../dist/core/index.js";
import { startServer, browserLog } from "../dist/server.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_NO_BROWSER = "1";
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const ui = (f) => read(`ui/src/${f}`);

/** Load a dashboard module that has no runtime imports (the bundler's own compiler drops the types). */
async function load(file) {
  const { code } = await transformWithOxc(ui(file), file);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("engine texts: German where people meet them, English and unknown texts untouched", async () => {
  const { localizeEngineText: L, localizeEventType, localizeVerdict, localizeEngineList } = await load("localize.ts");
  assert.equal(L("Autosave before rewind to n3", "de"), "Automatisch gesichert vor dem Zurückgehen zu n3");
  assert.equal(L("not yet proven on this line: k2 (run the canon checks on this line, or confirm them in the dashboard)", "de"), "Auf dieser Linie noch nicht bewiesen: k2 (führe die Prüfungen auf dieser Linie aus oder bestätige sie hier)");
  assert.equal(L("24db3e479f · 5 files", "de"), "24db3e479f · 5 Dateien");
  assert.equal(L("24db3e479f · 1 files", "de"), "24db3e479f · 1 Datei");
  assert.equal(L("2 file claim(s) confirmed", "de"), "2 genannte Dateien vorhanden");
  assert.equal(L("No model configured — choose one in Settings.", "de"), "Noch kein Modell eingerichtet – wähle eines in den Einstellungen.");
  assert.match(L("approval link opened in the default browser (asked by a client marked as the dashboard; user agent: Mozilla/5.0 (X11) Chrome)", "de"), /^Freigabe-Fenster im Standard-Browser geöffnet/);
  assert.equal(L("k3 proposed (past): Nur serverseitig", "de"), "k3 vorgeschlagen (Vergangenheit): Nur serverseitig");
  assert.equal(L("canon checks: k2 passed", "de"), "Prüfungen der Regeln: k2 bestanden");
  // English stays English, and so does everything Scenaria does not recognise (never a wrong translation).
  for (const s of ["Autosave before rewind to n3", "snapshot restorable"]) assert.equal(L(s, "en"), s);
  for (const s of ["Spam-Schutz ergänzt", "some new sentence of a later version", ""]) assert.equal(L(s, "de"), s);
  assert.equal(L(undefined, "de"), "");
  assert.deepEqual(localizeEngineList(["rationale missing", "x"], "de"), ["Begründung fehlt", "x"]);
  assert.equal(localizeEventType("rewind", "de"), "Zurückgegangen");
  assert.equal(localizeEventType("rewind", "en"), "rewind");
  assert.equal(localizeEventType("something-new", "de"), "something-new");
  assert.equal(localizeVerdict("passed", "de"), "bestanden");
});

test("engine texts: every automatic check the engine names has a German name (a new check is noticed here)", async () => {
  const { localizeEngineText: L, localizeEventType } = await load("localize.ts");
  const verify = read("src/core/verify.ts");
  const names = [...new Set([...verify.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(names.length >= 7, String(names));
  for (const n of names) assert.notEqual(L(n, "de"), n, `no German name for the check "${n}"`);
  // … and every fixed detail text of those checks.
  for (const d of [...verify.matchAll(/detail: "([^"]+)"/g)].map((m) => m[1])) assert.notEqual(L(d, "de"), d, `no German text for "${d}"`);
  // every kind of log entry
  const types = read("src/core/types.ts").match(/export type EventType =([^;]+);/)[1];
  for (const t of [...types.matchAll(/"(\w+)"/g)].map((m) => m[1])) assert.notEqual(localizeEventType(t, "de"), t, `no German word for the log entry "${t}"`);
  // the titles the engine gives its own steps
  const engine = read("src/core/engine.ts");
  assert.match(engine, /title: `Autosave before rewind to \$\{targetId\}`/);
  assert.match(engine, /title: `Alternative: \$\{opt\.label\}`/);
  assert.equal(L("Alternative: Resend API", "de"), "Anderer Weg: Resend API");
});

test("engine texts are used where they are shown: map, step panel, Simple view, gate, log, settings", () => {
  assert.match(ui("Map.tsx"), /localizeEngineText\(n\.title, t\.langCode\)/);
  assert.match(ui("NodePanel.tsx"), /localizeEngineText\(c\.name, t\.langCode\)[\s\S]{0,200}localizeEngineText\(c\.detail, t\.langCode\)/);
  assert.match(ui("SimpleView.tsx"), /head: localizeEngineText\(n\.title, t\.langCode\)/);
  const dialogs = ui("Dialogs.tsx");
  assert.match(dialogs, /localizeEngineList\(verdict\.reasons, t\.langCode\)/);
  assert.match(dialogs, /localizeEventType\(e\.type, t\.langCode\)/);
  const control = ui("Control.tsx");
  assert.match(control, /localizeEngineList\(r\.reasons, t\.langCode\)/);
  // Chat and oracle explain a failed model call in plain words (reason and what to do), like the forecasts do.
  assert.equal((control.match(/<ErrorBox t=\{t\} message=\{err\} \/>/g) ?? []).length, 2);
});

test("introduction: the same texts in German and English, five steps, a picture for each explaining step", async () => {
  const { TOUR } = await load("tourText.ts");
  const shape = (v) => (typeof v === "function" ? "fn" : Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
  assert.deepEqual(shape(TOUR.de), shape(TOUR.en));
  const texts = (v) => (typeof v === "string" ? [v] : typeof v === "function" ? [v(1, 5)] : Object.values(v).flatMap(texts));
  for (const lang of ["de", "en"]) for (const s of texts(TOUR[lang])) assert.ok(String(s).trim().length > 1, `empty text (${lang})`);
  // The words of the drawings match the buttons people then look for.
  const i18n = ui("i18n.ts");
  assert.ok(i18n.includes(`svBack: "${TOUR.de.s3Art.back}"`) && i18n.includes(`svUndo: "${TOUR.de.s3Art.undo}"`));
  assert.ok(i18n.includes(`svWhatDidAi: "${TOUR.de.s2Art.button}"`) && i18n.includes(`svWhatDidAi: "${TOUR.en.s2Art.button}"`));

  const tour = ui("Tour.tsx");
  assert.match(tour, /TOUR_STEPS = \["save", "look", "back", "lock", "start"\] as const/);
  for (const art of ["ArtSave", "ArtLook", "ArtBack", "ArtLock"]) assert.match(tour, new RegExp(`<${art} x=\\{x\\} />`), art);
  // Pictures are built in (nothing is loaded from anywhere) and have a text alternative.
  const art = ui("TourArt.tsx");
  assert.doesNotMatch(art, /https?:\/\/(?!www\.w3\.org)|<img|url\(/);
  assert.match(art, /role="img" aria-label=\{props\.label\}/);
  // No word is fixed in a drawing: all of them come from the texts.
  assert.doesNotMatch(art, />[A-Za-zÄÖÜäöü]{3,}[^<{]*<\/text>/);
});

test("introduction: starts on the first visit and can be started again from the help, the Simple view and the menu", () => {
  const app = ui("App.tsx");
  assert.match(app, /if \(!onboardingDone\(\)\) setOnboarding\(true\)/);
  assert.match(app, /\{onboarding && \(\s*<Tour/);
  assert.match(app, /case "onboarding":\s*restartOnboarding\(\);\s*setOnboarding\(true\)/);
  assert.match(app, /case "demo":\s*setDemo\(true\)/);
  assert.match(app, /\{demo && <Demo /);
  const help = ui("Help.tsx");
  assert.match(help, /className="help-start"[\s\S]{0,300}props\.onAction\("onboarding"\)[\s\S]{0,200}props\.onAction\("demo"\)/);
  const simple = ui("SimpleView.tsx");
  assert.match(simple, /props\.onIntro &&[\s\S]{0,160}TOUR\[lang\]\.startIntro/);
  assert.match(simple, /props\.onDemo &&[\s\S]{0,160}TOUR\[lang\]\.startDemo/);
  assert.match(app, /onIntro=\{\(\) => act\("onboarding"\)\}\s*onDemo=\{\(\) => act\("demo"\)\}/);
  assert.match(app, /act\("demo"\)\}>\s*\{TOUR\[lang\]\.startDemo\}/, "also under Manage → More");
  // Seen or not is remembered in this browser only.
  assert.match(ui("Tour.tsx"), /markOnboardingDone\(\)/);
  assert.doesNotMatch(ui("Tour.tsx"), /localStorage/);
});

test("example to try out: the real Simple view on recorded data, and nothing reaches the server", () => {
  const demo = ui("Demo.tsx");
  assert.match(demo, /<SimpleBackendContext\.Provider value=\{backend\}>\s*<SimpleView/);
  // No call to the server at all: no api object, no fetch.
  assert.doesNotMatch(demo, /\bapi\.|fetch\(|from "\.\/api";?\n(?!)/);
  assert.doesNotMatch(demo, /import \{[^}]*\bapi\b[^}]*\} from "\.\/api"/);
  // The Simple view asks only through the backend it is given (default: the server).
  const simple = ui("SimpleView.tsx");
  assert.match(simple, /export const SimpleBackendContext = createContext<SimpleBackend>\(api\)/);
  assert.doesNotMatch(simple, /\bapi\.(rewind|folder|nodeMessages|headAt)\(/);
  // The data: both languages, the same steps, nothing of the machine that built it.
  const data = ui("demoData.ts");
  assert.match(data, /^\/\/ Generated by scripts\/make-demo-data\.mjs/);
  const json = JSON.parse(data.slice(data.indexOf("{"), data.lastIndexOf("}") + 1));
  assert.deepEqual(json.de.nodes.map((n) => [n.id, n.type, n.parentId]), json.en.nodes.map((n) => [n.id, n.type, n.parentId]));
  assert.ok(json.de.nodes.length >= 8 && json.de.nodes.some((n) => n.type === "decision") && json.de.nodes.some((n) => n.type === "branch"));
  assert.equal(json.de.head, json.en.head);
  assert.ok(json.de.nodes.some((n) => n.id === json.de.head));
  assert.notEqual(json.de.goal, json.en.goal);
  assert.doesNotMatch(data, /\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\\\|"uid":|"user":|snapshotFolder|[0-9a-f]{40}/);
});

test("without a language model the dashboard shows nothing that needs one; with one, marked as experimental", () => {
  const app = ui("App.tsx");
  assert.match(app, /setHasModel\(Boolean\(st\.effective\?\.chat\)\)/);
  assert.match(app, /view === "manage" && !auditView && hasModel && \(\s*<button className=\{`btn \$\{side === "chat"/, "chat button");
  assert.match(app, /view === "manage" && !auditView && hasModel && \(\s*<div className="more">\s*<button className="btn" aria-haspopup="menu" aria-expanded=\{extOpen\}/, "extensions menu");
  assert.match(app, /\{hasModel && \(\s*<button role="tab" aria-selected=\{side === "chat"\}/, "chat tab");
  assert.match(app, /side === "chat" && hasModel \?/);
  assert.match(app, /<p className="menu-note">\{t\.extensionsNote\}<\/p>/);
  // A help topic or an old link never leads to a hidden function: it leads to where a model is set up.
  assert.match(app, /if \(!hasModel && \(a === "chat" \|\| a === "relay" \|\| a === "forecasts" \|\| a === "audit"\)\) \{\s*toast\(t\.needsModel\);/);
  assert.match(ui("Help.tsx"), /NEEDS_MODEL = new Set\(\["forecasts", "forecast-check", "chat", "relay"\]\)/);
  assert.match(ui("Control.tsx"), /!page\.effective\?\.chat && <p className="hint">\{t\.stModelUnlocks\}<\/p>/);
  const i18n = ui("i18n.ts");
  for (const k of ["extensionsNote", "needsModel", "needsModelTag", "approvalOpeningSettings", "stModelUnlocks", "protocolNote"]) assert.equal((i18n.match(new RegExp(`\\n  ${k}: `, "g")) ?? []).length, 2, k);
});

test("Simple view: no box that only says there is nothing to measure", () => {
  // Progress: a card only for a task with approved criteria.
  assert.match(ui("Progress.tsx"), /const tp = p\.tasks\.find\(\(x\) => x\.task === task\);[\s\S]{0,320}if \(!tp\) return null;/);
  // Context window: a card only when something was measured or there is something to say (a stop, a warning, invalid values).
  assert.match(ui("Window.tsx"), /if \(!w && !st && !ws\.progress\?\.warning && !ws\.progress\?\.escalation && ws\.settings\.trust !== "invalid"\) return null;/);
});

test("one name per thing: the analysis, rules & milestones, and the view names in the READMEs", () => {
  const i18n = ui("i18n.ts");
  assert.match(i18n, /\n  projectCheck: "Analyse",/);
  assert.match(i18n, /\n  projectCheck: "Analysis",/);
  const help = ui("helpContent.ts");
  assert.match(help, /title: "Regeln & Meilensteine \(Fixpunkte\)"/);
  assert.match(help, /title: "Rules & milestones \(fixed points\)"/);
  // The READMEs name the three views as the dashboard does.
  const de = i18n.slice(i18n.lastIndexOf("\n  viewSimple: "));
  for (const k of ["viewSimple", "viewAudit", "viewManage"]) {
    const word = de.match(new RegExp(`\\n  ${k}: "([^"]+)"`))[1];
    assert.ok(read("README.de.md").includes(`*${word}*`), `README.de.md names the view „${word}“`);
  }
});

test("connecting an AI from a locked window: the unlocked window opens at the settings; nothing else can ride on the link", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  const srv = await startServer(s, { port: 4793, quiet: true, showApprovalLink: false });
  const post = (body) => fetch(`${srv.url}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-view": "dashboard" }, body: JSON.stringify(body) });
  try {
    browserLog.length = 0;
    assert.equal((await post({ then: "settings" })).status, 200);
    const link = new URL(browserLog.at(-1));
    assert.equal(link.searchParams.get("then"), "settings");
    assert.deepEqual([...link.searchParams.keys()].sort(), ["approve", "then"]);
    const red = await fetch(link, { redirect: "manual" });
    assert.equal(red.headers.get("location"), "/?then=settings");
    assert.match(red.headers.get("set-cookie") ?? "", /^scenaria_approval=/);
    // A link with anything else in `then` unlocks as usual and passes nothing on.
    const code = [...(await import("node:crypto")).randomBytes(4)].join("");
    assert.equal((await fetch(`${srv.url}/?approve=${code}&then=settings`, { redirect: "manual" })).headers.get("location"), "/?approval=invalid", "an invalid code gets no window at all");
  } finally {
    srv.close();
  }
  // A value outside the fixed list never reaches the link.
  const p2 = tempProject();
  const srv2 = await startServer(Scenaria.init(p2.dir), { port: 4794, quiet: true, showApprovalLink: false });
  try {
    browserLog.length = 0;
    const r = await fetch(`${srv2.url}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-view": "dashboard" }, body: JSON.stringify({ then: "https://evil.example/?x=" }) });
    assert.equal(r.status, 200);
    const link = new URL(browserLog.at(-1));
    assert.deepEqual([...link.searchParams.keys()], ["approve"]);
    const red = await fetch(`${srv2.url}/?approve=${link.searchParams.get("approve")}&then=https://evil.example`, { redirect: "manual" });
    assert.equal(red.headers.get("location"), "/", "an unknown value is dropped at the redirect as well");
  } finally {
    srv2.close();
  }
  const app = ui("App.tsx");
  assert.match(app, /case "connect":[\s\S]{0,420}requestApproval\(t, "settings"\)/);
  assert.match(app, /q\.get\("then"\) === "settings"[\s\S]{0,200}history\.replaceState/);
});

test("Windows: an approval link with a second parameter reaches the browser whole (cmd would cut it at &)", async () => {
  const { browserArgs } = await import("../dist/server.js");
  const url = "http://127.0.0.1:4477/?approve=abc123&then=settings";
  assert.deepEqual(browserArgs(url, "win32"), ["/c", "start", "", "http://127.0.0.1:4477/?approve=abc123^&then=settings"]);
  assert.deepEqual(browserArgs(url, "darwin"), [url]);
  assert.deepEqual(browserArgs(url, "linux"), [url]);
  // A plain link is passed on unchanged everywhere.
  assert.deepEqual(browserArgs("http://127.0.0.1:4477/?approve=abc123", "win32"), ["/c", "start", "", "http://127.0.0.1:4477/?approve=abc123"]);
});
