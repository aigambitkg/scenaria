import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants as fsc, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { devNull } from "node:os";
import { createHash } from "node:crypto";
import { globalConfigPath } from "./global.js";
import type { Snapshot } from "./types.js";

/**
 * Options for every git call Scenaria makes on a repository inside the project folder.
 *
 * Files in the project (also `.scenaria/shadow.git`) can be written by an agent, while Scenaria often runs
 * under the person's account (dashboard, hooks). Git would run programs named in such a repository: hooks,
 * `core.fsmonitor`, an alternate-refs command, a signing program, the `ext::` transport. These options
 * switch all of that off; they win over the repository's own config. For the shadow repository they are a
 * second line: its config lives outside the project (see `ShadowRepo`).
 */
export const SAFE_GIT: readonly string[] = [
  "-c", `core.hooksPath=${devNull}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.alternateRefsCommand=",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "protocol.ext.allow=never",
  "-c", "gc.auto=0",
];

/** What git found out about the project's file system at `git init` (the only settings taken from the project). */
const FS_FACTS = new Set(["filemode", "ignorecase", "precomposeunicode", "symlinks"]);

/**
 * The file-system facts from a git config text, as `-c core.<key>=<true|false>` options.
 *
 * The control files of the shadow repository live outside the project, on a file system that can differ from
 * the project's (case, execute bit, symlinks). Git wrote the project's facts into `.scenaria/shadow.git/config`
 * at `git init`; only those four yes/no values are read from that file, by this function, never by git itself.
 * Anything else in the text is ignored.
 */
export function fileSystemFacts(text: string): string[] {
  const facts = new Map<string, string>();
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inCore = /^\[core\]$/i.test(line);
      continue;
    }
    const m = /^([A-Za-z]+)\s*=\s*(true|false)$/i.exec(line);
    if (inCore && m && FS_FACTS.has(m[1].toLowerCase())) facts.set(m[1].toLowerCase(), m[2].toLowerCase());
  }
  return [...facts].flatMap(([k, v]) => ["-c", `core.${k}=${v}`]);
}

/** Why file snapshots are off (shown to the person and to agents). */
export interface SnapshotIssue {
  code: "git_missing" | "control_folder";
  /** The folder Scenaria could not use (`control_folder`). */
  folder?: string;
  /** `inside_project`: the folder lies in the project; otherwise what the system said. */
  reason?: string;
  /** The system Scenaria runs on (`process.platform`), for a fitting suggestion. */
  platform?: string;
}

/** The issue in plain English, with what to check on this system (CLI and agents; the dashboard has its own texts). */
export function snapshotIssueText(issue: SnapshotIssue): string {
  if (issue.code === "git_missing") return "file snapshots are off: git was not found";
  const dir = issue.folder ?? "";
  if (issue.reason === "inside_project") {
    return `file snapshots are off: Scenaria's own folder "${dir}" lies inside this project. Please check: start Scenaria with SCENARIA_HOME set to a folder outside the project, or open a subfolder as the project.`;
  }
  const check =
    issue.platform === "win32"
      ? `in PowerShell, icacls "${dir}" shows who may write there; or in the Explorer: right-click the folder, Properties, Security`
      : `in a terminal, ls -ld "${dir}" shows the owner and the rights; chmod u+rwx "${dir}" gives your account access`;
  const why: Record<string, string> = { EACCES: "no permission", EPERM: "no permission", ENOTDIR: "a file is in the way", EEXIST: "a file is in the way", EROFS: "the drive is read-only", ENOSPC: "the drive is full" };
  const reason = issue.reason ? why[issue.reason] ?? issue.reason : "";
  return `file snapshots are off: Scenaria cannot use its own folder "${dir}"${reason ? ` (${reason})` : ""}. Please check that it exists and that your account may write to it: ${check}.`;
}

/** The control folder of a shadow repository cannot be used; file snapshots stay off until the person fixed it. */
export class ShadowControlError extends Error {
  readonly issue: SnapshotIssue;
  constructor(folder: string, reason: string) {
    const issue: SnapshotIssue = { code: "control_folder", folder, reason, platform: process.platform };
    super(snapshotIssueText(issue));
    this.issue = issue;
  }
}

function real(p: string) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Where the control files of a project's shadow repository live: in Scenaria's own folder, never in the project. */
export function shadowControlDir(root: string): string {
  const h = createHash("sha256").update(real(root)).digest("hex").slice(0, 20);
  return join(dirname(globalConfigPath()), "shadow", h);
}

/**
 * File snapshots via a private "shadow" git repository.
 *
 * - The saved file states (git objects) and the index live in the project, in `.scenaria/`: they travel with
 *   the folder, and an agent in a sandbox and the person's dashboard both reach them.
 * - The control files (config, HEAD, refs, exclude list) live outside the project, in Scenaria's own folder
 *   (`shadowControlDir`). Git reads its settings only from there; the config in `.scenaria/shadow.git` is never
 *   read by git (rule 13). The refs can be rebuilt from the steps at any time (`resetRefs`).
 * - Works in any folder (with or without its own git repo).
 * - Never touches the project's own `.git`, index, branches or stash.
 * - Honors the project's .gitignore files. `.scenaria/` is excluded by an explicit
 *   pathspec, so even allowlist-style .gitignores (`*`, `!*\/`) cannot pull it in.
 * - Each snapshot is pinned by a ref `refs/scenaria/<nodeId>` so it is never GC'd.
 */
export class ShadowRepo {
  readonly root: string;
  /** Control files (config, HEAD, refs, info): outside the project. This is git's `GIT_DIR`. */
  readonly controlDir: string;
  /** `.scenaria/shadow.git` in the project: the file states (`objects/`); the rest of it is not used any more. */
  readonly dataDir: string;
  readonly objectDir: string;
  readonly indexFile: string;
  /** Paths excluded at runtime (e.g. nested repos without commits). */
  private runtimeExcludes = new Set<string>();
  private warnings = new Set<string>();
  private facts: string[] | null = null;

  /** `controlDir` is for tests; everything else uses the folder `shadowControlDir` names. */
  constructor(root: string, scenariaDir: string, controlDir: string = shadowControlDir(root)) {
    this.root = root;
    this.controlDir = controlDir;
    this.dataDir = join(scenariaDir, "shadow.git");
    this.objectDir = join(this.dataDir, "objects");
    this.indexFile = join(scenariaDir, "shadow.index");
  }

  static gitAvailable(): boolean {
    const r = spawnSync("git", ["--version"], { encoding: "utf8", env: cleanEnv() });
    return r.status === 0;
  }

  /** Are there stored file states in this project folder? (A copy or clone without `.scenaria/shadow.git` has none.) */
  get initialized() {
    return existsSync(this.objectDir);
  }

  /** Environment for git calls that only read stored file states (no work tree, no index). */
  readEnv(): NodeJS.ProcessEnv {
    const env = cleanEnv();
    env.GIT_DIR = this.controlDir;
    env.GIT_OBJECT_DIRECTORY = this.objectDir;
    return env;
  }

  /** The project's file-system facts as git options (see `fileSystemFacts`); read once per process. */
  private fsFacts(): string[] {
    if (this.facts) return this.facts;
    try {
      this.facts = fileSystemFacts(readFileSync(join(this.dataDir, "config"), "utf8").slice(0, 4096));
    } catch {
      this.facts = [];
    }
    return this.facts;
  }

  private env() {
    const env = this.readEnv();
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
      [...SAFE_GIT, ...this.fsFacts(), "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "advice.addEmbeddedRepo=false", "-c", "core.safecrlf=false", ...args],
      { cwd: this.root, env: this.env(), encoding: "utf8", input, maxBuffer: maxBuffer ?? 128 * 1024 * 1024 },
    );
  }

  /**
   * Make the shadow repository ready: the data folder in the project, the control folder outside it, the
   * exclude list. Cheap when everything is there. Throws `ShadowControlError` when the control folder cannot be
   * used; then nothing is saved (never a fallback to control files inside the project).
   */
  init(exclude: string[] = []) {
    if (!existsSync(join(this.dataDir, "HEAD")) || !existsSync(this.objectDir)) {
      mkdirSync(this.dataDir, { recursive: true });
      // As before: a plain bare repository in the project. Git writes the project's file-system facts into its
      // config here; later git calls never read that config (their GIT_DIR is the control folder).
      execFileSync("git", [...SAFE_GIT, "init", "-q", "--bare", this.dataDir], { stdio: "ignore", env: cleanEnv() });
      mkdirSync(this.objectDir, { recursive: true });
      this.facts = null;
    }
    this.ensureControl();
    this.writeExcludes(exclude);
  }

  private ensureControl() {
    const dir = this.controlDir;
    const rootReal = real(this.root);
    const inside = (p: string) => p === rootReal || p.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
    if (inside(real(dirname(dir))) || inside(real(dir))) throw new ShadowControlError(dir, "inside_project");
    try {
      if (!existsSync(join(dir, "HEAD"))) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Asked again now that the folder exists (a link on the way there is resolved only then).
        if (inside(real(dir))) throw new ShadowControlError(dir, "inside_project");
        // No template: no sample hooks, nothing from the person's `init.templateDir`.
        execFileSync("git", ["init", "-q", "--bare", "--template=", dir], { stdio: ["ignore", "ignore", "pipe"], env: cleanEnv(), encoding: "utf8" });
      }
      accessSync(dir, fsc.R_OK | fsc.W_OK);
      // For `git fetch` from the control folder (mirror): where the file states are. Scenaria's own calls name
      // the object folder directly (GIT_OBJECT_DIRECTORY).
      const alt = join(dir, "objects", "info", "alternates");
      const line = this.objectDir.split(sep).join("/") + "\n";
      if (!/[\r\n]/.test(this.objectDir) && !/^["#]/.test(line)) {
        let have = "";
        try {
          have = readFileSync(alt, "utf8");
        } catch {}
        if (have !== line) {
          mkdirSync(dirname(alt), { recursive: true });
          writeFileSync(alt, line);
        }
      }
    } catch (e: any) {
      if (e instanceof ShadowControlError) throw e;
      throw new ShadowControlError(dir, String(e?.code ?? e?.stderr ?? e?.message ?? e).trim().split("\n")[0].slice(0, 160));
    }
  }

  writeExcludes(exclude: string[]) {
    const lines = ["# managed by scenaria (.scenaria/ is excluded by pathspec)", ...exclude];
    const file = join(this.controlDir, "info", "exclude");
    const next = lines.join("\n") + "\n";
    try {
      if (existsSync(file) && readFileSync(file, "utf8") === next) return;
    } catch {}
    try {
      mkdirSync(join(this.controlDir, "info"), { recursive: true });
      writeFileSync(file, next);
    } catch (e: any) {
      throw new ShadowControlError(this.controlDir, String(e?.code ?? e?.message ?? e).slice(0, 160));
    }
  }

  /**
   * Forget every ref in the control folder. Refs only name file states the steps name anyway; the caller
   * writes them again from the steps (`Scenaria.syncRefs`). Used before the mirror, so that refs left by an
   * earlier project in this folder, or missing on this machine, cannot get in the way.
   */
  resetRefs() {
    rmSync(join(this.controlDir, "refs", "scenaria"), { recursive: true, force: true });
    rmSync(join(this.controlDir, "packed-refs"), { force: true });
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

  /**
   * Which of these commits are no longer stored (one git call for all; C2.1, review K3). Without the shadow
   * repository every one is missing. Ids that are not plain hex are reported missing without asking git.
   */
  missingCommits(commits: string[]): Set<string> {
    const ids = [...new Set(commits.filter((c) => typeof c === "string" && c))];
    const missing = new Set<string>();
    if (!ids.length) return missing;
    if (!this.initialized) return new Set(ids);
    const ask = ids.filter((c) => /^[0-9a-f]{7,64}$/i.test(c));
    const asked = new Set(ask);
    for (const c of ids) if (!asked.has(c)) missing.add(c);
    if (!ask.length) return missing;
    const r = this.runOnce(["cat-file", "--batch-check=%(objectname) %(objecttype)"], ask.map((c) => `${c}^{commit}`).join("\n") + "\n");
    // A check that cannot run proves nothing either way: the caller reports it as "could not be checked" (C2.1 R1).
    if (r.status !== 0 || r.error) throw new Error(`git cat-file failed: ${String(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
    const lines = String(r.stdout ?? "").split("\n");
    ask.forEach((c, i) => {
      if (!/ commit$/.test(lines[i] ?? "")) missing.add(c);
    });
    return missing;
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
      const r = spawnSync("git", [...SAFE_GIT, ...this.fsFacts(), "-c", "core.autocrlf=false", ...args], { cwd: dir, env, encoding: "utf8" });
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
    const out = this.git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--no-renames", fromCommit, toCommit]);
    if (!out) return [];
    return out.split("\n").map((l) => {
      const [status, ...rest] = l.split("\t");
      const sign = status === "A" ? "+" : status === "D" ? "-" : "~";
      return `${sign} ${rest.join("\t")}`;
    });
  }

  diff(fromRev: string, toRev: string, maxChars = 40_000): { stat: string; patch: string; truncated: boolean } {
    const stat = this.git(["diff", "--no-ext-diff", "--no-textconv", "--stat=120", fromRev, toRev]);
    let patch = this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", fromRev, toRev]);
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
