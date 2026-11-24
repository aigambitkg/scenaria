// Temporary diagnostics for the Windows port (scratch branch only).
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Scenaria } from "../../dist/core/index.js";
import { buildAuditFile } from "../../dist/core/auditfile.js";
import { tempProject } from "../../test/helpers.mjs";
console.log("platform", process.platform, "node", process.version, "HOME", process.env.HOME, "USERPROFILE", process.env.USERPROFILE, "homedir", homedir(), "tmpdir", tmpdir());
const p = tempProject();
const s = Scenaria.init(p.dir);
s.startMission({ projectGoal: "G", title: "T", goal: "g" });
p.write("a.txt", "1");
s.checkpoint({ title: "c", outputs: ["x"], agent: "a" });
rmSync(join(p.dir, ".scenaria/ledger.jsonl"));
mkdirSync(join(p.dir, ".scenaria/ledger.jsonl"));
try { readFileSync(join(p.dir, ".scenaria/ledger.jsonl"), "utf8"); console.log("read of a directory: no error?!"); } catch (e) { console.log("read of a directory:", e.code, e.message); }
try {
  const f = buildAuditFile(Scenaria.open(p.dir));
  console.log("integrity", f.integrity.state, JSON.stringify(f.integrity.warnings.map((w) => [w.code, w.level, (w.items ?? []).slice(0, 3)])));
} catch (e) { console.log("buildAuditFile threw", e.stack); }
// Does a bare program name start a file from the working folder on Windows?
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
const q = tempProject();
copyFileSync(process.execPath, join(q.dir, "git.exe"));
const bare = spawnSync("git", ["--version"], { cwd: q.dir, encoding: "utf8" });
console.log("bare 'git --version' with a planted git.exe in cwd →", JSON.stringify((bare.stdout || bare.stderr || "").trim().slice(0, 80)));
const { program } = await import("../../dist/core/programs.js");
console.log("program('git') =", program("git"));
