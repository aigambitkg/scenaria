// The landing page (site/): the same texts in German and English, the dashboard's own example and drawings,
// nothing loaded from other servers, and no promise the product does not keep today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { transformWithOxc } from "vite";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("landing page: German and English have the same texts, and none is empty", async () => {
  const { code } = await transformWithOxc(read("site/src/text.ts"), "text.ts");
  const { SITE, LINKS, INSTALL, INSTALL_EN } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const shape = (v) => (Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
  assert.deepEqual(shape(SITE.de), shape(SITE.en));
  const texts = (v) => (typeof v === "string" ? [v] : Object.values(v).flatMap(texts));
  for (const lang of ["de", "en"]) for (const s of texts(SITE[lang])) assert.ok(s.trim().length > 1, `empty text (${lang})`);
  // Links lead only to the project and its maker.
  for (const u of texts(LINKS)) assert.match(u, /^https:\/\/(github\.com\/aigambitkg\/scenaria|ai-gambit\.com)(\/|$)/, u);
  // The install lines work today: from source, with the scripts the package really has.
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.build && pkg.bin?.scenaria);
  assert.equal(INSTALL.length, 3);
  assert.match(INSTALL[0], /^git clone https:\/\/github\.com\/aigambitkg\/scenaria$/);
  assert.match(INSTALL[1], /npm install && npm run build && npm link$/);
  assert.match(INSTALL[2], /scenaria start$/);
  assert.deepEqual(INSTALL.slice(0, 2), INSTALL_EN.slice(0, 2));
  // No promise the product does not keep: the status names the preview, that Windows is the newest, and the missing external audit.
  assert.match(SITE.de.status, /Vorschau[\s\S]*Windows[\s\S]*am jüngsten[\s\S]*Dritten/);
  assert.match(SITE.en.status, /preview[\s\S]*Windows[\s\S]*newest[\s\S]*third party/);
  // … and that claim rests on CI: Windows is a required job there, not an informational one.
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /runs-on: windows-latest/);
  assert.doesNotMatch(ci, /continue-on-error/);
  for (const lang of ["de", "en"]) assert.doesNotMatch(texts(SITE[lang]).join(" "), /zertifiziert|certified|100 ?%|garantiert|guaranteed|unhackable|manipulationssicher|tamper-proof/i);
  assert.match(SITE.de.forWhom[2].what, /kein Zertifikat/);
  // What Scenaria is for comes first, in the same words everywhere: approval and evidence.
  assert.match(SITE.de.title, /Freigabe und Nachweis/);
  assert.match(SITE.en.title, /approval and evidence/);
  assert.match(SITE.de.heroTitle.join(" ") + SITE.de.heroText, /gibst frei[\s\S]*Signatur[\s\S]*Nachweis[\s\S]*zurück/);
  assert.match(SITE.en.heroTitle.join(" ") + SITE.en.heroText, /approve[\s\S]*signature[\s\S]*record[\s\S]*go back/);
  assert.match(read("site/index.html"), /<title>Scenaria – Freigabe und Nachweis/);
  assert.match(read("README.md").split("\n")[2], /^\*\*Approval and evidence for the work of AI agents/);
  assert.match(read("README.de.md").split("\n")[2], /^\*\*Freigabe und Nachweis für die Arbeit von KI-Agenten/);
  assert.match(pkg.description, /^Approval and evidence/);
});

test("landing page: shows the dashboard's own example and drawings, and loads nothing from other servers", () => {
  const page = read("site/src/Landing.tsx");
  assert.match(page, /import\("\.\.\/\.\.\/ui\/src\/Demo"\)\.then\(\(m\) => \(\{ default: m\.DemoStage \}\)\)/);
  assert.match(page, /<DemoStage t=\{t\} lang=\{lang\} toast=\{toast\} embedded/);
  assert.match(page, /import \{ ArtBack, ArtLock, ArtLook, ArtSave \} from "\.\.\/\.\.\/ui\/src\/TourArt"/);
  // The example answers itself (test/simpleui.test.mjs); the page adds no call to a server.
  for (const f of readdirSync(new URL("../site/src/", import.meta.url))) {
    const src = read(`site/src/${f}`);
    assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie/, f);
    assert.doesNotMatch(src, /googleapis|gstatic|cdn\.|unpkg|jsdelivr|google-analytics|gtag|plausible|matomo/i, f);
  }
  const html = read("site/index.html");
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/);
  assert.match(html, /<meta name="description" content="[^"]{60,}"/);
  assert.match(html, /class="notranslate"/);
  // Both exports exist: the example itself and the overlay of the dashboard.
  const demo = read("ui/src/Demo.tsx");
  assert.match(demo, /export function DemoStage\(/);
  assert.match(demo, /export function Demo\([\s\S]*<DemoStage \{\.\.\.props\} \/>/);
  // Publishing is a person's click, never automatic.
  const wf = read(".github/workflows/site.yml");
  assert.match(wf, /\non:\n  workflow_dispatch:\n\npermissions:/);
  assert.doesNotMatch(wf, /\n  push:|\n  schedule:|pull_request/);
});
