import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Scenaria } from "./core/engine.js";
import { callTool, toolSchemas, type SchemaFormat, type ToolContext } from "./tools.js";
import { handleProxy } from "./proxy.js";
import { UI_DIR, embeddedUi, hasDiskUi } from "./assets.js";
import { agentPrompt, type PromptKind } from "./core/prompts.js";
import { applyBlocks } from "./core/blocks.js";
import { recall } from "./core/recall.js";
import { SECTIONS, checkExpectations, resolveRefs, workspace, type Section } from "./core/workspace.js";
import { acceptRule, analysisPrompt, dossier, importAnalysis, listAnalyses, projectMetrics, runAnalysis } from "./core/analysis.js";

export const VERSION = "0.5.0";

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

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("Body too large");
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
  let lastVersion = s.store.version();
  const timer = setInterval(() => {
    const v = s.store.version();
    if (v !== lastVersion) {
      lastVersion = v;
      for (const c of clients) c.write(`event: change\ndata: ${v}\n\n`);
    }
  }, 800);
  timer.unref();

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

        // ---------- analysis & rules ----------
        if (req.method === "GET" && p === "/api/analysis") return send(res, 200, projectMetrics(s));
        if (req.method === "GET" && p === "/api/analysis/list") return send(res, 200, listAnalyses(s));
        if (req.method === "GET" && p === "/api/analysis/dossier") {
          const lang = url.searchParams.get("lang") === "en" ? "en" : "de";
          const d = dossier(s, { maxTokens: Number(url.searchParams.get("maxTokens") ?? 8000) });
          return send(res, 200, { ...d, prompt: analysisPrompt(lang), text: `${analysisPrompt(lang)}\n\n--- DOSSIER ---\n${d.text}` });
        }
        if (req.method === "GET" && p === "/api/analysis/config") {
          return send(res, 200, { config: s.config().analysis ?? null, envKeys: KEY_ENVS.filter((k) => Boolean(process.env[k])), teamMode: Boolean(token) });
        }
        if (req.method === "POST" && p === "/api/analysis/config") {
          const b = await readBody(req);
          const c = s.config();
          if (!b?.provider || !b?.model) return send(res, 400, { error: "provider and model required" });
          if (token && b.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode (use proxy.upstreams in config.json)" });
          c.analysis = { provider: String(b.provider).slice(0, 40), model: String(b.model).slice(0, 120), baseUrl: b.baseUrl ? String(b.baseUrl).slice(0, 300) : undefined, apiKeyEnv: b.apiKeyEnv ? String(b.apiKeyEnv).slice(0, 80) : undefined };
          s.store.writeConfig(c);
          return send(res, 200, { ok: true, config: c.analysis });
        }
        if (req.method === "POST" && p === "/api/analysis/run") {
          const b = await readBody(req);
          if (token && b?.baseUrl) return send(res, 400, { error: "custom base URLs are disabled in team mode" });
          try {
            const rec = await runAnalysis(s, { provider: b?.provider, model: b?.model, baseUrl: b?.baseUrl, apiKey: b?.apiKey, apiKeyEnv: b?.apiKeyEnv, lang: b?.lang === "en" ? "en" : "de", maxTokens: b?.maxTokens });
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
  return { handler, close: () => clearInterval(timer) };
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

export async function startServer(
  s: Scenaria,
  opts: { port?: number; open?: boolean; host?: string; token?: string; showToken?: boolean; quiet?: boolean } = {},
) {
  const host0 = opts.host ?? "127.0.0.1";
  if (!isLoopbackHost(host0) && !opts.token) {
    throw new Error("Listening on a non-loopback host requires a token (--token or SCENARIA_TOKEN).");
  }
  const app = createApp(s, { token: opts.token });
  const server = createServer(app.handler);
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
      "Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) openBrowser(uiUrl);
  return { server, url, close: () => { app.close(); server.close(); } };
}
