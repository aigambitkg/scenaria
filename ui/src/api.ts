import type { AnalysisConfig, ConversationMessage, ConversationSession, ProjectRule, ScenariaConfig, ScenariaEvent, ScenariaNode, ScenariaState } from "../../src/core/types";
import type { AnalysisRecord, Metrics } from "../../src/core/analysis";
import type { FidelityPoint } from "../../src/core/fidelity";

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
};
