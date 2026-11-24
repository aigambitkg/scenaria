// Nothing in the project folder may make Scenaria run a program with the person's rights.
// The project folder (also `.scenaria/`) is writable by agents, while the dashboard, the HTTP API and the hooks
// often run under the person's account. Each test plants what an agent could plant and checks that it never runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { cleanShadowConfig, SAFE_GIT } from "../dist/core/snapshot.js";
import { insideScenaria, showFolderCommand } from "../dist/core/folders.js";
import { findOnPath, program } from "../dist/core/programs.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { tempProject } from "./helpers.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
/** A path as a POSIX shell and a git config value take it, also on Windows (git there runs hooks with its own sh). */
const sh = (p) => p.replaceAll("\\", "/");

function project() {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("a.txt", "1");
  const cp = s.checkpoint({ title: "c" });
  return { p, s, cp };
}

/** A command that leaves a marker file when it runs. */
function marker(p, name) {
  const file = join(p.dir, name);
  return { file, cmd: `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],'ran')" "${file}"` };
}

async function withServer(s, fn) {
  const app = createApp(s);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const post = (path, body) =>
    new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.end(JSON.stringify(body));
    });
  try {
    return await fn(post);
  } finally {
    app.close();
    server.close();
  }
}

test("verifyCommand: an agent's paths (HTTP, tool API, MCP tool, plain library call) never run it", async () => {
  const { p, s, cp } = project();
  const m = marker(p, "ran-verify.txt");
  const cfg = s.config();
  cfg.verifyCommand = m.cmd; // what an agent can write into .scenaria/config.json
  s.store.writeConfig(cfg);
  // The marker would make the tree dirty; keep it out of the comparison.
  await withServer(s, async (post) => {
    const a = await post("/api/verify", { id: cp.id, runCommand: true });
    assert.equal(a.status, 200);
    const b = await post("/api/v1/tools/scenaria_verify", { id: cp.id, runCommand: true });
    assert.equal(b.status, 200);
    assert.match(b.body, /not run/);
  });
  callTool(s, "scenaria_verify", { id: cp.id, runCommand: true }, { source: "mcp", agent: "a" });
  const n = s.verify(cp.id, { runCommand: true });
  assert.equal(existsSync(m.file), false, "the verify command ran for a caller that is not the person");
  const check = n.verification.checks.find((c) => c.name.startsWith("command"));
  assert.equal(check.status, "warning");
  assert.match(check.detail, /only the person runs it/);
});

test("verifyCommand: `scenaria verify --run` from a shell without a terminal (an agent's shell) does not run it", () => {
  const { p, s, cp } = project();
  const m = marker(p, "ran-cli.txt");
  const cfg = s.config();
  cfg.verifyCommand = m.cmd;
  s.store.writeConfig(cfg);
  const r = spawnSync(process.execPath, [CLI, "verify", cp.id, "--run", "--root", p.dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(m.file), false);
  assert.match(r.stdout, /not run/);
});

test("verifyCommand: with the person's go (commandBy) it still runs", () => {
  const { p, s, cp } = project();
  const cfg = s.config();
  cfg.verifyCommand = `"${process.execPath}" -e "process.exit(0)"`;
  s.store.writeConfig(cfg);
  const n = s.verify(cp.id, { runCommand: true, commandBy: "person" });
  assert.equal(n.verification.checks.find((c) => c.name.startsWith("command")).status, "passed");
});

test("shadow repository: planted hooks and fsmonitor never run when Scenaria saves, compares or restores", () => {
  const { p, s, cp } = project();
  const git = join(p.dir, ".scenaria", "shadow.git");
  const hookMark = join(p.dir, "..", `hook-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const script = `#!/bin/sh\necho ran >> "${sh(hookMark)}"\n`;
  mkdirSync(join(git, "hooks"), { recursive: true });
  for (const h of ["reference-transaction", "post-index-change", "pre-commit", "post-checkout", "pre-auto-gc"]) {
    writeFileSync(join(git, "hooks", h), script);
    chmodSync(join(git, "hooks", h), 0o755);
  }
  const fsm = join(p.dir, ".scenaria", "fsm.sh");
  writeFileSync(fsm, script);
  chmodSync(fsm, 0o755);
  writeFileSync(join(git, "config"), `${readFileSync(join(git, "config"), "utf8")}\n[core]\n\tfsmonitor = ${sh(fsm)}\n\thooksPath = ${sh(join(git, "hooks"))}\n`);
  const s2 = Scenaria.open(p.dir);
  p.write("a.txt", "2");
  const cp2 = s2.checkpoint({ title: "c2" });
  s2.diff(cp.id, cp2.id);
  s2.rewind(cp.id, {});
  assert.equal(existsSync(hookMark), false, "a program planted in .scenaria/shadow.git ran");
});

test("shadow repository: a filter driver planted in its config is removed before git runs, and the change is logged", () => {
  const { p, s } = project();
  const git = join(p.dir, ".scenaria", "shadow.git");
  const mark = join(p.dir, "..", `filter-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(join(git, "config"), `${readFileSync(join(git, "config"), "utf8")}\n[filter "x"]\n\tclean = sh -c 'echo ran >> "${sh(mark)}"; cat'\n\tsmudge = sh -c 'echo ran >> "${sh(mark)}"; cat'\n[include]\n\tpath = ../evil.cfg\n`);
  p.write(".gitattributes", "* filter=x\n");
  const s2 = Scenaria.open(p.dir);
  p.write("a.txt", "3");
  s2.checkpoint({ title: "c3" });
  assert.equal(existsSync(mark), false, "a filter driver from the shadow repository's config ran");
  const cfg = readFileSync(join(git, "config"), "utf8");
  assert.doesNotMatch(cfg, /filter|include/);
  assert.match(cfg, /bare = true/);
  assert.ok(s2.store.readEvents().some((e) => e.data?.security === "shadow_config_cleaned"));
});

test("cleanShadowConfig keeps what git init writes and drops everything else", () => {
  assert.equal(cleanShadowConfig("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\tignorecase = true\n\tprecomposeunicode = true\n"), null);
  assert.equal(cleanShadowConfig("[core]\n\tbare = true\n\tfsmonitor = /tmp/x\n"), "[core]\n\tbare = true\n");
  assert.equal(cleanShadowConfig("[core] bare = true\n"), "[core]\n");
  assert.equal(cleanShadowConfig('[core]\n\tbare = true\n[url "ext::sh -c x"]\n\tinsteadOf = /\n'), "[core]\n\tbare = true\n");
  assert.equal(cleanShadowConfig("[core]\n\tbare = true \\\n\tfsmonitor = x\n"), "[core]\n");
  assert.equal(cleanShadowConfig("[CORE]\n\tbare = true\n[include]\n\tpath = x\n"), "[core]\n\tbare = true\n");
});

test("every git call carries the options that switch off hooks, fsmonitor and the ext transport", () => {
  const joined = SAFE_GIT.join(" ");
  for (const k of ["core.hooksPath=", "core.fsmonitor=false", "protocol.ext.allow=never", "core.alternateRefsCommand="]) assert.ok(joined.includes(k), k);
  for (const f of ["snapshot.ts", "folders.ts", "engine.ts"]) {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core", f), "utf8");
    for (const m of src.matchAll(/(?:spawnSync|execFileSync)\(\s*"git",\s*\[([^\]]*)\]/g)) {
      if (/"--version"|"init"/.test(m[1])) continue; // no repository of the project is read
      assert.match(m[1], /SAFE_GIT/, `${f}: git call without SAFE_GIT: ${m[1].slice(0, 80)}`);
    }
  }
});

test("a step's folder: a name edited by hand never leads out of .scenaria, and showing a folder never starts it", () => {
  const { p, s, cp } = project();
  assert.equal(insideScenaria(p.dir, ".scenaria/snapshots/n0/s1/v001"), true);
  for (const bad of ["evil.app", "../outside", "/etc", ".scenaria/../evil.app", ".scenariaX/a", ""]) assert.equal(insideScenaria(p.dir, bad), false, bad);
  // A step file edited by hand names an "application" in the project folder.
  mkdirSync(join(p.dir, "evil.app"), { recursive: true });
  writeFileSync(join(p.dir, "evil.app", ".scenaria-version"), "x");
  const f = join(p.dir, ".scenaria", "nodes", `${cp.id}.json`);
  const node = JSON.parse(readFileSync(f, "utf8"));
  node.snapshotFolder = "evil.app";
  writeFileSync(f, JSON.stringify(node));
  const folder = Scenaria.open(p.dir).ensureFolder(cp.id);
  assert.ok(folder && !folder.includes("evil.app"), String(folder));
  assert.ok(insideScenaria(p.dir, folder.slice(p.dir.length + 1)));
  // macOS: reveal (`open -R`), never `open <folder>`, which would launch an application bundle.
  const mac = showFolderCommand(folder, "darwin");
  assert.equal(mac.cmd, "/usr/bin/open");
  assert.equal(mac.args[0], "-R");
  assert.ok(mac.args[1].startsWith(folder));
  assert.deepEqual(showFolderCommand("/x/y", "linux"), { cmd: "xdg-open", args: ["/x/y"] });
  // Windows: Explorer by its full path, never by name (a file called explorer.exe in the project must not be started).
  const win = showFolderCommand("C:\\p\\.scenaria\\snapshots\\v1", "win32");
  assert.match(win.cmd, /[\\/]explorer\.exe$/i);
  assert.notEqual(win.cmd, "explorer");
});

test("the version the server reports is the package's version", async () => {
  const { VERSION } = await import("../dist/server.js");
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("Windows: a program is found on the PATH only, never in the current folder", () => {
  const files = new Set(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\tools\\claude.cmd", "C:\\proj\\git.exe"]);
  const o = { platform: "win32", exists: (f) => files.has(f) };
  // An empty entry, "." and a relative folder all mean "where I am now" — the project. They never count.
  assert.equal(findOnPath("git", { ...o, pathVar: ";.;proj;C:\\Program Files\\Git\\cmd;C:\\proj" }), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(findOnPath("git", { ...o, pathVar: ".;;bin" }), null);
  assert.equal(findOnPath("git", { ...o, pathVar: '"C:\\Program Files\\Git\\cmd\\"' }), "C:\\Program Files\\Git\\cmd\\git.exe");
  // A .cmd only counts where it is asked for (it needs the shell to start).
  assert.equal(findOnPath("claude", { ...o, pathVar: "C:\\tools" }), null);
  assert.equal(findOnPath("claude", { ...o, pathVar: "C:\\tools", exts: [".exe", ".cmd"] }), "C:\\tools\\claude.cmd");
  // macOS and Linux: the name on a full-path entry.
  assert.equal(findOnPath("git", { platform: "linux", pathVar: ":.:/usr/bin", exists: (f) => f === "/usr/bin/git" }), "/usr/bin/git");
  // What spawn gets: the name elsewhere; on Windows a full path — also when nothing was found (then one that cannot exist).
  if (process.platform === "win32") assert.match(program("git"), /^[A-Za-z]:\\.*git\.(exe|com)$/i);
  else assert.equal(program("git"), "git");
  // No program is started by its bare name with the project as the working folder.
  for (const f of ["core/snapshot.ts", "core/folders.ts", "core/engine.ts", "ingest.ts", "setup.ts", "server.ts", "cli.ts"]) {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", f), "utf8");
    assert.doesNotMatch(src, /(?:spawn|spawnSync|execFile|execFileSync)\(\s*"(git|unzip|explorer|where)"/, f);
  }
});

test("Windows: a git.exe placed in the project folder is never started", { skip: process.platform !== "win32" }, () => {
  const { p, s, cp } = project();
  // Any program will do as the planted one: started as git it would fail on git's options, and saving would fail with it.
  copyFileSync(process.execPath, join(p.dir, "git.exe"));
  writeFileSync(join(p.dir, "git.cmd"), "@echo planted>> planted.txt\r\n");
  const s2 = Scenaria.open(p.dir);
  p.write("a.txt", "2");
  const cp2 = s2.checkpoint({ title: "c2" });
  assert.ok(cp2.snapshot?.commit, "saved with the real git");
  s2.diff(cp.id, cp2.id);
  s2.rewind(cp.id, {});
  assert.equal(p.read("a.txt"), "1");
  assert.equal(existsSync(join(p.dir, "planted.txt")), false);
});
