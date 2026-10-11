import type { ConversationMessage, ConversationSession, ScenariaConfig, ScenariaEvent, ScenariaNode, ScenariaState } from "../../src/core/types";

export type { ScenariaNode, ScenariaEvent, ConversationMessage, ConversationSession };

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
  context: (id: string) => req<{ nodeId: string; markdown: string; tokens: number }>(`/api/node/${id}/context`),
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
};
