import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";

function defaultUserName() {
  try {
    return process.env.SCENARIA_USER || userInfo().username || "local user";
  } catch {
    return "local user";
  }
}
import { Scenaria } from "./core/engine.js";
import { callTool, toolSchemas, type SchemaFormat, type ToolContext } from "./tools.js";
import { handleProxy } from "./proxy.js";
import { UI_DIR, embeddedUi, hasDiskUi } from "./assets.js";
import { agentPrompt, type PromptKind } from "./core/prompts.js";
import { applyBlocks } from "./core/blocks.js";
import { recall } from "./core/recall.js";
import { SECTIONS, checkExpectations, resolveRefs, stringPayload, workspace, type Section } from "./core/workspace.js";
import { archivistProposals } from "./core/canon-llm.js";
import { gateMatrix, runGate } from "./core/gate.js";
import { effectiveLlm, listModels, readSettings, upstreams, writeSettings } from "./core/settings.js";
import { listRelays, runRelay } from "./core/relay.js";
import { benchmarkInWorker, calibrationFor, forecastQuality } from "./core/predict.js";
import { autoBudget, evaluateForecasts, forecast, listForecasts, markUsed, openWithoutForecast, quickDecision, quickPrompt } from "./core/forecast.js";
import { auditForecast, auditOverview, auditReportMarkdown, deepAudit, listOracleBacktests, oracleBacktest, oracleQuality, pastDecisions } from "./core/auditor.js";
import { chat } from "./chat.js";
import { TARGETS, agentStatus, connectionSnippets, setupAgents, type Target } from "./setup.js";
import { callLlm } from "./core/analysis.js";
import { adoptRecommendation, expertAnalysis, factSheet, getReport, listPersonalReports, listReports } from "./core/expert.js";
import { forgetProject, listProjects, registerProject } from "./core/projects.js";
import { acceptRule, analysisPrompt, dossier, importAnalysis, listAnalyses, projectMetrics, runAnalysis } from "./core/analysis.js";

export const VERSION = "0.9.0";

const KEY_ENVS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "AZURE_OPENAI_API_KEY"];

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined;
}

/** OpenAI-style tool calls deliver arguments as a JSON string. */
function parseArgs(a: unknown): unknown {
  if (typeof a === "string") {
    try {
      return JSON.parse(a);
    } catch {
      throw new Error("arguments is not valid JSON");
    }
  }
  return a;
}

const here = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Reveal a folder in Finder / Explorer / the file manager (local mode only). */
function openPath(path: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [path], { stdio: "ignore", detached: true }).unref();
  } catch {}
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function safeHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK.has(name.toLowerCase());
}

export interface AppOptions {
  /** Shared secret for team/server mode. Required when listening on a non-loopback host. */
  token?: string;
  /**
   * Binding canon decisions (approve, reject, retire, confirm, add, run checks) need an approval
   * session: a cookie the server sets only when the approval link is opened. Local mode: the link
   * carries `approvalCode` (opened by `scenaria start/ui`, printed only in that terminal).
   * Team mode: the link carries `approverToken` (a separate secret); without it, approvals over HTTP are off.
   */
  approvalCode?: string;
  approverToken?: string;
  /** For tests: fixed session secret. */
  approvalSecret?: string;
  /** Automatic multiverse forecasts for open decisions (default: per the person's Settings). */
  autoForecast?: boolean;
  /** Shared between the apps of one server when the person switches projects (single-use link state). */
  linkState?: { secret?: string };
  /** The server can switch the dashboard to another of the person's projects (local mode only). */
  onSwitch?: (root: string) => Promise<{ name: string; root: string }>;
  /** The project agents' HTTP/proxy endpoints of this server stay on (the one it was started with). */
  agentsProject?: { name: string; root: string };
}

function approvalCookie(req: IncomingMessage): string | undefined {
  const m = (req.headers.cookie ?? "").match(/(?:^|;\s*)scenaria_approval=([^;]+)/);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  // Compare fixed-length digests: constant time and no length leak.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
  const m = (req.headers.cookie ?? "").match(/(?:^|;\s*)scenaria_token=([^;]+)/);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined; // malformed cookie must never crash the server
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
}

export function createApp(s: Scenaria, opts: AppOptions = {}) {
  const clients = new Set<ServerResponse>();
  const approvalSecret = opts.approvalSecret ?? randomBytes(24).toString("hex");
  // Local mode: the link works ONCE (the browser Scenaria opens redeems it within a second), so a copy
  // that shows up later in a log or a process list is useless — and if someone else used it first,
  // your own click fails visibly. Team mode: the configured approver token.
  const link = opts.linkState ?? { secret: opts.token ? opts.approverToken : opts.approvalCode };
  const isApprover = (req: IncomingMessage) => tokenMatches(approvalCookie(req), approvalSecret);
  let lastVersion = s.store.version();
  // Automatic multiverse forecasts for open decisions on the current line — only when the person
  // switched it on in Settings, only with the model the PERSON chose (never the project file), with a
  // daily limit. One at a time; at most two attempts per decision, then it is reported as failed.
  let forecasting: string | null = null;
  // What the person's model is doing right now (multiverse, AI check, backtest): shown while it runs.
  type Job = { kind: "multiverse" | "audit" | "backtest"; subject: string; step: string; index?: number; total?: number; startedAt: string };
  let job: Job | null = null;
  const runJob = async <T>(j: Omit<Job, "startedAt" | "step">, fn: (step: (st: Partial<Job>) => void) => Promise<T>): Promise<T> => {
    if (job) throw new Error(`Läuft gerade: ${job.kind} ${job.subject} — bitte warten. / Already running: ${job.kind} ${job.subject}.`);
    job = { ...j, step: "start", startedAt: new Date().toISOString() };
    try {
      return await fn((st) => {
        if (job) job = { ...job, ...st };
      });
    } finally {
      job = null;
    }
  };
  const attempts = new Map<string, { n: number; at: number; error?: string }>();
  const autoForecast = () => {
    if (forecasting || opts.autoForecast === false) return;
    try {
      const st = readSettings(s);
      if (!st.forecast.auto || !effectiveLlm(s, "oracle", undefined, { globalOnly: true })) return;
      // Every attempt counts against the daily budget (kept outside the project), failed ones too.
      const budget = autoBudget(s);
      if (budget.used() >= st.forecast.dailyLimit) return;
      const next = openWithoutForecast(s).find((id) => {
        const a = attempts.get(id);
        return !a || (a.n < 2 && Date.now() - a.at > 600_000);
      });
      if (!next) return;
      const roles = (["archivist", "craftsman", "oracle"] as const).map((r) => effectiveLlm(s, r, undefined, { globalOnly: true }));
      if (roles.some((r) => !r)) return;
      forecasting = next;
      budget.spend();
      forecast(s, { node: next, trigger: "auto", lang: st.ui.lang, globalOnly: true })
        .catch((err) => attempts.set(next, { n: (attempts.get(next)?.n ?? 0) + 1, at: Date.now(), error: String(err?.message ?? err).slice(0, 200) }))
        .finally(() => {
          forecasting = null;
        });
    } catch {
      /* never break the dashboard */
    }
  };
  const timer = setInterval(() => {
    const v = s.store.version();
    if (v !== lastVersion) {
      lastVersion = v;
      for (const c of clients) c.write(`event: change\ndata: ${v}\n\n`);
      autoForecast();
    }
  }, 800);
  timer.unref();
  setTimeout(autoForecast, 1500).unref();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handle(req, res);
    } catch (err: any) {
      // Last line of defense: a single bad request must never take the server down.
      try {
        if (!res.headersSent) send(res, 400, { error: err?.message ?? String(err) });
        else res.end();
      } catch {}
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, 400, { error: "invalid URL" });
    }
    const p = url.pathname;
    const token = opts.token;

    // ---------- LLM proxy (conversation overlay for any provider) ----------
    if (p.startsWith("/proxy/")) {
      if (!token) {
        if (!isLoopbackHost(req.headers.host)) return send(res, 421, { error: "unexpected Host header" });
        if (req.headers.origin && !isLoopbackHost(safeHost(req.headers.origin))) return send(res, 403, { error: "cross-origin request rejected" });
      } else {
        // Authorization carries the provider's API key, so team mode uses its own header.
        if (!tokenMatches(header(req, "x-scenaria-token"), token)) return send(res, 401, { error: "proxy needs the x-scenaria-token header in team mode" });
        if (req.headers.origin && safeHost(req.headers.origin) !== req.headers.host) return send(res, 403, { error: "cross-origin request rejected" });
      }
      // Only JSON bodies: plain HTML forms cannot send them cross-site without CORS.
      const mediaType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (req.method === "POST" && !(mediaType === "application/json" || /^application\/[\w.+-]+\+json$/.test(mediaType))) {
        return send(res, 415, { error: "proxy accepts JSON requests only" });
      }
      const raw = await readRaw(req, 50 * 1024 * 1024);
      return handleProxy(s, req, res, url, raw, { allowUpstreamOverride: !token });
    }

    let viaBearer = false;
    if (!token) {
      // Local mode — DNS-rebinding protection: only answer to loopback host names.
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, { error: "unexpected Host header" });
      if (req.method === "POST" && req.headers.origin && !isLoopbackHost(safeHost(req.headers.origin))) {
        return send(res, 403, { error: "cross-origin request rejected" });
      }
    } else {
      // Team/server mode — every request needs the token (Bearer header or cookie).
      if (!p.startsWith("/api/") && tokenMatches(url.searchParams.get("token") ?? undefined, token)) {
        res.writeHead(302, {
          location: "/",
          // Lax so the first click from Slack/email works; CSRF stays blocked by X-Scenaria + Origin checks.
          "set-cookie": `scenaria_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`,
        });
        return res.end();
      }
      viaBearer = tokenMatches(bearer(req), token);
      if (!viaBearer && !tokenMatches(cookieToken(req), token)) {
        return p.startsWith("/api/")
          ? send(res, 401, { error: "missing or invalid token (Authorization: Bearer <token>)" })
          : send(res, 401, "Scenaria team server: open this page with ?token=<your token>", "text/plain; charset=utf-8");
      }
      if (req.method === "POST" && req.headers.origin && safeHost(req.headers.origin) !== req.headers.host) {
        return send(res, 403, { error: "cross-origin request rejected" });
      }
    }
    // Approval link: sets the approval session cookie (never shown to scripts: HttpOnly, SameSite=Strict).
    if (!p.startsWith("/api/") && url.searchParams.has("approve")) {
      if (isApprover(req)) {
        res.writeHead(302, { location: "/" });
        return res.end();
      }
      if (link.secret && tokenMatches(url.searchParams.get("approve") ?? undefined, link.secret)) {
        if (!opts.token) link.secret = undefined; // single use (also across project switches)
        res.writeHead(302, { location: "/", "set-cookie": `scenaria_approval=${encodeURIComponent(approvalSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
        return res.end();
      }
      // Never a dead page: open the dashboard without approval rights and say why (the dashboard shows it).
      res.writeHead(302, { location: "/?approval=invalid" });
      return res.end();
    }
    const ctx: ToolContext = {
      agent: header(req, "x-scenaria-agent") ?? "http-client",
      model: header(req, "x-scenaria-model"),
      user: header(req, "x-scenaria-user"),
      source: "api",
    };
    try {
      if (p.startsWith("/api/")) {
        if (req.method === "POST" && !viaBearer && req.headers["x-scenaria"] !== "1") return send(res, 403, { error: "missing X-Scenaria header" });

        // ---------- vendor-neutral v1 API (any LLM / framework) ----------
        if (req.method === "GET" && p === "/api/v1/health") return send(res, 200, { ok: true, name: "scenaria", version: VERSION, project: s.config().projectName });
        if (req.method === "GET" && p === "/api/v1/tools") {
          try {
            return send(res, 200, toolSchemas((url.searchParams.get("format") ?? "json") as SchemaFormat));
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
        }
        const tm = p.match(/^\/api\/v1\/tools\/([\w-]+)$/);
        if (req.method === "POST" && tm) {
          const body = await readBody(req);
          const args = body && typeof body === "object" && "arguments" in body ? parseArgs(body.arguments) : body;
          try {
            const r = callTool(s, tm[1], args, ctx);
            return send(res, 200, { ok: true, text: r.text, data: r.data });
          } catch (err: any) {
            return send(res, 400, { ok: false, error: err?.message ?? String(err) });
          }
        }
        if (req.method === "GET" && p === "/api/v1/export") return send(res, 200, s.exportJson());
        if (req.method === "GET" && p === "/api/v1/versions") return send(res, 200, s.versions(url.searchParams.get("mission") ?? undefined));
        if (req.method === "GET" && p === "/api/v1/conversations") return send(res, 200, s.conversations.listSessions());
        const cm = p.match(/^\/api\/v1\/conversations\/([\w:.-]+)$/);
        if (req.method === "GET" && cm) {
          const sess = s.conversations.getSession(decodeURIComponent(cm[1]));
          return send(res, 200, { session: sess, messages: s.conversations.messages(sess.id) });
        }
        if (req.method === "POST" && p === "/api/v1/messages") {
          const b = await readBody(req);
          if (!b || !Array.isArray(b.messages)) return send(res, 400, { ok: false, error: "body needs messages: [{role, text}]" });
          const sess = b.session ?? {};
          const r = s.logMessages(
            {
              externalId: sess.externalId ?? sess.id ?? `api:${ctx.agent}`,
              sessionId: sess.sessionId,
              title: sess.title,
              provider: sess.provider,
              model: sess.model ?? ctx.model,
              agent: sess.agent ?? ctx.agent,
              source: "api",
            },
            b.messages.map((m: any) => ({ role: m.role, text: String(m.text ?? m.content ?? ""), ts: m.ts, model: m.model, toolCalls: m.toolCalls })),
            b.mode === "history" ? "history" : "append",
          );
          return send(res, 200, { ok: true, session: r.session, added: r.added.length, messages: r.added });
        }

        // ---------- prompts, chat capture, recall ----------
        if (req.method === "GET" && p === "/api/v1/prompt") {
          const kind = (url.searchParams.get("kind") ?? "mcp") as PromptKind;
          if (!["mcp", "cli", "chat"].includes(kind)) return send(res, 400, { error: "kind must be mcp, cli or chat" });
          const text = agentPrompt(s, { kind, lang: url.searchParams.get("lang") === "en" ? "en" : "de", withContext: url.searchParams.get("context") === "1" });
          return send(res, 200, { kind, text, tokens: Math.ceil(text.length / 4) });
        }
        if (req.method === "POST" && p === "/api/v1/ingest-text") {
          const b = await readBody(req);
          const text = String(b?.text ?? "");
          if (!text.trim()) return send(res, 400, { ok: false, error: "text required" });
          if (b.log) s.logMessages({ externalId: `paste:${ctx.agent}`, source: "api", agent: ctx.agent, title: "Pasted answers" }, [{ role: "assistant", text: text.slice(0, 50_000) }], "append");
          const r = applyBlocks(s, text, { agent: b.agent ?? ctx.agent, model: b.model ?? ctx.model, source: "api" });
          return send(res, 200, { ok: true, created: r.created.map((n) => ({ id: n.id, type: n.type, title: n.title })), errors: r.errors, skipped: r.skipped });
        }
        if (req.method === "GET" && p === "/api/v1/recall") {
          const q = url.searchParams.get("q") ?? "";
          const head = s.store.readState().head;
          const hits = recall(s.store.listNodes(), s.conversations.allMessages(), q, { limit: Number(url.searchParams.get("limit") ?? 12), pathIds: head ? new Set(s.path(head).map((n) => n.id)) : undefined });
          return send(res, 200, hits);
        }

        // ---------- context fidelity, workspace, references, expectations ----------
        if (req.method === "GET" && p === "/api/fidelity") return send(res, 200, s.fidelity());
        if (p === "/api/v1/workspace" && (req.method === "GET" || req.method === "POST")) {
          // Reader mode changes what a reader is told next time, so it needs POST (+ X-Scenaria / token), never a plain GET.
          const b = req.method === "POST" ? await readBody(req) : {};
          const raw = req.method === "POST" ? (Array.isArray(b?.sections) ? b.sections.join(",") : String(b?.sections ?? "")) : url.searchParams.get("sections") ?? "";
          const sections = raw.split(",").map((x: string) => x.trim()).filter((x: string) => (SECTIONS as readonly string[]).includes(x)) as Section[];
          if (req.method === "GET" && url.searchParams.get("reader")) return send(res, 405, { error: "reader mode needs POST /api/v1/workspace {reader, sections}" });
          const r = workspace(s, { sections, reader: req.method === "POST" ? b?.reader : undefined, full: Boolean(b?.full) });
          return send(res, 200, r);
        }
        if (req.method === "GET" && p === "/api/v1/resolve") {
          return send(res, 200, resolveRefs(s, (url.searchParams.get("refs") ?? "").split(",").map((x) => x.trim()).filter(Boolean)));
        }
        if (req.method === "POST" && p === "/api/v1/expect") {
          const b = await readBody(req);
          if (!Array.isArray(b?.expectations)) return send(res, 400, { error: "body needs expectations: [string]" });
          return send(res, 200, checkExpectations(s, b.expectations.map(String)));
        }

        // ---------- canon events (fixed points) ----------
        if (req.method === "GET" && p === "/api/approval") return send(res, 200, { granted: isApprover(req), mode: token ? (opts.approverToken ? "team" : "disabled") : "local" });
        if (req.method === "GET" && p === "/api/canon") {
          const st = s.canonState();
          return send(res, 200, { events: st.events, error: st.error, missing: st.missing, suggestions: st.error ? [] : s.suggestCanon(), approval: isApprover(req) });
        }
        // Binding canon actions, the person's settings, the built-in chat and the relay: only with the
        // approval session (not with the API/agent token) — they act for the person or use the person's keys.
        // (The archivist and the analysis also spend the person's quota with the person's keys.)
        const personOnly = p.startsWith("/api/canon") || p.startsWith("/api/settings") || p.startsWith("/api/agents") || p === "/api/chat" || p === "/api/relay" || p.startsWith("/api/forecast") || p === "/api/analysis/run" || p === "/api/analysis/config" || p.startsWith("/api/expert") || p.startsWith("/api/projects");
        if (personOnly && req.method === "POST" && !isApprover(req)) {
          return send(res, 403, { error: "This is the person's action (approvals, settings, chat, relay, analysis with your keys): open the approval link from the terminal running Scenaria (scenaria start/ui). Agents can only propose.", code: "approval_required" });
        }
        // The approver is the person at this machine (local) — client-supplied names are only a claim in team mode.
        const approver = token ? `${ctx.user ?? "approver"} (team approver link)` : `${defaultUserName()} (local approval link)`;
        if (req.method === "GET" && p === "/api/v1/string") return send(res, 200, stringPayload(s, url.searchParams.get("at") ?? undefined));

        // ---------- settings: models, keys (never stored), agents ----------
        if (req.method === "GET" && p === "/api/settings") {
          const host = req.headers.host ? `http://${req.headers.host}` : undefined;
          return send(res, 200, { ...readSettings(s), agents: agentStatus(s.root), snippets: connectionSnippets(s.root, host), approval: isApprover(req), teamMode: Boolean(token), version: VERSION });
        }
        if (req.method === "POST" && p === "/api/settings") {
          const b = await readBody(req);
          if (token && (b?.trustedEndpoints || JSON.stringify(b?.llm ?? {}).includes("baseUrl"))) return send(res, 400, { error: "custom base URLs and trusted endpoints are disabled in team mode (use proxy.upstreams in config.json on the server)" });
          writeSettings(b ?? {});
          s.store.appendEvent({ type: "update", data: { message: `settings changed by ${approver} (models/agents)` } });
          return send(res, 200, readSettings(s));
        }
        if (req.method === "POST" && p === "/api/settings/models") {
          const b = await readBody(req);
          if (token && b?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            return send(res, 200, { models: await listModels(s, { provider: String(b?.provider ?? ""), baseUrl: b?.baseUrl, apiKey: b?.apiKey }) });
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/settings/test") {
          const b = await readBody(req);
          if (token && b?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            const t0 = Date.now();
            const out = await callLlm({ provider: String(b?.provider ?? ""), model: String(b?.model ?? ""), baseUrl: b?.baseUrl, apiKey: b?.apiKey }, upstreams(s), "Answer with the single word OK.", "Connection test", 60_000);
            return send(res, 200, { ok: true, model: out.model, reply: out.text.slice(0, 80), ms: Date.now() - t0 });
          } catch (err: any) {
            return send(res, 502, { ok: false, error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/agents/connect") {
          const b = await readBody(req);
          const targets = (Array.isArray(b?.targets) ? b.targets.map(String) : []).filter((t: string) => (TARGETS as readonly string[]).includes(t)) as Target[];
          if (!targets.length) return send(res, 400, { error: `targets must be some of ${TARGETS.join(", ")}` });
          const r = setupAgents(s.root, targets, { rulesFiles: b?.rulesFiles !== false });
          s.store.appendEvent({ type: "update", data: { message: `agents connected by ${approver}: ${targets.join(", ")}` } });
          return send(res, 200, { ...r, agents: agentStatus(s.root) });
        }

        // ---------- built-in chat & relay (the person's own surface) ----------
        if (req.method === "POST" && p === "/api/chat") {
          const b = await readBody(req, 4_000_000);
          if (token && b?.llm?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            return send(res, 200, await chat(s, { sessionId: String(b?.sessionId ?? ""), messages: b?.messages, decisions: b?.decisions, llm: b?.llm, lang: b?.lang === "en" ? "en" : "de", user: token ? ctx.user : defaultUserName() }));
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "GET" && p === "/api/relay") return send(res, 200, listRelays(s));

        // ---------- forecasts (multiverse) ----------
        if (req.method === "GET" && p === "/api/forecasts") {
          const failed = Object.fromEntries([...attempts].filter(([, a]) => a.n >= 2).map(([id, a]) => [id, a.error ?? "failed"]));
          return send(res, 200, { ...evaluateForecasts(s), running: forecasting, open: openWithoutForecast(s), failed, auto: { ...readSettings(s).forecast, usedToday: autoBudget(s).used() } });
        }
        if (req.method === "GET" && p === "/api/forecast/quality") return send(res, 200, forecastQuality(s));
        // The auditor's area: read-only, for everyone who can open the dashboard.
        if (req.method === "GET" && p === "/api/audit/overview") return send(res, 200, auditOverview(s, url.searchParams.get("lang") === "en" ? "en" : "de"));
        if (req.method === "GET" && p === "/api/audit/report") {
          const lang = url.searchParams.get("lang") === "en" ? "en" : "de";
          const o = auditOverview(s, lang);
          const md = url.searchParams.get("format") !== "json";
          const name = `scenaria-pruefbericht-${o.project.replace(/[^\w.-]+/g, "_")}-${o.generatedAt.slice(0, 10)}.${md ? "md" : "json"}`;
          res.writeHead(200, { "content-type": md ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` });
          return res.end(md ? auditReportMarkdown(o, lang) : JSON.stringify(o, null, 2));
        }
        if (req.method === "GET" && p === "/api/forecast/progress") return send(res, 200, { job, auto: forecasting });
        if (req.method === "GET" && p === "/api/forecast/past") return send(res, 200, pastDecisions(s));
        if (req.method === "POST" && p === "/api/forecast/decision") {
          // The person writes down a decision to forecast (question + at least two options).
          const b = await readBody(req);
          const question = String(b?.question ?? "").trim().slice(0, 400);
          const options = (Array.isArray(b?.options) ? b.options : [])
            .map((o: any) => (typeof o === "string" ? { label: o } : { label: String(o?.label ?? ""), description: o?.description ? String(o.description).slice(0, 1000) : undefined }))
            .map((o: { label: string; description?: string }) => ({ ...o, label: o.label.trim().slice(0, 200) }))
            .filter((o: { label: string }) => o.label);
          if (question.length < 3 || options.length < 2) return send(res, 400, { error: "Eine Frage und mindestens zwei Optionen. / A question and at least two options." });
          return send(res, 200, s.decide({ question, options: options.slice(0, 6), agent: "dashboard", source: "ui", user: token ? ctx.user : defaultUserName() }));
        }
        if (req.method === "POST" && p === "/api/forecast/benchmark") {
          // Throw-away projects in the temp folder; uses the calibration this project's forecasts use.
          const cal = calibrationFor(s);
          try {
            return send(res, 200, { calibration: cal, ...(await benchmarkInWorker(cal)) });
          } catch (err: any) {
            return send(res, 500, { error: err?.message ?? String(err) });
          }
        }
        // The Prüf-Experte: the checklist is free and open to read; the skeptic and the oracle backtest
        // use the person's model (person-only, like every POST under /api/forecast).
        if (req.method === "GET" && p === "/api/forecast/audit") {
          const id = url.searchParams.get("id") ?? "";
          const f = listForecasts(s).find((x) => x.id === id);
          if (!f) return send(res, 404, { error: `unknown forecast ${id}` });
          return send(res, 200, auditForecast(s, f, url.searchParams.get("lang") === "en" ? "en" : "de"));
        }
        if (req.method === "POST" && p === "/api/forecast/audit") {
          const b = await readBody(req);
          if (token && b?.llm?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            const lang = b?.lang === "en" ? "en" : "de";
            const rec = await runJob({ kind: "audit", subject: String(b?.id ?? "") }, (step) => {
              step({ step: "auditor" });
              return deepAudit(s, String(b?.id ?? ""), { lang, llm: b?.llm });
            });
            const f = listForecasts(s).find((x) => x.id === rec.forecast)!;
            return send(res, 200, auditForecast(s, f, lang));
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "GET" && p === "/api/forecast/oracle") return send(res, 200, { ...oracleQuality(s), runs: listOracleBacktests(s).slice(0, 10) });
        if (req.method === "POST" && p === "/api/forecast/oracle-backtest") {
          const b = await readBody(req);
          if (token && b?.llm?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            const decisions = Array.isArray(b?.decisions) ? b.decisions.map(String) : undefined;
            const rec = await runJob({ kind: "backtest", subject: decisions?.join(", ") ?? "last decisions" }, (step) =>
              oracleBacktest(s, { limit: Number(b?.limit) || 5, decisions, lang: b?.lang === "en" ? "en" : "de", llm: b?.llm, onStep: (st) => step({ step: st.role, subject: st.decision, index: st.index + 1, total: st.total }) }),
            );
            return send(res, 200, { run: rec, ...oracleQuality(s) });
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/forecast/used") {
          const b = await readBody(req);
          return send(res, 200, markUsed(s, String(b?.id ?? ""), String(b?.key ?? "")));
        }
        if (req.method === "GET" && p === "/api/forecast/quick") {
          const node = url.searchParams.get("node");
          if (node) return send(res, 200, { node, options: quickDecision(s, node) });
          const text = url.searchParams.get("prompt") ?? "";
          return send(res, 200, { prompt: text, quick: quickPrompt(s, text) });
        }
        if (req.method === "POST" && p === "/api/forecast") {
          const b = await readBody(req, 200_000);
          if (token && b?.llm?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            const fr = { node: b?.node ? String(b.node) : undefined, prompt: b?.prompt ? String(b.prompt) : undefined, variants: Array.isArray(b?.variants) ? b.variants.map(String) : undefined, quick: b?.quick === true, lang: (b?.lang === "en" ? "en" : "de") as "de" | "en", llm: b?.llm, trigger: "person" as const };
            if (fr.quick) return send(res, 200, await forecast(s, fr));
            return send(res, 200, await runJob({ kind: "multiverse", subject: fr.node ?? "prompt" }, (step) => forecast(s, { ...fr, onStep: (st) => step({ step: st }) })));
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/relay") {
          const b = await readBody(req);
          if (token && b?.llm?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            return send(res, 200, await runRelay(s, { question: String(b?.question ?? ""), options: Array.isArray(b?.options) ? b.options.map(String) : undefined, createDecision: b?.createDecision === true, lang: b?.lang === "en" ? "en" : "de", llm: b?.llm, actor: { user: token ? ctx.user : defaultUserName(), agent: "relay" } }));
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/canon") {
          // The dashboard is a person's surface: adding here makes the event binding (audited as "dashboard").
          const b = await readBody(req);
          return send(res, 200, s.addCanonAsUser({ kind: b?.kind, text: String(b?.text ?? ""), hard: b?.hard !== false, check: b?.check, due: b?.due || undefined, evidence: Array.isArray(b?.evidence) ? b.evidence : undefined }, { user: approver, via: "dashboard" }));
        }
        if (req.method === "POST" && p === "/api/canon/decide") {
          const b = await readBody(req);
          if (!["approve", "reject", "retire", "confirm"].includes(b?.action)) return send(res, 400, { error: "action must be approve, reject, retire or confirm" });
          const adoptCheck = typeof b?.adoptCheck === "string" ? b.adoptCheck : b?.adoptCheck === true;
          return send(res, 200, s.decideCanon(String(b?.id ?? ""), b.action, { user: approver, via: "dashboard", reason: b?.reason, adoptCheck }));
        }
        if (req.method === "GET" && p === "/api/canon/gate") return send(res, 200, gateMatrix(s));
        if (req.method === "POST" && p === "/api/canon/gate") {
          const b = await readBody(req);
          const strs = (x: unknown) => (Array.isArray(x) ? x.map(String).slice(0, 40) : undefined);
          await runGate(s, { lines: strs(b?.lines), ids: strs(b?.ids), by: approver });
          return send(res, 200, gateMatrix(s));
        }
        if (req.method === "POST" && p === "/api/canon/check") {
          const b = await readBody(req);
          return send(res, 200, await s.checkCanon(Array.isArray(b?.ids) ? b.ids.map(String) : undefined, approver));
        }
        if (req.method === "POST" && p === "/api/canon/archivist") {
          const b = await readBody(req);
          if (token && b?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            return send(res, 200, await archivistProposals(s, { provider: b?.provider, model: b?.model, baseUrl: b?.baseUrl, apiKey: b?.apiKey, lang: b?.lang === "en" ? "en" : "de" }));
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }

        // ---------- analysis & rules ----------
        if (req.method === "GET" && p === "/api/analysis") return send(res, 200, projectMetrics(s));
        if (req.method === "GET" && p === "/api/analysis/list") return send(res, 200, listAnalyses(s));
        if (req.method === "GET" && p === "/api/analysis/dossier") {
          const lang = url.searchParams.get("lang") === "en" ? "en" : "de";
          const d = dossier(s, { maxTokens: Number(url.searchParams.get("maxTokens") ?? 8000) });
          return send(res, 200, { ...d, prompt: analysisPrompt(lang), text: `${analysisPrompt(lang)}\n\n--- DOSSIER ---\n${d.text}` });
        }
        if (req.method === "GET" && p === "/api/analysis/config") {
          // The model the analysis really uses (Settings → role/default, else the project's old setting).
          const eff = effectiveLlm(s, "analysis");
          return send(res, 200, { config: eff ? { provider: eff.provider, model: eff.model, baseUrl: eff.baseUrl } : null, envKeys: KEY_ENVS.filter((k) => Boolean(process.env[k])), teamMode: Boolean(token) });
        }
        if (req.method === "POST" && p === "/api/analysis/config") {
          const b = await readBody(req);
          const c = s.config();
          if (!b?.provider || !b?.model) return send(res, 400, { error: "provider and model required" });
          if (token && b.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode (use proxy.upstreams in config.json)" });
          // Saved as the analysis model in the person's settings (same place as the Settings page).
          const cur = readSettings(s).llm;
          writeSettings({ llm: { default: cur.default, roles: { ...(cur.roles ?? {}), analysis: { provider: String(b.provider).slice(0, 40), model: String(b.model).slice(0, 160), ...(b.baseUrl ? { baseUrl: String(b.baseUrl).slice(0, 300) } : {}) } } } });
          void c;
          return send(res, 200, { ok: true, config: readSettings(s).effective.analysis });
        }
        if (req.method === "POST" && p === "/api/analysis/run") {
          const b = await readBody(req);
          if (token && b?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            const rec = await runAnalysis(s, { provider: b?.provider, model: b?.model, baseUrl: b?.baseUrl, apiKey: b?.apiKey, lang: b?.lang === "en" ? "en" : "de", maxTokens: b?.maxTokens });
            return send(res, 200, rec);
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/analysis/import") {
          const b = await readBody(req);
          return send(res, 200, importAnalysis(s, String(b?.text ?? ""), { provider: b?.provider, model: b?.model, lang: b?.lang === "en" ? "en" : "de" }));
        }
        if (req.method === "POST" && p === "/api/analysis/accept") {
          const b = await readBody(req);
          return send(res, 200, acceptRule(s, String(b?.id ?? ""), Number(b?.index)));
        }
        // ---------- the person's projects (switch the dashboard) ----------
        if (req.method === "GET" && p === "/api/projects") {
          // The list (names, folders) is the person's: only with the approval session, never in team mode.
          const person = isApprover(req) && !token;
          const here = realRoot(s.root);
          return send(res, 200, {
            current: { name: s.config().projectName, root: person ? s.root : undefined },
            canSwitch: Boolean(opts.onSwitch) && !token,
            person,
            // Agents' HTTP tools, the LLM proxy and auto-save stay with the project the server was started in.
            agents: opts.agentsProject ? { name: opts.agentsProject.name, root: person ? opts.agentsProject.root : undefined, same: realRoot(opts.agentsProject.root) === here } : null,
            projects: person ? listProjects({ includeMissing: true }).map((x) => ({ name: x.name, root: x.root, lastSeen: x.lastSeen, exists: x.exists, current: realRoot(x.root) === here })) : [],
          });
        }
        if (req.method === "POST" && p === "/api/projects/switch") {
          if (!opts.onSwitch || token) return send(res, 400, { error: "Switching projects is available in the local dashboard (scenaria start)." });
          const b = await readBody(req);
          const target = String(b?.root ?? "").trim();
          if (!target) return send(res, 400, { error: "root required" });
          if (!existsSync(join(target, ".scenaria", "config.json"))) return send(res, 400, { error: `No Scenaria project in ${target} — run "scenaria start" (or "scenaria init") in that folder once.`, code: "not_a_project" });
          try {
            const r = await opts.onSwitch(target);
            return send(res, 200, { ok: true, ...r });
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/projects/forget") {
          if (token) return send(res, 400, { error: "Not available in team mode." });
          const b = await readBody(req);
          const target = String(b?.root ?? "");
          if (realRoot(target) === realRoot(s.root)) return send(res, 400, { error: "The open project cannot be forgotten." });
          forgetProject(target);
          return send(res, 200, { ok: true });
        }

        // ---------- expert analyst (report to optimise with) ----------
        if (req.method === "GET" && p === "/api/expert") {
          // Reports across projects and the list of projects are the person's (other projects' data):
          // only with the approval session, never in team mode.
          const person = isApprover(req) && !token;
          const row = (r: ReturnType<typeof listReports>[number]) => ({ id: r.id, createdAt: r.createdAt, scope: r.scope, model: r.model, maturity: r.maturity, findings: r.findings.length, recommendations: r.recommendations.length, projects: r.facts.map((f) => f.project), verified: r.verified });
          return send(res, 200, { reports: [...listReports(s), ...(person ? listPersonalReports(s) : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row), facts: factSheet(s), projects: person ? listProjectsSafe(s).map((x) => ({ name: x.name, lastSeen: x.lastSeen, current: x.root === s.root })) : [], person });
        }
        if (req.method === "GET" && p === "/api/expert/report") {
          const id = String(url.searchParams.get("id") ?? "");
          if (id.startsWith("g") && !(isApprover(req) && !token)) return send(res, 403, { error: "Reports across projects are the person's.", code: "approval_required" });
          try {
            return send(res, 200, getReport(s, id));
          } catch (err: any) {
            return send(res, 404, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/expert") {
          const b = await readBody(req);
          if (token && b?.llm?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          const scope = b?.scope === "all" || b?.scope === "line" ? b.scope : "project";
          try {
            const llm = b?.llm && typeof b.llm === "object" ? { provider: b.llm.provider, model: b.llm.model, baseUrl: b.llm.baseUrl, apiKey: b.llm.apiKey, keyFor: b.llm.keyFor } : undefined;
            const r = await expertAnalysis(s, { scope, head: typeof b?.head === "string" ? b.head : undefined, lang: b?.lang === "en" ? "en" : "de", noModel: Boolean(b?.noModel), llm });
            return send(res, 200, r);
          } catch (err: any) {
            return send(res, 502, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "POST" && p === "/api/expert/adopt") {
          const b = await readBody(req);
          try {
            return send(res, 200, adoptRecommendation(s, String(b?.id ?? ""), Number(b?.index)));
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
        }
        if (req.method === "GET" && p === "/api/rules") return send(res, 200, s.rules());
        if (req.method === "POST" && p === "/api/rules") {
          const b = await readBody(req);
          return send(res, 200, s.addRule(String(b?.text ?? ""), "manual"));
        }
        if (req.method === "POST" && p === "/api/rules/delete") {
          const b = await readBody(req);
          return send(res, 200, { ok: s.removeRule(String(b?.id ?? "")) });
        }
        if (req.method === "POST" && p === "/api/goal") {
          const b = await readBody(req);
          if (!String(b?.goal ?? "").trim()) return send(res, 400, { error: "goal required" });
          return send(res, 200, s.setProjectGoal(String(b.goal).slice(0, 2000), { agent: "dashboard", user: ctx.user, source: "ui" }));
        }
        if (req.method === "POST" && p === "/api/node/update") {
          const b = await readBody(req);
          const patch: Record<string, unknown> = {};
          for (const k of ["title", "goal", "summary", "rationale", "context", "servesGoal", "expectedOutcome"]) if (typeof b?.[k] === "string") patch[k] = b[k].slice(0, 2000);
          if (["active", "done", "abandoned"].includes(b?.status)) patch.status = b.status;
          return send(res, 200, s.update(String(b?.id ?? ""), patch as any));
        }

        if (req.method === "GET" && p === "/api/graph") {
          const g = s.graph();
          return send(res, 200, { ...g, version: s.store.version(), snapshots: Boolean(s.repo) });
        }
        if (req.method === "GET" && p === "/api/status") return send(res, 200, s.status());
        if (req.method === "GET" && p === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write(`event: hello\ndata: ${s.store.version()}\n\n`);
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        let m = p.match(/^\/api\/node\/([\w-]+)\/context$/);
        if (req.method === "GET" && m) return send(res, 200, s.context(m[1]));
        if (req.method === "GET" && p === "/api/diff") {
          const from = url.searchParams.get("from");
          if (!from) return send(res, 400, { error: "from required" });
          return send(res, 200, s.diff(from, url.searchParams.get("to") ?? undefined));
        }
        if (req.method === "GET" && p === "/api/protocol") return send(res, 200, { markdown: s.protocolMarkdown() });
        if (req.method === "GET" && p === "/api/log") return send(res, 200, { events: s.store.readEvents().slice(-500) });

        if (req.method === "POST" && p === "/api/rewind") {
          const b = await readBody(req);
          const r = s.rewind(String(b.id), { lesson: b.lesson, restoreFiles: b.restoreFiles !== false, agent: "dashboard", user: ctx.user, source: "ui" });
          return send(res, 200, r);
        }
        if (req.method === "POST" && p === "/api/fork") {
          const b = await readBody(req);
          return send(res, 200, s.fork(String(b.decisionId), b.option, { lesson: b.lesson, agent: "dashboard", source: "ui" }));
        }
        if (req.method === "POST" && p === "/api/verify") {
          const b = await readBody(req);
          return send(res, 200, s.verify(String(b.id), { status: b.status, notes: b.notes, by: "dashboard", auto: b.auto !== false, runCommand: Boolean(b.runCommand) }));
        }
        if (req.method === "POST" && p === "/api/choose") {
          const b = await readBody(req);
          return send(res, 200, s.choose(String(b.id), b.option, b.rationale));
        }
        if (req.method === "POST" && p === "/api/checkpoint") {
          const b = await readBody(req);
          return send(res, 200, s.checkpoint({ title: String(b.title || "Manual checkpoint"), outputs: b.outputs, agent: "dashboard", source: "ui" }));
        }
        m = p.match(/^\/api\/node\/([\w-]+)\/messages$/);
        if (req.method === "GET" && m) {
          const node = s.node(m[1]);
          return send(res, 200, { leading: s.messagesLeadingTo(node.id), after: s.conversations.messagesAt(node.id) });
        }
        m = p.match(/^\/api\/node\/([\w-]+)\/folder$/);
        if (req.method === "POST" && m) {
          const folder = s.ensureFolder(m[1]);
          const b = await readBody(req).catch(() => ({}));
          if (folder && b?.open && !token) openPath(folder);
          return send(res, 200, { folder });
        }
        m = p.match(/^\/api\/node\/([\w-]+)$/);
        if (req.method === "GET" && m) return send(res, 200, s.node(m[1]));
        return send(res, 404, { error: "not found" });
      }

      // static UI (from disk, or embedded in the standalone binary)
      if (hasDiskUi()) {
        let file = normalize(join(UI_DIR, decodeURIComponent(p)));
        if (!file.startsWith(UI_DIR)) return send(res, 403, "forbidden", "text/plain");
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(UI_DIR, "index.html");
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
        return res.end(readFileSync(file));
      }
      const rel = decodeURIComponent(p).replace(/^\/+/, "");
      const asset = (rel && embeddedUi(rel)) || embeddedUi("index.html");
      if (!asset) return send(res, 500, "Dashboard not built. Run: npm run build", "text/plain; charset=utf-8");
      const name = rel && embeddedUi(rel) ? rel : "index.html";
      res.writeHead(200, { "content-type": MIME[extname(name)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(asset);
    } catch (err: any) {
      send(res, 400, { error: err?.message ?? String(err) });
    }
  };
  return {
    handler,
    /** reason "switch": open dashboards are told to reload the new project. */
    close: (reason?: "switch") => {
      clearInterval(timer);
      for (const c of clients) {
        try {
          if (reason === "switch") c.write(`event: project\ndata: switched\n\n`);
          c.end();
        } catch {}
      }
      clients.clear();
    },
  };
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore */
  }
}

function realRoot(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function listProjectsSafe(s: Scenaria) {
  try {
    const all = listProjects();
    return all.some((p) => p.root === s.root) ? all : [{ root: s.root, name: s.config().projectName, lastSeen: new Date().toISOString() }, ...all];
  } catch {
    return [];
  }
}

export async function startServer(
  s: Scenaria,
  opts: { port?: number; open?: boolean; host?: string; token?: string; showToken?: boolean; quiet?: boolean; approverToken?: string; showApprovalLink?: boolean } = {},
) {
  const host0 = opts.host ?? "127.0.0.1";
  if (!isLoopbackHost(host0) && !opts.token) {
    throw new Error("Listening on a non-loopback host requires a token (--token or SCENARIA_TOKEN).");
  }
  const approvalCode = randomBytes(18).toString("base64url");
  // Print the link only to a person's terminal: when an agent starts the server, its output is the agent's.
  const showLink = opts.showApprovalLink ?? Boolean(process.stdout.isTTY);
  const approverToken = opts.approverToken ?? process.env.SCENARIA_APPROVER_TOKEN;
  registerProject(s.root, s.config().projectName);
  // One server, one approval session for the person; the dashboard can switch between their projects.
  // Every app keeps its own project: requests already running finish in the project they started in.
  const approvalSecret = randomBytes(24).toString("hex");
  const linkState = { secret: opts.token ? approverToken : approvalCode };
  let current = s;
  const agentsProject = { name: s.config().projectName, root: s.root };
  const make = (proj: Scenaria): ReturnType<typeof createApp> =>
    createApp(proj, {
      token: opts.token,
      approvalCode,
      approverToken,
      approvalSecret,
      linkState,
      agentsProject,
      onSwitch: opts.token
        ? undefined
        : async (root: string) => {
            const next = Scenaria.open(root);
            registerProject(next.root, next.config().projectName);
            const old = app;
            current = next;
            app = make(next);
            old.close("switch");
            if (!opts.quiet) process.stdout.write(`Scenaria → project: ${next.root}\n`);
            return { name: next.config().projectName, root: next.root };
          },
    });
  let app = make(s);
  // Agents' endpoints never follow the dashboard: their tool calls, pasted answers and the LLM proxy
  // keep writing into the project the server was started in (that is where they work and where
  // auto-save runs). Only requests from the dashboard itself (marked by its client) follow a switch.
  const home = app;
  const forAgents = (req: IncomingMessage) => {
    const p = (req.url ?? "/").split("?")[0];
    // Everything under /api/ that the dashboard did not mark (agents, scripts) stays on the start project;
    // the live-update stream (EventSource cannot send headers) only carries version numbers.
    return p.startsWith("/proxy/") || (p.startsWith("/api/") && p !== "/api/events" && req.headers["x-scenaria-view"] !== "dashboard");
  };
  const server = createServer((req, res) => (forAgents(req) ? home : app).handler(req, res));
  const host = opts.host ?? "127.0.0.1";
  let port = opts.port ?? 4477;
  await new Promise<void>((resolve, reject) => {
    const tryListen = (attempt: number) => {
      server.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && attempt < 10) {
          port += 1;
          tryListen(attempt + 1);
        } else reject(err);
      });
      server.listen(port, host, () => resolve());
    };
    tryListen(0);
  });
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  const uiUrl = opts.token ? (opts.showToken ? `${url}/?token=${encodeURIComponent(opts.token)}` : `${url}/?token=<your token>`) : url;
  if (!opts.quiet) process.stdout.write(
    [
      `Scenaria ${VERSION} → ${uiUrl}`,
      `  project: ${s.root}`,
      `  API:     ${url}/api/v1/tools  (schemas: ?format=openai|anthropic|gemini|json)`,
      `  Proxy:   ${url}/proxy/openai · /proxy/anthropic · /proxy/ollama · /proxy/<provider>  (records every conversation)`,
      opts.token ? `  auth:    Authorization: Bearer <token>` : `  mode:    local only (127.0.0.1)`,
      opts.token
        ? approverToken
          ? `  approve: ${url}/?approve=<approver token>  (canon approvals; keep this token away from agents)`
          : `  approve: off over HTTP (set SCENARIA_APPROVER_TOKEN to allow canon approvals in team mode)`
        : showLink
          ? `  approve: ${url}/?approve=${approvalCode}  (approval link for canon decisions — works once, only for you)`
          : `  approve: ${opts.open ? "opened in your browser" : "start Scenaria from your own terminal to get the approval link"}`,
      "Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) openBrowser(opts.token ? uiUrl : `${url}/?approve=${approvalCode}`);
  const approvalUrl = opts.token ? (approverToken ? `${url}/?approve=<approver token>` : null) : showLink ? `${url}/?approve=${approvalCode}` : null;
  return { server, url, approvalUrl, project: () => current, close: () => { app.close(); server.close(); } };
}
