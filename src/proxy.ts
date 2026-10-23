/**
 * Universal LLM proxy — the provider-independent conversation overlay.
 *
 * Point any client's base URL at Scenaria and keep using your own API key:
 *   OpenAI-compatible:  http://127.0.0.1:4477/proxy/<provider>   (openai, ollama, mistral, groq, openrouter, gemini, …)
 *   Anthropic:          http://127.0.0.1:4477/proxy/anthropic
 * Every request/response is forwarded unchanged (streaming included). Scenaria records
 * the conversation (deduplicated, linked to the current decision-tree node) and, after
 * each answer, checkpoints the project if files changed. API keys are never stored.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scenaria } from "./core/engine.js";
import { DEFAULT_PROXY } from "./core/engine.js";
import type { MessageInput } from "./core/conversations.js";
import { applyBlocks } from "./core/blocks.js";
import { recordWindowEvents, windowKeyFor } from "./core/window.js";
import { contextAdvice, cutIfDue } from "./core/windowact.js";

type ApiKind = "openai-chat" | "openai-responses" | "anthropic" | "other";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "cookie",
  "origin",
  "referer",
  "proxy-authorization",
  "proxy-connection",
]);

/** Response headers we never pass back (cookies/CORS of the provider must not apply to Scenaria's origin). */
const BLOCKED_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "set-cookie2"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : ["text", "input_text", "output_text"].includes(c?.type) ? c.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function apiKind(path: string, provider: string): ApiKind {
  if (/\/messages$/.test(path) && provider === "anthropic") return "anthropic";
  if (/chat\/completions$/.test(path)) return "openai-chat";
  if (/\/responses$/.test(path)) return "openai-responses";
  return "other";
}

/** Normalize a request body into chat messages. */
export function requestMessages(kind: ApiKind, body: any): MessageInput[] {
  if (!body || typeof body !== "object") return [];
  if (kind === "openai-chat") {
    return (Array.isArray(body.messages) ? body.messages : []).map((m: any) => ({
      role: (["system", "developer"].includes(m.role) ? "system" : m.role === "tool" || m.role === "function" ? "tool" : m.role === "assistant" ? "assistant" : "user") as MessageInput["role"],
      text: textOf(m.content),
      toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.map((t: any) => ({ name: t.function?.name ?? "tool", arguments: t.function?.arguments })) : undefined,
      toolName: m.name,
    }));
  }
  if (kind === "openai-responses") {
    const out: MessageInput[] = [];
    if (typeof body.instructions === "string") out.push({ role: "system", text: body.instructions });
    if (typeof body.input === "string") out.push({ role: "user", text: body.input });
    else if (Array.isArray(body.input)) {
      for (const it of body.input) {
        if (it?.role) out.push({ role: it.role === "assistant" ? "assistant" : it.role === "system" || it.role === "developer" ? "system" : "user", text: textOf(it.content) });
        else if (it?.type === "function_call_output") out.push({ role: "tool", text: String(it.output ?? "").slice(0, 4000) });
      }
    }
    return out;
  }
  if (kind === "anthropic") {
    const out: MessageInput[] = [];
    const sys = typeof body.system === "string" ? body.system : textOf(body.system);
    if (sys) out.push({ role: "system", text: sys });
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
      const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      const toolCalls = blocks.filter((b: any) => b?.type === "tool_use").map((b: any) => ({ name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
      const results = blocks.filter((b: any) => b?.type === "tool_result");
      if (text || toolCalls.length) out.push({ role: m.role === "assistant" ? "assistant" : "user", text, toolCalls });
      for (const r of results) out.push({ role: "tool", text: textOf(r.content).slice(0, 4000) });
    }
    return out;
  }
  return [];
}

/** Assistant message from a non-streaming JSON response. */
export function responseMessage(kind: ApiKind, json: any): MessageInput | null {
  if (!json || typeof json !== "object") return null;
  if (kind === "openai-chat") {
    const m = json.choices?.[0]?.message;
    if (!m) return null;
    return {
      role: "assistant",
      text: textOf(m.content),
      toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.map((t: any) => ({ name: t.function?.name ?? "tool", arguments: t.function?.arguments })) : undefined,
      model: json.model,
    };
  }
  if (kind === "openai-responses") {
    const items: any[] = Array.isArray(json.output) ? json.output : [];
    const text = items.filter((i) => i.type === "message").map((i) => textOf(i.content)).join("\n");
    const toolCalls = items.filter((i) => i.type === "function_call").map((i) => ({ name: i.name, arguments: i.arguments }));
    return text || toolCalls.length ? { role: "assistant", text, toolCalls, model: json.model } : null;
  }
  if (kind === "anthropic") {
    const blocks: any[] = Array.isArray(json.content) ? json.content : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
    return text || toolCalls.length ? { role: "assistant", text, toolCalls, model: json.model } : null;
  }
  return null;
}

/** Reassemble the assistant message from server-sent events. */
export function streamMessage(kind: ApiKind, sse: string): MessageInput | null {
  let text = "";
  let model: string | undefined;
  const tools = new Map<number, { name: string; arguments: string }>();
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (kind === "openai-chat") {
      model ??= ev.model;
      const d = ev.choices?.[0]?.delta;
      if (typeof d?.content === "string") text += d.content;
      for (const tc of d?.tool_calls ?? []) {
        const cur = tools.get(tc.index ?? 0) ?? { name: "", arguments: "" };
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        tools.set(tc.index ?? 0, cur);
      }
    } else if (kind === "anthropic") {
      if (ev.type === "message_start") model ??= ev.message?.model;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") tools.set(ev.index, { name: ev.content_block.name, arguments: "" });
      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") text += ev.delta.text;
        if (ev.delta?.type === "input_json_delta") {
          const cur = tools.get(ev.index);
          if (cur) cur.arguments += ev.delta.partial_json ?? "";
        }
      }
    } else if (kind === "openai-responses") {
      if (ev.type === "response.output_text.delta") text += ev.delta ?? "";
      if (ev.type === "response.completed") model ??= ev.response?.model;
    }
  }
  const toolCalls = [...tools.values()].filter((t) => t.name);
  return text || toolCalls.length ? { role: "assistant", text, toolCalls: toolCalls.length ? toolCalls : undefined, model } : null;
}

/**
 * Batch E3a-1: the tokens of the request as the provider counted them (what is in the context window), from a JSON
 * answer or a stream. Anthropic: input + cache write + cache read. OpenAI chat (and Ollama, Mistral … in that format):
 * `prompt_tokens` (streams only carry it with `stream_options.include_usage`). OpenAI responses: `input_tokens`.
 * Null when the answer carries no usage.
 */
export function usageTokens(kind: ApiKind, payload: string, isStream: boolean): number | null {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
  const anth = (u: any) => {
    if (!u || typeof u !== "object" || n(u.input_tokens) === null) return null;
    return (n(u.input_tokens) ?? 0) + (n(u.cache_creation_input_tokens) ?? 0) + (n(u.cache_read_input_tokens) ?? 0);
  };
  const fromJson = (j: any): number | null => {
    if (!j || typeof j !== "object") return null;
    if (kind === "anthropic") return anth(j.usage);
    if (kind === "openai-chat") return n(j.usage?.prompt_tokens);
    if (kind === "openai-responses") return n(j.usage?.input_tokens);
    return null;
  };
  if (!isStream) {
    try {
      return fromJson(JSON.parse(payload));
    } catch {
      return null;
    }
  }
  let found: number | null = null;
  for (const line of payload.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (kind === "anthropic") {
      // message_start carries the input side; a later message_delta may repeat it (then it wins).
      const v = ev.type === "message_start" ? anth(ev.message?.usage) : ev.type === "message_delta" ? anth(ev.usage) : null;
      if (v) found = v;
    } else if (kind === "openai-chat") {
      const v = n(ev.usage?.prompt_tokens);
      if (v) found = v;
    } else if (kind === "openai-responses" && ev.type === "response.completed") {
      const v = n(ev.response?.usage?.input_tokens);
      if (v) found = v;
    }
  }
  return found;
}

/** The id of an OpenAI Responses answer: a later request names it in `previous_response_id` (same conversation). */
export function responseId(kind: ApiKind, payload: string, isStream: boolean): string | null {
  if (kind !== "openai-responses") return null;
  const ok = (x: unknown) => (typeof x === "string" && /^[\w-]{1,100}$/.test(x) ? x : null);
  if (!isStream) {
    try {
      return ok(JSON.parse(payload)?.id);
    } catch {
      return null;
    }
  }
  for (const line of payload.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim());
      if (ev?.type === "response.completed") return ok(ev.response?.id);
    } catch {
      /* not an event */
    }
  }
  return null;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Stable conversation id: explicit header, else hash of the opening of the conversation. */
export function conversationKey(provider: string, msgs: MessageInput[], explicit?: string): string {
  if (explicit) return `proxy:${explicit}`;
  const sys = msgs.find((m) => m.role === "system")?.text ?? "";
  const firstUser = msgs.find((m) => m.role === "user")?.text ?? "";
  return `proxy:${provider}:${createHash("sha1").update(`${sys}\0${firstUser}`).digest("hex").slice(0, 12)}`;
}

export async function handleProxy(
  s: Scenaria,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
  opts: { allowUpstreamOverride?: boolean } = {},
) {
  const m = url.pathname.match(/^\/proxy\/([\w.-]+)(\/.*)?$/);
  if (!m) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "use /proxy/<provider>/…" }));
  }
  const provider = m[1];
  const rest = m[2] ?? "/";
  const upstreams = { ...DEFAULT_PROXY.upstreams, ...(s.config().proxy?.upstreams ?? {}) } as Record<string, string>;
  // In team mode only configured upstreams are allowed (no server-side request forgery via headers).
  const override = opts.allowUpstreamOverride === false ? undefined : header(req, "x-scenaria-upstream");
  const base = override ?? (Object.prototype.hasOwnProperty.call(upstreams, provider) ? upstreams[provider] : undefined);
  if (!base) {
    res.writeHead(400, { "content-type": "application/json" });
    const hint = opts.allowUpstreamOverride === false ? "" : " or send the x-scenaria-upstream header";
    return res.end(JSON.stringify({ error: `Unknown provider "${provider}". Configure proxy.upstreams.${provider} in .scenaria/config.json${hint}.` }));
  }
  const target = base.replace(/\/+$/, "") + rest + url.search;
  const kind = req.method === "POST" ? apiKind(rest, provider) : "other";

  let body: any = null;
  if (kind !== "other" && rawBody.length) {
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      body = null;
    }
  }
  const agent = header(req, "x-scenaria-agent") ?? `proxy:${provider}`;
  const model: string | undefined = body?.model;
  const reqMsgs = body ? requestMessages(kind, body) : [];
  const sessionInfo = reqMsgs.length
    ? { externalId: conversationKey(provider, reqMsgs, header(req, "x-scenaria-session")), provider, model, agent, source: "proxy" as const }
    : null;
  // Each conversation is one task on the project line (created with its first real node).
  const firstUser = reqMsgs.find((x) => x.role === "user")?.text ?? "Conversation";
  const task = sessionInfo ? { key: sessionInfo.externalId, title: firstUser.replace(/\s+/g, " ").trim().slice(0, 80) || "Conversation", goal: firstUser.slice(0, 600) } : undefined;
  // Record the request side first — even if the provider call fails, the user's turn is kept.
  if (sessionInfo) {
    try {
      // First contact creates the project root (snapshot = state before the answer) and remembers the task.
      s.noteTask(task!.key, task!.title, task!.goal, { agent, model, source: "api" });
      s.logMessages(sessionInfo, reqMsgs.map((x) => ({ ...x, provider, model, agent })), "history");
    } catch {
      /* recording must never break the call */
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || k.startsWith("x-scenaria")) continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }
  headers["accept-encoding"] = "identity";

  // Cancel the provider call when the client goes away (an LLM keeps generating — and billing — otherwise).
  const abort = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) abort.abort();
  });
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(rawBody),
      redirect: "manual",
      signal: abort.signal,
    });
  } catch (err: any) {
    if (abort.signal.aborted) return;
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `Upstream ${base} not reachable: ${err?.message ?? err}` }));
  }

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    // x-scenaria-*: only Scenaria sets these towards the client (an upstream cannot pass off a zone).
    if (!BLOCKED_RESPONSE.has(k) && !k.startsWith("access-control-") && !k.startsWith("x-scenaria-")) outHeaders[k] = v;
  });
  // E3a-2: the conversation's window as measured after its previous answer (the headers go out before this answer
  // is complete). Only from the yellow zone on and only for a checked measurement; the answer's body is never touched.
  // The window's key: a Responses call that names an earlier answer (previous_response_id) belongs to that
  // conversation, exactly as recordWindowEvents files it (review M2).
  const prevResponse = typeof body?.previous_response_id === "string" ? body.previous_response_id.slice(0, 100) : "";
  const windowKey = sessionInfo ? windowKeyFor(s, { source: "proxy", key: sessionInfo.externalId, agent, ...(prevResponse ? { continues: `r:${prevResponse}` } : {}) }) : "";
  if (sessionInfo && kind !== "other" && !override) {
    const adv = contextAdvice(s, windowKey);
    if (adv) {
      outHeaders["x-scenaria-context-zone"] = adv.zone;
      outHeaders["x-scenaria-context-fill"] = String(adv.fill);
      outHeaders["x-scenaria-context-window"] = adv.window.id;
    }
  }
  res.writeHead(upstream.status, outHeaders);

  const decoder = new TextDecoder();
  let captured = "";
  const capture = kind !== "other" && upstream.ok;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    const IDLE_MS = 10 * 60_000;
    try {
      for (;;) {
        let idle: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => {
            idle = setTimeout(() => rej(new Error("upstream idle timeout")), IDLE_MS);
          }),
        ]).finally(() => clearTimeout(idle));
        if (chunk.done) break;
        // Backpressure: wait until the client has taken the data.
        if (!res.write(chunk.value)) await new Promise<void>((r) => (res.writableEnded || res.destroyed ? r() : res.once("drain", () => r()).once("close", () => r())));
        if (res.destroyed) {
          abort.abort();
          break;
        }
        if (capture && captured.length < 5_000_000) captured += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      abort.abort();
      try {
        await reader.cancel();
      } catch {}
    }
  }
  finished = true;
  res.end();
  if (res.destroyed && !captured) return;

  if (!capture || !sessionInfo) return;
  try {
    const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    let answer: MessageInput | null = null;
    if (isStream) answer = streamMessage(kind, captured);
    else {
      try {
        answer = responseMessage(kind, JSON.parse(captured));
      } catch {
        answer = null;
      }
    }
    // Batch E3a-1: how full this conversation's context window is, as the provider counted it.
    try {
      const tokens = usageTokens(kind, captured, isStream);
      // Only from a configured provider: an upstream named by the client itself could report any number (review 2, N4).
      if (tokens && !override) {
        const at = new Date().toISOString();
        const rid = responseId(kind, captured, isStream);
        recordWindowEvents(s, { source: "proxy", key: sessionInfo.externalId, agent, ...(prevResponse ? { continues: `r:${prevResponse}` } : {}) }, [
          { kind: "sample", at, tokens, model: answer?.model ?? model, ref: rid ? `r:${rid}` : `p:${at}:${randomUUID().slice(0, 8)}` },
        ]);
      }
    } catch {
      /* measuring must never break the call */
    }
    // E3a-2: an answer is the end of a turn — from orange on, a cut checkpoint (once per zone and window).
    if (!override) cutIfDue(s, windowKey, "answer", { task, source: "api" });
    if (answer) {
      // Stored in the lineage of THIS request: a regenerated answer becomes a sibling, not a duplicate.
      s.logMessages(
        sessionInfo,
        [...reqMsgs.map((x) => ({ ...x, provider, model, agent })), { ...answer, provider, model: answer.model ?? model, agent }],
        "history",
      );
    }
    // Decisions the model wrote as ```scenaria blocks (chat prompt) → decision nodes.
    if (answer?.text?.includes("```scenaria")) applyBlocks(s, answer.text, { agent, model: answer.model ?? model, source: "api" }, task);
    const cfg = { ...DEFAULT_PROXY, ...(s.config().proxy ?? {}) };
    if (cfg.autoCheckpoint && s.repo) {
      const lastUser = [...reqMsgs].reverse().find((x) => x.role === "user")?.text;
      s.autoCheckpoint({ agent, model: answer?.model ?? model, source: "api" }, lastUser, task);
    }
  } catch {
    /* recording must never break the call */
  }
}
