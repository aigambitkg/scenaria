// Regression tests for data-safety findings from the independent review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenaria } from "../dist/core/index.js";
import { createApp } from "../dist/server.js";
import { tempProject } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("rewind never silently overwrites ignored files — they are backed up in the autosave", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write(".env", "OLD-SECRET\n");
  const n2 = s.checkpoint({ title: "with env" });
  execFileSync("rm", [join(p.dir, ".env")]);
  p.write(".gitignore", ".env\n");
  s.checkpoint({ title: "ignore env" });
  p.write(".env", "NEW-PRECIOUS-SECRET\n");

  const r = s.rewind(n2.id);
  assert.equal(p.read(".env"), "OLD-SECRET\n"); // target state restored …
  assert.ok(r.autosave, "an autosave was forced even though tracked files were clean");
  s.rewind(r.autosave.id); // … and the newer content is recoverable
  assert.equal(p.read(".env"), "NEW-PRECIOUS-SECRET\n");
});

test("allowlist .gitignore cannot pull .scenaria into snapshots or destroy history", () => {
  const p = tempProject();
  p.write(".gitignore", "*\n!*/\n!*.json\n!*.md\n");
  p.write("a.json", "{}");
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  const n2 = s.checkpoint({ title: "one" }) ?? s.head();
  p.write("b.json", "{}");
  s.checkpoint({ title: "two" });
  p.write("c.json", "{}");
  s.checkpoint({ title: "three" });
  const files = s.repo.listFiles(s.head().snapshot.commit);
  assert.ok(!files.some((f) => f.startsWith(".scenaria")), files.join(","));
  const before = s.store.listNodes().length;
  s.rewind(n2.id);
  const after = s.store.listNodes();
  assert.ok(after.length >= before, "no node files deleted");
  const counter = s.store.readState().counter;
  assert.ok(counter >= before, "id counter not reset");
  assert.equal(p.exists("c.json"), false);
});

test("nested repository without commits does not break snapshots", () => {
  const p = tempProject();
  p.write("main.txt", "x");
  p.write("vendor/lib/file.txt", "y");
  execFileSync("git", ["init", "-q"], { cwd: join(p.dir, "vendor/lib") });
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("main.txt", "x2");
  const cp = s.checkpoint({ title: "c" });
  assert.ok(cp.snapshot.commit);
  assert.ok(cp.snapshot.warnings?.some((w) => w.includes("vendor/lib")));
  assert.equal(s.verify(cp.id).verification.checks.find((c) => c.name === "snapshot completeness").status, "warning");
});

test("a lock left by a dead process is reclaimed", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  writeFileSync(join(p.dir, ".scenaria", "lock"), "999999:dead");
  const m = s.startMission({ title: "m" });
  assert.ok(m.id);
});

test("verifyCommand runs without holding the store lock", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("a.txt", "1");
  const cp = s.checkpoint({ title: "c" });
  const cfg = s.config();
  // The command itself writes to the store — it would time out if verify held the lock.
  cfg.verifyCommand = `"${process.execPath}" "${CLI}" status --root "${p.dir}"`;
  s.store.writeConfig(cfg);
  const v = s.verify(cp.id, { runCommand: true });
  assert.equal(v.verification.checks.find((c) => c.name.startsWith("command")).status, "passed");
});

test("dashboard rejects foreign Host headers (DNS rebinding) and foreign origins", async () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  const app = createApp(s);
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const raw = (headers, method = "GET", path = "/api/graph") =>
    new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end(method === "POST" ? "{}" : undefined);
    });
  try {
    assert.equal(await raw({ host: "attacker.example" }), 421);
    assert.equal(await raw({ host: `localhost:${port}` }), 200);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, origin: "http://attacker.example", "x-scenaria": "1" }, "POST", "/api/checkpoint"), 403);
  } finally {
    app.close();
    server.close();
  }
});

test("setup keeps user hooks that merely mention scenaria and orphan marker text", () => {
  const p = tempProject();
  p.write(".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/tools/scenaria-notify hook pre" }] }] } }));
  p.write("CLAUDE.md", "# Rules\n<!-- scenaria:start -->\nkeep this text\n");
  for (let i = 0; i < 2; i++) assert.equal(spawnSync(process.execPath, [CLI, "init", "--claude"], { cwd: p.dir }).status, 0);
  const settings = JSON.parse(p.read(".claude/settings.json"));
  const cmds = settings.hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
  assert.ok(cmds.includes("~/tools/scenaria-notify hook pre"));
  assert.equal(cmds.filter((c) => c.endsWith("hook pre-tool")).length, 1);
  assert.match(p.read("CLAUDE.md"), /keep this text/);
});

test("leaked GIT_* environment does not break init or touch the user's repo", () => {
  const p = tempProject();
  const r = spawnSync(process.execPath, [CLI, "init"], { cwd: p.dir, env: { ...process.env, GIT_WORK_TREE: "/nonexistent", GIT_DIR: "/nonexistent/.git" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(p.exists(".scenaria/shadow.git/HEAD"), true);
});

test("an ignored file where the target has a folder is backed up before rewind", () => {
  const p = tempProject();
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("cache/x.txt", "x");
  const n2 = s.checkpoint({ title: "folder" });
  execFileSync("rm", ["-r", join(p.dir, "cache")]);
  p.write(".gitignore", "cache\n");
  s.checkpoint({ title: "ignore cache" });
  p.write("cache", "PRECIOUS-FILE");
  const r = s.rewind(n2.id);
  assert.equal(p.read("cache/x.txt"), "x");
  assert.ok(r.autosave);
  s.rewind(r.autosave.id);
  assert.equal(p.read("cache"), "PRECIOUS-FILE");
});
