import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ScenariaConfig,
  ScenariaEvent,
  ScenariaNode,
  ScenariaState,
} from "./types.js";

export const DIR_NAME = ".scenaria";

/** Walk up from `start` until a directory containing `.scenaria` is found. */
export function findRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  const home = resolve(homedir());
  for (;;) {
    // The home folder is never a project root (protects against stray ~/.scenaria/ folders).
    if (dir !== home && existsSync(join(dir, DIR_NAME, "config.json")) && existsSync(join(dir, DIR_NAME, "state.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const fromEnv = process.env.SCENARIA_ROOT || process.env.CLAUDE_PROJECT_DIR;
  const start = fromEnv ? resolve(fromEnv) : process.cwd();
  return findRoot(start) ?? start;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeJsonAtomic(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export function writeTextAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/**
 * File-backed store. Source of truth is plain JSON (one file per node) plus an
 * append-only event log, so everything stays human-readable and diffable.
 */
export class Store {
  readonly root: string;
  readonly dir: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.dir = join(this.root, DIR_NAME);
  }

  get exists() {
    return existsSync(join(this.dir, "config.json"));
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  // ---------- config & state ----------
  readConfig(): ScenariaConfig {
    return readJson<ScenariaConfig>(this.path("config.json"));
  }
  writeConfig(c: ScenariaConfig) {
    writeJsonAtomic(this.path("config.json"), c);
  }
  readState(): ScenariaState {
    const f = this.path("state.json");
    if (!existsSync(f)) return { head: null, activeMission: null, counter: 0 };
    return readJson<ScenariaState>(f);
  }
  writeState(s: ScenariaState) {
    writeJsonAtomic(this.path("state.json"), s);
  }

  // ---------- nodes ----------
  nodeFile(id: string) {
    // Ids come from APIs and tools: never let one escape the nodes folder.
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid node id "${String(id).slice(0, 40)}"`);
    return this.path("nodes", `${id}.json`);
  }
  hasNode(id: string) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
    return existsSync(this.nodeFile(id));
  }
  readNode(id: string): ScenariaNode {
    const f = this.nodeFile(id);
    if (!existsSync(f)) throw new Error(`Unknown node "${id}"`);
    return readJson<ScenariaNode>(f);
  }
  writeNode(n: ScenariaNode) {
    writeJsonAtomic(this.nodeFile(n.id), n);
  }
  listNodes(): ScenariaNode[] {
    const d = this.path("nodes");
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return readJson<ScenariaNode>(join(d, f));
        } catch {
          return null; // a half-written or foreign file must not break the whole project
        }
      })
      .filter((n): n is ScenariaNode => Boolean(n && typeof n.id === "string"))
      .sort((a, b) => numId(a.id) - numId(b.id));
  }

  // ---------- events ----------
  appendEvent(e: Omit<ScenariaEvent, "ts">) {
    const ev: ScenariaEvent = { ts: new Date().toISOString(), ...e };
    appendFileSync(this.path("events.jsonl"), JSON.stringify(ev) + "\n", "utf8");
    return ev;
  }
  readEvents(): ScenariaEvent[] {
    const f = this.path("events.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ScenariaEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ScenariaEvent => e !== null);
  }
  /** Cheap change marker for live UIs. */
  version(): number {
    const f = this.path("events.jsonl");
    return existsSync(f) ? statSync(f).size : 0;
  }

  // ---------- scratch (hook session state) ----------
  readScratch<T extends object>(name: string, fallback: T): T {
    const f = this.path(`${name}.json`);
    if (!existsSync(f)) return fallback;
    try {
      return readJson<T>(f);
    } catch {
      return fallback;
    }
  }
  writeScratch(name: string, data: unknown) {
    writeJsonAtomic(this.path(`${name}.json`), data);
  }

  // ---------- locking ----------
  /**
   * Cross-process lock (hooks, MCP server and UI may write concurrently).
   * The lock file holds "pid:token"; it is only treated as stale when its
   * process is gone (or it is very old), and only its owner removes it.
   */
  withLock<T>(fn: () => T, opts: { waitMs?: number } = {}): T {
    // Re-entrant within this Store instance (a locked operation may call another one that locks).
    if (this.lockDepth > 0) {
      this.lockDepth++;
      try {
        return fn();
      } finally {
        this.lockDepth--;
      }
    }
    const lock = this.path("lock");
    mkdirSync(this.dir, { recursive: true });
    const token = `${process.pid}:${randomUUID()}`;
    // A caller that must not hold anything up (a hook after every tool) waits less and gives up instead.
    const deadline = Date.now() + Math.max(0, Math.min(20_000, opts.waitMs ?? 20_000));
    for (;;) {
      try {
        const fd = openSync(lock, "wx");
        writeFileSync(fd, token);
        closeSync(fd);
        break;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        if (lockIsStale(lock)) {
          try {
            unlinkSync(lock);
          } catch {
            /* raced with another cleaner */
          }
          continue;
        }
        if (Date.now() > deadline) throw new Error("Scenaria store is busy (lock timeout) — try again");
        sleepSync(25);
      }
    }
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      try {
        if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
      } catch {}
    }
  }
  private lockDepth = 0;

  /** Read-modify-write a scratch file under the lock. */
  updateScratch<T extends object>(name: string, fallback: T, fn: (cur: T) => void): T {
    return this.withLock(() => {
      const cur = this.readScratch<T>(name, fallback);
      fn(cur);
      this.writeScratch(name, cur);
      return cur;
    });
  }

  projectName() {
    return basename(this.root);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function lockIsStale(lock: string): boolean {
  try {
    const content = readFileSync(lock, "utf8");
    const pid = parseInt(content.split(":")[0], 10);
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age > 10 * 60_000) return true;
    if (Number.isFinite(pid) && pid > 0) return !pidAlive(pid);
    return age > 5_000; // unreadable/empty lock: only stale after a grace period
  } catch {
    return false;
  }
}

export function numId(id: string) {
  const n = parseInt(id.replace(/^\D+/, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
