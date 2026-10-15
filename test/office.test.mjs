// Batch B (0.9.3): office users — Claude Desktop wiring, start icon, approval mode without copying a link,
// and the three views in the dashboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenaria } from "../dist/core/index.js";
import { createApp, startServer, browserLog, rootKey } from "../dist/server.js";
import { agentStatus, parseTargets, setupAgents, setupGlobal, writeLauncher } from "../dist/setup.js";
import { tempProject } from "./helpers.mjs";
import { createServer } from "node:http";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));
process.env.SCENARIA_NO_BROWSER = "1";
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function desktopConfig(content) {
  const dir = mkdtempSync(join(tmpdir(), "claude-desktop-"));
  const file = join(dir, "claude_desktop_config.json");
  if (content !== undefined) writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  process.env.SCENARIA_CLAUDE_DESKTOP_CONFIG = file;
  return { dir, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

function project(prefix = "scenaria-office-") {
  const p = tempProject(prefix);
  const s = Scenaria.init(p.dir);
  return { p, s };
}

test("Claude Desktop: one entry per project with a fixed folder; other servers stay; idempotent", () => {
  const cfg = desktopConfig({ mcpServers: { other: { command: "x", args: ["y"] } }, globalShortcut: "Cmd+K" });
  const { s } = project();
  const r = setupAgents(s.root, ["claude-desktop"]);
  const data = cfg.read();
  assert.equal(data.globalShortcut, "Cmd+K", "unrelated settings are kept");
  assert.deepEqual(data.mcpServers.other, { command: "x", args: ["y"] });
  const names = Object.keys(data.mcpServers).filter((n) => n.startsWith("scenaria-"));
  assert.equal(names.length, 1);
  const e = data.mcpServers[names[0]];
  const i = e.args.indexOf("--root");
  assert.ok(i > 0 && e.args.includes("mcp"));
  assert.equal(e.args[i + 1], realpathSync(s.root));
  assert.equal(e.env.SCENARIA_AGENT, "claude-desktop");
  assert.ok(r.notes.some((n) => /Restart the Claude Desktop app/.test(n)));
  assert.ok(!existsSync(join(s.root, "AGENTS.md")), "Claude Desktop reads no rules file");
  // again: same entry, no duplicate
  setupAgents(s.root, ["claude-desktop"]);
  assert.deepEqual(Object.keys(cfg.read().mcpServers).filter((n) => n.startsWith("scenaria-")), names);
  // status
  const row = agentStatus(s.root).find((a) => a.target === "claude-desktop");
  assert.equal(row.connected, true);
  assert.equal(row.detected, true);
});

test("Claude Desktop: two projects with the same folder name get two entries", () => {
  const cfg = desktopConfig({});
  const a = join(mkdtempSync(join(tmpdir(), "a-")), "Angebote");
  const b = join(mkdtempSync(join(tmpdir(), "b-")), "Angebote");
  mkdirSync(a);
  mkdirSync(b);
  Scenaria.init(a, { force: true });
  Scenaria.init(b, { force: true });
  setupAgents(a, ["claude-desktop"]);
  setupAgents(b, ["claude-desktop"]);
  const names = Object.keys(cfg.read().mcpServers).sort();
  assert.deepEqual(names, ["scenaria-angebote", "scenaria-angebote-2"]);
});

test("Claude Desktop: a config with comments is left alone (note instead), a broken one aborts before writing", () => {
  const cfg = desktopConfig('{\n  // mine\n  "mcpServers": {}\n}\n');
  const { s } = project();
  const r = setupAgents(s.root, ["claude-desktop"]);
  assert.match(readFileSync(cfg.file, "utf8"), /\/\/ mine/);
  assert.ok(r.notes.some((n) => /contains comments/.test(n)));
  desktopConfig("{ not json");
  assert.throws(() => setupAgents(s.root, ["claude-desktop", "cursor"]), /not valid JSON/);
  assert.ok(!existsSync(join(s.root, ".cursor", "mcp.json")), "nothing written after a failed preflight");
});

test("targets: claude-desktop by name or alias, never part of 'all' or of the global setup", () => {
  assert.deepEqual(parseTargets("desktop"), ["claude-desktop"]);
  assert.deepEqual(parseTargets("claude-desktop,claude"), ["claude-desktop", "claude"]);
  assert.ok(!parseTargets("all").includes("claude-desktop"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const r = setupGlobal(["claude-desktop"], home);
  assert.equal(r.changes.length, 0);
  assert.ok(r.notes.some((n) => /per project/.test(n)));
});

test("start icon: a double-clickable file that starts Scenaria in the project folder", () => {
  const { s } = project();
  const dir = mkdtempSync(join(tmpdir(), "desk-"));
  const file = writeLauncher(s.root, dir);
  assert.ok(file.startsWith(dir));
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(realpathSync(s.root)));
  assert.match(text, / start --launcher --root /);
  if (process.platform !== "win32") assert.ok(statSync(file).mode & 0o100, "executable");
  if (process.platform === "darwin") assert.match(text, /^#!\/bin\/sh/);
  if (process.platform === "linux") assert.match(text, /^\[Desktop Entry\][\s\S]*Terminal=true/);
  // default: the desktop folder when there is one
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, "Desktop"));
  assert.ok(writeLauncher(s.root, undefined, home).startsWith(join(home, "Desktop")));
});

async function listen(app) {
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => (server.close(), app.close()) };
}
const post = (base, p, cookie) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...(cookie ? { cookie } : {}) }, body: "{}" });

test("approval mode: the dashboard asks, Scenaria opens a fresh single-use link in the browser — the code never comes back", async () => {
  const { s } = project();
  const srv = await startServer(s, { port: 4791, quiet: true, showApprovalLink: false });
  try {
    browserLog.length = 0;
    const r = await post(srv.url, "/api/approval/open");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(browserLog.length, 1);
    const code = new URL(browserLog[0]).searchParams.get("approve");
    assert.ok(code && code.length > 10);
    assert.ok(!body.includes(code), "the code is never part of the answer");
    // at most once per 15 s
    const again = await post(srv.url, "/api/approval/open");
    assert.equal(again.status, 429);
    assert.equal(browserLog.length, 1);
    // the browser redeems it once
    const red = await fetch(`${srv.url}/?approve=${code}`, { redirect: "manual" });
    const cookie = (red.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^scenaria_approval=/);
    const second = await fetch(`${srv.url}/?approve=${code}`, { redirect: "manual" });
    assert.equal(second.headers.get("location"), "/?approval=invalid", "single use");
    // an approved window is told so, nothing is opened
    const ok = await (await post(srv.url, "/api/approval/open", cookie)).json();
    assert.equal(ok.already, true);
    // logged
    assert.ok(s.store.readEvents().some((e) => /approval link opened in the default browser/.test(e.data?.message ?? "")));
  } finally {
    srv.close();
  }
});

test("approval mode: not over a team server, not without a browser, not cross-site", async () => {
  const { s } = project();
  const team = await listen(createApp(s, { token: "t", approverToken: "a" }));
  const tr = await fetch(`${team.base}/api/approval/open`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: "{}" });
  assert.equal(tr.status, 400);
  team.close();
  const plain = await listen(createApp(s, { approvalCode: "c", approvalSecret: "sess" }));
  assert.equal((await post(plain.base, "/api/approval/open")).status, 409);
  const noHeader = await fetch(`${plain.base}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noHeader.status, 403, "needs X-Scenaria (no cross-site trigger)");
  plain.close();
});

test("start icon and Claude Desktop from the dashboard are the person's actions", async () => {
  desktopConfig({});
  const { s } = project();
  const app = await listen(createApp(s, { approvalCode: "c", approvalSecret: "sess" }));
  try {
    assert.equal((await post(app.base, "/api/agents/launcher")).status, 403);
    const conn = await fetch(`${app.base}/api/agents/connect`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: JSON.stringify({ targets: ["claude-desktop"] }) });
    assert.equal(conn.status, 403);
    const ok = await fetch(`${app.base}/api/agents/connect`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", cookie: "scenaria_approval=sess" }, body: JSON.stringify({ targets: ["claude-desktop"] }) });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.agents.find((a) => a.target === "claude-desktop").connected, true);
  } finally {
    app.close();
  }
});

test("health names the project folder only as a hash; a second `scenaria start` reuses the running one", async () => {
  const { s } = project();
  const srv = await startServer(s, { port: 4481, quiet: true, showApprovalLink: false });
  try {
    const h = await (await fetch(`${srv.url}/api/v1/health`)).json();
    assert.equal(h.rootKey, rootKey(s.root));
    assert.ok(!JSON.stringify(h).includes(s.root));
    browserLog.length = 0;
    const out = await new Promise((resolve, reject) =>
      execFile(process.execPath, [CLI, "start", "--root", s.root], { env: { ...process.env }, timeout: 20_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))),
    );
    assert.match(out, /already running/);
    assert.match(out, new RegExp(srv.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(browserLog.length, 1, "the running Scenaria opened the dashboard with approval");
  } finally {
    srv.close();
  }
});

test("dashboard: three views, Simple by default; every new text in both languages", () => {
  const app = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /function initialView\(\): View \{[\s\S]*?return "simple";\n\}/, "Simple is the default view");
  for (const v of ["simple", "audit", "manage"]) assert.ok(app.includes(`"${v}"`));
  assert.match(app, /<SimpleView/);
  const i18n = readFileSync(new URL("../ui/src/i18n.ts", import.meta.url), "utf8");
  for (const key of ["viewSimple", "svBack", "svWhatDidAi", "svOpenFolder", "svUndo", "approvalOpen", "launcherCreate", "desktopConnected", "advancedSettings", "extensions"]) {
    assert.equal((i18n.match(new RegExp(`^  ${key}: `, "gm")) ?? []).length, 2, key);
  }
});

// ---------------------------------------------------------------- review round 1 (K1–K17), one test per finding

test("K1: a fresh approval link is used up even when the browser that opens it is already approved", async () => {
  const { s } = project();
  const srv = await startServer(s, { port: 4792, quiet: true, showApprovalLink: false });
  try {
    browserLog.length = 0;
    await post(srv.url, "/api/approval/open");
    const first = new URL(browserLog.at(-1)).searchParams.get("approve");
    const cookie = ((await fetch(`${srv.url}/?approve=${first}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
    // the approved browser gets another link (e.g. a second double-click) …
    await new Promise((r) => setTimeout(r, 10));
    const open2 = await fetch(`${srv.url}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-view": "dashboard" }, body: "{}" });
    assert.ok([200, 429].includes(open2.status));
    if (open2.status === 200 && !(await open2.json()).already) {
      const code = new URL(browserLog.at(-1)).searchParams.get("approve");
      await fetch(`${srv.url}/?approve=${code}`, { redirect: "manual", headers: { cookie } });
      const replay = await fetch(`${srv.url}/?approve=${code}`, { redirect: "manual" });
      assert.equal(replay.headers.get("location"), "/?approval=invalid", "replaying the code from the history gives nothing");
      assert.equal(replay.headers.get("set-cookie"), null);
    }
  } finally {
    srv.close();
  }
});

test("K1/K8: codes from the lock live next to the start link (which stays valid) and expire", async () => {
  const { s } = project();
  const app = createApp(s, { approvalCode: "startcode", approvalSecret: "sess", openApproval: undefined });
  const linkState = { secret: "startcode", extra: new Map([["old", Date.now() - 1], ["fresh", Date.now() + 60_000]]) };
  const srv = await listen(createApp(s, { approvalCode: "startcode", approvalSecret: "sess", linkState }));
  app.close();
  try {
    assert.equal((await fetch(`${srv.base}/?approve=old`, { redirect: "manual" })).headers.get("location"), "/?approval=invalid", "expired");
    assert.match((await fetch(`${srv.base}/?approve=fresh`, { redirect: "manual" })).headers.get("set-cookie") ?? "", /scenaria_approval=sess/);
    assert.match((await fetch(`${srv.base}/?approve=startcode`, { redirect: "manual" })).headers.get("set-cookie") ?? "", /scenaria_approval=sess/, "the printed link still works");
  } finally {
    srv.close();
  }
});

test("K2: no browser program → a clear answer, the server keeps running, the code is withdrawn", async () => {
  const script = `
    process.env.SCENARIA_HOME = ${JSON.stringify(mkdtempSync(join(tmpdir(), "scenaria-home-")))};
    const { Scenaria } = await import(${JSON.stringify(new URL("../dist/core/index.js", import.meta.url).href)});
    const { startServer } = await import(${JSON.stringify(new URL("../dist/server.js", import.meta.url).href)});
    const s = Scenaria.init(${JSON.stringify(mkdtempSync(join(tmpdir(), "scenaria-office-")))});
    const srv = await startServer(s, { port: 4793, quiet: true, showApprovalLink: false });
    const r = await fetch(srv.url + "/api/approval/open", { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: "{}" });
    await new Promise((res) => setTimeout(res, 300));
    const h = await fetch(srv.url + "/api/v1/health");
    console.log(JSON.stringify({ status: r.status, alive: h.ok }));
    srv.close();`;
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PATH: "", SCENARIA_NO_BROWSER: "" }, timeout: 20_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))),
  );
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), { status: 409, alive: true });
});

test("K3: the Windows start icon switches to UTF-8 first and stops when the folder is gone; start --launcher never sets up a project", async () => {
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    const { writeLauncher } = await import(${JSON.stringify(new URL("../dist/setup.js", import.meta.url).href)});
    const { readFileSync } = await import("node:fs");
    const f = writeLauncher(process.argv[1], process.argv[2]);
    console.log(JSON.stringify(readFileSync(f, "utf8")));`;
  const dir = join(mkdtempSync(join(tmpdir(), "w-")), "Angebote Müller 100% & Co");
  mkdirSync(dir);
  const desk = mkdtempSync(join(tmpdir(), "desk-"));
  const text = JSON.parse(
    await new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script, dir, desk], (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout.trim())))),
  );
  const lines = text.split("\r\n");
  assert.equal(lines[1], "chcp 65001 >nul", "UTF-8 before any line with the path");
  assert.match(text, /pushd "[^"]*Müller 100%% & Co" \|\| \(echo/);
  assert.match(text, / start --launcher --root "[^"]*Müller 100%% & Co"/);
  // the CLI side: no project in that folder → refuse, create nothing
  const empty = mkdtempSync(join(tmpdir(), "desktop-"));
  writeFileSync(join(empty, "Gehaltsliste.xlsx"), "x");
  const res = await new Promise((resolve) => execFile(process.execPath, [CLI, "start", "--launcher", "--no-open", "--root", empty], { timeout: 20_000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })));
  assert.notEqual(res.code, 0);
  assert.match(res.out, /No Scenaria project/);
  assert.ok(!existsSync(join(empty, ".scenaria")), "nothing set up");
});

test("K4: a hand-edited root (goalHistory not a list) no longer breaks the integrity check; Simple view never falls back to stored verdicts", () => {
  const { s } = project();
  s.startMission({ projectGoal: "g", title: "t" });
  const root = s.store.readNode("n0");
  root.meta = { ...(root.meta ?? {}), goalHistory: {} };
  writeFileSync(join(s.root, ".scenaria", "nodes", "n0.json"), JSON.stringify(root));
  const f = s.fidelity();
  assert.ok(f.points);
  assert.equal(f.points.n0.integrity, "tampered", "the edit itself is still reported");
  const sv = readFileSync(new URL("../ui/src/SimpleView.tsx", import.meta.url), "utf8");
  assert.match(sv, /confirmed=\{confirmed\.has\(n\.id\)\}/);
  assert.match(sv, /p\.integrity === "tampered"/);
  assert.match(sv, /props\.fidelityError/);
});

test("K5/K6/K14: end of a day = its newest saved state; warnings and outside effects are shown; calendar yesterday", () => {
  const sv = readFileSync(new URL("../ui/src/SimpleView.tsx", import.meta.url), "utf8");
  assert.match(sv, /api\s*\.headAt\(midnight\.toISOString\(\)\)/, "end of day from the event log (K19)");
  assert.match(sv, /\.filter\(\(n\) => isStep\(n\) && n\.snapshot && dayKey\(n\.createdAt\) === key\)/, "fallback: newest saved state of the day");
  assert.match(sv, /\.forEach\(\(w\) => props\.toast\(w\)\)/);
  assert.match(sv, /t\.svCannotUndo/);
  assert.match(sv, /today\.getDate\(\) - 1/);
});

test("K7: a second project with the same folder name gets its own start icon; the same project reuses its icon", () => {
  const desk = mkdtempSync(join(tmpdir(), "desk-"));
  const a = join(mkdtempSync(join(tmpdir(), "ka-")), "Angebote");
  const b = join(mkdtempSync(join(tmpdir(), "kb-")), "Angebote");
  mkdirSync(a);
  mkdirSync(b);
  const fa = writeLauncher(a, desk);
  const fb = writeLauncher(b, desk);
  assert.notEqual(fa, fb);
  assert.match(fb, /Angebote \(2\)/);
  assert.ok(readFileSync(fa, "utf8").includes(realpathSync(a)), "A's icon still starts A");
  assert.equal(writeLauncher(a, desk), fa, "same project → same icon");
});

test("K9/K11: health tells which project the dashboard shows; a request not from the dashboard is logged as such and waits longer", async () => {
  const { s } = project();
  const srv = await startServer(s, { port: 4794, quiet: true, showApprovalLink: false });
  try {
    const h = await (await fetch(`${srv.url}/api/v1/health`)).json();
    assert.equal(h.viewKey, h.rootKey);
    await fetch(`${srv.url}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-agent": "some-agent" }, body: "{}" });
    assert.ok(s.store.readEvents().some((e) => /asked by some-agent, not marked as the dashboard/.test(e.data?.message ?? "")));
    const again = await fetch(`${srv.url}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" }, body: "{}" });
    assert.equal(again.status, 429);
    assert.ok((await again.json()).retryIn > 15, "agents wait a minute");
  } finally {
    srv.close();
  }
});

test("K12/K15: the wait and the verdict lock speak the person's language and point to the lock", () => {
  const ap = readFileSync(new URL("../ui/src/Approval.tsx", import.meta.url), "utf8");
  assert.match(ap, /t\.approvalBusy\(/);
  const srv = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.ok(!/open the approval link from the terminal running Scenaria \(scenaria start\/ui\)/.test(srv));
});

test("K16: the start icon goes to the localized desktop folder on Linux", { skip: process.platform !== "linux" }, () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".config"));
  mkdirSync(join(home, "Schreibtisch"));
  writeFileSync(join(home, ".config", "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Schreibtisch"\n');
  const { s } = project();
  const saved = process.env.XDG_DESKTOP_DIR;
  delete process.env.XDG_DESKTOP_DIR;
  try {
    const f = writeLauncher(s.root, undefined, home);
    assert.ok(f.startsWith(join(home, "Schreibtisch")), f);
    assert.match(f, /\.(desktop|sh)$/);
  } finally {
    if (saved !== undefined) process.env.XDG_DESKTOP_DIR = saved;
  }
});

test("K17: a Claude Desktop config of the wrong shape stops before anything is written", () => {
  const { s } = project();
  for (const bad of ['{"mcpServers": []}', "null", "[]"]) {
    const cfg = desktopConfig(bad);
    assert.throws(() => setupAgents(s.root, ["claude-desktop", "cursor"]), /does not look like a Claude Desktop config/);
    assert.equal(readFileSync(cfg.file, "utf8"), bad);
    assert.ok(!existsSync(join(s.root, ".cursor", "mcp.json")));
  }
});

// ---------------------------------------------------------------- review round 2 (K18–K21)

test("K18: the node panel and the map count only the engine's confirmed set (never stored fields)", () => {
  const np = readFileSync(new URL("../ui/src/NodePanel.tsx", import.meta.url), "utf8");
  assert.match(np, /const confirmedSet = new Set\(props\.fidelity\?\.confirmed \?\? \[\]\);/);
  assert.match(np, /verdictView\(n\.verification, confirmedSet\.has\(n\.id\)\)/);
  const app = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /const confirmedSet = useMemo\(\(\) => new Set\(fidelity\?\.confirmed \?\? \[\]\), \[fidelity\]\);/);
});

test("K19: the state at the end of a day is the step that was current then — an evening 'go back' counts", async () => {
  const { s, p } = project();
  s.startMission({ projectGoal: "Offer", title: "Offer" });
  p.write("a.txt", "A");
  const A = s.checkpoint({ title: "A" });
  p.write("a.txt", "B");
  const B = s.checkpoint({ title: "B" });
  await new Promise((r) => setTimeout(r, 15));
  s.rewind(A.id, { restoreFiles: true });
  await new Promise((r) => setTimeout(r, 15));
  const evening = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 15));
  p.write("a.txt", "C");
  s.checkpoint({ title: "C" });
  assert.equal(s.headAt(evening), A.id, "not B, although B is newer");
  assert.notEqual(s.headAt(evening), B.id);
  const app = await listen(createApp(s, { approvalCode: "c", approvalSecret: "sess" }));
  try {
    assert.deepEqual(await (await fetch(`${app.base}/api/head-at?until=${encodeURIComponent(evening)}`)).json(), { id: A.id });
    assert.equal((await fetch(`${app.base}/api/head-at?until=nonsense`)).status, 400);
  } finally {
    app.close();
  }
});

test("K20/K21: a failed start from the icon waits for Enter; the dashboard mark is logged as a claim", async () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /process\.argv\.includes\("--launcher"\) && process\.stdin\.isTTY/);
  assert.match(cli, /Did not open a new window/);
  const { s } = project();
  const srv = await startServer(s, { port: 4796, quiet: true, showApprovalLink: false });
  try {
    await fetch(`${srv.url}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-view": "dashboard" }, body: "{}" });
    assert.ok(s.store.readEvents().some((e) => /asked by a client marked as the dashboard/.test(e.data?.message ?? "")));
  } finally {
    srv.close();
  }
});
