import type { AnalysisConfig, ConversationMessage, ConversationSession, ProjectRule, ScenariaConfig, ScenariaEvent, ScenariaNode, ScenariaState } from "../../src/core/types";
import type { AnalysisRecord, Metrics } from "../../src/core/analysis";
import type { FidelityPoint } from "../../src/core/fidelity";
import type { CanonEvent, CanonSuggestion } from "../../src/core/canon";
import type { StringPayload } from "../../src/core/workspace";
import type { SettingsView, LlmRole } from "../../src/core/settings";
import type { LlmChoice } from "../../src/core/global";
import type { AgentStatus } from "../../src/setup";
import type { ChatMessage, ChatResponse, ChatToolCall } from "../../src/chat";
import type { RelayReport } from "../../src/core/relay";
import type { gateMatrix } from "../../src/core/gate";
import type { Forecast, ForecastOption, QuickForecast } from "../../src/core/forecast";
export type { Forecast, ForecastOption, QuickForecast };
import type { ExpertReport, FactSheet, Finding, Recommendation } from "../../src/core/expert";
import type { KnownProject } from "../../src/core/projects";
export type { ExpertReport, FactSheet, Finding, Recommendation, KnownProject };
export interface ExpertPage {
  reports: { id: string; createdAt: string; scope: ExpertReport["scope"]; model: string | null; maturity: ExpertReport["maturity"]; findings: number; recommendations: number; projects: string[]; verified?: boolean }[];
  facts: FactSheet;
  /** Only for the person (approval session, not team mode). */
  projects: { name: string; lastSeen: string; current: boolean }[];
  person: boolean;
}
export interface ForecastsPage {
  forecasts: Forecast[];
  calibration: { evaluated: number; meanError: number | null; hits: number };
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

export type { CanonEvent, CanonSuggestion, StringPayload };

export type { ScenariaNode, ScenariaEvent, ConversationMessage, ConversationSession, ProjectRule, AnalysisRecord, Metrics, AnalysisConfig, FidelityPoint };

export interface Fidelity {
  points: Record<string, FidelityPoint>;
  ledgerBrokenAt: number | null;
  ledgerEntries: number;
  ledgerMissing?: boolean;
  ledgerTorn?: number;
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
    headers: body === undefined ? {} : { "content-type": "application/json", "x-scenaria": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  graph: () => req<Graph>("/api/graph"),
  context: (id: string) => req<{ nodeId: string; markdown: string; tokens: number; historyTokens: number; omitted: number }>(`/api/node/${id}/context`),
  diff: (from: string, to?: string) =>
    req<{ from: string; to: string; stat: string; patch: string; truncated: boolean }>(
      `/api/diff?from=${encodeURIComponent(from)}${to ? `&to=${encodeURIComponent(to)}` : ""}`,
    ),
  log: () => req<{ events: ScenariaEvent[] }>("/api/log"),
  protocol: () => req<{ markdown: string }>("/api/protocol"),
  rewind: (id: string, lesson: string, restoreFiles: boolean) =>
    req<{ target: ScenariaNode; autosave: ScenariaNode | null; warnings: string[] }>("/api/rewind", { id, lesson, restoreFiles }),
  fork: (decisionId: string, option: string, lesson: string) =>
    req<{ branch: ScenariaNode; autosave: ScenariaNode | null; warnings: string[] }>("/api/fork", { decisionId, option, lesson }),
  verify: (id: string, body: { status?: string; notes?: string; auto?: boolean; runCommand?: boolean }) =>
    req<ScenariaNode>("/api/verify", { id, ...body }),
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
  canon: () => req<{ events: CanonEvent[]; suggestions: CanonSuggestion[]; error: string | null; missing?: string[]; approval: boolean }>("/api/canon"),
  approval: () => req<{ granted: boolean; mode: "local" | "team" | "disabled" }>("/api/approval"),
  addCanon: (c: { kind: string; text: string; hard: boolean; check?: string; due?: string; evidence?: string[] }) => req<CanonEvent>("/api/canon", c),
  decideCanon: (id: string, action: "approve" | "reject" | "retire" | "confirm", opts: { reason?: string; adoptCheck?: boolean | string } = {}) => req<CanonEvent>("/api/canon/decide", { id, action, ...opts }),
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
  // v0.7
  settings: () => req<SettingsPage>("/api/settings"),
  saveSettings: (patch: { llm?: { default?: LlmChoice; roles?: Partial<Record<LlmRole, LlmChoice>> }; trustedEndpoints?: string[]; chat?: { confirmDestructive: boolean; maxSteps: number }; forecast?: { auto: boolean; dailyLimit: number }; ui?: { lang: string } }) => req<SettingsView>("/api/settings", patch),
  forecasts: () => req<ForecastsPage>("/api/forecasts"),
  quickDecision: (node: string) => req<{ node: string; options: ForecastOption[] }>(`/api/forecast/quick?node=${encodeURIComponent(node)}`),
  quickPrompt: (text: string) => req<{ prompt: string; quick: QuickForecast }>(`/api/forecast/quick?prompt=${encodeURIComponent(text)}`),
  runForecast: (b: { node?: string; prompt?: string; variants?: string[]; quick?: boolean; lang: string; llm?: Partial<LlmCall> }) => req<Forecast>("/api/forecast", b),
  markUsed: (id: string, key: string) => req<Forecast>("/api/forecast/used", { id, key }),
  models: (b: { provider: string; baseUrl?: string; apiKey?: string }) => req<{ models: string[] }>("/api/settings/models", b),
  testLlm: (b: LlmCall) => req<{ ok: boolean; model: string; reply: string; ms: number }>("/api/settings/test", b),
  connectAgents: (targets: string[]) => req<{ changes: string[]; notes: string[]; agents: AgentStatus[] }>("/api/agents/connect", { targets }),
  chat: (b: { sessionId: string; messages: ChatMessage[]; decisions?: Record<string, "approve" | "deny">; llm?: Partial<LlmCall>; lang: string }) => req<ChatResponse>("/api/chat", b),
  relay: (b: { question: string; options?: string[]; createDecision: boolean; lang: string; llm?: Partial<LlmCall> }) => req<RelayReport>("/api/relay", b),
  relays: () => req<RelayReport[]>("/api/relay"),
  gate: () => req<GateMatrix>("/api/canon/gate"),
  runGate: (lines?: string[]) => req<GateMatrix>("/api/canon/gate", { lines }),
  expert: () => req<ExpertPage>("/api/expert"),
  expertReport: (id: string) => req<ExpertReport>(`/api/expert/report?id=${encodeURIComponent(id)}`),
  runExpert: (b: { scope: "project" | "line" | "all"; head?: string; noModel?: boolean; lang: string; llm?: Partial<LlmCall> }) => req<ExpertReport>("/api/expert", b),
  adoptRecommendation: (id: string, index: number) => req<ProjectRule>("/api/expert/adopt", { id, index }),
  choose: (id: string, option: string, rationale: string) => req<ScenariaNode>("/api/choose", { id, option, rationale }),
};
