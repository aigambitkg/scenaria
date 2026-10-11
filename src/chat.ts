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
import { OLLAMA_CTX, llmTimeout, resolveLlm, type LlmRequest } from "./core/analysis.js";
import { effectiveLlm, readSettings, upstreams } from "./core/settings.js";
import { runRelay } from "./core/relay.js";
import { INSTRUCTIONS, TOOLS, callTool, toolSchemas } from "./tools.js";

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** For calls that wait for the person: what exactly will happen (computed by Scenaria, not the model). */
  summary?: string;
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

/**
 * The person's own actions, offered in the chat so everything can be controlled from here. The model
 * can only ASK for them: each one waits for the person's click ("Allow") on a card that Scenaria
 * writes from the real data — never auto-run, whatever the settings say.
 */
const PERSON_TOOLS = [
  {
    name: "scenaria_canon_decide",
    description: "Ask the person to approve, reject, retire or confirm a canon event (fixed point). The person confirms with a click; you cannot decide yourself. Check commands are never adopted here (only in the Canon dialog).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Canon id, e.g. k3" },
        action: { type: "string", enum: ["approve", "reject", "retire", "confirm"] },
        reason: { type: "string", description: "Why (shown to the person)" },
      },
      required: ["id", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "scenaria_canon_check",
    description: "Ask the person to run the approved check commands of the canon events on the current working tree (they confirm with a click).",
    parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Canon ids (default: all with a check)" } }, additionalProperties: false },
  },
  {
    name: "scenaria_gate",
    description: "Ask the person to run the canon gate: the approved checks on the snapshot of every line of work (shows which lines survive). They confirm with a click.",
    parameters: { type: "object", properties: { lines: { type: "array", items: { type: "string" }, description: "Head node ids of the lines (default: all)" } }, additionalProperties: false },
  },
  {
    name: "scenaria_analyze",
    description: "Ask the person to run the pattern analysis of the whole project with the configured model (costs tokens; they confirm with a click). For the quick health check without a model use scenaria_health.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "scenaria_expert_analysis",
    description:
      "Ask the person to run the ANALYST: a professional, fact-based expert report (architecture, goal alignment, agent workflow & context engineering, governance) with prioritised recommendations to optimise with — for the whole project, one line of work, or all their Scenaria projects. Uses the configured analyst model (they confirm with a click); noModel gives the rule-based report.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "line", "all"], description: "project (default), line (one scenario), all (every registered project)" },
        head: { type: "string", description: "For scope line: head node id of the line" },
        noModel: { type: "boolean", description: "Rule-based only (no model, no tokens)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scenaria_set_model",
    description: "Ask the person to switch the default model used by chat, analysis, archivist and relay (they confirm with a click). API keys are never set here.",
    parameters: {
      type: "object",
      properties: { provider: { type: "string", description: "ollama, lmstudio, openai, anthropic, gemini, mistral, openrouter, groq" }, model: { type: "string" } },
      required: ["provider", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "scenaria_connect_agents",
    description: "Ask the person to wire agents into this project via MCP (writes their config files; they confirm with a click).",
    parameters: {
      type: "object",
      properties: { targets: { type: "array", items: { type: "string", enum: ["claude", "cursor", "vscode", "gemini", "codex", "generic"] } } },
      required: ["targets"],
      additionalProperties: false,
    },
  },
];
const MULTIVERSE_TOOL = {
  name: "scenaria_multiverse",
  description:
    "Forecast with the multiverse (archivist = past, craftsman = present, oracle = future): for a decision node, one universe per option; or for a prompt/plan (with optional alternative wordings): will it keep the context and the main goal or lose it? Returns predicted context % per option, what each would drop, risks and a recommendation. Use it before choosing or before giving an agent a big prompt.",
  parameters: {
    type: "object",
    properties: {
      node: { type: "string", description: "Decision node id (e.g. n12)" },
      prompt: { type: "string", description: "Or: a prompt / plan to evaluate on the current line" },
      variants: { type: "array", items: { type: "string" }, description: "Alternative wordings of the prompt to compare" },
    },
    additionalProperties: false,
  },
};
const PERSON_ONLY = new Set(PERSON_TOOLS.map((t) => t.name));
const CHAT_TOOLS = [RELAY_TOOL, MULTIVERSE_TOOL, ...PERSON_TOOLS];

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
- When the person asks about the project, its state, decisions or history: call scenaria_status / scenaria_context / scenaria_tree first and answer from the result, not from these instructions.
- The person can control everything through you. Their own actions — approving/rejecting/retiring canon (scenaria_canon_decide), running checks (scenaria_canon_check), the gate (scenaria_gate), the model analysis (scenaria_analyze), the expert report to optimise with (scenaria_expert_analysis), switching the model (scenaria_set_model), connecting agents (scenaria_connect_agents) — you request with these tools; the dashboard shows the person a card and runs it only after their click. New canon: propose it with scenaria_canon action "propose" and then request its approval with scenaria_canon_decide.
- The main goal: set it with scenaria_start_mission {projectGoal} when the person states it.
- Rewind and fork change files; the dashboard asks the person before they run. If they decline, accept it.
- Before an open decision is chosen, or before a big prompt/plan goes to an agent: forecast it with scenaria_multiverse (or quickly with scenaria_forecast) and show the person which option keeps the context and the main goal. For a new high-impact question without options, use scenaria_relay. The person chooses.
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

const KNOWN = () => new Set([...TOOLS.map((t) => t.name), ...CHAT_TOOLS.map((t) => t.name)]);

/** `<tool_call>{"name": …, "arguments": {…}}</tool_call>` or a JSON block naming a known tool. */
export function textToolCalls(content: string): { calls: ChatToolCall[]; rest: string } {
  const known = KNOWN();
  const calls: ChatToolCall[] = [];
  let rest = content;
  const take = (raw: string, whole: string) => {
    try {
      const v = JSON.parse(raw.trim());
      for (const c of Array.isArray(v) ? v : [v]) {
        const name = String(c?.name ?? c?.function?.name ?? c?.tool ?? "");
        if (!known.has(name)) continue;
        calls.push({ id: newId(), name, args: parseArgs(c?.arguments ?? c?.function?.arguments ?? c?.parameters ?? c?.input ?? {}) });
        rest = rest.replace(whole, "");
      }
    } catch {
      /* not a tool call */
    }
  };
  for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) take(m[1], m[0]);
  // A fenced JSON block counts only when it IS the answer (not an example inside an explanation).
  if (!calls.length) {
    const blocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    const outside = blocks.reduce((t, m) => t.replace(m[0], ""), content).trim();
    if (blocks.length && outside.length < 200) for (const m of blocks) take(m[1], m[0]);
  }
  return { calls: calls.slice(0, 8), rest: rest.trim() };
}

/** Reasoning models (qwen3, deepseek-r1 …) may put their thinking into the answer text. */
function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
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

/** Ollama's native chat format (tool arguments as objects, tool results named). */
function ollamaMessages(system: string, msgs: ChatMessage[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of msgs) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.content ?? "", ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })) } : {}) });
    else out.push({ role: "tool", content: m.content.slice(0, MAX_TOOL_TEXT), ...(m.toolName ? { tool_name: m.toolName } : {}) });
  }
  return out;
}

async function callModel(cfg: LlmRequest, ups: Record<string, string>, system: string, msgs: ChatMessage[]): Promise<{ message: ChatMessage; model: string }> {
  const r = resolveLlm(cfg, ups);
  const ctrl = new AbortController();
  const limit = llmTimeout(r);
  const timer = setTimeout(() => ctrl.abort(), limit);
  try {
    let res: Response;
    if (r.kind === "anthropic") {
      const tools = [...toolSchemas("anthropic"), ...CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))];
      res = await fetch(`${r.base}${/\/v1$/.test(r.base) ? "" : "/v1"}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": r.key ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: r.model, max_tokens: 4096, system, messages: anthropicMessages(msgs), tools }),
        signal: ctrl.signal,
      });
    } else if (r.kind === "ollama") {
      const tools = [...toolSchemas("openai"), ...CHAT_TOOLS.map((t) => ({ type: "function", function: t }))];
      res = await fetch(`${r.nativeBase}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: r.model, messages: ollamaMessages(system, msgs), tools, stream: false, options: { num_ctx: OLLAMA_CTX(), temperature: 0.2 } }),
        signal: ctrl.signal,
      });
    } else {
      const tools = [...toolSchemas("openai"), ...CHAT_TOOLS.map((t) => ({ type: "function", function: t }))];
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
          content: stripThinking(blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim()),
          // Our own ids (never the provider's): a model cannot reuse an id the person already approved.
          toolCalls: blocks.filter((b) => b?.type === "tool_use").map((b) => ({ id: newId(), name: String(b.name), args: parseArgs(b.input) })),
        },
      };
    }
    const m = (r.kind === "ollama" ? json.message : json.choices?.[0]?.message) ?? {};
    let content = String(m.content ?? "").trim();
    let toolCalls: ChatToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c: any) => ({ id: newId(), name: String(c?.function?.name ?? ""), args: parseArgs(c?.function?.arguments) }));
    // Small local models sometimes write the tool call as text instead of using the API field.
    if (!toolCalls.length) {
      const t = textToolCalls(content);
      if (t.calls.length) {
        toolCalls = t.calls;
        content = t.rest;
      }
    }
    return { model: json.model ?? r.model, message: { role: "assistant", content: stripThinking(content), toolCalls } };
  } catch (err: any) {
    if (ctrl.signal.aborted) throw new Error(`${r.provider} did not answer within ${Math.round(limit / 1000)} s`);
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
        llm: ctx.llm,
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
    if (call.name === MULTIVERSE_TOOL.name) {
      const { forecast } = await import("./core/forecast.js");
      const f = await forecast(s, { node: call.args.node ? String(call.args.node) : undefined, prompt: call.args.prompt ? String(call.args.prompt) : undefined, variants: Array.isArray(call.args.variants) ? call.args.variants.map(String) : undefined, lang: ctx.lang, llm: ctx.llm, trigger: "chat" });
      const text = [
        `Forecast ${f.id} (${f.mode}) — ${f.subject.kind === "decision" ? `${f.subject.node}: ${f.subject.question}` : "prompt"}`,
        ...f.options.map((o) => `- ${o.key} ${o.label}: context ${o.score}%${o.universe ? ` (goal ${o.universe.goal}%, confidence ${Math.round(o.universe.confidence * 100)}%) → ${o.universe.outcome}${o.universe.loses.length ? ` · would drop: ${o.universe.loses.join("; ")}` : ""}${o.universe.risks.length ? ` · risks: ${o.universe.risks.join("; ")}` : ""}` : ""}${o.quick.warnings.length ? ` · lessons: ${o.quick.warnings.join("; ")}` : ""}`),
        f.recommended ? `Recommended: ${f.recommended.key} — ${f.recommended.why}` : "",
        ...f.warnings.map((w) => `WARNING: ${w}`),
      ].filter(Boolean);
      return { ...base, content: text.join("\n"), data: f, ok: true };
    }
    if (PERSON_ONLY.has(call.name)) {
      const r = await personAction(s, call, ctx);
      return { ...base, ...r, ok: true };
    }
    const res = callTool(s, call.name, call.args, { source: "ui", agent: "scenaria-chat", model: ctx.model, user: ctx.user });
    return { ...base, content: res.text, data: res.data, ok: true };
  } catch (err: any) {
    return { ...base, content: `Error: ${String(err?.message ?? err)}`, ok: false };
  }
}

const strList = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 40) : undefined);

/** Runs ONLY after the person clicked "Allow" on the card for exactly this call. */
async function personAction(s: Scenaria, call: ChatToolCall, ctx: { model: string; user?: string; lang: "de" | "en"; llm?: Partial<LlmRequest> }): Promise<{ content: string; data?: unknown }> {
  const by = `${ctx.user ?? "person"} (chat, confirmed)`;
  const a = call.args;
  switch (call.name) {
    case "scenaria_canon_decide": {
      const action = String(a.action);
      if (!["approve", "reject", "retire", "confirm"].includes(action)) throw new Error("action must be approve, reject, retire or confirm");
      const ev = s.decideCanon(String(a.id ?? ""), action as any, { user: by, via: "chat", reason: a.reason ? String(a.reason) : undefined, adoptCheck: false });
      return { content: `${ev.id} is now ${ev.status}${action === "confirm" ? " (confirmed as met)" : ""}: ${ev.text}`, data: ev };
    }
    case "scenaria_canon_check": {
      const r = await s.checkCanon(strList(a.ids), by);
      return { content: r.length ? r.map((x) => `${x.id}: ${x.status} — ${x.detail}`).join("\n") : "No approved canon event has a check command.", data: r };
    }
    case "scenaria_gate": {
      const { runGate, gateMatrix } = await import("./core/gate.js");
      await runGate(s, { lines: strList(a.lines), by });
      const m = gateMatrix(s);
      return { content: m.rows.map((r) => `${r.head} (${r.scenario}${r.current ? ", current" : ""}): ${r.verdict}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}`).join("\n") || "No lines of work.", data: m };
    }
    case "scenaria_analyze": {
      const { runAnalysis } = await import("./core/analysis.js");
      const rec = await runAnalysis(s, { lang: ctx.lang, apiKey: ctx.llm?.apiKey, keyFor: ctx.llm?.keyFor });
      const i = rec.insights;
      return { content: [`Analysis ${rec.id} (health ${rec.health}/100)`, i.summary ?? "", ...(i.issues ?? []).slice(0, 6).map((x) => `! ${x.title}`), ...(i.rules ?? []).slice(0, 4).map((r) => `rule: ${r.text}`)].filter(Boolean).join("\n"), data: rec };
    }
    case "scenaria_expert_analysis": {
      const { expertAnalysis } = await import("./core/expert.js");
      const scope = a.scope === "all" || a.scope === "line" ? a.scope : "project";
      const r = await expertAnalysis(s, { scope, head: a.head ? String(a.head) : undefined, lang: ctx.lang, noModel: Boolean(a.noModel), llm: { apiKey: ctx.llm?.apiKey, keyFor: ctx.llm?.keyFor } });
      return {
        content: [
          `Expert analysis ${r.id} (${r.scope.kind}, ${r.model ?? "rule-based"}) — maturity ${r.maturity.score}/100 (${r.maturity.level})`,
          r.summary,
          ...r.findings.slice(0, 6).map((f) => `! [${f.severity}/${f.lens}] ${f.title}${f.verified ? "" : " (unverified)"}${f.evidence.length ? ` — ${f.evidence.join(", ")}` : ""}`),
          ...r.recommendations.slice(0, 5).map((x) => `→ ${x.priority} ${x.title}: ${x.action}`),
          "Full report: dashboard → Analyse → Experten-Analyse.",
        ].join("\n"),
        data: { id: r.id, maturity: r.maturity, findings: r.findings.length, recommendations: r.recommendations.length },
      };
    }
    case "scenaria_set_model": {
      const { writeSettings, readSettings } = await import("./core/settings.js");
      const cur = readSettings(s).llm;
      writeSettings({ llm: { default: { provider: String(a.provider ?? ""), model: String(a.model ?? "") }, roles: cur.roles as any } });
      s.store.appendEvent({ type: "update", data: { message: `default model set to ${a.provider}/${a.model} by ${by}` } });
      return { content: `Default model is now ${a.provider}/${a.model} (from the next message on).` };
    }
    case "scenaria_connect_agents": {
      const { setupAgents, agentStatus, TARGETS } = await import("./setup.js");
      const targets = (strList(a.targets) ?? []).filter((t) => (TARGETS as readonly string[]).includes(t)) as any[];
      if (!targets.length) throw new Error("no known agent target");
      const r = setupAgents(s.root, targets, { rulesFiles: true });
      s.store.appendEvent({ type: "update", data: { message: `agents connected by ${by}: ${targets.join(", ")}` } });
      return { content: [...r.changes, ...r.notes].join("\n") || "Nothing to change.", data: { ...r, agents: agentStatus(s.root) } };
    }
  }
  throw new Error(`unknown action ${call.name}`);
}

/** What a waiting call will do — written by Scenaria from the real data, shown on the person's card. */
function describe(s: Scenaria, call: ChatToolCall, lang: "de" | "en"): string {
  const de = lang === "de";
  const a = call.args;
  try {
    switch (call.name) {
      case "scenaria_rewind": {
        const n = s.node(String(a.id));
        return de ? `Zurückspulen zu ${n.id} „${n.title}“${a.restoreFiles === false ? " (nur Entscheidungsstand, Dateien bleiben)" : " – Dateien werden auf diesen Stand gesetzt (vorher automatisch gesichert)"}` : `Rewind to ${n.id} "${n.title}"${a.restoreFiles === false ? " (decision state only)" : " — files are restored to it (autosaved first)"}`;
      }
      case "scenaria_fork": {
        const n = s.node(String(a.decisionId));
        return de ? `Alternative „${String(a.option)}“ der Entscheidung ${n.id} „${n.question ?? n.title}“ erkunden – Dateien werden auf deren Stand gesetzt` : `Explore option "${String(a.option)}" of decision ${n.id} "${n.question ?? n.title}" — files are restored to it`;
      }
      case "scenaria_canon_decide": {
        const ev = s.canon().find((e) => e.id === String(a.id));
        if (!ev) return de ? `Unbekannter Kanon-Eintrag ${String(a.id)}` : `Unknown canon event ${String(a.id)}`;
        const verb = de ? { approve: "freigeben", reject: "ablehnen", retire: "ausmustern", confirm: "als erfüllt bestätigen" } : { approve: "approve", reject: "reject", retire: "retire", confirm: "confirm as met" };
        const cmd = ev.check ?? ev.suggestedCheck;
        return `${ev.id} ${(verb as any)[String(a.action)] ?? String(a.action)}: „${ev.text}“ (${ev.kind}, ${ev.hard ? (de ? "hart" : "hard") : de ? "weich" : "soft"})${cmd && a.action === "approve" ? (de ? ` – Prüfbefehl wird NICHT übernommen (nur im Kanon-Dialog): ${cmd}` : ` — check command NOT adopted (Canon dialog only): ${cmd}`) : ""}`;
      }
      case "scenaria_canon_check": {
        const evs = s.canon().filter((e) => e.status === "active" && e.check && (!strList(a.ids)?.length || strList(a.ids)!.includes(e.id)));
        return (de ? "Prüfbefehle im Projektordner ausführen: " : "Run check commands in the project folder: ") + (evs.map((e) => `${e.id}: ${e.check}`).join(" · ") || (de ? "(keine)" : "(none)"));
      }
      case "scenaria_gate": {
        const evs = s.canon().filter((e) => e.status === "active" && e.check);
        return (de ? "Gate: Prüfbefehle auf dem Snapshot jeder Arbeitslinie ausführen (temporäre Kopien): " : "Gate: run the check commands on every line's snapshot (temporary copies): ") + (evs.map((e) => `${e.id}: ${e.check}`).join(" · ") || (de ? "(keine Prüfbefehle)" : "(no check commands)"));
      }
      case "scenaria_analyze":
        return de ? "Muster-Analyse des ganzen Projekts mit dem eingestellten Modell (verbraucht Token)" : "Pattern analysis of the whole project with the configured model (uses tokens)";
      case "scenaria_expert_analysis": {
        const sc = a.scope === "all" ? (de ? "alle registrierten Projekte" : "all registered projects") : a.scope === "line" ? `${de ? "Arbeitslinie bis" : "line up to"} ${String(a.head ?? "HEAD")}` : de ? "ganzes Projekt" : "whole project";
        return a.noModel ? (de ? `Experten-Analyse (regelbasiert, ohne Modell): ${sc}` : `Expert analysis (rule-based, no model): ${sc}`) : de ? `Experten-Analyse mit dem Analyst-Modell (verbraucht Token): ${sc}` : `Expert analysis with the analyst model (uses tokens): ${sc}`;
      }
      case "scenaria_set_model":
        return de ? `Standardmodell wechseln zu ${String(a.provider)}/${String(a.model)}` : `Switch the default model to ${String(a.provider)}/${String(a.model)}`;
      case "scenaria_connect_agents":
        return (de ? "Agenten per MCP verbinden (schreibt deren Konfigurationsdateien): " : "Connect agents via MCP (writes their config files): ") + (strList(a.targets) ?? []).join(", ");
    }
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  return call.name;
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
  // A session key typed for the chat's provider is never handed to another provider's role model.
  const ctx = () => ({ model, user: req.user, lang, llm: req.llm?.apiKey ? { ...req.llm, keyFor: req.llm.keyFor ?? cfg.provider } : req.llm });

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
    // The person's own actions always wait for their click; rewind/fork per setting.
    const waiting = open.filter((c) => (PERSON_ONLY.has(c.name) || (settings.confirmDestructive && isDestructive(c.name))) && !decisions[c.id]);
    if (waiting.length) return waiting.map((c) => ({ ...c, summary: describe(s, c, lang) }));
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
