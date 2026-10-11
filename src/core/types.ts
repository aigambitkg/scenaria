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

export type Source = "mcp" | "cli" | "hook" | "ui" | "api";

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
  id: string; // n1, n2, ...
  type: NodeType;
  missionId: string;
  parentId: string | null;
  /** Option id of the parent decision this node continues. */
  viaOption?: string;
  title: string;
  createdAt: string;
  agent?: string;
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

export interface ScenariaConfig {
  version: 1;
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
  | "update";

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
