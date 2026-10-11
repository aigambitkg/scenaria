import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { userInfo } from "node:os";
import { composeContext, estimateTokens, nearestGoal, optionLabel, taskNodes } from "./context.js";
import { renderNodeNote, renderProtocol } from "./protocol.js";
import { ShadowRepo, cleanEnv } from "./snapshot.js";
import { Store, numId as numIdOf, resolveRoot, writeJsonAtomic, writeTextAtomic } from "./store.js";
import type {
  DecisionOption,
  GraphSnapshot,
  NodeType,
  ProjectRule,
  ScenariaConfig,
  ScenariaNode,
  SnapshotFolderConfig,
  Source,
  VerificationStatus,
} from "./types.js";
import { autoChecks, commandCheck, worst } from "./verify.js";
import { Conversations, renderConversation, type MessageInput, type SessionInput } from "./conversations.js";
import { DEFAULT_SNAPSHOT_FOLDERS, SnapshotFolders, versionReadme } from "./folders.js";
import { ulid, versionLabel } from "./ids.js";
import { isForbiddenRoot } from "./global.js";
import { Ledger, checkIntegrity, contentHash } from "./ledger.js";
import { fidelityAll } from "./fidelity.js";
import { activeCanon, addCanon, canonLines, canonState, decideCanon, readCanon, runCanonChecks, suggestCanon, type CanonAction, type CanonInput } from "./canon.js";

export interface Actor {
  agent?: string;
  model?: string;
  user?: string;
  source?: Source;
}

function defaultUser(): string | undefined {
  if (process.env.SCENARIA_USER) return process.env.SCENARIA_USER;
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/** Attribution fields for a new node. */
function attrib(a: Actor) {
  return {
    agent: a.agent ?? process.env.SCENARIA_AGENT ?? undefined,
    model: a.model ?? process.env.SCENARIA_MODEL ?? undefined,
    user: a.user ?? defaultUser(),
    source: a.source ?? "api",
  } as const;
}

export interface MissionInput extends Actor {
  /** Task title. Empty = only update the project (e.g. set projectGoal). */
  title?: string;
  goal?: string;
  brief?: string;
  tags?: string[];
  /** The project's overall main goal (set/replace on the project root n0). */
  projectGoal?: string;
  /** Session/conversation key this task belongs to (defaults to the pending task's key). */
  key?: string;
}

/** A session's task: created lazily (as a goal node) right before its first real node. */
export interface TaskHint {
  key: string;
  title: string;
  goal?: string;
}

/** The project root always has this id. */
export const ROOT_ID = "n0";

export type OptionInput = string | { label: string; description?: string };

export interface DecisionInput extends Actor {
  question: string;
  options: OptionInput[];
  /** Option id ("a"), label, or 1-based index. Omit for an open decision. */
  chosen?: string | number;
  rationale?: string;
  context?: string;
  servesGoal?: string;
  expectedOutcome?: string;
  /** References the decision rests on: node ids or item refs ("n12.f2", "r3"). */
  basedOn?: string[];
  respectsCanon?: string[];
  breaksCanon?: string[];
  task?: TaskHint;
  assumptions?: string[];
  confidence?: number;
  title?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
}

/** A fact as plain text, or with how sure the agent is and what it rests on. */
export type FactInput = string | { text: string; confidence?: number; basedOn?: string[] };

export interface CheckpointInput extends Actor {
  title: string;
  outputs?: string[];
  facts?: FactInput[];
  basedOn?: string[];
  openQuestions?: string[];
  irreversible?: string[];
  tags?: string[];
  meta?: Record<string, unknown>;
  /** Skip (return null) when files did not change since HEAD's snapshot. */
  onlyIfChanged?: boolean;
  type?: Extract<NodeType, "checkpoint" | "autosave">;
  /** Ignored files to include anyway (used to back up files a rewind would overwrite). */
  forceAdd?: string[];
  /** Attach to (and lazily create) this session's task. */
  task?: TaskHint;
  /** Mark the current task as done (optionally with a summary). */
  taskDone?: boolean;
  summary?: string;
}

export interface RewindOptions extends Actor {
  lesson?: string;
  restoreFiles?: boolean;
}

export interface VerifyInput {
  status?: VerificationStatus;
  notes?: string;
  by?: string;
  auto?: boolean;
  runCommand?: boolean;
}

export interface ContextResult {
  nodeId: string;
  markdown: string;
  tokens: number;
  /** Estimated tokens of the raw conversation history along the same path (what the capsule replaces). */
  historyTokens: number;
  /** Items left out to stay within the budget (reachable via recall / get_node). */
  omitted: number;
}

const OPTION_IDS = "abcdefghijklmnopqrstuvwxyz";

/** Everything in .scenaria/ that is local-only by default (large or possibly sensitive). */
const GITIGNORE_LINES = [
  "# Scenaria internals (local by default)",
  "shadow.git/",
  "shadow.index",
  "lock",
  "session.json",
  "*.tmp",
  "snapshots/",
  "blobs/",
  "conversations/",
  "hook-errors.log",
  // Integrity evidence and reader memory are per machine (a shared, merged ledger would break its chain).
  "ledger.jsonl",
  "ledger.sealed",
  "ledger.*.jsonl",
  "readers.json",
];

export const DEFAULT_PROXY = {
  upstreams: {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    lmstudio: "http://127.0.0.1:1234/v1",
    ollama: "http://127.0.0.1:11434/v1",
    mistral: "https://api.mistral.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
  },
  autoCheckpoint: true,
};

function splitFacts(list?: FactInput[]): { facts?: string[]; factInfo?: ({ confidence?: number; basedOn?: string[] } | null)[] } {
  const facts: string[] = [];
  const info: ({ confidence?: number; basedOn?: string[] } | null)[] = [];
  for (const f of list ?? []) {
    const text = (typeof f === "string" ? f : String(f?.text ?? "")).trim();
    if (!text) continue;
    facts.push(text);
    if (typeof f === "object" && f) {
      const confidence = typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : undefined;
      const basedOn = clean(f.basedOn);
      info.push(confidence !== undefined || basedOn ? { confidence, basedOn } : null);
    } else info.push(null);
  }
  return { facts: facts.length ? facts : undefined, factInfo: info.some(Boolean) ? info : undefined };
}

function clean(list?: string[]): string[] | undefined {
  const l = (list ?? []).map((s) => String(s).trim()).filter(Boolean);
  return l.length ? l : undefined;
}

export class Scenaria {
  readonly store: Store;
  readonly repo: ShadowRepo | null;

  private constructor(store: Store, repo: ShadowRepo | null) {
    this.store = store;
    this.repo = repo;
  }

  get root() {
    return this.store.root;
  }

  /** Append-only integrity ledger (tamper evidence for node files). */
  get ledger() {
    return new Ledger(this.store.path("ledger.jsonl"));
  }

  /** Which nodes still match what Scenaria wrote (ok), were changed outside it (tampered), or predate the ledger (unsealed). */
  integrity() {
    // Nodes are re-hashed on every call (a hand edit shows up immediately); the parsed ledger is cached by size/mtime.
    return checkIntegrity(this.store.listNodes(), this.ledger, { expectSealed: existsSync(this.store.path("ledger.sealed")) });
  }

  /**
   * Accept the current state as the new baseline (after a torn ledger, a restore from backup or a
   * reviewed manual fix). The old ledger is kept as evidence; the event log records who resealed.
   */
  reseal(actor: Actor = {}): { archived: string | null; nodes: number } {
    return this.store.withLock(() => {
      const lf = this.store.path("ledger.jsonl");
      let archived: string | null = null;
      if (existsSync(lf)) {
        archived = `ledger.${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
        renameSync(lf, this.store.path(archived));
      }
      const nodes = this.store.listNodes();
      this.ledger.append(nodes.map((n) => ({ id: n.id, hash: contentHash(n), op: "reseal" })));
      writeFileSync(this.store.path("ledger.sealed"), new Date().toISOString() + "\n");
      this.store.appendEvent({ type: "update", data: { message: `integrity ledger resealed by ${actor.user ?? defaultUser() ?? "?"} (${nodes.length} nodes)${archived ? `, previous ledger kept as ${archived}` : ""}` } });
      return { archived, nodes: nodes.length };
    });
  }

  /** Context fidelity of every node (0–100) plus ledger state — see core/fidelity.ts. */
  fidelity() {
    const nodes = this.store.listNodes();
    const integ = this.integrity();
    const root = nodes.find((n) => n.id === (this.store.readState().projectRoot ?? ROOT_ID));
    const goalChanges = ((root?.meta?.goalHistory as { until?: string }[] | undefined) ?? []).map((g) => g.until).filter((x): x is string => typeof x === "string");
    const points = fidelityAll(nodes, { integrity: integ.state, goalChanges });
    return { points: Object.fromEntries(points), ledgerBrokenAt: integ.ledgerBrokenAt, ledgerEntries: integ.entries, ledgerMissing: integ.ledgerMissing, ledgerTorn: integ.torn };
  }

  // ------------------------------------------------------------------ setup
  static init(root?: string, opts: { projectName?: string; exclude?: string[]; force?: boolean } = {}): Scenaria {
    const r = resolveRoot(root);
    if (!opts.force && isForbiddenRoot(r)) {
      throw new Error(`Refusing to initialize Scenaria in ${r} (home folder, filesystem root or a config folder). Run it inside a project folder.`);
    }
    const store = new Store(r);
    mkdirSync(store.dir, { recursive: true });
    if (!store.exists) {
      const config: ScenariaConfig = {
        version: 1,
        projectName: opts.projectName ?? basename(r),
        createdAt: new Date().toISOString(),
        exclude: opts.exclude ?? ["node_modules/", ".DS_Store"],
        injectContextOnSessionStart: true,
        contextFullCheckpoints: 3,
        snapshotFolders: { ...DEFAULT_SNAPSHOT_FOLDERS },
        mirrorToProjectGit: false,
        proxy: { ...DEFAULT_PROXY, upstreams: { ...DEFAULT_PROXY.upstreams } },
      };
      store.writeConfig(config);
      store.writeState({ head: null, activeMission: null, counter: 0, schema: 3, scenarioCounter: 0, messageCounter: 0, projectRoot: null });
      writeFileSync(store.path(".gitignore"), GITIGNORE_LINES.join("\n") + "\n");
      store.appendEvent({ type: "init", data: { message: `initialized in ${r}` } });
    }
    const repo = ShadowRepo.gitAvailable() ? new ShadowRepo(r, store.dir) : null;
    repo?.init(store.readConfig().exclude);
    const s = new Scenaria(store, repo);
    s.upgrade();
    return s;
  }

  static open(root?: string): Scenaria {
    const r = resolveRoot(root);
    const store = new Store(r);
    if (!store.exists) {
      throw new Error(`No Scenaria project found at or above ${r}. Run "scenaria init" first.`);
    }
    const repo = ShadowRepo.gitAvailable() ? new ShadowRepo(r, store.dir) : null;
    if (repo) {
      if (!repo.initialized) repo.init(store.readConfig().exclude);
      else repo.writeExcludes(store.readConfig().exclude);
    }
    const s = new Scenaria(store, repo);
    s.upgrade();
    return s;
  }

  /** Bring older projects up to the current schema (idempotent, cheap when current). */
  private upgrade() {
    try {
      const gi = this.store.path(".gitignore");
      const have = existsSync(gi) ? readFileSync(gi, "utf8").split("\n") : [];
      const missing = GITIGNORE_LINES.filter((l) => !l.startsWith("#") && !have.includes(l));
      if (missing.length) appendFileSync(gi, (have.length && have[have.length - 1] !== "" ? "\n" : "") + missing.join("\n") + "\n");
    } catch {}
    const st0 = this.store.readState();
    if ((st0.schema ?? 1) < 3 || st0.migrating) this.upgradeSchema();
    // Seal existing history once, so later edits outside Scenaria become visible.
    // A ledger that existed and disappeared is NOT resealed silently (integrity reports it missing).
    if (!this.ledger.exists && !existsSync(this.store.path("ledger.sealed")) && this.store.listNodes().length) {
      this.store.withLock(() => {
        if (this.ledger.exists) return;
        this.ledger.append(this.store.listNodes().map((n) => ({ id: n.id, hash: contentHash(n), op: "seal" })));
        writeFileSync(this.store.path("ledger.sealed"), new Date().toISOString() + "\n");
      });
    }
  }

  private upgradeSchema() {
    if ((this.store.readState().schema ?? 1) < 2) this.store.withLock(() => {
      const state = this.store.readState();
      if ((state.schema ?? 1) >= 2) return;
      const nodes = this.store.listNodes();
      const done: ScenariaNode[] = [];
      let counter = state.scenarioCounter ?? 0;
      for (const n of nodes) {
        const parent = n.parentId ? done.find((d) => d.id === n.parentId) ?? null : null;
        n.uid ??= ulid(Date.parse(n.createdAt) || Date.now());
        if (!parent) {
          n.scenarioId = `s${++counter}`;
          n.version = 0;
        } else if (
          done.some((d) => d.parentId === parent.id && d.scenarioId === parent.scenarioId) ||
          (parent.type === "decision" && parent.chosen && n.viaOption && n.viaOption !== parent.chosen)
        ) {
          n.scenarioId = `s${++counter}`;
          n.version = (parent.version ?? 0) + 1;
          n.forkedFrom = parent.id;
        } else {
          n.scenarioId = parent.scenarioId;
          n.version = (parent.version ?? 0) + 1;
        }
        this.store.writeNode(n);
        this.writeVersionRefs(n);
        done.push(n);
      }
      state.scenarioCounter = counter;
      state.messageCounter ??= 0;
      state.schema = 2;
      this.store.writeState(state);
    });
    this.store.withLock(() => this.migrateToProjectTree());
  }

  /**
   * Schema 3: one project tree. Older projects had one root per mission; they are joined
   * into a single line under a new project root n0 — each former mission becomes a task
   * (goal node) attached to the node that was HEAD when it was started (from the event log).
   * Scenario labels are recomputed, so a new scenario only marks a real branch.
   * A backup of the previous node files is kept in .scenaria/backups/.
   */
  private migrateToProjectTree() {
    let state = this.store.readState();
    // An interrupted migration (process killed, hook timeout) is rolled back from its backup and redone.
    if (state.migrating) {
      const backup = join(this.store.dir, state.migrating);
      if (existsSync(join(backup, "state.json")) && existsSync(join(backup, "nodes"))) {
        const keep = new Set(readdirSync(join(backup, "nodes")).filter((f) => f.endsWith(".json")));
        for (const f of readdirSync(this.store.path("nodes"))) if (f.endsWith(".json") && !keep.has(f)) rmSync(this.store.path("nodes", f), { force: true });
        for (const f of keep) copyFileSync(join(backup, "nodes", f), this.store.path("nodes", f));
        copyFileSync(join(backup, "state.json"), this.store.path("state.json"));
        state = this.store.readState();
      } else {
        const missing = state.migrating;
        delete state.migrating;
        this.store.writeState(state);
        this.store.appendEvent({ type: "migrate", data: { message: `WARNING: migration backup ${missing} is missing — the tree may be half-migrated; check .scenaria/backups/` } });
      }
    }
    if ((state.schema ?? 1) >= 3) return;
    const nodes = this.store.listNodes();
    if (!nodes.length || this.store.hasNode(ROOT_ID)) {
      state.schema = 3;
      state.projectRoot = this.store.hasNode(ROOT_ID) ? ROOT_ID : null;
      this.store.writeState(state);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRel = join("backups", `schema2-${stamp}`);
    const backup = this.store.path(backupRel);
    mkdirSync(join(backup, "nodes"), { recursive: true });
    for (const f of readdirSync(this.store.path("nodes"))) if (f.endsWith(".json")) copyFileSync(this.store.path("nodes", f), join(backup, "nodes", f));
    copyFileSync(this.store.path("state.json"), join(backup, "state.json"));
    // From here on every write is undone if the migration does not finish.
    this.store.writeState({ ...this.store.readState(), migrating: backupRel });

    const byCreated = (a: ScenariaNode, b: ScenariaNode) => a.createdAt.localeCompare(b.createdAt) || numIdOf(a.id) - numIdOf(b.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId)).sort(byCreated);
    const rootIds = new Set(roots.map((r) => r.id));
    const origRoot = (id: string): string => {
      let cur = byId.get(id);
      const seen = new Set<string>();
      while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
      return cur?.id ?? id;
    };

    // Which node was HEAD when each later mission started? Replay the event log.
    const parentOf = new Map<string, string>();
    let head: string | null = null;
    for (const e of this.store.readEvents()) {
      if (e.type === "mission" && e.nodeId && rootIds.has(e.nodeId)) {
        if (head && head !== e.nodeId && byId.has(head) && origRoot(head) !== e.nodeId) parentOf.set(e.nodeId, head);
        head = e.nodeId;
      } else if (["decision", "checkpoint", "branch", "autosave"].includes(e.type) && e.nodeId && byId.has(e.nodeId)) head = e.nodeId;
      else if (e.type === "rewind" && typeof e.data?.to === "string" && byId.has(e.data.to)) head = e.data.to;
    }

    const single = roots.length === 1;
    const project: ScenariaNode = {
      id: ROOT_ID,
      uid: ulid(Date.parse(roots[0].createdAt) || Date.now()),
      type: "mission",
      missionId: ROOT_ID,
      parentId: null,
      title: this.config().projectName,
      goal: single ? roots[0].goal : undefined,
      createdAt: roots[0].createdAt,
      agent: "scenaria",
      source: "api",
      status: "active",
      snapshot: roots[0].snapshot ? { ...roots[0].snapshot } : null,
      meta: { project: true, migratedFrom: roots.map((r) => r.id) },
    };

    const headNow = state.head && byId.has(state.head) ? state.head : null;
    const headTree = headNow ? origRoot(headNow) : null;
    roots.forEach((r, i) => {
      let parent = i === 0 ? ROOT_ID : parentOf.get(r.id);
      if (!parent) {
        // Fallback: the newest node of an earlier tree created before this mission.
        const earlier = nodes.filter((n) => origRoot(n.id) !== r.id && n.createdAt <= r.createdAt).sort(byCreated);
        parent = earlier.length ? earlier[earlier.length - 1].id : ROOT_ID;
      }
      const p = parent === ROOT_ID ? project : byId.get(parent)!;
      r.parentId = parent;
      r.viaOption = p.type === "decision" ? p.chosen : undefined;
      if (r.type === "mission") {
        r.type = "goal";
        r.status = r.id === headTree ? "active" : "done";
        // A v0.3 session baseline is history, not a task with a result of its own.
        r.meta = { ...(r.meta ?? {}), formerMission: true, baseline: r.meta?.autoBaseline ? true : undefined, autoBaseline: undefined };
      } else {
        // An orphan (its parent file is missing) keeps its type; it is only re-attached.
        r.meta = { ...(r.meta ?? {}), reattached: true };
      }
    });

    // The task HEAD lies in is the active one (walk the new parents; orphans may sit in between).
    if (headNow) {
      let cur: ScenariaNode | undefined = byId.get(headNow);
      const seen = new Set<string>();
      while (cur && cur.type !== "goal" && cur.parentId && cur.parentId !== ROOT_ID && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
      if (cur?.type === "goal") {
        for (const r of roots) if (r.type === "goal") r.status = "done";
        cur.status = "active";
      }
    }

    // Recompute ids along the single tree (parents before children).
    const all = [project, ...nodes];
    const done = new Map<string, ScenariaNode>();
    let counter = 0;
    const queue = [...all].sort(byCreated);
    queue.sort((a, b) => (a.id === ROOT_ID ? -1 : b.id === ROOT_ID ? 1 : 0));
    let guard = 0;
    while (queue.length && guard++ < all.length * all.length + 10) {
      const n = queue.shift()!;
      if (n.parentId && !done.has(n.parentId)) {
        queue.push(n);
        continue;
      }
      n.missionId = ROOT_ID;
      n.forkedFrom = undefined;
      const parent = n.parentId ? done.get(n.parentId)! : null;
      n.uid ??= ulid(Date.parse(n.createdAt) || Date.now());
      if (!parent) {
        n.scenarioId = `s${++counter}`;
        n.version = 0;
      } else if (
        [...done.values()].some((d) => d.parentId === parent.id && d.scenarioId === parent.scenarioId) ||
        (parent.type === "decision" && parent.chosen && n.viaOption && n.viaOption !== parent.chosen)
      ) {
        n.scenarioId = `s${++counter}`;
        n.version = (parent.version ?? 0) + 1;
        n.forkedFrom = parent.id;
      } else {
        n.scenarioId = parent.scenarioId;
        n.version = (parent.version ?? 0) + 1;
      }
      done.set(n.id, n);
    }
    if (this.ledger.exists) this.ledger.append(all.map((n) => ({ id: n.id, hash: contentHash(n), op: "migrate" })));
    for (const n of all) this.store.writeNode(n);
    // Refs and notes in bulk (one git process, one node listing) — fast even for thousands of nodes.
    if (this.repo) {
      try {
        const refs = this.repo.git(["for-each-ref", "--format=%(refname)", "refs/scenaria/scenarios", "refs/scenaria/heads"]);
        const lines = refs.split("\n").map((x) => x.trim()).filter(Boolean).map((ref) => `delete ${ref}`);
        for (const n of all) {
          if (!n.snapshot || !n.scenarioId) continue;
          lines.push(`update refs/scenaria/scenarios/${n.scenarioId}/v${n.version ?? 0} ${n.snapshot.commit}`);
        }
        const heads = new Map<string, string>();
        for (const n of [...all].sort(byCreated)) if (n.snapshot && n.scenarioId) heads.set(n.scenarioId, n.snapshot.commit);
        for (const [sc, commit] of heads) lines.push(`update refs/scenaria/heads/${sc} ${commit}`);
        if (lines.length) this.repo.git(["update-ref", "--stdin"], { input: lines.join("\n") + "\n" });
      } catch {
        /* refs are a convenience */
      }
    }
    this.writeNotesBulk(all);

    const st = this.store.readState();
    delete st.migrating;
    st.schema = 3;
    st.projectRoot = ROOT_ID;
    st.activeMission = ROOT_ID;
    st.scenarioCounter = counter;
    st.head = headNow ?? ROOT_ID;
    const g = nearestGoal(this.path(st.head));
    st.currentTask = g ? { key: `migrated:${g.id}`, nodeId: g.id } : null;
    st.taskBindings = g ? { [`migrated:${g.id}`]: g.id } : {};
    this.store.writeState(st);
    try {
      if (this.repo) new SnapshotFolders(this.root, this.store.dir, this.repo).writeIndex(this.store.listNodes(), this.folderConfig(), this.config().projectName);
    } catch {}
    this.store.appendEvent({
      type: "migrate",
      nodeId: ROOT_ID,
      data: { message: `joined ${roots.length} mission tree(s) into one project tree (backup: ${backup.slice(this.root.length + 1)})`, roots: roots.map((r) => r.id) },
    });
  }

  /** Open if initialized, otherwise initialize (used by hooks / MCP for zero-config). */
  static openOrInit(root?: string): Scenaria {
    const r = resolveRoot(root);
    return new Store(r).exists ? Scenaria.open(r) : Scenaria.init(r);
  }

  config(): ScenariaConfig {
    return this.store.readConfig();
  }

  get conversations() {
    return new Conversations(this.store);
  }

  folderConfig(): SnapshotFolderConfig {
    const c = { ...DEFAULT_SNAPSHOT_FOLDERS, ...(this.config().snapshotFolders ?? {}) };
    // Snapshot folders must live inside .scenaria/ (otherwise they would be snapshotted themselves).
    if (!c.path.replace(/\\/g, "/").startsWith(".scenaria/")) c.path = DEFAULT_SNAPSHOT_FOLDERS.path;
    return c;
  }

  // ------------------------------------------------------------------ reads
  node(id: string): ScenariaNode {
    return this.store.readNode(id);
  }

  head(): ScenariaNode | null {
    const { head } = this.store.readState();
    return head && this.store.hasNode(head) ? this.store.readNode(head) : null;
  }

  graph(): GraphSnapshot {
    const state = this.store.readState();
    return { config: this.config(), state, nodes: this.store.listNodes(), root: this.root };
  }

  children(id: string, nodes = this.store.listNodes()): ScenariaNode[] {
    return nodes.filter((n) => n.parentId === id);
  }

  /** Nodes from the mission root to `id` (inclusive). */
  path(id: string): ScenariaNode[] {
    const out: ScenariaNode[] = [];
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) throw new Error(`Cycle detected at ${cur}`);
      seen.add(cur);
      const n = this.store.readNode(cur);
      out.unshift(n);
      cur = n.parentId;
    }
    return out;
  }

  /** Nearest ancestor-or-self with verification status "passed". */
  lastGood(id?: string): ScenariaNode | null {
    const target = id ?? this.store.readState().head;
    if (!target) return null;
    const p = this.path(target);
    for (let i = p.length - 1; i >= 0; i--) if (p[i].verification?.status === "passed") return p[i];
    return null;
  }

  /** The single project root (n0), if it exists yet. */
  project(): ScenariaNode | null {
    const id = this.store.readState().projectRoot ?? ROOT_ID;
    return this.store.hasNode(id) ? this.store.readNode(id) : null;
  }

  /** The task (goal node) the given node — default HEAD — belongs to. */
  currentTask(id?: string): ScenariaNode | null {
    const target = id ?? this.store.readState().head;
    return target ? nearestGoal(this.path(target)) : null;
  }

  status() {
    const state = this.store.readState();
    const nodes = this.store.listNodes();
    const head = state.head ? nodes.find((n) => n.id === state.head) ?? null : null;
    const project = nodes.find((n) => n.id === (state.projectRoot ?? ROOT_ID)) ?? null;
    const task = head ? nearestGoal(this.path(head.id)) : null;
    const decisions = nodes.filter((n) => n.type === "decision");
    return {
      root: this.root,
      projectName: this.config().projectName,
      snapshots: Boolean(this.repo),
      head,
      project,
      /** @deprecated kept for older clients — the project root */
      mission: project,
      task,
      dirty: head ? this.isDirty(head) : null,
      counts: {
        nodes: nodes.length,
        tasks: nodes.filter((n) => n.type === "goal").length,
        decisions: decisions.length,
        checkpoints: nodes.filter((n) => n.type === "checkpoint").length,
        branches: nodes.filter((n) => n.type === "branch").length,
        verified: nodes.filter((n) => n.verification?.status === "passed").length,
        failed: nodes.filter((n) => n.verification?.status === "failed").length,
        withoutRationale: decisions.filter((d) => d.chosen && !d.rationale).length,
        withoutContext: decisions.filter((d) => !d.context && !d.trigger).length,
      },
      rules: this.rules().length,
    };
  }

  isDirty(head: ScenariaNode | null = this.head()): boolean {
    if (!this.repo) return false;
    const snap = head ? this.nearestSnapshot(head) : null;
    if (!snap) return true;
    return this.repo.currentTree() !== snap.tree;
  }

  private nearestSnapshot(n: ScenariaNode) {
    if (n.snapshot) return n.snapshot;
    let cur = n.parentId;
    while (cur) {
      const p = this.store.readNode(cur);
      if (p.snapshot) return p.snapshot;
      cur = p.parentId;
    }
    return null;
  }

  // ------------------------------------------------------------------ writes
  /** Assign uid, scenario and version for a new node (call under lock, before saving). */
  private assignIdentity(node: ScenariaNode, parent: ScenariaNode | null) {
    node.uid = ulid();
    const st = this.store.readState();
    const newScenario = () => {
      st.scenarioCounter = (st.scenarioCounter ?? 0) + 1;
      this.store.writeState(st);
      return `s${st.scenarioCounter}`;
    };
    if (!parent) {
      node.scenarioId = newScenario();
      node.version = 0;
      return;
    }
    // If the parent already continues in its own scenario, this node opens a new one:
    // that is a fork, or new work after a rewind.
    const continues = this.store.listNodes().some((c) => c.parentId === parent.id && c.id !== node.id && c.scenarioId === parent.scenarioId);
    // Exploring a non-chosen option of a decision is always its own scenario.
    const otherOption = parent.type === "decision" && Boolean(parent.chosen) && Boolean(node.viaOption) && node.viaOption !== parent.chosen;
    if (continues || otherOption) {
      node.scenarioId = newScenario();
      node.forkedFrom = parent.id;
    } else {
      node.scenarioId = parent.scenarioId;
    }
    node.version = (parent.version ?? 0) + 1;
  }

  private writeVersionRefs(node: ScenariaNode) {
    if (!this.repo || !node.snapshot || !node.scenarioId) return;
    try {
      this.repo.git(["update-ref", `refs/scenaria/scenarios/${node.scenarioId}/v${node.version ?? 0}`, node.snapshot.commit]);
      this.repo.git(["update-ref", `refs/scenaria/heads/${node.scenarioId}`, node.snapshot.commit]);
    } catch {
      /* refs are a convenience */
    }
  }

  /** Post-creation side effects: version refs, snapshot folder, project-git mirror. Best effort. */
  private afterCreate(node: ScenariaNode) {
    this.writeVersionRefs(node);
    const cfg = this.folderConfig();
    if (cfg.enabled && this.repo && node.snapshot) {
      try {
        this.materializeFolder(node, cfg);
      } catch (err: any) {
        node.meta = { ...(node.meta ?? {}), snapshotFolderError: String(err?.message ?? err) };
        this.save(node);
      }
    }
    if (this.config().mirrorToProjectGit) this.mirrorToProjectGit();
  }

  private materializeFolder(node: ScenariaNode, cfg = this.folderConfig()) {
    if (!this.repo) return null;
    const path = this.path(node.id);
    const pathIds = new Set(path.map((p) => p.id));
    const convo = this.conversations.allMessages().filter((m) => m.headAt && pathIds.has(m.headAt) && m.ts <= node.createdAt);
    const folders = new SnapshotFolders(this.root, this.store.dir, this.repo);
    const r = folders.materialize(node, cfg, {
      readme: versionReadme(node, path),
      conversation: `# Conversation along the path to ${node.id} (${versionLabel(node.scenarioId, node.version) ?? ""})\n\n${renderConversation(convo)}`,
    });
    if (r.folder) node.snapshotFolder = r.folder;
    if (r.warning) node.meta = { ...(node.meta ?? {}), snapshotFolderWarning: r.warning };
    this.save(node);
    folders.writeIndex(this.store.listNodes(), cfg, this.config().projectName);
    return r.folder;
  }

  /** Make sure a node has a browsable folder (lazy for old nodes); returns the absolute path. */
  ensureFolder(id: string, opts: { rebuild?: boolean } = {}): string | null {
    return this.store.withLock(() => {
      const node = this.store.readNode(id);
      if (!node.snapshot) return null;
      const cfg = { ...this.folderConfig(), enabled: true };
      if (opts.rebuild && node.snapshotFolder) {
        // Regenerate from the authoritative git history (e.g. after a snapshot file was edited).
        const abs = join(this.root, node.snapshotFolder);
        if (abs.startsWith(join(this.root, ".scenaria"))) rmSync(abs, { recursive: true, force: true });
        node.snapshotFolder = undefined;
      }
      const rel = node.snapshotFolder && existsSync(join(this.root, node.snapshotFolder, ".scenaria-version")) ? node.snapshotFolder : this.materializeFolder(node, cfg);
      return rel ? join(this.root, rel) : null;
    });
  }

  /** Publish refs/scenaria/* into the project's own git repo (only adds refs under refs/scenaria/). */
  mirrorToProjectGit(): { ok: boolean; message: string } {
    if (!this.repo) return { ok: false, message: "git not available" };
    if (!existsSync(join(this.root, ".git"))) return { ok: false, message: "project is not a git repository" };
    const r = spawnSync("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", this.repo.gitDir, "+refs/scenaria/*:refs/scenaria/*"], {
      cwd: this.root,
      env: cleanEnv(),
      encoding: "utf8",
    });
    return r.status === 0 ? { ok: true, message: "refs/scenaria/* mirrored into the project repository" } : { ok: false, message: (r.stderr || "").trim() };
  }

  /** Baseline for `scenaria start`: the project root n0 captures the state before any agent work. */
  ensureBaseline(actor: Actor = {}): ScenariaNode {
    return this.store.withLock(() => {
      this.ensureProject(actor);
      return this.head()!;
    });
  }

  /**
   * Remember the latest request of a session/conversation. Its task node is only created
   * when the session produces its first real node (decision, checkpoint, autosave), so
   * questions without any work leave the map untouched. Also creates the project root
   * (baseline snapshot) on first use.
   */
  noteTask(key: string, title: string, goal?: string, actor: Actor = {}) {
    const t = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!t) return;
    this.store.withLock(() => {
      this.ensureProject(actor);
      if (this.boundTask(key)) return;
      const st = this.store.readState();
      st.pendingTask = { key, title: t, goal: goal?.replace(/\s+/g, " ").trim().slice(0, 600) || undefined, at: new Date().toISOString() };
      this.store.writeState(st);
    });
  }

  /** Set or replace the project's main goal (lives on the project root n0). */
  setProjectGoal(goal: string, actor: Actor = {}): ScenariaNode {
    return this.store.withLock(() => this.setProjectGoalUnlocked(goal, actor));
  }

  private setProjectGoalUnlocked(goal: string, actor: Actor = {}): ScenariaNode {
    const root = this.ensureProject(actor);
    const g = goal.trim();
    if (!g || g === root.goal) return root;
    const prev = root.goal;
    root.goal = g;
    if (prev) root.meta = { ...(root.meta ?? {}), goalHistory: [...((root.meta?.goalHistory as any[]) ?? []), { goal: prev, until: new Date().toISOString() }].slice(-10) };
    this.save(root);
    this.store.appendEvent({ type: "update", nodeId: root.id, data: { fields: ["goal"], message: prev ? "main goal changed" : "main goal set" } });
    return root;
  }

  // ------------------------------------------------------------------ conversations
  /** Log chat messages from any source into the overlay, linked to the current HEAD. */
  logMessages(session: SessionInput, messages: MessageInput[], mode: "history" | "append" = "append") {
    return this.store.withLock(() => this.logMessagesUnlocked(session, messages, mode));
  }

  /** Same as logMessages, for callers that already hold the store lock. */
  logMessagesUnlocked(session: SessionInput, messages: MessageInput[], mode: "history" | "append" = "append") {
    {
      const conv = this.conversations;
      const sess = conv.ensureSession(session);
      const state = this.store.readState();
      const added = conv.append(sess, messages, {
        mode,
        headAt: state.head,
        nextId: () => {
          const st = this.store.readState();
          st.messageCounter = (st.messageCounter ?? 0) + 1;
          this.store.writeState(st);
          return `m${st.messageCounter}`;
        },
      });
      const lastUser = [...added].reverse().find((m) => m.role === "user" && m.text.trim());
      if (lastUser) {
        const st = this.store.readState();
        st.lastUserMessage = { text: lastUser.text.slice(0, 600), ts: lastUser.ts };
        this.store.writeState(st);
      }
      if (added.length) this.store.appendEvent({ type: "messages", nodeId: state.head ?? undefined, data: { session: sess.id, count: added.length } });
      return { session: conv.getSession(sess.id), added };
    }
  }

  /**
   * Messages that led to a node. For the first node of a lazily created task this includes
   * the task's opening conversation (said while the task's parent was HEAD).
   */
  messagesLeadingTo(id: string) {
    const node = this.store.readNode(id);
    const conv = this.conversations;
    if (!node.parentId) return [];
    const parent = this.store.hasNode(node.parentId) ? this.store.readNode(node.parentId) : null;
    const since = typeof parent?.meta?.since === "string" ? (parent.meta.since as string) : null;
    return conv
      .allMessages()
      .filter((m) => m.ts <= node.createdAt && (m.headAt === node.parentId || (since && parent?.parentId && m.headAt === parent.parentId && m.ts >= since)));
  }

  /** Version overview: every node with its ids, snapshot and folder. */
  versions(missionId?: string) {
    return this.store
      .listNodes()
      .filter((n) => !missionId || n.missionId === missionId)
      .map((n) => ({
        id: n.id,
        uid: n.uid,
        mission: n.missionId,
        scenario: n.scenarioId,
        version: n.version,
        label: versionLabel(n.scenarioId, n.version),
        type: n.type,
        title: n.title,
        createdAt: n.createdAt,
        agent: n.agent,
        model: n.model,
        snapshot: n.snapshot?.commit,
        folder: n.snapshotFolder,
        forkedFrom: n.forkedFrom,
      }));
  }

  private nextId(): string {
    const s = this.store.readState();
    s.counter += 1;
    this.store.writeState(s);
    return `n${s.counter}`;
  }

  private save(n: ScenariaNode) {
    // Hash first, then the file: a crash in between leaves the previous version, which still verifies.
    try {
      const fresh = !this.ledger.exists;
      this.ledger.append([{ id: n.id, hash: contentHash(n), op: "write" }]);
      if (fresh && !existsSync(this.store.path("ledger.sealed"))) writeFileSync(this.store.path("ledger.sealed"), new Date().toISOString() + "\n");
    } catch {
      /* the ledger is evidence, never a reason to fail a write */
    }
    this.store.writeNode(n);
    this.writeNote(n);
  }

  private writeNotesBulk(nodes: ScenariaNode[]) {
    try {
      const kids = new Map<string, ScenariaNode[]>();
      for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
      for (const n of nodes) writeTextAtomic(this.store.path("kb", `${n.id}.md`), renderNodeNote(n, kids.get(n.id) ?? []));
    } catch {
      /* knowledge-base notes are best effort */
    }
  }

  private writeNote(n: ScenariaNode) {
    try {
      const nodes = this.store.listNodes();
      writeTextAtomic(this.store.path("kb", `${n.id}.md`), renderNodeNote(n, this.children(n.id, nodes)));
      if (n.parentId) {
        const p = nodes.find((x) => x.id === n.parentId);
        if (p) writeTextAtomic(this.store.path("kb", `${p.id}.md`), renderNodeNote(p, this.children(p.id, nodes)));
      }
    } catch {
      /* knowledge-base notes are best effort */
    }
  }

  private setHead(id: string, missionId: string) {
    const s = this.store.readState();
    s.head = id;
    s.activeMission = missionId;
    this.store.writeState(s);
  }

  private takeSnapshot(id: string, title: string, parent: ScenariaNode | null, forceAdd: string[] = []) {
    if (!this.repo) return null;
    const parentSnap = parent ? this.nearestSnapshot(parent) : null;
    return this.repo.snapshot(id, `${id}: ${title}`, parentSnap?.commit, forceAdd);
  }

  /** Create the project root n0 if needed (call under lock). The first node of every project. */
  private ensureProject(actor: Actor = {}): ScenariaNode {
    const st = this.store.readState();
    const id = st.projectRoot ?? ROOT_ID;
    if (this.store.hasNode(id)) return this.store.readNode(id);
    const node: ScenariaNode = {
      id: ROOT_ID,
      type: "mission",
      missionId: ROOT_ID,
      parentId: null,
      title: this.config().projectName,
      status: "active",
      createdAt: new Date().toISOString(),
      ...attrib({ agent: actor.agent, model: actor.model, user: actor.user, source: actor.source }),
      meta: { project: true },
    };
    this.assignIdentity(node, null);
    node.snapshot = this.takeSnapshot(ROOT_ID, node.title, null);
    this.save(node);
    const s2 = this.store.readState();
    s2.projectRoot = ROOT_ID;
    s2.activeMission = ROOT_ID;
    if (!s2.head || !this.store.hasNode(s2.head)) s2.head = ROOT_ID;
    this.store.writeState(s2);
    this.afterCreate(node);
    this.store.appendEvent({ type: "mission", nodeId: ROOT_ID, data: { message: "project root" } });
    return node;
  }

  /** Where new work attaches: HEAD (after creating the project root and, if given, the session's task). */
  private ensureParent(input: Actor & { task?: TaskHint }): ScenariaNode {
    const project = this.ensureProject(input);
    if (input.task?.key && input.task.title?.trim() && !this.boundTask(input.task.key)) {
      this.createGoalUnlocked({ title: input.task.title, goal: input.task.goal, agent: input.agent, model: input.model, user: input.user, source: input.source }, input.task.key, true);
    }
    return this.head() ?? project;
  }

  /**
   * The task a session/conversation key is bound to — only while that task lies on the
   * HEAD path. After a rewind to before the task (or onto another branch) the binding no
   * longer applies and the session's next real step starts a new task there.
   */
  private boundTask(key: string): string | null {
    const st = this.store.readState();
    const id = st.taskBindings?.[key];
    if (!id || !st.head || !this.store.hasNode(id)) return null;
    let cur: string | null = st.head;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === id) return id;
      seen.add(cur);
      cur = this.store.hasNode(cur) ? this.store.readNode(cur).parentId : null;
    }
    return null;
  }

  /**
   * Start a task (sub-goal) on the project line. This never creates a second tree:
   * the task is attached to HEAD, so the whole project stays one connected history.
   * A new scenario only appears when work continues from an earlier point (fork/rewind).
   */
  startMission(input: MissionInput): ScenariaNode {
    return this.store.withLock(() => {
      const root = this.ensureProject(input);
      if (input.projectGoal?.trim()) this.setProjectGoalUnlocked(input.projectGoal, input);
      if (!input.title?.trim()) return this.store.readNode(root.id);
      const head = this.head();
      // Starting a task twice without any work in between refines it instead of stacking tasks.
      if (head && head.type === "goal" && !this.children(head.id).length) {
        head.title = input.title.trim().slice(0, 200);
        if (input.goal?.trim()) head.goal = input.goal.trim();
        if (input.brief?.trim()) head.brief = input.brief.trim();
        this.save(head);
        this.store.appendEvent({ type: "update", nodeId: head.id, data: { fields: ["title", "goal"] } });
        return head;
      }
      // The new task takes over the session that is working right now (pending request, else the current task's session).
      const st = this.store.readState();
      const key = input.key ?? st.pendingTask?.key ?? st.currentTask?.key ?? `task:${Date.now().toString(36)}`;
      return this.createGoalUnlocked(input, key, false);
    });
  }

  /** @deprecated use startMission (tasks) / noteTask. Kept for API compatibility. */
  claimMission(title: string, goal: string, actor: Actor = {}): ScenariaNode {
    this.noteTask(`claim:${title}`, title, goal, actor);
    return this.head()!;
  }

  /**
   * Create a goal node under HEAD. `inherit` = lazily created right before real work:
   * it shares the previous snapshot (state at task start) instead of capturing new edits.
   */
  private createGoalUnlocked(input: MissionInput, key: string, inherit: boolean): ScenariaNode {
    const root = this.ensureProject(input);
    const parent = this.head() ?? root;
    // The task being left is finished (unless someone already set its status).
    const prev = nearestGoal(this.path(parent.id));
    if (prev && prev.type === "goal" && (!prev.status || prev.status === "active")) {
      prev.status = "done";
      this.save(prev);
    }
    const id = this.nextId();
    const node: ScenariaNode = {
      id,
      type: "goal",
      missionId: root.id,
      parentId: parent.id,
      viaOption: this.viaFor(parent),
      title: (input.title ?? "Task").trim().slice(0, 200) || "Task",
      goal: input.goal?.trim() || undefined,
      brief: input.brief?.trim() || undefined,
      status: "active",
      createdAt: new Date().toISOString(),
      ...attrib(input),
      tags: clean(input.tags),
      meta: { taskKey: key },
    };
    this.assignIdentity(node, parent);
    if (inherit) {
      const snap = this.nearestSnapshot(parent);
      node.snapshot = snap ? { ...snap } : this.takeSnapshot(id, node.title, parent);
      // Created after the fact: the conversation that started this task was said at the parent.
      const pending = this.store.readState().pendingTask;
      if (pending?.key === key) node.meta = { ...node.meta, since: pending.at };
    } else node.snapshot = this.takeSnapshot(id, node.title, parent);
    this.save(node);
    this.setHead(id, root.id);
    const st = this.store.readState();
    st.currentTask = { key, nodeId: id };
    const bindings = { ...(st.taskBindings ?? {}) };
    delete bindings[key];
    bindings[key] = id;
    const keys = Object.keys(bindings);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete bindings[k];
    st.taskBindings = bindings;
    if (st.pendingTask?.key === key) st.pendingTask = null;
    this.store.writeState(st);
    this.afterCreate(node);
    this.store.appendEvent({ type: "goal", nodeId: id });
    return node;
  }

  /** Resolve an option reference: id ("b"), label (case-insensitive) or 1-based index. */
  resolveOption(node: ScenariaNode, ref: string | number): DecisionOption | null {
    const opts = node.options ?? [];
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      const i = Number(ref) - 1;
      if (opts[i]) return opts[i];
    }
    const s = String(ref).trim().toLowerCase();
    return (
      opts.find((o) => o.id.toLowerCase() === s) ??
      opts.find((o) => o.label.toLowerCase() === s) ??
      opts.find((o) => o.label.toLowerCase().startsWith(s)) ??
      null
    );
  }

  decide(input: DecisionInput): ScenariaNode {
    // Breaking a fixed point is allowed, but never silently: every path (tools, API, chat blocks) needs a reason.
    if (input.breaksCanon?.some((x) => String(x).trim()) && !input.rationale?.trim()) throw new Error("breaksCanon needs a rationale: why is breaking the fixed point justified?");
    return this.store.withLock(() => {
      const parent = this.ensureParent(input);
      const id = this.nextId();
      const options: DecisionOption[] = input.options
        .map((o) => (typeof o === "string" ? { label: o } : o))
        .filter((o) => o.label && String(o.label).trim())
        .map((o, i) => ({
          id: OPTION_IDS[i] ?? `o${i + 1}`,
          label: String(o.label).trim(),
          description: o.description?.trim() || undefined,
        }));
      const node: ScenariaNode = {
        id,
        type: "decision",
        missionId: parent.missionId,
        parentId: parent.id,
        viaOption: this.viaFor(parent),
        title: (input.title ?? input.question).trim().slice(0, 160),
        question: input.question.trim(),
        options,
        rationale: input.rationale?.trim() || undefined,
        context: input.context?.trim() || undefined,
        servesGoal: input.servesGoal?.trim() || undefined,
        expectedOutcome: input.expectedOutcome?.trim() || undefined,
        basedOn: clean(input.basedOn),
        // Only approved canon events count (a proposal is not binding yet).
        // Breaking wins if an id is listed both ways.
        respectsCanon: clean(input.respectsCanon?.filter((id) => !input.breaksCanon?.includes(id) && activeCanon(this.store).some((k) => k.id === id))),
        breaksCanon: clean(input.breaksCanon?.filter((id) => activeCanon(this.store).some((k) => k.id === id))),
        trigger: this.recentUserRequest(parent),
        assumptions: clean(input.assumptions),
        confidence: typeof input.confidence === "number" ? Math.max(0, Math.min(1, input.confidence)) : undefined,
        createdAt: new Date().toISOString(),
        ...attrib(input),
        tags: clean(input.tags),
        meta: input.meta,
      };
      if (input.chosen !== undefined && input.chosen !== "") {
        let opt = this.resolveOption(node, input.chosen);
        if (!opt && typeof input.chosen === "string") {
          // Free-text answer ("Other") becomes its own option.
          opt = { id: OPTION_IDS[options.length] ?? `o${options.length + 1}`, label: input.chosen.trim(), description: "custom answer" };
          options.push(opt);
        }
        node.chosen = opt?.id;
      }
      this.assignIdentity(node, parent);
      node.snapshot = this.takeSnapshot(id, node.title, parent);
      this.save(node);
      this.setHead(id, node.missionId);
      this.afterCreate(node);
      this.store.appendEvent({ type: "decision", nodeId: id });
      return node;
    });
  }

  choose(nodeId: string, option: string | number, rationale?: string): ScenariaNode {
    return this.store.withLock(() => {
      const node = this.store.readNode(nodeId);
      if (node.type !== "decision") throw new Error(`${nodeId} is not a decision`);
      const opt = this.resolveOption(node, option);
      if (!opt) throw new Error(`Option "${option}" not found on ${nodeId}`);
      node.chosen = opt.id;
      if (rationale) node.rationale = rationale.trim();
      this.save(node);
      this.store.appendEvent({ type: "choose", nodeId, data: { option: opt.id } });
      return node;
    });
  }

  /** The latest user request (if recent and from the current task) — the automatic context of a decision. */
  private recentUserRequest(parent?: ScenariaNode): string | undefined {
    const m = this.store.readState().lastUserMessage;
    if (!m?.text) return undefined;
    const at = Date.parse(m.ts);
    if (Date.now() - at > 6 * 3600_000) return undefined;
    const task = parent ? nearestGoal(this.path(parent.id)) : null;
    if (task) {
      const since = Date.parse(typeof task.meta?.since === "string" ? (task.meta.since as string) : task.createdAt);
      // A request from before this task started belongs to an earlier task.
      if (at < since - 15 * 60_000) return undefined;
    }
    const one = m.text.replace(/\s+/g, " ").trim();
    return one.length > 300 ? one.slice(0, 299) + "…" : one;
  }

  private viaFor(parent: ScenariaNode): string | undefined {
    return parent.type === "decision" ? parent.chosen : undefined;
  }

  checkpoint(input: CheckpointInput): ScenariaNode | null {
    return this.store.withLock(() => this.checkpointUnlocked(input));
  }

  private checkpointUnlocked(input: CheckpointInput): ScenariaNode | null {
    if (input.onlyIfChanged && this.repo && !this.isDirty(this.head())) {
      if (input.taskDone) this.finishTaskUnlocked(input.summary);
      return null;
    }
    const parent = this.ensureParent(input);
    const id = this.nextId();
    const node: ScenariaNode = {
      id,
      type: input.type ?? "checkpoint",
      missionId: parent.missionId,
      parentId: parent.id,
      viaOption: this.viaFor(parent),
      title: input.title.trim().slice(0, 200) || "Checkpoint",
      outputs: clean(input.outputs),
      ...splitFacts(input.facts),
      basedOn: clean(input.basedOn),
      openQuestions: clean(input.openQuestions),
      irreversible: clean(input.irreversible),
      createdAt: new Date().toISOString(),
      ...attrib(input),
      tags: clean(input.tags),
      meta: input.meta,
    };
    this.assignIdentity(node, parent);
    node.snapshot = this.takeSnapshot(id, node.title, parent, input.forceAdd ?? []);
    if (input.forceAdd?.length) {
      node.outputs = [...(node.outputs ?? []), `Backed up ${input.forceAdd.length} ignored file(s) the rewind overwrites: ${input.forceAdd.slice(0, 5).join(", ")}${input.forceAdd.length > 5 ? " …" : ""}`];
    }
    if (node.snapshot && this.repo) {
      const prev = this.nearestSnapshot(parent);
      node.changedFiles = clean(this.repo.changedFiles(prev?.commit, node.snapshot.commit));
    }
    this.save(node);
    this.setHead(id, node.missionId);
    this.afterCreate(node);
    this.store.appendEvent({ type: node.type === "autosave" ? "autosave" : "checkpoint", nodeId: id });
    if (input.taskDone) this.finishTaskUnlocked(input.summary);
    return node;
  }

  /** Mark the current task as done with a summary (the summary is what later capsules carry). */
  finishTask(summary?: string): ScenariaNode | null {
    return this.store.withLock(() => this.finishTaskUnlocked(summary));
  }

  private finishTaskUnlocked(summary?: string): ScenariaNode | null {
    const head = this.head();
    if (!head) return null;
    const goal = nearestGoal(this.path(head.id));
    if (!goal || goal.type !== "goal") return null;
    goal.status = "done";
    // A summary describes the path it was written on; capsules on other branches of this task ignore it.
    if (summary?.trim()) {
      goal.summary = summary.trim();
      goal.meta = { ...(goal.meta ?? {}), summaryFrom: head.id };
    }
    this.save(goal);
    this.store.appendEvent({ type: "update", nodeId: goal.id, data: { fields: ["status", "summary"] } });
    return goal;
  }

  /**
   * Jump back to `targetId`. Unsaved work is first stored as an autosave node,
   * so a rewind itself can always be undone.
   */
  rewind(targetId: string, opts: RewindOptions = {}): { target: ScenariaNode; autosave: ScenariaNode | null; context: ContextResult; warnings: string[] } {
    const result = this.store.withLock(() => {
      const target = this.store.readNode(targetId);
      const from = this.store.readState().head;
      const warnings: string[] = [];
      const restoreFiles = opts.restoreFiles !== false;
      let autosave: ScenariaNode | null = null;

      const targetSnap = this.nearestSnapshot(target);
      let forced: string[] = [];
      if (restoreFiles && this.repo && from) {
        // Ignored files on disk at paths the target contains would be overwritten
        // silently — back them up into the autosave first.
        const overwrites = targetSnap ? this.repo.unsavedOverwrites(targetSnap.commit) : [];
        forced = overwrites;
        autosave = this.checkpointUnlocked({
          title: `Autosave before rewind to ${targetId}`,
          type: "autosave",
          onlyIfChanged: overwrites.length === 0,
          forceAdd: overwrites,
          agent: opts.agent,
          model: opts.model,
          user: opts.user,
          source: opts.source,
        });
      }

      // Effects that happened after the target on the abandoned path cannot be undone.
      if (from) {
        const keep = new Set(this.path(targetId).map((p) => p.id));
        const abandoned = this.path(from).filter((n) => !keep.has(n.id));
        const irr = abandoned.flatMap((n) => n.irreversible ?? []);
        if (irr.length) warnings.push(`Not undoable by rewind: ${irr.join("; ")}`);
      }

      if (restoreFiles) {
        const snap = targetSnap;
        if (this.repo && snap) {
          try {
            this.repo.restore(snap.commit);
          } catch (err) {
            // Don't let force-added ignored files linger in the shadow index.
            if (forced.length) this.repo.unstage(forced);
            throw err;
          }
        }
        else warnings.push("No file snapshot available — only the decision state was rewound.");
      }

      if (opts.lesson?.trim()) {
        target.lessons = [...(target.lessons ?? []), `${opts.lesson.trim()}${from ? ` (learned on ${from})` : ""}`];
        this.save(target);
      }
      this.setHead(target.id, target.missionId);
      this.store.appendEvent({
        type: "rewind",
        nodeId: target.id,
        data: { from, to: target.id, lesson: opts.lesson, restoreFiles, autosave: autosave?.id },
      });
      return { target, autosave, warnings };
    });
    return { ...result, context: this.context(result.target.id) };
  }

  /** Explore a different option of a past decision as a new branch. */
  fork(decisionId: string, option: string | number, opts: RewindOptions = {}) {
    const decision = this.store.readNode(decisionId);
    if (decision.type !== "decision") throw new Error(`${decisionId} is not a decision`);
    const opt = this.resolveOption(decision, option);
    if (!opt) throw new Error(`Option "${option}" not found on ${decisionId}`);

    const rw = this.rewind(decisionId, { ...opts, lesson: undefined });
    const branch = this.store.withLock(() => {
      const id = this.nextId();
      const node: ScenariaNode = {
        id,
        type: "branch",
        missionId: decision.missionId,
        parentId: decision.id,
        viaOption: opt.id,
        title: `Alternative: ${opt.label}`,
        outputs: opt.description ? [opt.description] : undefined,
        lessons: opts.lesson?.trim() ? [opts.lesson.trim()] : undefined,
        createdAt: new Date().toISOString(),
        ...attrib(opts),
        snapshot: decision.snapshot ? { ...decision.snapshot } : null,
      };
      this.assignIdentity(node, decision);
      if (node.snapshot && this.repo) this.repo.git(["update-ref", `refs/scenaria/${id}`, node.snapshot.commit]);
      this.save(node);
      this.setHead(id, node.missionId);
      this.afterCreate(node);
      this.store.appendEvent({ type: "branch", nodeId: id, data: { decision: decisionId, option: opt.id } });
      return node;
    });
    return { branch, autosave: rw.autosave, warnings: rw.warnings, context: this.context(branch.id) };
  }

  verify(id: string, input: VerifyInput = {}): ScenariaNode {
    // 1) deterministic checks under the lock
    const pre = this.store.withLock(() => {
      const node = this.store.readNode(id);
      const isHeadAndClean = this.store.readState().head === id && !this.isDirty(node);
      const checks = input.auto === false ? [] : autoChecks(node, this.repo, { root: this.root });
      return { checks, isHeadAndClean };
    });
    // 2) the (possibly slow) verify command runs WITHOUT holding the lock
    const cmd = this.config().verifyCommand;
    if (input.auto !== false && input.runCommand && cmd) {
      pre.checks.push(commandCheck(cmd, this.root, pre.isHeadAndClean));
    }
    // 3) record the verdict
    return this.store.withLock(() => {
      const node = this.store.readNode(id);
      const checks = pre.checks;
      const status = input.status ?? (checks.length ? worst(checks.map((c) => c.status)) : "unverified");
      node.verification = {
        status,
        notes: input.notes?.trim() || node.verification?.notes,
        checks: checks.length ? checks : node.verification?.checks,
        by: input.by ?? "scenaria-auto",
        at: new Date().toISOString(),
      };
      this.save(node);
      this.store.appendEvent({ type: "verify", nodeId: id, data: { status, notes: input.notes, by: node.verification.by } });
      return node;
    });
  }

  update(
    id: string,
    patch: Partial<Pick<ScenariaNode, "title" | "facts" | "outputs" | "openQuestions" | "irreversible" | "tags" | "goal" | "brief" | "lessons" | "summary" | "status" | "rationale" | "context" | "servesGoal" | "expectedOutcome">>,
  ): ScenariaNode {
    return this.store.withLock(() => {
      const node = this.store.readNode(id);
      Object.assign(node, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      // New facts: confidence/basedOn of the old facts no longer apply.
      if (patch.facts !== undefined) delete node.factInfo;
      this.save(node);
      this.store.appendEvent({ type: "update", nodeId: id, data: { fields: Object.keys(patch) } });
      return node;
    });
  }

  /**
   * Checkpoint the working tree if it differs from HEAD (used by `scenaria watch`).
   * The title lists the changed files, so the map stays readable without an agent summary.
   */
  autoCheckpoint(actor: Actor = {}, titleHint?: string, task?: TaskHint): ScenariaNode | null {
    if (!this.repo) return null;
    return this.store.withLock(() => {
      const head = this.head();
      const snap = head ? this.nearestSnapshot(head) : null;
      const tree = this.repo!.currentTree();
      if (snap && tree === snap.tree) return null;
      const changed = snap ? this.repo!.changedFiles(snap.commit, tree) : [];
      const names = changed.map((c) => c.replace(/^[+~-] /, ""));
      const shown = names.slice(0, 3).join(", ");
      const files = names.length ? `${shown}${names.length > 3 ? ` (+${names.length - 3})` : ""}` : "";
      const hint = titleHint?.replace(/\s+/g, " ").trim().slice(0, 80);
      const title = hint ? `${hint}${files ? ` — ${files}` : ""}` : files ? `Auto-save: ${files}` : "Auto-save";
      return this.checkpointUnlocked({ title, onlyIfChanged: true, source: "watch", ...actor, task, agent: actor.agent ?? "watch", outputs: names.length ? [`Changed: ${names.slice(0, 8).join(", ")}${names.length > 8 ? " …" : ""}`] : undefined });
    });
  }

  /** Full machine-readable export (graph + events) for audits, BI or governance tooling. */
  exportJson() {
    return {
      format: "scenaria-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      project: this.config().projectName,
      state: this.store.readState(),
      nodes: this.store.listNodes(),
      events: this.store.readEvents(),
    };
  }

  // ------------------------------------------------------------------ context & diff
  /**
   * Resume capsule for a node (default HEAD), kept within a token budget:
   * project goal, rules, current task in detail, earlier tasks as one-line rollups.
   * What does not fit stays reachable through recall / get_node.
   */
  context(id?: string, opts: { budget?: number } = {}): ContextResult {
    const target = id ?? this.store.readState().head;
    if (!target) throw new Error("No HEAD yet — start a task first.");
    const path = this.path(target);
    const pathIds = new Set(path.map((p) => p.id));
    const onPath = this.conversations.allMessages().filter((m) => m.headAt && pathIds.has(m.headAt));
    const lastUser = onPath.filter((m) => m.role === "user").pop();
    const historyTokens = onPath.reduce((sum, m) => sum + estimateTokens(m.text ?? "") + (m.toolCalls?.length ?? 0) * 20, 0);
    const cfg = this.config();
    const r = composeContext(path, {
      fullCheckpoints: cfg.contextFullCheckpoints,
      lastGood: this.lastGood(target)?.id ?? null,
      lastUserRequest: lastUser?.text ?? null,
      budget: opts.budget ?? cfg.contextBudget ?? 1500,
      rules: this.rules(),
      ...(() => {
        const cs = canonState(this.store);
        return {
          canon: canonLines(cs.events),
          canonProposals: cs.events.filter((e) => e.status === "proposed").length,
          canonTampered: cs.events.filter((e) => e.status === "tampered").map((e) => e.id),
          canonUntrusted: cs.events.filter((e) => e.status === "untrusted").map((e) => e.id),
          canonError: cs.error,
          canonMissing: cs.missing,
        };
      })(),
    });
    return { nodeId: target, markdown: r.markdown, tokens: estimateTokens(r.markdown), historyTokens, omitted: r.omitted };
  }

  // ------------------------------------------------------------------ canon events (fixed points)
  canon() {
    return readCanon(this.store);
  }

  /** Canon events with trust info, plus a read error (e.g. merge conflict in canon.json). */
  canonState() {
    return canonState(this.store);
  }

  /** Agents and the archivist propose; the event stays "proposed" until a person approves it. */
  proposeCanon(input: CanonInput, actor: Actor & { archivist?: boolean } = {}) {
    return addCanon(this.store, input, { source: actor.archivist ? "archivist" : "agent", by: actor.agent ?? actor.user });
  }

  /** A person adds a fixed point directly (dashboard / interactive CLI). */
  addCanonAsUser(input: CanonInput, who: { user?: string; via: string }) {
    return addCanon(this.store, input, { source: "user", by: who.user ?? defaultUser(), via: who.via });
  }

  decideCanon(id: string, action: CanonAction, who: { user?: string; via: string; reason?: string; adoptCheck?: boolean | string }) {
    return decideCanon(this.store, id, action, { by: who.user ?? defaultUser(), via: who.via, reason: who.reason, adoptCheck: who.adoptCheck, head: this.store.readState().head });
  }

  /** The archivist's candidate fixed points from the recorded history (nothing is stored). */
  suggestCanon() {
    const head = this.store.readState().head;
    return suggestCanon(this.store, this.store.listNodes(), head ? this.path(head) : [], this.rules());
  }

  /** Run the check commands of approved canon events (a person's action; async). */
  checkCanon(ids?: string[], by?: string) {
    const head = this.head();
    return runCanonChecks(this.store, { root: this.root, head: head?.id ?? null, clean: head ? !this.isDirty(head) : false, ids, by: by ?? defaultUser() });
  }

  // ------------------------------------------------------------------ project memory (rules)
  private memoryFile() {
    return this.store.path("memory.json");
  }

  /** Durable project rules: accepted lessons/recommendations every capsule and prompt carries. */
  rules(): ProjectRule[] {
    const f = this.memoryFile();
    if (!existsSync(f)) return [];
    try {
      const m = JSON.parse(readFileSync(f, "utf8"));
      return Array.isArray(m?.rules) ? m.rules : [];
    } catch {
      return [];
    }
  }

  addRule(text: string, source: ProjectRule["source"] = "manual", evidence?: string[]): ProjectRule {
    const t = text.replace(/\s+/g, " ").trim().slice(0, 400);
    if (!t) throw new Error("rule text is empty");
    return this.store.withLock(() => {
      const rules = this.rules();
      const dup = rules.find((r) => r.text.toLowerCase() === t.toLowerCase());
      if (dup) return dup;
      const next = rules.reduce((m, r) => Math.max(m, numIdOf(r.id)), 0) + 1;
      const rule: ProjectRule = { id: `r${next}`, text: t, source, evidence: clean(evidence), createdAt: new Date().toISOString() };
      writeJsonAtomic(this.memoryFile(), { rules: [...rules, rule] });
      this.store.appendEvent({ type: "rule", data: { message: `rule ${rule.id} added: ${t}`, id: rule.id } });
      return rule;
    });
  }

  removeRule(id: string): boolean {
    return this.store.withLock(() => {
      const rules = this.rules();
      const keep = rules.filter((r) => r.id !== id);
      if (keep.length === rules.length) return false;
      writeJsonAtomic(this.memoryFile(), { rules: keep });
      this.store.appendEvent({ type: "rule", data: { message: `rule ${id} removed`, id } });
      return true;
    });
  }

  diff(fromId: string, toId?: string) {
    if (!this.repo) throw new Error("Snapshots are disabled (git not found).");
    const from = this.nearestSnapshot(this.store.readNode(fromId));
    if (!from) throw new Error(`${fromId} has no snapshot`);
    let toRev: string;
    let toLabel: string;
    if (toId && toId !== "working") {
      const to = this.nearestSnapshot(this.store.readNode(toId));
      if (!to) throw new Error(`${toId} has no snapshot`);
      toRev = to.commit;
      toLabel = toId;
    } else {
      toRev = this.repo.currentTree();
      toLabel = "working tree";
    }
    return { from: fromId, to: toLabel, ...this.repo.diff(from.commit, toRev) };
  }

  /**
   * Text tree for terminals and agents. Finished tasks are folded into one line each
   * (token-friendly); pass full = true for every node, or a node id to start there.
   */
  treeText(from?: string, opts: { full?: boolean } = {}): string {
    const state = this.store.readState();
    const nodes = this.store.listNodes();
    const mid = from && nodes.some((n) => n.id === from) ? from : state.projectRoot ?? ROOT_ID;
    const root = nodes.find((n) => n.id === mid) ?? nodes.find((n) => !n.parentId);
    if (!root) return "(no project tree yet)";
    const headPath = new Set(state.head ? this.path(state.head).map((n) => n.id) : []);
    const current = state.head ? nearestGoal(this.path(state.head)) : null;
    const icon: Record<string, string> = { mission: "◎", goal: "◉", decision: "❖", checkpoint: "◆", branch: "⑂", autosave: "⟲" };
    const vmark: Record<string, string> = { passed: " ✔", failed: " ✘", warning: " !", unverified: "" };
    const lines: string[] = [];
    // Linear stretches are printed one step per line without extra indentation; only real branches indent.
    const walk = (n: ScenariaNode, prefix: string, last: boolean, isRoot: boolean, cont = false) => {
      const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
      const via = parent?.type === "decision" && n.viaOption ? `[${optionLabel(parent, n.viaOption)}] ` : "";
      let label = `${icon[n.type] ?? "·"} ${n.id} ${via}${n.type === "decision" ? n.question ?? n.title : n.title}`;
      if (n.type === "decision") label += ` → ${optionLabel(n, n.chosen) ?? "open"}`;
      label += vmark[n.verification?.status ?? "unverified"];
      if (n.type === "mission" && n.goal) label += ` — goal: ${n.goal.replace(/\s+/g, " ").slice(0, 120)}`;
      const fold = !opts.full && n.type === "goal" && n.id !== current?.id && n.id !== root.id;
      let kids = nodes.filter((x) => x.parentId === n.id);
      if (fold) {
        // Show the folded task as one line and continue with the next tasks on the line.
        const inside = taskNodes(n.id, nodes);
        const dec = inside.filter((x) => x.type === "decision").length;
        label += ` [${n.status ?? "done"} · ${inside.length} steps, ${dec} decisions — expand: scenaria tree ${n.id}]`;
        const insideIds = new Set(inside.map((x) => x.id));
        kids = nodes.filter((x) => x.type === "goal" && x.parentId && (x.parentId === n.id || insideIds.has(x.parentId)));
      }
      if (n.id === state.head) label += "   ◀ HEAD";
      else if (headPath.has(n.id)) label += "  ·";
      lines.push(isRoot || cont ? `${prefix}${label}` : `${prefix}${last ? "└─ " : "├─ "}${label}`);
      const inner = isRoot || cont ? prefix : prefix + (last ? "   " : "│  ");
      if (kids.length === 1) walk(kids[0], inner, true, false, true);
      else kids.forEach((k, i) => walk(k, inner, i === kids.length - 1, false));
    };
    walk(root, "", true, true);
    return lines.join("\n");
  }

  writeProtocol(): string {
    const md = renderProtocol(this.config().projectName, this.store.readEvents(), this.store.listNodes());
    const file = this.store.path("protocol.md");
    writeTextAtomic(file, md);
    return file;
  }

  protocolMarkdown(): string {
    return renderProtocol(this.config().projectName, this.store.readEvents(), this.store.listNodes());
  }
}

export function isInitialized(root?: string) {
  return existsSync(join(resolveRoot(root), ".scenaria", "config.json"));
}
