import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Snapshot } from "./types.js";

/**
 * File snapshots via a private "shadow" git repository inside `.scenaria/`.
 *
 * - Works in any folder (with or without its own git repo).
 * - Never touches the project's own `.git`, index, branches or stash.
 * - Honors the project's .gitignore files. `.scenaria/` is excluded by an explicit
 *   pathspec, so even allowlist-style .gitignores (`*`, `!*\/`) cannot pull it in.
 * - Each snapshot is pinned by a ref `refs/scenaria/<nodeId>` so it is never GC'd.
 */
export class ShadowRepo {
  readonly root: string;
  readonly gitDir: string;
  readonly indexFile: string;
  /** Paths excluded at runtime (e.g. nested repos without commits). */
  private runtimeExcludes = new Set<string>();
  private warnings = new Set<string>();

  constructor(root: string, scenariaDir: string) {
    this.root = root;
    this.gitDir = join(scenariaDir, "shadow.git");
    this.indexFile = join(scenariaDir, "shadow.index");
  }

  static gitAvailable(): boolean {
    const r = spawnSync("git", ["--version"], { encoding: "utf8", env: cleanEnv() });
    return r.status === 0;
  }

  get initialized() {
    return existsSync(join(this.gitDir, "HEAD"));
  }

  private env() {
    const env = cleanEnv();
    env.GIT_DIR = this.gitDir;
    env.GIT_WORK_TREE = this.root;
    env.GIT_INDEX_FILE = this.indexFile;
    // Untranslated git messages: the parsers below match English text.
    if (env.LC_ALL) {
      env.LC_CTYPE ??= env.LC_ALL;
      delete env.LC_ALL;
    }
    env.LC_MESSAGES = "C";
    env.LANGUAGE = "";
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "Scenaria";
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "scenaria@localhost";
    return env;
  }

  git(args: string[], opts: { input?: string; allowFail?: boolean; maxBuffer?: number } = {}): string {
    const r = this.run(args, opts.input, opts.maxBuffer);
    if (r.status !== 0 && !opts.allowFail) {
      throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || "").trim()}`);
    }
    return (r.stdout || "").trimEnd();
  }

  private run(args: string[], input?: string, maxBuffer?: number) {
    // Parallel processes (hooks, proxy, dashboard) may briefly contend for the shadow index lock.
    for (let attempt = 0; ; attempt++) {
      const r = this.runOnce(args, input, maxBuffer);
      if (r.status === 0 || attempt >= 40 || !/index\.lock/.test(String(r.stderr ?? ""))) return r;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }

  private runOnce(args: string[], input?: string, maxBuffer?: number) {
    return spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "advice.addEmbeddedRepo=false", "-c", "core.safecrlf=false", ...args],
      { cwd: this.root, env: this.env(), encoding: "utf8", input, maxBuffer: maxBuffer ?? 128 * 1024 * 1024 },
    );
  }

  init(exclude: string[] = []) {
    if (!this.initialized) {
      mkdirSync(this.gitDir, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", this.gitDir], { stdio: "ignore", env: cleanEnv() });
    }
    this.writeExcludes(exclude);
  }

  writeExcludes(exclude: string[]) {
    const lines = ["# managed by scenaria (.scenaria/ is excluded by pathspec)", ...exclude];
    const file = join(this.gitDir, "info", "exclude");
    const next = lines.join("\n") + "\n";
    try {
      if (existsSync(file) && readFileSync(file, "utf8") === next) return;
    } catch {}
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(file, next);
  }

  /** A hook killed mid-operation can leave git's index lock behind; clear it if clearly orphaned. */
  private clearStaleIndexLock() {
    const lock = `${this.indexFile}.lock`;
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 120_000) unlinkSync(lock);
    } catch {}
  }

  private pathspec(): string[] {
    return [
      "--",
      ".",
      ":(top,literal,exclude).scenaria",
      ...[...this.runtimeExcludes].map((p) => `:(top,literal,exclude)${p}`),
    ];
  }

  /** Stage the whole working tree into the shadow index. */
  private stageAll() {
    this.clearStaleIndexLock();
    this.warnings.clear();
    for (const p of this.runtimeExcludes) this.warnings.add(`nested repository "${p}" has no commits and was not snapshotted`);
    for (let attempt = 0; attempt < 25; attempt++) {
      const r = this.run(["add", "-A", ...this.pathspec()]);
      if (r.status === 0) break;
      const err = `${r.stderr}${r.stdout}`;
      // git (seen with 2.34 and 2.43) exits 1 when an exclude pathspec names a path the
      // project's .gitignore already ignores (".scenaria/"), although every other
      // file was staged. That is harmless as long as only our own excludes are listed.
      if (r.status === 1 && this.onlyOwnPathsIgnored(err)) break;
      const m = err.match(/'([^']+)' does not have a commit checked out/);
      if (!m) throw new Error(`git add failed: ${err.trim()}`);
      const p = m[1].replace(/\/$/, "");
      this.runtimeExcludes.add(p);
      this.warnings.add(`nested repository "${p}" has no commits and was not snapshotted`);
      if (attempt === 24) throw new Error(`git add failed: ${err.trim()}`);
    }
    // Defensive: never keep Scenaria's own state in the index.
    this.run(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ".scenaria"]);
    const gitlinks = this.git(["ls-files", "-s"]).split("\n").filter((l) => l.startsWith("160000"));
    for (const l of gitlinks) {
      const p = l.split("\t")[1];
      this.warnings.add(`nested repository "${p}": only its commit pointer is saved, uncommitted changes inside it are not`);
    }
  }

  /** True when git's only complaint is "paths are ignored" for .scenaria or runtime excludes. */
  private onlyOwnPathsIgnored(err: string): boolean {
    const head = "The following paths are ignored by one of your .gitignore files:";
    const at = err.indexOf(head);
    if (at < 0) return false;
    const before = err.slice(0, at).trim();
    if (before) return false;
    const strip = (p: string) => p.replace(/\/+$/, "");
    const own = [".scenaria", ...[...this.runtimeExcludes].map(strip)];
    // git names the ignored path itself, or an ignored parent folder of an exclude.
    const isOwn = (p: string) => own.some((e) => e === p || e.startsWith(`${p}/`));
    const paths: string[] = [];
    for (const raw of err.slice(at + head.length).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (/^hint:/i.test(line)) continue;
      if (/^(error|fatal|warning):/i.test(line)) return false;
      paths.push(strip(line));
    }
    return paths.length > 0 && paths.every(isOwn);
  }

  /**
   * Cheap fingerprint of the working tree (paths + size + mtime of tracked and
   * non-ignored files). Used by watch mode; writes no git objects.
   */
  fingerprint(): string {
    const out = this.git(["ls-files", "-z", "-co", "--exclude-standard", ...this.pathspec()]);
    const h = createHash("sha1");
    for (const f of out.split("\0").filter(Boolean).sort()) {
      try {
        const st = lstatSync(join(this.root, f));
        h.update(`${f}\0${st.size}\0${st.mtimeMs}\n`);
      } catch {
        h.update(`${f}\0gone\n`);
      }
    }
    return h.digest("hex");
  }

  /** Stage the whole working tree and return its tree hash. */
  currentTree(): string {
    this.stageAll();
    return this.git(["write-tree"]);
  }

  snapshot(nodeId: string, message: string, parentCommit?: string | null, forceAdd: string[] = []): Snapshot {
    this.stageAll();
    if (forceAdd.length) {
      this.git(["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: forceAdd.join("\0") });
    }
    const tree = this.git(["write-tree"]);
    const args = ["commit-tree", tree, "-m", message];
    if (parentCommit && this.hasObject(parentCommit)) args.push("-p", parentCommit);
    const commit = this.git(args);
    this.git(["update-ref", `refs/scenaria/${nodeId}`, commit]);
    const files = this.countFiles(tree);
    const snap: Snapshot = { commit, tree, files };
    if (this.warnings.size) snap.warnings = [...this.warnings];
    return snap;
  }

  countFiles(tree: string): number {
    const out = this.git(["ls-tree", "-r", "--name-only", tree]);
    return out ? out.split("\n").length : 0;
  }

  listFiles(rev: string): string[] {
    const out = this.git(["ls-tree", "-r", "-z", "--name-only", rev]);
    return out ? out.split("\0").filter(Boolean) : [];
  }

  hasObject(rev: string): boolean {
    return this.run(["cat-file", "-e", rev]).status === 0;
  }

  /**
   * Files that a restore to `commit` would overwrite although they are not part of
   * the current snapshot state (ignored/excluded files on disk at a path the target
   * contains). They must be force-saved before restoring.
   */
  unsavedOverwrites(commit: string): string[] {
    this.stageAll();
    const indexed = new Set(this.git(["ls-files", "-z"]).split("\0").filter(Boolean));
    const out = new Set<string>();
    const checked = new Set<string>();
    const consider = (path: string, mustBeNonDir: boolean) => {
      if (checked.has(path)) return;
      checked.add(path);
      if (indexed.has(path) || path === ".scenaria" || path.startsWith(".scenaria/")) return;
      try {
        const st = lstatSync(join(this.root, path));
        if (mustBeNonDir && st.isDirectory()) return;
        out.add(path);
      } catch {
        /* not on disk */
      }
    };
    for (const f of this.listFiles(commit)) {
      // A file on disk where the target has a folder would be replaced too.
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) consider(parts.slice(0, i).join("/"), true);
      consider(f, false);
    }
    return [...out];
  }

  unstage(paths: string[]) {
    this.git(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      input: paths.join("\0"),
      allowFail: true,
    });
  }

  /**
   * Write the files of `commit` into an empty directory elsewhere (the project and the shadow index
   * stay untouched). Used to run canon checks on other lines of work.
   */
  exportTo(commit: string, dir: string) {
    if (!this.hasObject(commit)) throw new Error(`Snapshot ${commit.slice(0, 10)} not found in shadow repo`);
    const env = { ...this.env(), GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(dir, ".scenaria-export-index") };
    for (const args of [["read-tree", commit], ["checkout-index", "-a", "-f"]]) {
      const r = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim()}`);
    }
    rmSync(join(dir, ".scenaria-export-index"), { force: true });
  }

  /** Restore the working tree to `commit` (files added since are removed, deleted files return). */
  restore(commit: string) {
    if (!this.hasObject(commit)) throw new Error(`Snapshot ${commit.slice(0, 10)} not found in shadow repo`);
    if (this.git(["ls-tree", "--name-only", commit, "--", ".scenaria"])) {
      throw new Error("Refusing to restore: snapshot contains .scenaria/ (would overwrite Scenaria's own history)");
    }
    // Make sure the index reflects the current working tree, so files created
    // after the snapshot are known and will be removed by read-tree.
    this.stageAll();
    this.git(["read-tree", "-u", "--reset", commit]);
  }

  changedFiles(fromCommit: string | undefined | null, toCommit: string): string[] {
    if (!fromCommit) {
      const out = this.git(["ls-tree", "-r", "--name-only", toCommit]);
      return out ? out.split("\n") : [];
    }
    const out = this.git(["diff", "--name-status", "--no-renames", fromCommit, toCommit]);
    if (!out) return [];
    return out.split("\n").map((l) => {
      const [status, ...rest] = l.split("\t");
      const sign = status === "A" ? "+" : status === "D" ? "-" : "~";
      return `${sign} ${rest.join("\t")}`;
    });
  }

  diff(fromRev: string, toRev: string, maxChars = 40_000): { stat: string; patch: string; truncated: boolean } {
    const stat = this.git(["diff", "--stat=120", fromRev, toRev]);
    let patch = this.git(["diff", "--no-color", fromRev, toRev]);
    let truncated = false;
    if (patch.length > maxChars) {
      patch = patch.slice(0, maxChars) + "\n… (diff truncated)";
      truncated = true;
    }
    return { stat, patch, truncated };
  }

  fileExists(commit: string, path: string): boolean {
    const clean = path.replace(/^\.\//, "");
    return this.hasObject(`${commit}:${clean}`);
  }
}

/** process.env without any GIT_* variables (a surrounding git hook must not leak in). */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}
