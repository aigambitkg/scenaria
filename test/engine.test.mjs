import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Scenaria } from "../dist/core/index.js";
import { tempProject } from "./helpers.mjs";

function setup() {
  const p = tempProject();
  p.write("README.md", "v1\n");
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "Test mission", goal: "Ship it", brief: "Do the thing" });
  return { p, s };
}

test("checkpoint records snapshot and changed files", () => {
  const { p, s } = setup();
  p.write("src/a.ts", "export const a = 1;\n");
  const cp = s.checkpoint({ title: "add a", outputs: ["`src/a.ts` created"] });
  assert.ok(cp.snapshot.commit);
  assert.deepEqual(cp.changedFiles, ["+ src/a.ts"]);
  assert.equal(s.head().id, cp.id);
});

test("onlyIfChanged skips unchanged trees", () => {
  const { s } = setup();
  assert.equal(s.checkpoint({ title: "noop", onlyIfChanged: true }), null);
});

test("rewind restores modified, deleted and new files and autosaves first", () => {
  const { p, s } = setup();
  p.write("src/a.ts", "good\n");
  const good = s.checkpoint({ title: "good" });
  p.write("src/a.ts", "broken\n");
  p.write("junk.txt", "junk\n");
  execFileSync("rm", [`${p.dir}/README.md`]);

  const r = s.rewind(good.id, { lesson: "do not break a.ts" });
  assert.equal(p.read("src/a.ts"), "good\n");
  assert.equal(p.read("README.md"), "v1\n");
  assert.equal(p.exists("junk.txt"), false);
  assert.ok(r.autosave, "autosave created");
  assert.equal(r.autosave.type, "autosave");
  assert.equal(s.head().id, good.id);
  assert.match(s.node(good.id).lessons[0], /do not break/);

  // The rewind itself is undoable.
  s.rewind(r.autosave.id);
  assert.equal(p.read("src/a.ts"), "broken\n");
  assert.equal(p.exists("junk.txt"), true);
});

test("project .gitignore is honored and .scenaria is never snapshotted", () => {
  const { p, s } = setup();
  p.write(".gitignore", "secret.env\n");
  p.write("secret.env", "TOKEN=1\n");
  const cp = s.checkpoint({ title: "with ignore" });
  const files = s.repo.git(["ls-tree", "-r", "--name-only", cp.snapshot.commit]).split("\n");
  assert.ok(files.includes(".gitignore"));
  assert.ok(!files.includes("secret.env"));
  assert.ok(!files.some((f) => f.startsWith(".scenaria")));
  // ignored files survive a rewind untouched
  p.write("x.txt", "x");
  s.checkpoint({ title: "x" });
  s.rewind(cp.id);
  assert.equal(p.read("secret.env"), "TOKEN=1\n");
});

test("the user's own git repo is untouched", () => {
  const p = tempProject();
  execFileSync("git", ["init", "-q"], { cwd: p.dir });
  p.write("a.txt", "1");
  execFileSync("git", ["add", "."], { cwd: p.dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: p.dir });
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8" });
  const s = Scenaria.init(p.dir);
  s.startMission({ title: "m" });
  p.write("a.txt", "2");
  const cp = s.checkpoint({ title: "c" });
  p.write("a.txt", "3");
  s.rewind(cp.id);
  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8" });
  assert.equal(before, after);
  const refs = execFileSync("git", ["for-each-ref"], { cwd: p.dir, encoding: "utf8" });
  assert.ok(!refs.includes("scenaria"));
  assert.equal(p.read("a.txt"), "2");
});

test("decisions resolve options by label, id, index and free text", () => {
  const { s } = setup();
  const d1 = s.decide({ question: "Q1", options: ["Alpha", "Beta"], chosen: "beta" });
  assert.equal(d1.chosen, "b");
  const d2 = s.decide({ question: "Q2", options: ["Alpha", "Beta"], chosen: 1 });
  assert.equal(d2.chosen, "a");
  const d3 = s.decide({ question: "Q3", options: ["Alpha", "Beta"], chosen: "Something else" });
  assert.equal(d3.options.length, 3);
  assert.equal(d3.options[2].label, "Something else");
  assert.equal(d3.chosen, "c");
  const d4 = s.decide({ question: "Q4", options: ["Alpha", "Beta"] });
  assert.equal(d4.chosen, undefined);
  s.choose(d4.id, "Alpha", "because");
  assert.equal(s.node(d4.id).chosen, "a");
});

test("children of a decision carry the option they continue", () => {
  const { s } = setup();
  const d = s.decide({ question: "DB?", options: ["Postgres", "SQLite"], chosen: "SQLite" });
  const cp = s.checkpoint({ title: "schema" });
  assert.equal(cp.parentId, d.id);
  assert.equal(cp.viaOption, "b");
});

test("fork starts a branch from the decision's files", () => {
  const { p, s } = setup();
  const d = s.decide({ question: "Framework?", options: ["Astro", "Next.js"], chosen: "Astro" });
  p.write("astro.config.mjs", "astro");
  s.checkpoint({ title: "astro setup" });
  const r = s.fork(d.id, "Next.js", { lesson: "Astro lacks feature X" });
  assert.equal(r.branch.type, "branch");
  assert.equal(r.branch.parentId, d.id);
  assert.equal(r.branch.viaOption, "b");
  assert.equal(p.exists("astro.config.mjs"), false);
  assert.equal(s.head().id, r.branch.id);
  assert.match(r.context.markdown, /\*\*Next\.js\*\*/);
  assert.match(r.context.markdown, /Astro lacks feature X/);
});

test("resume context excludes sibling branches (non-anticipativity)", () => {
  const { p, s } = setup();
  const d = s.decide({ question: "Approach?", options: ["A", "B"], chosen: "A" });
  p.write("a.txt", "a");
  s.checkpoint({ title: "SECRET-A-RESULT", outputs: ["A produced SECRET-A-OUTPUT"] });
  const r = s.fork(d.id, "B");
  assert.doesNotMatch(r.context.markdown, /SECRET-A/);
  const full = s.context();
  assert.match(full.markdown, /Ship it/);
  assert.ok(full.tokens > 10 && full.tokens < 2000);
});

test("auto verification catches hallucinated files and low confidence", () => {
  const { p, s } = setup();
  const d = s.decide({ question: "Lib?", options: ["x", "y"], chosen: "x", confidence: 0.3 });
  const vd = s.verify(d.id);
  assert.equal(vd.verification.status, "warning");
  p.write("src/real.ts", "1");
  const cp = s.checkpoint({ title: "work", outputs: ["`src/real.ts` written", "`src/imaginary.ts` written"] });
  const v = s.verify(cp.id);
  assert.equal(v.verification.status, "failed");
  assert.match(JSON.stringify(v.verification.checks), /imaginary/);
  const manual = s.verify(cp.id, { status: "passed", notes: "imaginary was renamed", by: "reviewer" });
  assert.equal(manual.verification.status, "passed");
  assert.equal(s.lastGood().id, cp.id);
});

test("verifyCommand runs only on a clean HEAD", () => {
  const { p, s } = setup();
  const cfg = s.config();
  cfg.verifyCommand = "test -f ok.txt";
  s.store.writeConfig(cfg);
  p.write("ok.txt", "1");
  const cp = s.checkpoint({ title: "ok" });
  const v = s.verify(cp.id, { runCommand: true });
  assert.equal(v.verification.checks.find((c) => c.name.startsWith("command")).status, "passed");
  p.write("other.txt", "dirty");
  const v2 = s.verify(cp.id, { runCommand: true });
  assert.equal(v2.verification.checks.find((c) => c.name.startsWith("command")).status, "warning");
});

test("irreversible effects are warned about on rewind", () => {
  const { p, s } = setup();
  const base = s.checkpoint({ title: "base" }) ?? s.head();
  p.write("x", "1");
  s.checkpoint({ title: "pushed", irreversible: ["git push origin main"] });
  const r = s.rewind(base.id);
  assert.ok(r.warnings.some((w) => w.includes("git push")));
});

test("knowledge base notes, protocol and tree are written", () => {
  const { p, s } = setup();
  const d = s.decide({ question: "Q?", options: ["A", "B"], chosen: "A", rationale: "r" });
  assert.ok(p.exists(`.scenaria/kb/${d.id}.md`));
  assert.match(p.read(`.scenaria/kb/${d.id}.md`), /- \[x\] \*\*A\*\*/);
  const f = s.writeProtocol();
  assert.match(p.read(".scenaria/protocol.md"), /decision/);
  assert.ok(f.endsWith("protocol.md"));
  assert.match(s.treeText(), /◀ HEAD/);
});

test("diff between nodes and against working tree", () => {
  const { p, s } = setup();
  const a = s.checkpoint({ title: "a" }) ?? s.head();
  p.write("f.txt", "hello\n");
  const b = s.checkpoint({ title: "b" });
  const d = s.diff(a.id, b.id);
  assert.match(d.stat, /f\.txt/);
  p.write("f.txt", "changed\n");
  const w = s.diff(b.id);
  assert.equal(w.to, "working tree");
  assert.match(w.patch, /\+changed/);
});
