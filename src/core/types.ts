/**
 * Scenaria data model.
 *
 * The central idea: a mission is a tree of *decision points*. Every node can
 * carry a file snapshot (restorable) and a compact fact capsule (resumable).
 */

export type NodeType =
  | "mission" // the project root (n0): project name + main goal — exactly one per project
  | "goal" // a task / sub-goal on the project line (started by an agent, a chat session or a person)
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
  /**
   * Who gave the verdict (security rule 11, see core/verdict.ts): the person (approval session or
   * interactive terminal), a registered audit agent (signed request), an agent (self-reported, never
   * counts as verified) or the automatic checks. Missing on verdicts from before 0.9.2 ("legacy").
   */
  origin?: "person" | "auditor" | "agent" | "auto";
  /** How the person gave it: "dashboard" or "terminal". */
  via?: string;
  /** For an audit agent's verdict: its key id and name, and the signed request as received. */
  auditor?: { keyId: string; name?: string; request: { payload: string; pub: string; sig: string } };
  /** For the person's verdict: signature with the person's approver key (verdict/v2, bound to the project). */
  pub?: string;
  sig?: string;
  /** Hash of the work the verdict was given on (see ledger.workHash); a later change supersedes the verdict. */
  work?: string;
  /**
   * A later report by an agent or the automatic checks, kept NEXT TO a verdict of the person or an audit
   * agent instead of replacing it. A failed/warning report lowers the outcome; a passed one changes nothing.
   */
  report?: { status: VerificationStatus; origin: "agent" | "auto"; notes?: string; by?: string; at: string; checks?: VerificationCheck[] };
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

  // project root + tasks
  goal?: string;
  brief?: string;
  /** Task (goal node) state. */
  status?: "active" | "done" | "abandoned";
  /** Task rollup written when the task was finished (agent, LLM or deterministic). */
  summary?: string;

  // decision
  question?: string;
  options?: DecisionOption[];
  chosen?: string;
  rationale?: string;
  /** The situation that made this decision necessary (constraints, facts at hand). */
  context?: string;
  /** How the chosen option serves the project's main goal / the current task. */
  servesGoal?: string;
  /** What should be observable if the decision was right (checked later by verifier/analysis). */
  expectedOutcome?: string;
  /** Auto-captured: the latest user request when the decision was recorded. */
  trigger?: string;
  assumptions?: string[];
  /** 0..1 — how sure the agent was. */
  confidence?: number;

  /** References this node builds on (node ids or item refs like "n12.f2", "r3"). */
  basedOn?: string[];
  /** Canon events (k1, …) the decision was checked against and respects. */
  respectsCanon?: string[];
  /** Canon events the decision knowingly breaks (needs a rationale; flagged everywhere). */
  breaksCanon?: string[];

  // fact capsule
  facts?: string[];
  /** Per-fact metadata, aligned with `facts` by index: how sure, and what it rests on. */
  factInfo?: ({ confidence?: number; basedOn?: string[] } | null)[];
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
  /** Random project identity; canon signatures are bound to it (created on the first signed change). */
  projectId?: string;
  createdAt: string;
  /** Extra gitignore-style patterns excluded from snapshots. */
  exclude: string[];
  /** Optional command run by auto-verification when the node is HEAD (e.g. "npm test"). */
  verifyCommand?: string;
  /** Inject a compact status into Claude Code on session start. */
  injectContextOnSessionStart: boolean;
  /** How many recent checkpoints are shown in full in the resume context. */
  contextFullCheckpoints: number;
  /** Token budget of the resume capsule (older parts are rolled up / left to recall). Default 1500. */
  contextBudget?: number;
  /** Claude Code: add a one-line Scenaria reminder to every prompt (≈60 tokens). Default true. */
  promptReminder?: boolean;
  /** Reject decisions that pick an option without a rationale. Default true. */
  requireRationale?: boolean;
  /** LLM used for `scenaria analyze` (any provider; keys come from env vars, never from this file). */
  analysis?: AnalysisConfig;
}

export interface AnalysisConfig {
  /** openai, anthropic, ollama, lmstudio, gemini, mistral, openrouter, groq, azure, or any proxy upstream name. */
  provider: string;
  model: string;
  /** Override the base URL (default: proxy.upstreams[provider]). */
  baseUrl?: string;
  /** Ignored since 0.7 (only the provider's own env var is used). */
  apiKeyEnv?: string;
}

/**
 * A durable project rule (learned lesson / accepted recommendation) that every capsule carries.
 * Only ACTIVE rules reach agents. Agents can only propose a rule; the person activates it (security rule 5).
 */
export interface ProjectRule {
  id: string; // r1, r2, …
  text: string;
  source: "manual" | "analysis" | "lesson" | "agent";
  evidence?: string[];
  createdAt: string;
  /**
   * "proposed": waiting for the person; "rejected": the person said no; "removed": the person removed it.
   * Rejected and removed rules are kept (signed), so the id is never reused, the text is not proposed again
   * and every machine sees the removal. Missing (older projects): active, except rules from agents.
   */
  status?: "active" | "proposed" | "rejected" | "removed";
  /** Who proposed it: the name the agent STATED (not verified), for proposals. */
  proposedBy?: string;
  /** The person's decision: by whom and through which channel (dashboard approval mode or terminal). */
  decidedBy?: string;
  decidedVia?: "dashboard" | "terminal";
  decidedAt?: string;
  /** Signature of the person's decision (0.9.5): revision, approver key and Ed25519 signature. */
  rev?: number;
  keyId?: string;
  pub?: string;
  sig?: string;
}

/** Can this machine vouch for a rule? Only "verified" active rules reach agents. */
export type RuleTrust = "verified" | "unsigned" | "untrusted" | "tampered" | "proposal";

/** The person's decision on a rule, recorded with it. */
export interface RuleDecision {
  by: string;
  via: "dashboard" | "terminal";
}

export interface ScenariaState {
  head: string | null;
  activeMission: string | null;
  counter: number;
  /** Data schema version (2 = uid/scenario/version on every node, 3 = one project tree). */
  schema?: number;
  scenarioCounter?: number;
  messageCounter?: number;
  /** The single project root (n0). */
  projectRoot?: string | null;
  /** The task (goal node) new work is attached to, keyed by session/conversation. */
  currentTask?: { key: string; nodeId: string } | null;
  /** The latest request of a session whose task node does not exist yet (created lazily with the first real node). */
  pendingTask?: { key: string; title: string; goal?: string; at: string } | null;
  /** Session/conversation key → its task node (reused while that node is on the HEAD path). */
  taskBindings?: Record<string, string>;
  /** Set while a schema migration runs (relative backup path); an interrupted migration is rolled back. */
  migrating?: string;
  /** Latest user message (any source) — becomes a decision's `trigger`. */
  lastUserMessage?: { text: string; ts: string } | null;
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
  | "messages"
  | "goal"
  | "migrate"
  | "rule"
  | "analysis"
  | "canon";

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
