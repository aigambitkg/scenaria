/**
 * Getting conversations from anywhere into the overlay:
 * - Claude Code transcripts (incremental, from hooks)
 * - File imports: ChatGPT export, Claude.ai export, OpenAI-style message arrays, generic JSONL
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { Scenaria } from "./core/engine.js";
import type { MessageInput } from "./core/conversations.js";
import { claudeCodeWindowEvents, recordWindowEvents, windowJustStarted, type StartReason } from "./core/window.js";
import { evaluateStop } from "./core/windowprogress.js";

const TOOL_TEXT_MAX = 4000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.type === "text" || c?.type === "input_text" || c?.type === "output_text" ? c.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as any).text === "string") return (content as any).text;
  return "";
}

/** One Claude Code transcript entry → zero or more messages. */
export function claudeCodeEntryToMessages(e: any): MessageInput[] {
  if (!e || (e.type !== "user" && e.type !== "assistant") || e.isMeta || e.isSidechain) return [];
  const msg = e.message ?? {};
  const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;
  const content = msg.content;
  if (e.type === "assistant") {
    const blocks: any[] = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
    const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
    const toolCalls = blocks
      .filter((b) => b?.type === "tool_use")
      .map((b) => ({ name: String(b.name ?? "tool"), arguments: JSON.stringify(b.input ?? {}).slice(0, 2000) }));
    if (!text && !toolCalls.length) return [];
    return [{ role: "assistant", text, toolCalls, ts, model: msg.model, provider: "anthropic", agent: "claude-code" }];
  }
  if (typeof content === "string") return content.trim() ? [{ role: "user", text: content, ts, agent: "claude-code" }] : [];
  if (Array.isArray(content)) {
    const out: MessageInput[] = [];
    const userText = content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
    if (userText && !userText.startsWith("<system-reminder>")) out.push({ role: "user", text: userText, ts, agent: "claude-code" });
    for (const b of content) {
      if (b?.type === "tool_result") {
        const t = textOf(b.content) || (typeof b.content === "string" ? b.content : "");
        out.push({ role: "tool", text: t.slice(0, TOOL_TEXT_MAX), ts, agent: "claude-code" });
      }
    }
    return out;
  }
  return [];
}

/**
 * Read new lines of a Claude Code transcript since the last call (byte offset kept in
 * the hook session scratch) and log them. Returns the number of new messages.
 */
export function ingestClaudeTranscript(s: Scenaria, transcriptPath: string | undefined, sessionId: string | undefined, opts: { startReason?: StartReason } = {}): number {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  // Offset read, parsing, logging and offset write happen under one lock: parallel hooks must not double-ingest.
  return s.store.withLock(() => {
    const scratch = s.store.readScratch<{ offsets: Record<string, number> }>("transcripts", { offsets: {} });
    const size = statSync(transcriptPath).size;
    let start = scratch.offsets[transcriptPath] ?? 0;
    // File shrank (rotated/rewritten): re-read it from the start; chain-based dedupe skips what we have.
    const reread = size < start;
    if (reread) start = 0;
    if (size <= start) return 0;
    const fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(size - start);
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < 0) return 0; // no complete line yet
    const msgs: MessageInput[] = [];
    const entries: any[] = [];
    for (const line of buf.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        entries.push(e);
        msgs.push(...claudeCodeEntryToMessages(e));
      } catch {
        /* skip malformed line */
      }
    }
    // Batch E3a-1: how full the context window is (provider usage of each answer, compaction boundaries).
    try {
      const key = `claude-code:${sessionId ?? transcriptPath}`;
      if (recordWindowEvents(s, { source: "transcript", key, agent: "claude-code", startReason: opts.startReason }, claudeCodeWindowEvents(entries)) && windowJustStarted(s, key)) evaluateStop(s);
    } catch {
      /* measuring must never break recording the conversation */
    }
    const { added } = s.logMessagesUnlocked(
      { externalId: `claude-code:${sessionId ?? transcriptPath}`, source: "transcript", provider: "anthropic", agent: "claude-code" },
      msgs,
      reread ? "history" : "append",
    );
    scratch.offsets[transcriptPath] = start + lastNl + 1;
    s.store.writeScratch("transcripts", scratch);
    return added.length;
  });
}

// ------------------------------------------------------------------ file imports

export type ImportFormat = "auto" | "chatgpt" | "claude-ai" | "claude-code" | "openai" | "jsonl";

interface ImportedConversation {
  externalId: string;
  title?: string;
  provider?: string;
  model?: string;
  messages: MessageInput[];
}

function readImportFile(file: string): string {
  if (file.toLowerCase().endsWith(".zip")) {
    const r = spawnSync("unzip", ["-p", file, "conversations.json"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) throw new Error("Could not read conversations.json from the zip (is `unzip` installed?). Unzip it and import the JSON file.");
    return r.stdout;
  }
  return readFileSync(file, "utf8");
}

function fromChatGPT(data: any[]): ImportedConversation[] {
  return data.map((c, i) => {
    const mapping = c.mapping ?? {};
    const chain: any[] = [];
    let cur = c.current_node ?? Object.keys(mapping).find((k) => !(mapping[k]?.children?.length));
    const seen = new Set<string>();
    while (cur && mapping[cur] && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(mapping[cur]);
      cur = mapping[cur].parent;
    }
    const messages: MessageInput[] = [];
    let model: string | undefined;
    for (const node of chain) {
      const m = node?.message;
      if (!m || m.metadata?.is_visually_hidden_from_conversation) continue;
      const role = m.author?.role;
      if (!["user", "assistant", "system", "tool"].includes(role)) continue;
      const parts: unknown[] = m.content?.parts ?? (m.content?.text ? [m.content.text] : []);
      const text = parts.map((p) => (typeof p === "string" ? p : textOf(p))).join("\n").trim();
      if (!text) continue;
      model = m.metadata?.model_slug ?? model;
      messages.push({
        role,
        text,
        ts: m.create_time ? new Date(m.create_time * 1000).toISOString() : undefined,
        model: m.metadata?.model_slug,
        provider: "openai",
        agent: "chatgpt",
      });
    }
    return { externalId: `chatgpt:${c.id ?? c.conversation_id ?? i}`, title: c.title, provider: "openai", model, messages };
  });
}

function fromClaudeAi(data: any[]): ImportedConversation[] {
  return data.map((c, i) => ({
    externalId: `claude-ai:${c.uuid ?? i}`,
    title: c.name,
    provider: "anthropic",
    messages: (c.chat_messages ?? [])
      .map((m: any) => ({
        role: m.sender === "human" ? "user" : "assistant",
        text: (m.text || textOf(m.content)).trim(),
        ts: m.created_at,
        provider: "anthropic",
        agent: "claude.ai",
      }))
      .filter((m: MessageInput) => m.text),
  }));
}

function fromOpenAIMessages(list: any[], id: string): ImportedConversation {
  return {
    externalId: id,
    messages: list
      .filter((m) => m && typeof m.role === "string")
      .map((m) => ({
        role: (["user", "assistant", "system", "tool"].includes(m.role) ? m.role : "user") as MessageInput["role"],
        text: textOf(m.content ?? m.text ?? ""),
        toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.map((t: any) => ({ name: t.function?.name ?? "tool", arguments: t.function?.arguments })) : undefined,
        ts: m.ts ?? m.timestamp,
        model: m.model,
      })),
  };
}

export function detectFormat(raw: string, file: string): ImportFormat {
  const t = raw.trimStart();
  if (t.startsWith("[")) {
    const first = JSON.parse(raw)[0] ?? {};
    if (first.mapping) return "chatgpt";
    if (first.chat_messages) return "claude-ai";
    return "openai";
  }
  if (t.startsWith("{")) {
    const firstLine = t.split("\n")[0];
    try {
      const o = JSON.parse(firstLine);
      if ((o.type === "user" || o.type === "assistant" || o.type === "summary") && ("message" in o || o.type === "summary")) return "claude-code";
      if (o.role) return "jsonl";
    } catch {
      /* not jsonl */
    }
    const o = JSON.parse(raw);
    if (Array.isArray(o.messages)) return "openai";
  }
  throw new Error(`Could not detect the format of ${file}. Pass --format chatgpt|claude-ai|claude-code|openai|jsonl`);
}

export function parseImport(file: string, format: ImportFormat = "auto"): ImportedConversation[] {
  const raw = readImportFile(file);
  const fmt = format === "auto" ? detectFormat(raw, file) : format;
  switch (fmt) {
    case "chatgpt":
      return fromChatGPT(JSON.parse(raw));
    case "claude-ai":
      return fromClaudeAi(JSON.parse(raw));
    case "openai": {
      const o = JSON.parse(raw);
      return [fromOpenAIMessages(Array.isArray(o) ? o : o.messages, `import:${file}`)];
    }
    case "jsonl":
    case "claude-code": {
      const lines = raw.split("\n").filter((l) => l.trim());
      const entries = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
      if (fmt === "claude-code") {
        return [{ externalId: `claude-code:${file}`, provider: "anthropic", messages: entries.flatMap((e) => claudeCodeEntryToMessages(e)) }];
      }
      return [fromOpenAIMessages(entries.filter(Boolean), `import:${file}`)];
    }
    default:
      throw new Error(`Unknown format ${fmt}`);
  }
}

export function importConversations(s: Scenaria, file: string, format: ImportFormat = "auto") {
  const convs = parseImport(file, format);
  if (!s.head()) s.ensureBaseline({ agent: "import", source: "cli" });
  let total = 0;
  const sessions: string[] = [];
  for (const c of convs) {
    if (!c.messages.length) continue;
    const r = s.logMessages(
      { externalId: c.externalId, title: c.title, provider: c.provider, model: c.model, agent: c.messages[0]?.agent, source: "import" },
      c.messages,
      "history",
    );
    total += r.added.length;
    sessions.push(r.session.id);
  }
  return { conversations: sessions.length, messages: total, sessions };
}
