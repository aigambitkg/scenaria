import type { AnalysisConfig, ConversationMessage, ConversationSession, ProjectRule, ScenariaConfig, ScenariaEvent, ScenariaNode, ScenariaState } from "../../src/core/types";
import type { AnalysisRecord, Metrics } from "../../src/core/analysis";
import type { FidelityPoint } from "../../src/core/fidelity";
import type { CanonEvent, CanonExpect, CanonSuggestion } from "../../src/core/canon";
import type { ProjectProgress, TaskProgress, CriterionProgress } from "../../src/core/progress";
import type { WindowStatus, WindowInfo, WindowCut } from "../../src/core/window";
import type { ContextSettings, ContextValues, LocalModel } from "../../src/core/contextsettings";
import type { Handover } from "../../src/core/windowact";
import type { StringPayload } from "../../src/core/workspace";
import type { SettingsView, LlmRole } from "../../src/core/settings";
import type { LlmChoice } from "../../src/core/global";
import type { AgentStatus } from "../../src/setup";
import type { ChatMessage, ChatResponse, ChatToolCall } from "../../src/chat";
import type { RelayReport } from "../../src/core/relay";
import type { gateMatrix } from "../../src/core/gate";
import type { AuditFile } from "../../src/core/auditfile";
import type { AuditAccess } from "../../src/core/auditaccess";
import type { CopyPlan, OrgEvidence, OrgEvidenceInput, OrgEvidenceState, RemovePlan } from "../../src/core/orgevidence";
import type { Forecast, ForecastOption, QuickForecast } from "../../src/core/forecast";
export type { Forecast, ForecastOption, QuickForecast };
import type { ExpertReport, FactSheet, Finding, Recommendation } from "../../src/core/expert";
import type { Explain, Quality as ForecastQuality, BenchSummary, Calibration } from "../../src/core/predict";
export type { Explain, ForecastQuality, BenchSummary, Calibration };
import type { Audit, AuditOverview, AuditRow, BacktestRecord, Check, DeepAudit, OracleQuality, PastDecision, PastOption } from "../../src/core/auditor";
import type { OracleAdjust } from "../../src/core/oracle";
export type { Audit, AuditOverview, AuditRow, Check, DeepAudit, OracleQuality, OracleAdjust, PastDecision, PastOption };
export type OracleBacktestRun = BacktestRecord;
export interface ForecastJob {
  kind: "multiverse" | "audit" | "backtest";
  subject: string;
  step: string;
  index?: number;
  total?: number;
  startedAt: string;
}
import type { KnownProject } from "../../src/core/projects";
export type { ExpertReport, FactSheet, Finding, Recommendation, KnownProject };
export interface ProjectsPage {
  current: { name: string; root?: string };
  canSwitch: boolean;
  person: boolean;
  projects: { name: string; root: string; lastSeen: string; exists: boolean; current: boolean }[];
  agents: { name: string; root?: string; same: boolean } | null;
}
export interface ExpertPage {
  reports: { id: string; createdAt: string; scope: ExpertReport["scope"]; model: string | null; maturity: ExpertReport["maturity"]; findings: number; recommendations: number; projects: string[]; verified?: boolean }[];
  facts: FactSheet;
  /** Only for the person (approval session, not team mode). */
  projects: { name: string; lastSeen: string; current: boolean }[];
  person: boolean;
}
export interface ForecastsPage {
  forecasts: Forecast[];
  calibration: { evaluated: number; meanError: number | null; hits: number; legacy: number; multiverse: { evaluated: number; meanError: number | null } };
  running: string | null;
  open: string[];
  failed: Record<string, string>;
  auto: { auto: boolean; dailyLimit: number; usedToday: number };
}

export type { SettingsView, LlmRole, LlmChoice, AgentStatus, ChatMessage, ChatResponse, ChatToolCall, RelayReport };
export type GateMatrix = ReturnType<typeof gateMatrix>;
export interface SettingsPage extends SettingsView {
  agents: AgentStatus[];
  snippets: { mcpCommand: string; mcpJson: string; http: { tools: string; call: string } | null; proxy: Record<string, string> | null };
  approval: boolean;
  teamMode: boolean;
  version: string;
}
export interface LlmCall {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** The provider the session key belongs to (never handed to another provider's model). */
  keyFor?: string;
}

export type { CanonEvent, CanonSuggestion, StringPayload, ProjectProgress, TaskProgress, CriterionProgress };

export type { ScenariaNode, ScenariaEvent, ConversationMessage, ConversationSession, ProjectRule, AnalysisRecord, Metrics, AnalysisConfig, FidelityPoint };

export interface Fidelity {
  points: Record<string, FidelityPoint>;
  ledgerBrokenAt: number | null;
  ledgerEntries: number;
  ledgerMissing?: boolean;
  ledgerTorn?: number;
  /** The ledger is not the one this machine accepted (deleted and recreated, or reset without the person). */
  ledgerReplaced?: boolean;
  /** Reseals without an authentic record. */
  resealsUnproven?: string[];
  /** The ledger does not end where this machine last saw it. */
  ledgerDiverged?: { expected: { lines: number }; found: { lines: number }; kind: "extended" | "rewritten"; since: string[] } | null;
  /** A new project was started in this folder. */
  restarted?: { at: string; since: string } | null;
  /** Node ids whose "passed" counts as verified (checked by the engine: authentic and untampered). */
  confirmed?: string[];
  /** Verdicts signed by a key this machine does not trust. */
  verdictsUntrusted?: string[];
  /** Verdicts whose work changed afterwards (no longer apply). */
  verdictsSuperseded?: string[];
  /** The person's / audit agents' verdicts that vanished or changed outside Scenaria. */
  verdictsRemoved?: string[];
}

export interface Graph {
  config: ScenariaConfig;
  state: ScenariaState;
  nodes: ScenariaNode[];
  root: string;
  version: number;
  snapshots: boolean;
}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    // The dashboard marks its requests: after a project switch they follow it (agents' calls do not).
    headers: body === undefined ? { "x-scenaria-view": "dashboard" } : { "content-type": "application/json", "x-scenaria": "1", "x-scenaria-view": "dashboard" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const code = typeof (data as any)?.code === "string" ? (data as any).code : undefined;
  if (!res.ok) throw new ApiError((code && errorTexts[code]) || ((data as any)?.error ?? `HTTP ${res.status}`), res.status, code, typeof (data as any)?.key === "string" ? (data as any).key : undefined);
  return data as T;
}

/** Texts in the person's language for some of Scenaria's error codes (set by the app when the language changes). */
export const errorTexts: Record<string, string> = {};

/** An error answer of Scenaria: the message, the HTTP status and Scenaria's code (e.g. "approval_required"). */
export class ApiError extends Error {
  /** `key`: the field a refused value belongs to (e.g. "red"), when the server names one. */
  constructor(message: string, readonly status: number, readonly code?: string, readonly key?: string) {
    super(message);
  }
}
export type { AuditFile, AuditAccess, CopyPlan, OrgEvidence, OrgEvidenceInput, OrgEvidenceState };
export type { WindowStatus, WindowInfo, WindowCut, ContextSettings, ContextValues, LocalModel, Handover };
export type ContextSettingsView = ContextSettings & { text: { de: string; en: string }; defaults: ContextValues; bounds: Record<keyof ContextValues, [number, number]>; approval: boolean };
/** What removing would do, and the digest of the entry concerned (sent back so nothing unseen is signed). */
export type RemovePlanView = RemovePlan & { digest: string };
export interface AuditPackageResult {
  /** The package folder's name (never a machine path). */
  folder: string;
  where: "downloads" | "home";
  digest: string;
  keyId: string;
  names: "with-names" | "roles-only";
}

export const api = {
  graph: () => req<Graph>("/api/graph"),
  context: (id: string) => req<{ nodeId: string; markdown: string; tokens: number; historyTokens: number; omitted: number }>(`/api/node/${id}/context`),
  diff: (from: string, to?: string) =>
    req<{ from: string; to: string; stat: string; patch: string; truncated: boolean }>(
      `/api/diff?from=${encodeURIComponent(from)}${to ? `&to=${encodeURIComponent(to)}` : ""}`,
    ),
  log: () => req<{ events: ScenariaEvent[] }>("/api/log"),
  headAt: (until: string) => req<{ id: string | null }>(`/api/head-at?until=${encodeURIComponent(until)}`),
  protocol: () => req<{ markdown: string }>("/api/protocol"),
  rewind: (id: string, lesson: string, restoreFiles: boolean) =>
    req<{ target: ScenariaNode; autosave: ScenariaNode | null; warnings: string[] }>("/api/rewind", { id, lesson, restoreFiles }),
  fork: (decisionId: string, option: string, lesson: string) =>
    req<{ branch: ScenariaNode; autosave: ScenariaNode | null; warnings: string[] }>("/api/fork", { decisionId, option, lesson }),
  verify: (id: string, body: { status?: string; notes?: string; auto?: boolean; runCommand?: boolean }) =>
    req<ScenariaNode>("/api/verify", { id, ...body }),
  /** The person's: accept the current state as the new integrity baseline (approval session). */
  reseal: () => req<{ archived: string | null; nodes: number; record: string }>("/api/integrity/reseal", {}),
  checkpoint: (title: string) => req<ScenariaNode | null>("/api/checkpoint", { title }),
  nodeMessages: (id: string) => req<{ leading: ConversationMessage[]; after: ConversationMessage[] }>(`/api/node/${id}/messages`),
  folder: (id: string, open: boolean) => req<{ folder: string | null }>(`/api/node/${id}/folder`, { open }),
  conversations: () => req<ConversationSession[]>("/api/v1/conversations"),
  conversation: (id: string) => req<{ session: ConversationSession; messages: ConversationMessage[] }>(`/api/v1/conversations/${encodeURIComponent(id)}`),
  versions: () => req<any[]>("/api/v1/versions"),
  setGoal: (goal: string) => req<ScenariaNode>("/api/goal", { goal }),
  updateNode: (id: string, patch: Record<string, string>) => req<ScenariaNode>("/api/node/update", { id, ...patch }),
  prompt: (kind: string, lang: string, context: boolean) =>
    req<{ text: string; tokens: number }>(`/api/v1/prompt?kind=${kind}&lang=${lang}${context ? "&context=1" : ""}`),
  ingestText: (text: string) => req<{ created: { id: string; type: string; title: string }[]; errors: string[]; skipped: number }>("/api/v1/ingest-text", { text, log: true }),
  analysis: () => req<Metrics>("/api/analysis"),
  fidelity: () => req<Fidelity>("/api/fidelity"),
  /** E2: progress per task and for the project, each with its derivation. */
  progress: () => req<ProjectProgress>("/api/progress"),
  /** E3: how full each agent's context window is (measured), with the derivation of every number. */
  windows: () => req<WindowStatus>("/api/windows"),
  /** E3a-2: the prepared handover to a new window (read-only). */
  handover: (window?: string) => req<Handover>(`/api/handover${window ? `?window=${encodeURIComponent(window)}` : ""}`),
  /** E3b-1: the values of the context-window rule; setting them is the person's (approval session). */
  contextSettings: () => req<ContextSettingsView>("/api/context-settings"),
  setContextSettings: (body: { values?: Partial<ContextValues>; models?: LocalModel[]; reset?: boolean }) => req<ContextSettingsView>("/api/context-settings", body),
  canon: () => req<{ events: CanonEvent[]; suggestions: CanonSuggestion[]; error: string | null; missing?: string[]; letGo?: { id: string; text: string }[]; approval: boolean }>("/api/canon"),
  approval: () => req<{ granted: boolean; mode: "local" | "team" | "disabled"; auditView?: boolean | "stale" }>("/api/approval"),
  /** The ISO/IEC 42001 audit file (C2): the person's (or the auditor mode's), unless the person opened it. */
  auditFile: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const qs = q.toString();
    return req<AuditFile>(`/api/audit-file${qs ? `?${qs}` : ""}`);
  },
  auditAccess: () => req<AuditAccess & { approval: boolean }>("/api/audit-file/access"),
  /** The person's: write the signed audit package to Downloads and open its print page (local mode). */
  auditPackage: (b: { from?: string; to?: string; names: "with-names" | "roles-only"; lang: string }) => req<AuditPackageResult>("/api/audit-file/package", b),
  /** The person's: this browser becomes read-only for the auditor (8 h); the approval is removed here. */
  auditorModeStart: () => req<{ ok: boolean; hours: number }>("/api/audit-file/auditor-mode", {}),
  auditorModeEnd: () => req<{ ok: boolean }>("/api/audit-file/auditor-mode/end", {}),
  // The organisation's evidence (C3 routes; the dashboard form is C4c-2). Every POST is the person's.
  orgEvidence: () => req<{ entries: OrgEvidenceState[]; missing: string[]; error: string | null; approval: boolean }>("/api/audit-file/evidence"),
  orgEvidencePreview: (input: Partial<OrgEvidenceInput>) => req<{ input: OrgEvidenceInput }>("/api/audit-file/evidence", { ...input, dryRun: true }),
  orgEvidenceAdd: (input: OrgEvidenceInput) => req<{ entry: OrgEvidence }>("/api/audit-file/evidence", input),
  orgEvidenceRemovePlan: (id: string, discard: boolean) => req<RemovePlanView>("/api/audit-file/evidence/remove", { id, discard, dryRun: true }),
  orgEvidenceRemove: (id: string, discard: boolean, expect: { outcome: string; digest: string }) => req<{ entry: OrgEvidence; discarded: boolean; dropped: number }>("/api/audit-file/evidence/remove", { id, discard, expect }),
  orgEvidenceConfirm: (id: string, digest: string) => req<{ entry: OrgEvidence }>("/api/audit-file/evidence/confirm", { id, digest }),
  orgEvidenceCopyPlan: (from: string) => req<CopyPlan>("/api/audit-file/evidence/copy", { from, dryRun: true }),
  orgEvidenceCopy: (from: string, expect: { name: string; entries: { id: string; digest: string }[] }) => req<{ copied: OrgEvidence[]; skipped: { id: string; reason: string }[]; from: string }>("/api/audit-file/evidence/copy", { from, expect }),
  addCanon: (c: { kind: string; text: string; hard: boolean; check?: string; due?: string; evidence?: string[]; task?: string; weight?: number; artifact?: string }) => req<CanonEvent>("/api/canon", c),
  /** A criterion is approved exactly as shown (`expect`); `weight` sets it on approve or reweigh. */
  decideCanon: (id: string, action: "approve" | "reject" | "retire" | "confirm" | "reweigh", opts: { reason?: string; adoptCheck?: boolean | string; weight?: number; expect?: CanonExpect } = {}) => req<CanonEvent>("/api/canon/decide", { id, action, ...opts }),
  checkCanon: () => req<{ id: string; status: string; detail: string }[]>("/api/canon/check", {}),
  archivist: (lang: string) => req<{ proposed: CanonEvent[]; skipped: number; model: string }>("/api/canon/archivist", { lang }),
  stringAt: (id: string) => req<StringPayload>(`/api/v1/string?at=${encodeURIComponent(id)}`),
  analyses: () => req<AnalysisRecord[]>("/api/analysis/list"),
  dossier: (lang: string) => req<{ text: string; tokens: number; decisions: number; omitted: number }>(`/api/analysis/dossier?lang=${lang}`),
  analysisConfig: () => req<{ config: AnalysisConfig | null; envKeys: string[]; teamMode: boolean }>("/api/analysis/config"),
  saveAnalysisConfig: (c: AnalysisConfig) => req<{ ok: boolean }>("/api/analysis/config", c),
  runAnalysis: (body: Partial<AnalysisConfig> & { apiKey?: string; lang: string }) => req<AnalysisRecord>("/api/analysis/run", body),
  importAnalysis: (text: string, lang: string) => req<AnalysisRecord>("/api/analysis/import", { text, lang }),
  acceptRule: (id: string, index: number) => req<ProjectRule>("/api/analysis/accept", { id, index }),
  rules: () => req<ProjectRule[]>("/api/rules"),
  addRule: (text: string) => req<ProjectRule>("/api/rules", { text }),
  deleteRule: (id: string) => req<{ ok: boolean }>("/api/rules/delete", { id }),
  ruleProposals: () => req<{ proposals: ProjectRule[]; count: number; unconfirmed: (ProjectRule & { trust: string })[]; tampered: (ProjectRule & { trust: string })[]; missing: string[]; needsYou: number; approval: boolean }>("/api/rules/proposals"),
  confirmRule: (id: string, text: string) => req<ProjectRule>("/api/rules/confirm", { id, text }),
  approveRule: (id: string, text: string) => req<ProjectRule>("/api/rules/approve", { id, text }),
  rejectRule: (id: string) => req<{ ok: boolean }>("/api/rules/reject", { id }),
  // v0.7
  settings: () => req<SettingsPage>("/api/settings"),
  saveSettings: (patch: { llm?: { default?: LlmChoice; roles?: Partial<Record<LlmRole, LlmChoice>> }; trustedEndpoints?: string[]; chat?: { confirmDestructive: boolean; maxSteps: number }; forecast?: { auto: boolean; dailyLimit: number }; ui?: { lang: string } }) => req<SettingsView>("/api/settings", patch),
  forecasts: () => req<ForecastsPage>("/api/forecasts"),
  quickDecision: (node: string) => req<{ node: string; options: ForecastOption[] }>(`/api/forecast/quick?node=${encodeURIComponent(node)}`),
  quickPrompt: (text: string) => req<{ prompt: string; quick: QuickForecast }>(`/api/forecast/quick?prompt=${encodeURIComponent(text)}`),
  runForecast: (b: { node?: string; prompt?: string; variants?: string[]; quick?: boolean; lang: string; llm?: Partial<LlmCall> }) => req<Forecast>("/api/forecast", b),
  forecastQuality: () => req<ForecastQuality>("/api/forecast/quality"),
  audit: (id: string, lang: string) => req<Audit>(`/api/forecast/audit?id=${encodeURIComponent(id)}&lang=${lang}`),
  deepAudit: (id: string, lang: string, llm?: Partial<LlmCall>) => req<Audit>("/api/forecast/audit", { id, lang, llm }),
  oracleQuality: () => req<OracleQuality & { runs: OracleBacktestRun[] }>("/api/forecast/oracle"),
  oracleBacktest: (limit: number, lang: string, llm?: Partial<LlmCall>) => req<OracleQuality & { run: OracleBacktestRun }>("/api/forecast/oracle-backtest", { limit, lang, llm }),
  cancelForecast: () => req<{ cancelled: boolean }>("/api/forecast/cancel", {}),
  /** Download through fetch, so the request carries the dashboard's mark (follows a project switch). */
  downloadReport: async (format: "md" | "json", lang: string) => {
    const res = await fetch(`/api/audit/report?format=${format}&lang=${lang}`, { headers: { "x-scenaria-view": "dashboard" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `scenaria-report.${format}`;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
  auditOverview: (lang: string) => req<AuditOverview>(`/api/audit/overview?lang=${lang}`),
  forecastProgress: () => req<{ job: ForecastJob | null; auto: string | null }>("/api/forecast/progress"),
  pastDecisions: () => req<{ id: string; question: string; at: string; chosen?: string; chosenLabel?: string; options: number; measurable: number }[]>("/api/forecast/past"),
  createDecision: (question: string, options: { label: string; description?: string }[]) => req<ScenariaNode>("/api/forecast/decision", { question, options }),
  oracleBacktestDecisions: (decisions: string[], lang: string, llm?: Partial<LlmCall>) => req<OracleQuality & { run: OracleBacktestRun }>("/api/forecast/oracle-backtest", { decisions, lang, llm }),
  benchmark: () => req<BenchSummary & { calibration: Calibration }>("/api/forecast/benchmark", {}),
  markUsed: (id: string, key: string) => req<Forecast>("/api/forecast/used", { id, key }),
  models: (b: { provider: string; baseUrl?: string; apiKey?: string }) => req<{ models: string[] }>("/api/settings/models", b),
  testLlm: (b: LlmCall) => req<{ ok: boolean; model: string; reply: string; ms: number }>("/api/settings/test", b),
  /** Opens a fresh single-use approval link in the default browser (the code never comes back here). */
  openApproval: () => req<{ ok: boolean; already?: boolean; opened?: boolean }>("/api/approval/open", {}),
  createLauncher: () => req<{ ok: boolean; file: string }>("/api/agents/launcher", {}),
  connectAgents: (targets: string[]) => req<{ changes: string[]; notes: string[]; agents: AgentStatus[] }>("/api/agents/connect", { targets }),
  chat: (b: { sessionId: string; messages: ChatMessage[]; decisions?: Record<string, "approve" | "deny">; llm?: Partial<LlmCall>; lang: string }) => req<ChatResponse>("/api/chat", b),
  relay: (b: { question: string; options?: string[]; createDecision: boolean; lang: string; llm?: Partial<LlmCall> }) => req<RelayReport>("/api/relay", b),
  relays: () => req<RelayReport[]>("/api/relay"),
  gate: () => req<GateMatrix>("/api/canon/gate"),
  runGate: (lines?: string[]) => req<GateMatrix>("/api/canon/gate", { lines }),
  projects: () => req<ProjectsPage>("/api/projects"),
  switchProject: (root: string) => req<{ ok: boolean; name: string; root: string }>("/api/projects/switch", { root }),
  forgetProject: (root: string) => req<{ ok: boolean }>("/api/projects/forget", { root }),
  expert: () => req<ExpertPage>("/api/expert"),
  expertReport: (id: string) => req<ExpertReport>(`/api/expert/report?id=${encodeURIComponent(id)}`),
  runExpert: (b: { scope: "project" | "line" | "all"; head?: string; noModel?: boolean; lang: string; llm?: Partial<LlmCall> }) => req<ExpertReport>("/api/expert", b),
  adoptRecommendation: (id: string, index: number) => req<ProjectRule>("/api/expert/adopt", { id, index }),
  choose: (id: string, option: string, rationale: string) => req<ScenariaNode>("/api/choose", { id, option, rationale }),
};
