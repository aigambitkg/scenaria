import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { userInfo } from "node:os";
import { composeContext, estimateTokens, optionLabel } from "./context.js";
import { renderNodeNote, renderProtocol } from "./protocol.js";
import { ShadowRepo, cleanEnv } from "./snapshot.js";
import { Store, resolveRoot, writeTextAtomic } from "./store.js";
import type {
  DecisionOption,
  GraphSnapshot,
  NodeType,
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
  title: string;
  goal?: string;
  brief?: string;
  tags?: string[];
}

export type OptionInput = string | { label: string; description?: string };

export interface DecisionInput extends Actor {
  question: string;
  options: OptionInput[];
  /** Option id ("a"), label, or 1-based index. Omit for an open decision. */
  chosen?: string | number;
  rationale?: string;
  assumptions?: string[];
  confidence?: number;
  title?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface CheckpointInput extends Actor {
  title: string;
  outputs?: string[];
  facts?: string[];
  openQuestions?: string[];
  irreversible?: string[];
  tags?: string[];
  meta?: Record<string, unknown>;
  /** Skip (return null) when files did not change since HEAD's snapshot. */
  onlyIfChanged?: boolean;
  type?: Extract<NodeType, "checkpoint" | "autosave">;
  /** Ignored files to include anyway (used to back up files a rewind would overwrite). */
  forceAdd?: string[];
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
      store.writeState({ head: null, activeMission: null, counter: 0, schema: 2, scenarioCounter: 0, messageCounter: 0 });
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
    if ((this.store.readState().schema ?? 1) >= 2) return;
    this.store.withLock(() => {
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

  status() {
    const state = this.store.readState();
    const nodes = this.store.listNodes();
    const head = state.head ? nodes.find((n) => n.id === state.head) ?? null : null;
    const mission = state.activeMission ? nodes.find((n) => n.id === state.activeMission) ?? null : null;
    const inMission = nodes.filter((n) => n.missionId === state.activeMission);
    return {
      root: this.root,
      projectName: this.config().projectName,
      snapshots: Boolean(this.repo),
      head,
      mission,
      dirty: head ? this.isDirty(head) : null,
      counts: {
        nodes: inMission.length,
        decisions: inMission.filter((n) => n.type === "decision").length,
        checkpoints: inMission.filter((n) => n.type === "checkpoint").length,
        branches: inMission.filter((n) => n.type === "branch").length,
        verified: inMission.filter((n) => n.verification?.status === "passed").length,
        failed: inMission.filter((n) => n.verification?.status === "failed").length,
      },
      missions: nodes.filter((n) => n.type === "mission").map((m) => ({ id: m.id, title: m.title })),
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

  /** Baseline mission for `scenaria start`: captures the state before any agent work. */
  ensureBaseline(actor: Actor = {}): ScenariaNode {
    const head = this.head();
    if (head) return head;
    const node = this.startMission({
      title: `Session ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      ...actor,
    });
    node.meta = { ...(node.meta ?? {}), autoBaseline: true };
    this.store.withLock(() => this.save(node));
    return node;
  }

  /**
   * Make sure there is a mission for a new piece of work. An untouched auto-baseline
   * mission is renamed after the first real request instead of creating a second root.
   */
  claimMission(title: string, goal: string, actor: Actor = {}): ScenariaNode {
    const head = this.head();
    if (!head) return this.startMission({ title, goal, brief: goal, ...actor });
    if (head.type === "mission" && head.meta?.autoBaseline && !this.children(head.id).length) {
      return this.store.withLock(() => {
        const n = this.store.readNode(head.id);
        n.title = title;
        n.goal = goal;
        n.brief = goal;
        n.meta = { ...(n.meta ?? {}), autoBaseline: false };
        this.save(n);
        this.store.appendEvent({ type: "update", nodeId: n.id, data: { fields: ["title", "goal"] } });
        return n;
      });
    }
    return head;
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
      if (added.length) this.store.appendEvent({ type: "messages", nodeId: state.head ?? undefined, data: { session: sess.id, count: added.length } });
      return { session: conv.getSession(sess.id), added };
    }
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
    this.store.writeNode(n);
    this.writeNote(n);
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

  private ensureMission(actor: Actor): ScenariaNode {
    const head = this.head();
    if (head) return head;
    return this.startMissionUnlocked({
      title: `Mission ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      goal: undefined,
      agent: actor.agent,
      model: actor.model,
      user: actor.user,
      source: actor.source,
    });
  }

  startMission(input: MissionInput): ScenariaNode {
    return this.store.withLock(() => this.startMissionUnlocked(input));
  }

  private startMissionUnlocked(input: MissionInput): ScenariaNode {
    const id = this.nextId();
    const node: ScenariaNode = {
      id,
      type: "mission",
      missionId: id,
      parentId: null,
      title: input.title.trim(),
      goal: input.goal?.trim() || undefined,
      brief: input.brief?.trim() || undefined,
      createdAt: new Date().toISOString(),
      ...attrib(input),
      tags: clean(input.tags),
    };
    this.assignIdentity(node, null);
    node.snapshot = this.takeSnapshot(id, node.title, null);
    this.save(node);
    this.setHead(id, id);
    this.afterCreate(node);
    this.store.appendEvent({ type: "mission", nodeId: id });
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
    return this.store.withLock(() => {
      const parent = this.ensureMission(input);
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

  private viaFor(parent: ScenariaNode): string | undefined {
    return parent.type === "decision" ? parent.chosen : undefined;
  }

  checkpoint(input: CheckpointInput): ScenariaNode | null {
    return this.store.withLock(() => this.checkpointUnlocked(input));
  }

  private checkpointUnlocked(input: CheckpointInput): ScenariaNode | null {
    const parent = this.ensureMission(input);
    if (input.onlyIfChanged && this.repo && !this.isDirty(parent)) return null;
    const id = this.nextId();
    const node: ScenariaNode = {
      id,
      type: input.type ?? "checkpoint",
      missionId: parent.missionId,
      parentId: parent.id,
      viaOption: this.viaFor(parent),
      title: input.title.trim().slice(0, 200) || "Checkpoint",
      outputs: clean(input.outputs),
      facts: clean(input.facts),
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
    return node;
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

  update(id: string, patch: Partial<Pick<ScenariaNode, "title" | "facts" | "outputs" | "openQuestions" | "irreversible" | "tags" | "goal" | "brief">>): ScenariaNode {
    return this.store.withLock(() => {
      const node = this.store.readNode(id);
      Object.assign(node, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      this.save(node);
      this.store.appendEvent({ type: "update", nodeId: id, data: { fields: Object.keys(patch) } });
      return node;
    });
  }

  /**
   * Checkpoint the working tree if it differs from HEAD (used by `scenaria watch`).
   * The title lists the changed files, so the map stays readable without an agent summary.
   */
  autoCheckpoint(actor: Actor = {}, titleHint?: string): ScenariaNode | null {
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
      return this.checkpointUnlocked({ title, onlyIfChanged: true, source: "watch", ...actor, agent: actor.agent ?? "watch", outputs: names.length ? [`Changed: ${names.slice(0, 8).join(", ")}${names.length > 8 ? " …" : ""}`] : undefined });
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
  context(id?: string): ContextResult {
    const target = id ?? this.store.readState().head;
    if (!target) throw new Error("No HEAD yet — start a mission first.");
    const path = this.path(target);
    const pathIds = new Set(path.map((p) => p.id));
    const lastUser = this.conversations
      .allMessages()
      .filter((m) => m.role === "user" && m.headAt && pathIds.has(m.headAt))
      .pop();
    const markdown = composeContext(path, {
      fullCheckpoints: this.config().contextFullCheckpoints,
      lastGood: this.lastGood(target)?.id ?? null,
      lastUserRequest: lastUser?.text ?? null,
    });
    return { nodeId: target, markdown, tokens: estimateTokens(markdown) };
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

  /** Text tree for terminals and agents. */
  treeText(missionId?: string): string {
    const state = this.store.readState();
    const nodes = this.store.listNodes();
    const mid = missionId ?? state.activeMission;
    const root = nodes.find((n) => n.id === mid);
    if (!root) return "(no mission yet)";
    const headPath = new Set(state.head ? this.path(state.head).map((n) => n.id) : []);
    const icon: Record<string, string> = { mission: "◎", decision: "❖", checkpoint: "◆", branch: "⑂", autosave: "⟲" };
    const vmark: Record<string, string> = { passed: " ✔", failed: " ✘", warning: " !", unverified: "" };
    const lines: string[] = [];
    const walk = (n: ScenariaNode, prefix: string, last: boolean, isRoot: boolean) => {
      const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
      const via = parent?.type === "decision" && n.viaOption ? `[${optionLabel(parent, n.viaOption)}] ` : "";
      let label = `${icon[n.type] ?? "·"} ${n.id} ${via}${n.type === "decision" ? n.question ?? n.title : n.title}`;
      if (n.type === "decision") label += ` → ${optionLabel(n, n.chosen) ?? "open"}`;
      label += vmark[n.verification?.status ?? "unverified"];
      if (n.id === state.head) label += "   ◀ HEAD";
      else if (headPath.has(n.id)) label += "  ·";
      lines.push(isRoot ? label : `${prefix}${last ? "└─ " : "├─ "}${label}`);
      const kids = nodes.filter((x) => x.parentId === n.id);
      kids.forEach((k, i) => walk(k, isRoot ? "" : prefix + (last ? "   " : "│  "), i === kids.length - 1, false));
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
