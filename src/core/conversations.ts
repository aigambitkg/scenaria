import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "./ids.js";
import { readJson, writeJsonAtomic, type Store } from "./store.js";
import type { ConversationMessage, ConversationSession, MessageRole, ScenariaNode, ToolCallRecord } from "./types.js";

export interface MessageInput {
  role: MessageRole;
  text: string;
  toolCalls?: ToolCallRecord[];
  toolName?: string;
  ts?: string;
  provider?: string;
  model?: string;
  agent?: string;
}

export interface SessionInput {
  /** Stable external id (Claude session id, proxy conversation hash, import id …). */
  externalId?: string;
  /** Or address an existing session directly. */
  sessionId?: string;
  title?: string;
  provider?: string;
  model?: string;
  agent?: string;
  source: ConversationSession["source"];
}

interface SessionIndex {
  counter: number;
  sessions: ConversationSession[];
}

/** Tool-call arguments are re-serialized by clients ({"a": 1} vs {"a":1}) — normalize before hashing. */
function normArgs(a?: string): string {
  if (!a) return "";
  try {
    return JSON.stringify(JSON.parse(a));
  } catch {
    return a.trim();
  }
}

export function messageHash(m: Pick<MessageInput, "role" | "text" | "toolCalls" | "toolName">): string {
  const tools = (m.toolCalls ?? []).map((t) => `${t.name}(${normArgs(t.arguments)})`).join("|");
  return createHash("sha1")
    .update(`${m.role}\0${m.text.trim()}\0${m.toolName ?? ""}\0${tools}`)
    .digest("hex")
    .slice(0, 16);
}

export function chainHash(prev: string, hash: string): string {
  return createHash("sha1").update(`${prev}>${hash}`).digest("hex").slice(0, 20);
}

/** Chain hashes for stored messages (older records may lack them: assume linear order). */
function withChains(existing: ConversationMessage[]): ConversationMessage[] {
  let prev = "";
  return existing.map((m) => {
    const chain = m.chain ?? chainHash(prev, m.hash);
    prev = chain;
    return { ...m, chain };
  });
}

const MAX_TEXT = 200_000;

/**
 * Conversation overlay: every chat turn from any provider, linked into the
 * decision tree via `headAt` (the HEAD node at the time it was said).
 * Plain JSON/JSONL under .scenaria/conversations/ (git-ignored by default).
 */
export class Conversations {
  constructor(private store: Store) {}

  private dir() {
    return this.store.path("conversations");
  }
  private indexFile() {
    return join(this.dir(), "sessions.json");
  }
  private sessionFile(id: string) {
    return join(this.dir(), `${id}.jsonl`);
  }

  private readIndex(): SessionIndex {
    const f = this.indexFile();
    if (!existsSync(f)) return { counter: 0, sessions: [] };
    try {
      return readJson<SessionIndex>(f);
    } catch {
      return { counter: 0, sessions: [] };
    }
  }

  listSessions(): ConversationSession[] {
    return this.readIndex().sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(id: string): ConversationSession {
    const s = this.readIndex().sessions.find((x) => x.id === id || x.uid === id || x.externalId === id);
    if (!s) throw new Error(`Unknown conversation "${id}"`);
    return s;
  }

  messages(sessionId: string): ConversationMessage[] {
    const f = this.sessionFile(sessionId);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ConversationMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is ConversationMessage => m !== null);
  }

  allMessages(): ConversationMessage[] {
    if (!existsSync(this.dir())) return [];
    return readdirSync(this.dir())
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => this.messages(f.replace(/\.jsonl$/, "")))
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** Messages said while `nodeId` was HEAD (the conversation that followed this state). */
  messagesAt(nodeId: string): ConversationMessage[] {
    return this.allMessages().filter((m) => m.headAt === nodeId);
  }

  /** Messages that led to `node` (said at its parent, before it was created). */
  messagesLeadingTo(node: ScenariaNode): ConversationMessage[] {
    if (!node.parentId) return [];
    return this.allMessages().filter((m) => m.headAt === node.parentId && m.ts <= node.createdAt);
  }

  /** Must be called under the store lock. */
  ensureSession(input: SessionInput): ConversationSession {
    const idx = this.readIndex();
    let s =
      (input.sessionId && idx.sessions.find((x) => x.id === input.sessionId)) ||
      (input.externalId && idx.sessions.find((x) => x.externalId === input.externalId)) ||
      undefined;
    const now = new Date().toISOString();
    if (!s) {
      idx.counter += 1;
      s = {
        id: `c${idx.counter}`,
        uid: ulid(),
        externalId: input.externalId,
        title: input.title,
        provider: input.provider,
        model: input.model,
        agent: input.agent,
        source: input.source,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
      idx.sessions.push(s);
      mkdirSync(this.dir(), { recursive: true });
      writeJsonAtomic(this.indexFile(), idx);
    }
    return s;
  }

  /**
   * Append messages. Must be called under the store lock.
   * - mode "history": `msgs` is the FULL history (chat APIs resend it every turn) → only the
   *   part after the longest matching prefix is stored.
   * - mode "append": `msgs` are new; exact repeats of the last few messages are skipped
   *   (the same turn may arrive from two sources, e.g. hook + transcript).
   */
  append(
    session: ConversationSession,
    msgs: MessageInput[],
    opts: { mode: "history" | "append"; headAt: string | null; nextId: () => string },
  ): ConversationMessage[] {
    const existing = withChains(this.messages(session.id));
    const known = new Set(existing.map((m) => m.chain!));
    const clean = msgs
      .map((m) => ({ ...m, text: String(m.text ?? "").slice(0, MAX_TEXT) }))
      .filter((m) => m.text.trim() || m.toolCalls?.length);
    const fresh: (MessageInput & { _chain: string })[] = [];
    if (opts.mode === "history") {
      // Walk the full history; a message is new if its chain (whole conversation up to it) is unknown.
      // Resends store nothing; an edited/regenerated turn stores only the divergent part, once.
      let prev = "";
      for (const m of clean) {
        const c = chainHash(prev, messageHash(m));
        if (!known.has(c)) {
          fresh.push({ ...m, _chain: c });
          known.add(c);
        }
        prev = c;
      }
    } else {
      // New messages continue the session's latest line. Only an exact repeat of the message directly
      // before it is skipped (the same turn arriving twice, e.g. hook + transcript) — a user who really
      // says "continue" again later is kept.
      let lastHash = existing.length ? existing[existing.length - 1].hash : "";
      let prev = existing.length ? existing[existing.length - 1].chain! : "";
      for (const m of clean) {
        const h = messageHash(m);
        if (h === lastHash) continue;
        const c = chainHash(prev, h);
        fresh.push({ ...m, _chain: c });
        lastHash = h;
        prev = c;
      }
    }
    if (!fresh.length) return [];
    const now = Date.now();
    const out: ConversationMessage[] = fresh.map((m, k) => ({
      id: opts.nextId(),
      uid: ulid(now + k),
      sessionId: session.id,
      role: m.role,
      text: m.text,
      toolCalls: m.toolCalls?.length ? m.toolCalls : undefined,
      toolName: m.toolName,
      provider: m.provider ?? session.provider,
      model: m.model ?? session.model,
      agent: m.agent ?? session.agent,
      ts: m.ts ?? new Date(now + k).toISOString(),
      headAt: opts.headAt,
      hash: messageHash(m),
      chain: m._chain,
    }));
    mkdirSync(this.dir(), { recursive: true });
    appendFileSync(this.sessionFile(session.id), out.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
    const idx = this.readIndex();
    const s = idx.sessions.find((x) => x.id === session.id);
    if (s) {
      s.messageCount += out.length;
      s.updatedAt = new Date().toISOString();
      if (!s.title) {
        const firstUser = [...existing, ...out].find((m) => m.role === "user");
        if (firstUser) s.title = firstUser.text.replace(/\s+/g, " ").slice(0, 80);
      }
      if (!s.model) s.model = out.find((m) => m.model)?.model;
      writeJsonAtomic(this.indexFile(), idx);
    }
    return out;
  }
}

/** Markdown rendering of messages (snapshot folders, exports). */
export function renderConversation(msgs: ConversationMessage[], maxPerMessage = 4000): string {
  if (!msgs.length) return "_No conversation recorded for this path yet._\n";
  const label: Record<string, string> = { user: "User", assistant: "Assistant", system: "System", tool: "Tool" };
  return (
    msgs
      .map((m) => {
        const head = `### ${m.id} · ${label[m.role] ?? m.role}${m.model ? ` (${m.model})` : ""} — ${m.ts.replace("T", " ").slice(0, 19)}`;
        const tools = (m.toolCalls ?? []).map((t) => `- tool call \`${t.name}\`${t.arguments ? ` ${t.arguments.slice(0, 300)}` : ""}`).join("\n");
        const text = m.text.length > maxPerMessage ? m.text.slice(0, maxPerMessage) + "\n…" : m.text;
        return [head, "", text, tools].filter((x) => x !== "").join("\n");
      })
      .join("\n\n") + "\n"
  );
}
