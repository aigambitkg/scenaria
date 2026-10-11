import { spawnSync } from "node:child_process";
import { chmodSync, constants as fsc, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cleanEnv, type ShadowRepo } from "./snapshot.js";
import { slugify, versionLabel } from "./ids.js";
import type { ScenariaNode, SnapshotFolderConfig } from "./types.js";

export const DEFAULT_SNAPSHOT_FOLDERS: SnapshotFolderConfig = { enabled: true, path: ".scenaria/snapshots", maxFiles: 20000 };

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

/**
 * Browsable snapshot folders: one folder per node with the project files of that
 * moment plus `.scenaria-version/` (node metadata, decision, conversation).
 * Files are hardlinked from a content-addressed blob cache, so unchanged files cost
 * no extra disk space; they are read-only to protect history from accidental edits.
 */
export class SnapshotFolders {
  constructor(
    private root: string,
    private scenariaDir: string,
    private repo: ShadowRepo,
  ) {}

  folderFor(node: ScenariaNode, cfg: SnapshotFolderConfig): string {
    const v = String(node.version ?? 0).padStart(3, "0");
    return join(cfg.path, node.missionId, node.scenarioId ?? "s0", `v${v}-${node.id}-${slugify(node.title, 32)}`);
  }

  private tree(commit: string): (TreeEntry & { size: number })[] {
    const out = this.repo.git(["ls-tree", "-r", "-z", "-l", "--full-tree", commit]);
    return out
      .split("\0")
      .filter(Boolean)
      .map((l) => {
        const tab = l.indexOf("\t");
        const [mode, type, sha, size] = l.slice(0, tab).split(/\s+/);
        return { mode, type, sha, size: Number(size) || 0, path: l.slice(tab + 1) };
      });
  }

  /**
   * A cached blob is only reused if it still looks pristine: right size and still read-only.
   * (Editing a hardlinked snapshot file requires making it writable first — that taints it.)
   */
  private blobUsable(p: string, size: number): boolean {
    try {
      const st = lstatSync(p);
      return st.isFile() && st.size === size && (st.mode & 0o222) === 0;
    } catch {
      return false;
    }
  }

  private blobPath(sha: string, mode: string) {
    return join(this.scenariaDir, "blobs", sha.slice(0, 2), `${sha.slice(2)}${mode === "100755" ? ".x" : ""}`);
  }

  /** Read many blobs in one `git cat-file --batch` call. */
  private catBlobs(shas: string[]): Map<string, Buffer> {
    const res = new Map<string, Buffer>();
    for (let i = 0; i < shas.length; i += 400) {
      const chunk = shas.slice(i, i + 400);
      const r = spawnSync("git", ["cat-file", "--batch"], {
        cwd: this.root,
        env: { ...cleanEnv(), GIT_DIR: this.repo.gitDir },
        input: chunk.join("\n") + "\n",
        maxBuffer: 1024 * 1024 * 1024,
      });
      if (r.status !== 0) throw new Error(`git cat-file failed: ${r.stderr?.toString()}`);
      const buf = r.stdout as Buffer;
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString("utf8").split(" ");
        const size = Number(header[2]);
        if (header[1] === "missing" || !Number.isFinite(size)) {
          pos = nl + 1;
          continue;
        }
        res.set(header[0], buf.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
      }
    }
    return res;
  }

  /** Returns the folder path relative to the project root, or null if skipped. */
  materialize(
    node: ScenariaNode,
    cfg: SnapshotFolderConfig,
    meta: { readme: string; conversation: string },
  ): { folder: string | null; warning?: string } {
    if (!node.snapshot) return { folder: null };
    const relFolder = this.folderFor(node, cfg);
    const abs = resolve(this.root, relFolder);
    if (!abs.startsWith(resolve(this.root))) return { folder: null, warning: "snapshot folder path escapes the project" };
    const metaDir = join(abs, ".scenaria-version");
    if (existsSync(metaDir)) return { folder: relFolder };

    const entries = this.tree(node.snapshot.commit);
    if (entries.length > cfg.maxFiles) {
      return { folder: null, warning: `snapshot folder skipped: ${entries.length} files > maxFiles ${cfg.maxFiles}` };
    }
    const blobs = entries.filter((e) => e.type === "blob");
    const missing = [...new Set(blobs.filter((e) => !this.blobUsable(this.blobPath(e.sha, e.mode), e.size)).map((e) => e.sha))];
    if (missing.length) {
      const data = this.catBlobs(missing);
      for (const e of blobs) {
        const p = this.blobPath(e.sha, e.mode);
        const content = data.get(e.sha);
        if (!content || this.blobUsable(p, e.size)) continue;
        mkdirSync(dirname(p), { recursive: true });
        // Write to a new inode and swap it in: a tainted blob's old hardlinks stay as they are.
        const tmp = `${p}.${process.pid}.tmp`;
        writeFileSync(tmp, content);
        try {
          chmodSync(tmp, e.mode === "100755" ? 0o555 : 0o444);
        } catch {}
        renameSync(tmp, p);
      }
    }
    mkdirSync(abs, { recursive: true });
    for (const e of entries) {
      const dest = join(abs, e.path);
      if (!resolve(dest).startsWith(abs)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      try {
        if (e.mode === "160000") {
          mkdirSync(dest, { recursive: true }); // nested repo pointer — not expanded
        } else if (e.mode === "120000") {
          const target = this.catBlobs([e.sha]).get(e.sha)?.toString("utf8") ?? "";
          symlinkSync(target, dest);
        } else {
          const src = this.blobPath(e.sha, e.mode);
          if (cfg.link === "copy") {
            copyFileSync(src, dest);
            continue;
          }
          // Copy-on-write clone (APFS/btrfs/xfs): no extra space, and edits never leak into other versions.
          try {
            copyFileSync(src, dest, process.platform === "darwin" ? fsc.COPYFILE_FICLONE : fsc.COPYFILE_FICLONE_FORCE);
            continue;
          } catch {}
          try {
            linkSync(src, dest); // shared inode, protected by read-only mode
          } catch {
            copyFileSync(src, dest); // different filesystem or no hardlink support
          }
        }
      } catch {
        /* one odd entry must not break the folder */
      }
    }
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "node.json"), JSON.stringify(node, null, 2) + "\n");
    writeFileSync(join(metaDir, "README.md"), meta.readme);
    writeFileSync(join(metaDir, "conversation.md"), meta.conversation);
    return { folder: relFolder };
  }

  /** Overview of all versions with relative links. */
  writeIndex(nodes: ScenariaNode[], cfg: SnapshotFolderConfig, projectName: string) {
    const base = resolve(this.root, cfg.path);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const taskOf = (n: ScenariaNode): string => {
      let cur: ScenariaNode | undefined = n;
      const seen = new Set<string>();
      while (cur && cur.type !== "goal" && cur.parentId && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
      return cur?.type === "goal" ? cur.id : "—";
    };
    const rows = nodes
      .filter((n) => n.snapshotFolder)
      .map((n) => {
        const rel = relative(base, resolve(this.root, n.snapshotFolder!)).split("\\").join("/");
        return `| ${taskOf(n)} | ${n.scenarioId ?? ""} | ${n.version ?? ""} | [${n.id}](${encodeURI(rel)}/) | ${n.type} | ${n.title.replace(/\|/g, "\\|")} | ${n.createdAt.replace("T", " ").slice(0, 16)} | ${n.model ?? n.agent ?? ""} |`;
      });
    const md = [
      `# Scenaria snapshots — ${projectName}`,
      "",
      "Each folder is the complete project state at that point (read-only, deduplicated via hardlinks).",
      "`.scenaria-version/` inside each folder holds the decision, fact capsule and the conversation that led there.",
      "",
      "| Task | Scenario | Version | Node | Type | Title | Time | Model/agent |",
      "|---|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "index.md"), md);
  }
}

export function versionReadme(node: ScenariaNode, path: ScenariaNode[]): string {
  const lines = [
    `# ${node.id} · ${versionLabel(node.scenarioId, node.version) ?? ""} · ${node.title}`,
    "",
    `- type: ${node.type}`,
    `- uid: ${node.uid ?? ""}`,
    `- created: ${node.createdAt}`,
    node.agent ? `- agent: ${node.agent}` : "",
    node.model ? `- model: ${node.model}` : "",
    node.user ? `- user: ${node.user}` : "",
    node.snapshot ? `- snapshot: ${node.snapshot.commit}` : "",
    node.forkedFrom ? `- branched from: ${node.forkedFrom}` : "",
    "",
    "## Path",
    ...path.map((p) => {
      if (p.type === "decision") {
        const next = path[path.indexOf(p) + 1];
        const taken = p.options?.find((o) => o.id === (next?.viaOption ?? p.chosen))?.label;
        return `- ${p.id} (${versionLabel(p.scenarioId, p.version)}) ❖ ${p.question ?? p.title} → ${taken ?? "open"}`;
      }
      return `- ${p.id} (${versionLabel(p.scenarioId, p.version)}) ${p.type}: ${p.title}`;
    }),
  ];
  const sec = (t: string, l?: string[]) => (l?.length ? ["", `## ${t}`, ...l.map((x) => `- ${x}`)] : []);
  lines.push(...sec("Facts", node.facts), ...sec("Outputs", node.outputs), ...sec("Open questions", node.openQuestions));
  lines.push(...sec("Lessons", node.lessons), ...sec("Irreversible", node.irreversible), ...sec("Changed files", node.changedFiles));
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}
