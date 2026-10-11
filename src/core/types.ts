/**
 * Scenaria data model.
 *
 * The central idea: a mission is a tree of *decision points*. Every node can
 * carry a file snapshot (restorable) and a compact fact capsule (resumable).
 */

export type NodeType =
  | "mission" // root of a tree: goal + brief
  | "decision" // a decision point: question, options, chosen option
  | "checkpoint" // progress save: what was produced
  | "branch" // start of an alternative explored via fork
  | "autosave"; // automatic save (before rewind / risky command)

export type VerificationStatus = "unverified" | "passed" | "warning" | "failed";

export type Source = "mcp" | "cli" | "hook" | "ui" | "api" | "watch";

export interface DecisionOption {
  id: string; // "a", "b", "c" ...
  label: string;
  description?: string;
}

export interface Snapshot {
  commit: string;
  tree: string;
  files: number;
  /** e.g. nested repositories that could not be fully captured */
  warnings?: string[];
}

export interface VerificationCheck {
  name: string;
  status: Exclude<VerificationStatus, "unverified">;
  detail?: string;
}

export interface Verification {
  status: VerificationStatus;
  notes?: string;
  checks?: VerificationCheck[];
  by?: string;
  at?: string;
}

export interface ScenariaNode {
  id: string; // n1, n2, ... (short, per project)
  /** Globally unique, time-sortable id (ULID) — stable across exports and merges. */
  uid?: string;
  /** Scenario = one linear line of work. A new branch (fork, or new work after a rewind) starts a new scenario. */
  scenarioId?: string;
  /** Step number on the path from the mission root (root = 0). (scenarioId, version) is unique. */
  version?: number;
  /** For the first node of a new scenario: the node it branched off. */
  forkedFrom?: string;
  /** Browsable snapshot folder (relative to the project root), if materialized. */
  snapshotFolder?: string;
  type: NodeType;
  missionId: string;
  parentId: string | null;
  /** Option id of the parent decision this node continues. */
  viaOption?: string;
  title: string;
  createdAt: string;
  /** Which agent/tool produced the node (e.g. "claude-code", "cursor", "n8n"). */
  agent?: string;
  /** Which model produced it (e.g. "gpt-5", "claude-opus-5-5", "llama3.3"). */
  model?: string;
  /** Human/user account responsible for the run (audit). */
  user?: string;
  source: Source;
  snapshot?: Snapshot | null;

  // mission
  goal?: string;
  brief?: string;

  // decision
  question?: string;
  options?: DecisionOption[];
  chosen?: string;
  rationale?: string;
  assumptions?: string[];
  /** 0..1 — how sure the agent was. */
  confidence?: number;

  // fact capsule
  facts?: string[];
  outputs?: string[];
  openQuestions?: string[];
  lessons?: string[];
  changedFiles?: string[];
  /** External side effects that a rewind cannot undo (mails, pushes, API writes). */
  irreversible?: string[];

  verification?: Verification;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface SnapshotFolderConfig {
  /** Materialize a browsable folder per node (hardlinked, read-only, deduplicated). */
  enabled: boolean;
  /** Relative to the project root. */
  path: string;
  /** Skip materialization for trees larger than this (snapshots still work). */
  maxFiles: number;
  /**
   * How files are placed: "auto" = copy-on-write clone where the filesystem supports it
   * (APFS, btrfs, xfs), otherwise a hardlink; "copy" = always independent copies (more disk).
   */
  link?: "auto" | "copy";
}

export interface ProxyConfig {
  /** Upstream base URLs (including the version path), e.g. https://api.openai.com/v1 */
  upstreams: Record<string, string>;
  /** After each assistant turn: checkpoint if project files changed. */
  autoCheckpoint: boolean;
}

export interface ScenariaConfig {
  version: 1;
  snapshotFolders?: SnapshotFolderConfig;
  /** Also publish snapshot refs (refs/scenaria/*) into the project's own git repo. */
  mirrorToProjectGit?: boolean;
  proxy?: ProxyConfig;
  projectName: string;
  createdAt: string;
  /** Extra gitignore-style patterns excluded from snapshots. */
  exclude: string[];
  /** Optional command run by auto-verification when the node is HEAD (e.g. "npm test"). */
  verifyCommand?: string;
  /** Inject a compact status into Claude Code on session start. */
  injectContextOnSessionStart: boolean;
  /** How many recent checkpoints are shown in full in the resume context. */
  contextFullCheckpoints: number;
}

export interface ScenariaState {
  head: string | null;
  activeMission: string | null;
  counter: number;
  /** Data schema version (2 = uid/scenario/version on every node). */
  schema?: number;
  scenarioCounter?: number;
  messageCounter?: number;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

/** One conversation (a chat thread / agent session) from any provider. */
export interface ConversationSession {
  id: string; // c1, c2, ...
  uid: string;
  /** External id (e.g. Claude Code session id, proxy-derived hash, import id). */
  externalId?: string;
  title?: string;
  provider?: string; // openai, anthropic, ollama, google, …
  model?: string;
  agent?: string;
  source: Source | "proxy" | "import" | "transcript";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ToolCallRecord {
  name: string;
  arguments?: string;
}

/** A single message. `headAt` links it into the decision tree (the HEAD node when it was said). */
export interface ConversationMessage {
  id: string; // m1, m2, ...
  uid: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  toolCalls?: ToolCallRecord[];
  toolName?: string;
  provider?: string;
  model?: string;
  agent?: string;
  ts: string;
  headAt: string | null;
  hash: string;
  /** Hash of the whole conversation up to and including this message (dedupe across resends/edits). */
  chain?: string;
}

export type EventType =
  | "init"
  | "mission"
  | "decision"
  | "choose"
  | "checkpoint"
  | "branch"
  | "autosave"
  | "rewind"
  | "verify"
  | "update"
  | "messages";

export interface ScenariaEvent {
  ts: string;
  type: EventType;
  nodeId?: string;
  data?: Record<string, unknown>;
}

export interface GraphSnapshot {
  config: ScenariaConfig;
  state: ScenariaState;
  nodes: ScenariaNode[];
  root: string;
}
