// Nothing in the project folder may make Scenaria run a program with the person's rights.
// The project folder (also `.scenaria/`) is writable by agents, while the dashboard, the HTTP API and the hooks
// often run under the person's account. Each test plants what an agent could plant and checks that it never runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { fileSystemFacts, SAFE_GIT, ShadowControlError, ShadowRepo, shadowControlDir } from "../dist/core/snapshot.js";
import { insideScenaria, showFolderCommand } from "../dist/core/folders.js";
import { createApp } from "../dist/server.js";
import { callTool } from "../dist/tools.js";
import { tempProject } from "./helpers.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const posix = process.platform !== "win32";

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

test("shadow repository: planted hooks and fsmonitor never run when Scenaria saves, compares or restores", { skip: !posix }, () => {
  const { p, s, cp } = project();
  const git = join(p.dir, ".scenaria", "shadow.git");
  const hookMark = join(p.dir, "..", `hook-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const script = `#!/bin/sh\necho ran >> "${hookMark}"\n`;
  mkdirSync(join(git, "hooks"), { recursive: true });
  for (const h of ["reference-transaction", "post-index-change", "pre-commit", "post-checkout", "pre-auto-gc"]) {
    writeFileSync(join(git, "hooks", h), script);
    chmodSync(join(git, "hooks", h), 0o755);
  }
  const fsm = join(p.dir, ".scenaria", "fsm.sh");
  writeFileSync(fsm, script);
  chmodSync(fsm, 0o755);
  writeFileSync(join(git, "config"), `${readFileSync(join(git, "config"), "utf8")}\n[core]\n\tfsmonitor = ${fsm}\n\thooksPath = ${join(git, "hooks")}\n`);
  const s2 = Scenaria.open(p.dir);
  p.write("a.txt", "2");
  const cp2 = s2.checkpoint({ title: "c2" });
  s2.diff(cp.id, cp2.id);
  s2.rewind(cp.id, {});
  assert.equal(existsSync(hookMark), false, "a program planted in .scenaria/shadow.git ran");
});

/** Runs `fn` with another Scenaria home (the folder outside the project), then puts the old one back. */
function withHome(home, fn) {
  const before = process.env.SCENARIA_HOME;
  process.env.SCENARIA_HOME = home;
  try {
    return fn();
  } finally {
    process.env.SCENARIA_HOME = before;
  }
}

const inside = (dir, root) => realpathSync.native(dir).startsWith(realpathSync.native(root) + sep);

test("shadow repository: its control files live outside the project folder", () => {
  const { p, s } = project();
  const control = s.repo.controlDir;
  assert.equal(control, shadowControlDir(p.dir));
  assert.equal(inside(control, p.dir), false, "the control folder lies in the project");
  assert.equal(inside(control, process.env.SCENARIA_HOME), true, "the control folder is not in Scenaria's own folder");
  for (const f of ["HEAD", "config", join("info", "exclude")]) assert.equal(existsSync(join(control, f)), true, `${f} missing in the control folder`);
  assert.equal(existsSync(join(control, "hooks")), false, "the control folder got sample hooks");
  // The file states stay in the project: nothing but the pointer to them is stored outside.
  assert.deepEqual(readdirSync(join(control, "objects"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name), ["alternates"]);
  assert.ok(readdirSync(join(p.dir, ".scenaria", "shadow.git", "objects")).length > 2);
  assert.match(readFileSync(join(control, "info", "exclude"), "utf8"), /node_modules/);
});

test("shadow repository: a filter driver planted in the project never runs, also not in a process that is already running", { skip: !posix }, () => {
  const { p, s, cp } = project();
  const git = join(p.dir, ".scenaria", "shadow.git");
  const mark = join(p.dir, "..", `filter-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const planted = `[core]\n\tbare = true\n[filter "x"]\n\tclean = sh -c 'echo ran >> "${mark}"; cat'\n\tsmudge = sh -c 'echo ran >> "${mark}"; cat'\n\tprocess = sh -c 'echo ran >> "${mark}"'\n[include]\n\tpath = ../evil.cfg\n`;
  const plant = () => {
    writeFileSync(join(git, "config"), planted);
    mkdirSync(join(git, "info"), { recursive: true });
    writeFileSync(join(git, "info", "attributes"), "* filter=x\n");
  };
  plant();
  p.write(".gitattributes", "* filter=x\n");
  // the same process that saved before (a dashboard that keeps running) …
  p.write("a.txt", "3");
  const cp3 = s.checkpoint({ title: "c3" });
  s.diff(cp.id, cp3.id);
  s.rewind(cp.id, {});
  s.ensureFolder(cp3.id);
  // … and a new one
  plant();
  const s2 = Scenaria.open(p.dir);
  p.write("a.txt", "4");
  s2.checkpoint({ title: "c4" });
  s2.rewind(cp3.id, {});
  assert.equal(existsSync(mark), false, "a filter driver from the project folder ran");
  // Git reads its settings from the control folder; what is planted in the project stays what it is: unused text.
  assert.doesNotMatch(readFileSync(join(s2.repo.controlDir, "config"), "utf8"), /filter|include/);
  assert.equal(readFileSync(join(git, "config"), "utf8"), planted);
});

test("fileSystemFacts takes four yes/no values from a config text and nothing else", () => {
  assert.deepEqual(fileSystemFacts("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\tignorecase = false\n\tprecomposeunicode = true\n\tsymlinks = false\n"), ["-c", "core.filemode=true", "-c", "core.ignorecase=false", "-c", "core.precomposeunicode=true", "-c", "core.symlinks=false"]);
  assert.deepEqual(fileSystemFacts("[core]\n\tfsmonitor = /tmp/x\n\thooksPath = /tmp\n\tfilemode = /tmp/x\n\tsshCommand = x\n"), []);
  assert.deepEqual(fileSystemFacts('[filter "x"]\n\tclean = x\n\tfilemode = true\n[include]\n\tpath = x\n'), []);
  assert.deepEqual(fileSystemFacts("[core] filemode = true\n"), []);
  assert.deepEqual(fileSystemFacts("[core]\n\tfilemode = true \\\n\tfsmonitor = x\n"), []);
  assert.deepEqual(fileSystemFacts("[CORE]\r\n\tFileMode = FALSE\r\n"), ["-c", "core.filemode=false"]);
  assert.deepEqual(fileSystemFacts("[core]\n\tfilemode = true\n\tfilemode = false\n"), ["-c", "core.filemode=false"]);
  assert.deepEqual(fileSystemFacts(""), []);
});

test("shadow repository: a project from before (or from another machine) keeps every saved state", () => {
  const { p, s, cp } = project();
  p.write("a.txt", "2");
  p.write("b.txt", "new");
  const cp2 = s.checkpoint({ title: "c2" });
  // What an older version left, or what arrives with a copied folder: no control folder on this machine.
  rmSync(s.repo.controlDir, { recursive: true, force: true });
  const s2 = Scenaria.open(p.dir);
  assert.equal(s2.snapshotIssue, null);
  assert.equal(existsSync(join(s2.repo.controlDir, "HEAD")), true);
  assert.equal(s2.repo.missingCommits([cp.snapshot.commit, cp2.snapshot.commit]).size, 0);
  assert.match(s2.diff(cp.id, cp2.id).patch, /b\.txt/);
  s2.rewind(cp.id, {});
  assert.equal(p.read("a.txt"), "1");
  assert.equal(p.exists("b.txt"), false);
  // the refs are written anew from the steps
  assert.ok(s2.syncRefs() >= 2);
  const refs = s2.repo.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/scenaria"]);
  assert.match(refs, new RegExp(`refs/scenaria/${cp2.id} ${cp2.snapshot.commit}`));
});

test("shadow repository: the saved states move with the project folder", () => {
  const { p, s, cp } = project();
  p.write("a.txt", "2");
  s.checkpoint({ title: "c2" });
  const moved = `${p.dir}-moved`;
  renameSync(p.dir, moved);
  const s2 = Scenaria.open(moved);
  assert.equal(s2.snapshotIssue, null);
  assert.notEqual(s2.repo.controlDir, s.repo.controlDir);
  s2.rewind(cp.id, {});
  assert.equal(readFileSync(join(moved, "a.txt"), "utf8"), "1");
});

test("shadow repository: two accounts with their own Scenaria folder share the saved states of one project", () => {
  const p = tempProject();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.dir });
  p.write("a.txt", "1");
  // the agent's account (a sandbox with its own home) saves …
  const agentHome = mkdtempSync(join(tmpdir(), "scenaria-home-agent-"));
  const cp = withHome(agentHome, () => {
    const s = Scenaria.init(p.dir);
    s.startMission({ title: "m" });
    const first = s.checkpoint({ title: "c1" });
    p.write("a.txt", "2");
    s.checkpoint({ title: "c2" });
    return first;
  });
  // … the person's dashboard looks, goes back and publishes the refs
  const s = Scenaria.open(p.dir);
  assert.notEqual(s.repo.controlDir.startsWith(agentHome), true);
  assert.equal(s.repo.missingCommits([cp.snapshot.commit]).size, 0);
  s.rewind(cp.id, {});
  assert.equal(p.read("a.txt"), "1");
  const r = s.mirrorToProjectGit();
  assert.equal(r.ok, true, r.message);
  const refs = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/scenaria"], { cwd: p.dir, encoding: "utf8" });
  assert.match(refs, new RegExp(`refs/scenaria/${cp.id} ${cp.snapshot.commit}`));
});

test("shadow repository: a control folder that cannot be used switches saving off and says what to check", async () => {
  const p = tempProject();
  p.write("a.txt", "1");
  // Scenaria's own folder exists, but where the control folders belong there is a file.
  const home = mkdtempSync(join(tmpdir(), "scenaria-home-broken-"));
  writeFileSync(join(home, "shadow"), "not a folder");
  await withHomeAsync(home, async () => {
    const s = Scenaria.init(p.dir);
    assert.equal(s.repo, null);
    const st = s.status();
    assert.equal(st.snapshots, false);
    assert.equal(st.snapshotIssue.code, "control_folder");
    assert.equal(st.snapshotIssue.platform, process.platform);
    assert.ok(st.snapshotIssue.folder.startsWith(join(home, "shadow")));
    assert.match(st.snapshotIssue.message, /file snapshots are off/);
    assert.ok(st.snapshotIssue.message.includes(st.snapshotIssue.folder));
    assert.match(st.snapshotIssue.message, posix ? /ls -ld .*chmod u\+rwx/ : /icacls .*Properties, Security/);
    // Nothing is saved, and Scenaria does not fall back to control files in the project.
    s.startMission({ title: "m" });
    const cp = s.checkpoint({ title: "c" });
    assert.ok(!cp.snapshot);
    assert.throws(() => s.diff(cp.id), /file snapshots are off/);
    assert.equal(s.mirrorToProjectGit().ok, false);
    // agents are told, and the dashboard gets the reason
    const told = callTool(s, "scenaria_status", {});
    assert.match(JSON.stringify(told), /file snapshots are off.*tell the user/);
    const app = createApp(s, {});
    const srv = createServer(app.handler);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const g = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/graph`)).json();
      assert.equal(g.snapshots, false);
      assert.equal(g.snapshotIssue.code, "control_folder");
      assert.equal(g.snapshotIssue.folder, st.snapshotIssue.folder);
    } finally {
      app.close();
      srv.closeAllConnections?.();
      srv.close();
    }
    // the command line says it too
    const cli = spawnSync(process.execPath, [CLI, "status", "--root", p.dir], { encoding: "utf8", env: { ...process.env, SCENARIA_HOME: home } });
    assert.match(cli.stdout + cli.stderr, /file snapshots are off: Scenaria cannot use its own folder/);
  });
  // Once the folder is usable again, saving works without anything else to do.
  const s2 = Scenaria.open(p.dir);
  assert.equal(s2.snapshotIssue, null);
  p.write("a.txt", "2");
  assert.ok(s2.checkpoint({ title: "c2" }).snapshot.commit);
});

async function withHomeAsync(home, fn) {
  const before = process.env.SCENARIA_HOME;
  process.env.SCENARIA_HOME = home;
  try {
    return await fn();
  } finally {
    process.env.SCENARIA_HOME = before;
  }
}

test("shadow repository: a control folder inside the project is refused", () => {
  const p = tempProject();
  mkdirSync(join(p.dir, ".scenaria"), { recursive: true });
  for (const dir of [join(p.dir, ".scenaria", "control"), join(p.dir, "sub", "control")]) {
    const repo = new ShadowRepo(p.dir, join(p.dir, ".scenaria"), dir);
    assert.throws(() => repo.init(), (e) => e instanceof ShadowControlError && e.issue.reason === "inside_project" && /lies inside this project/.test(e.message));
    assert.equal(existsSync(join(dir, "HEAD")), false);
  }
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
});

test("the version the server reports is the package's version", async () => {
  const { VERSION } = await import("../dist/server.js");
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
});
