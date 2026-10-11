/**
 * Scenaria's own chat: talk to any model (local or API) and let it operate Scenaria with the same
 * tools an MCP agent gets — plus the relay (archivist → craftsman → oracle).
 *
 * The chat model is an agent like any other:
 *   - it can record decisions, checkpoints, tasks, propose canon — never approve canon or run
 *     check commands (those stay the person's, via buttons in the chat or the canon dialog);
 *   - rewind and fork change files, so they wait for the person's confirmation (setting);
 *   - every turn is recorded as a conversation (source "ui", agent "scenaria-chat").
 * Provider-neutral: OpenAI-compatible /chat/completions (OpenAI, Gemini, Ollama, LM Studio, Mistral,
 * OpenRouter, Groq, …) and Anthropic /v1/messages, both with tool calling.
 */
import { randomBytes } from "node:crypto";
import type { Scenaria } from "./core/engine.js";
import { resolveLlm, type LlmRequest } from "./core/analysis.js";
import { effectiveLlm, readSettings, upstreams } from "./core/settings.js";
import { runRelay } from "./core/relay.js";
import { INSTRUCTIONS, TOOLS, callTool, toolSchemas } from "./tools.js";

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Structured tool result for the dashboard (not sent to the model). */
  data?: unknown;
  ok?: boolean;
}

export interface ChatRequest {
  sessionId: string;
  messages: ChatMessage[];
  /** The person's answers to pending tool calls: id → approve | deny. */
  decisions?: Record<string, "approve" | "deny">;
  llm?: Partial<LlmRequest>;
  lang?: "de" | "en";
  user?: string;
}

export interface ChatResponse {
  messages: ChatMessage[];
  /** Tool calls that wait for the person (rewind, fork …). */
  pending: ChatToolCall[];
  model: string;
  steps: number;
  stopped?: "max_steps";
}

const RELAY_TOOL = {
  name: "scenaria_relay",
  description:
    "For high-impact decisions: ask the archivist (past), the craftsman (options) and the oracle (future canon) — three separate model calls. Returns options, which survive the fixed points, and a recommendation. With createDecision=true it records an OPEN decision; the person chooses.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "What should be decided?" },
      options: { type: "array", items: { type: "string" }, description: "Options to evaluate (optional)" },
      createDecision: { type: "boolean", description: "Record the result as an open decision" },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

const MAX_TOOL_TEXT = 8000;
const isDestructive = (name: string) => Boolean(TOOLS.find((t) => t.name === name)?.annotations?.destructiveHint);
const newId = () => `call_${randomBytes(6).toString("hex")}`;

function systemPrompt(s: Scenaria, lang: "de" | "en") {
  const head = s.store.readState().head;
  const capsule = head ? s.context(head, { budget: 1200 }).markdown : "(The project has no history yet.)";
  return `You are the Scenaria assistant inside the Scenaria dashboard. The person talks to you directly; you operate Scenaria for them with the tools (you are the "orchestrator": you coordinate, keep the main goal in view and keep the decision tree clean).

${INSTRUCTIONS}

In this chat:
- Act with tools instead of describing what you would do. Read before you change (scenaria_status, scenaria_context, scenaria_tree, scenaria_workspace).
- Canon events: you can only PROPOSE (scenaria_canon action "propose"). Approving, retiring and running check commands are the person's — tell them to use the "Approve" button that appears in the chat or the Canon dialog.
- Rewind and fork change files; the dashboard asks the person before they run. If they decline, accept it.
- For a high-impact choice, use scenaria_relay (archivist → craftsman → oracle) before deciding; let the person choose.
- Keep answers short; reference nodes as n12 and canon as k3 (the dashboard links them).
- Answer in ${lang === "de" ? "German" : "English"}.

Current state of the project:
${capsule}`;
}

// ------------------------------------------------------------------ provider formats

function openaiMessages(system: string, msgs: ChatMessage[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant")
      out.push({
        role: "assistant",
        content: m.content || (m.toolCalls?.length ? null : ""),
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.slice(0, MAX_TOOL_TEXT) });
  }
  return out;
}

function anthropicMessages(msgs: ChatMessage[]) {
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", block: any) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of msgs) {
    if (m.role === "user") push("user", { type: "text", text: m.content || "…" });
    else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      if (!m.content && !m.toolCalls?.length) push("assistant", { type: "text", text: "…" });
    } else push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content.slice(0, MAX_TOOL_TEXT), ...(m.ok === false ? { is_error: true } : {}) });
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return { __invalid: String(raw).slice(0, 200) };
  }
}

async function callModel(cfg: LlmRequest, ups: Record<string, string>, system: string, msgs: ChatMessage[]): Promise<{ message: ChatMessage; model: string }> {
  const r = resolveLlm(cfg, ups);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240_000);
  try {
    let res: Response;
    if (r.kind === "anthropic") {
      const tools = [...toolSchemas("anthropic"), { name: RELAY_TOOL.name, description: RELAY_TOOL.description, input_schema: RELAY_TOOL.parameters }];
      res = await fetch(`${r.base}${/\/v1$/.test(r.base) ? "" : "/v1"}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": r.key ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: r.model, max_tokens: 4096, system, messages: anthropicMessages(msgs), tools }),
        signal: ctrl.signal,
      });
    } else {
      const tools = [...toolSchemas("openai"), { type: "function", function: RELAY_TOOL }];
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (r.key) headers.authorization = `Bearer ${r.key}`;
      res = await fetch(`${r.base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: r.model, messages: openaiMessages(system, msgs), tools, temperature: 0.2 }),
        signal: ctrl.signal,
      });
    }
    const raw = await res.text();
    if (!res.ok) throw new Error(`${r.provider} answered HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    if (r.kind === "anthropic") {
      const blocks: any[] = Array.isArray(json.content) ? json.content : [];
      return {
        model: json.model ?? r.model,
        message: {
          role: "assistant",
          content: blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim(),
          // Our own ids (never the provider's): a model cannot reuse an id the person already approved.
          toolCalls: blocks.filter((b) => b?.type === "tool_use").map((b) => ({ id: newId(), name: String(b.name), args: parseArgs(b.input) })),
        },
      };
    }
    const m = json.choices?.[0]?.message ?? {};
    return {
      model: json.model ?? r.model,
      message: {
        role: "assistant",
        content: String(m.content ?? "").trim(),
        toolCalls: (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c: any) => ({ id: newId(), name: String(c?.function?.name ?? ""), args: parseArgs(c?.function?.arguments) })),
      },
    };
  } catch (err: any) {
    if (ctrl.signal.aborted) throw new Error(`${r.provider} did not answer within 240 s`);
    if (err?.cause?.code === "ECONNREFUSED") throw new Error(`${r.provider} not reachable at ${r.base} (is it running?)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ the loop

function sanitize(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  return input.slice(-80).flatMap((m: any): ChatMessage[] => {
    const role = m?.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") return [];
    const content = String(m?.content ?? "").slice(0, 20000);
    if (role === "tool") return [{ role, content, toolCallId: String(m?.toolCallId ?? ""), toolName: m?.toolName ? String(m.toolName) : undefined, ok: m?.ok !== false }];
    const toolCalls = role === "assistant" && Array.isArray(m?.toolCalls) ? m.toolCalls.slice(0, 12).map((c: any) => ({ id: String(c?.id ?? newId()), name: String(c?.name ?? ""), args: parseArgs(c?.args) })) : undefined;
    return [{ role, content, ...(toolCalls?.length ? { toolCalls } : {}) }];
  });
}

/**
 * Every tool call needs a result before the conversation goes on (providers reject the history
 * otherwise). Calls the person never answered — they wrote a new message instead — are closed as
 * not executed. Only the calls of the very last assistant turn can still be open.
 */
function closeAbandoned(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    let j = i + 1;
    const answered = new Set<string>();
    while (j < msgs.length && msgs[j].role === "tool") answered.add(msgs[j++].toolCallId ?? "");
    if (j >= msgs.length) continue; // last turn: handled by the loop
    for (; i + 1 < j; i++) out.push(msgs[i + 1]);
    for (const c of m.toolCalls) if (!answered.has(c.id)) out.push({ role: "tool", toolCallId: c.id, toolName: c.name, content: "Not executed: the person did not confirm it and wrote a new message instead.", ok: false });
  }
  return out;
}

/** Tool calls of the last assistant message that have no result yet. */
function openCalls(msgs: ChatMessage[]): ChatToolCall[] {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role === "tool") i--;
  const a = msgs[i];
  if (!a || a.role !== "assistant" || !a.toolCalls?.length) return [];
  const answered = new Set(msgs.slice(i + 1).map((m) => m.toolCallId));
  return a.toolCalls.filter((c) => !answered.has(c.id));
}

async function execute(s: Scenaria, call: ChatToolCall, ctx: { model: string; user?: string; lang: "de" | "en"; llm?: Partial<LlmRequest> }): Promise<ChatMessage> {
  const base = { role: "tool" as const, toolCallId: call.id, toolName: call.name };
  try {
    if ("__invalid" in call.args) throw new Error(`arguments are not valid JSON: ${call.args.__invalid}`);
    if (call.name === RELAY_TOOL.name) {
      const r = await runRelay(s, {
        question: String(call.args.question ?? ""),
        options: Array.isArray(call.args.options) ? call.args.options.map(String) : undefined,
        createDecision: call.args.createDecision === true,
        lang: ctx.lang,
        llm: ctx.llm?.apiKey ? { apiKey: ctx.llm.apiKey } : undefined,
        actor: { agent: "scenaria-chat", user: ctx.user, model: ctx.model },
      });
      const text = [
        `Relay ${r.id}${r.decisionId ? ` → open decision ${r.decisionId}` : ""}`,
        `Constraints: ${r.archivist.constraints.map((c) => c.text).join("; ") || "none"}`,
        ...r.craftsman.options.map((o) => {
          const a = r.oracle.assessments.find((x) => x.option === o.label);
          return `- ${o.label}${r.surviving.includes(o.label) ? " (survives)" : " (cut)"}: ${o.plan}${a?.risks.length ? ` · risks: ${a.risks.join("; ")}` : ""}`;
        }),
        r.oracle.recommendation ? `Oracle recommends: ${r.oracle.recommendation.option} — ${r.oracle.recommendation.why}` : "",
        ...r.warnings.map((w) => `WARNING: ${w}`),
      ].filter(Boolean);
      return { ...base, content: text.join("\n"), data: r, ok: true };
    }
    const res = callTool(s, call.name, call.args, { source: "ui", agent: "scenaria-chat", model: ctx.model, user: ctx.user });
    return { ...base, content: res.text, data: res.data, ok: true };
  } catch (err: any) {
    return { ...base, content: `Error: ${String(err?.message ?? err)}`, ok: false };
  }
}

export async function chat(s: Scenaria, req: ChatRequest): Promise<ChatResponse> {
  const sessionId = String(req.sessionId ?? "").replace(/[^\w-]/g, "").slice(0, 64) || randomBytes(8).toString("hex");
  const lang: "de" | "en" = req.lang === "en" ? "en" : "de";
  const cfg = effectiveLlm(s, "chat", req.llm);
  if (!cfg) throw new Error("No model configured — choose one in Settings.");
  const settings = readSettings(s).chat;
  const ups = upstreams(s);
  const msgs = closeAbandoned(sanitize(req.messages));
  if (!msgs.length) throw new Error("empty chat");
  // The person's answers apply only to the calls that were waiting when they answered — never to
  // calls the model makes later in this request.
  const waitingAtStart = new Set(openCalls(msgs).map((c) => c.id));
  let decisions: Record<string, "approve" | "deny"> = Object.fromEntries(Object.entries(req.decisions ?? {}).filter(([id, v]) => waitingAtStart.has(id) && (v === "approve" || v === "deny")));
  let model = cfg.model;
  let steps = 0;
  const ctx = () => ({ model, user: req.user, lang, llm: req.llm });

  const record = () => {
    try {
      const firstUser = msgs.find((m) => m.role === "user")?.content ?? "Chat";
      const title = firstUser.replace(/\s+/g, " ").trim().slice(0, 80) || "Chat";
      s.noteTask(`chat:${sessionId}`, title, firstUser.slice(0, 600), { agent: "scenaria-chat", model, user: req.user, source: "ui" });
      s.logMessages(
        { externalId: `chat:${sessionId}`, title, provider: cfg.provider, model, agent: "scenaria-chat", source: "ui" },
        msgs.map((m) => ({ role: m.role, text: m.content.slice(0, 20000), toolCalls: m.toolCalls?.map((c) => ({ name: c.name, arguments: JSON.stringify(c.args).slice(0, 2000) })), toolName: m.toolName, provider: cfg.provider, model, agent: "scenaria-chat" })),
        "history",
      );
    } catch {
      /* recording must never break the chat */
    }
  };

  /** Run open tool calls; returns the calls that still wait for the person. */
  const runOpen = async (): Promise<ChatToolCall[]> => {
    const open = openCalls(msgs);
    const waiting = open.filter((c) => settings.confirmDestructive && isDestructive(c.name) && !decisions[c.id]);
    if (waiting.length) return waiting;
    for (const c of open) {
      if (decisions[c.id] === "deny") msgs.push({ role: "tool", toolCallId: c.id, toolName: c.name, content: "The person declined this action. Do not retry it; ask what they want instead.", ok: false });
      else msgs.push(await execute(s, c, ctx()));
    }
    return [];
  };

  let pending = await runOpen();
  decisions = {};
  while (!pending.length && steps < settings.maxSteps) {
    steps++;
    const r = await callModel(cfg, ups, systemPrompt(s, lang), msgs);
    model = r.model;
    msgs.push(r.message);
    if (!r.message.toolCalls?.length) break;
    pending = await runOpen();
  }
  record();
  const stopped = !pending.length && openCalls(msgs).length === 0 && msgs[msgs.length - 1]?.role === "tool" && steps >= settings.maxSteps ? "max_steps" : undefined;
  return { messages: msgs, pending, model, steps, ...(stopped ? { stopped } : {}) };
}
