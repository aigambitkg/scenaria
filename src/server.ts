import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Scenaria } from "./core/engine.js";
import { callTool, toolSchemas, type SchemaFormat, type ToolContext } from "./tools.js";

export const VERSION = "0.2.0";

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
const UI_DIR = join(here, "ui");

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
        m = p.match(/^\/api\/node\/([\w-]+)$/);
        if (req.method === "GET" && m) return send(res, 200, s.node(m[1]));
        return send(res, 404, { error: "not found" });
      }

      // static UI
      if (!existsSync(UI_DIR)) {
        return send(res, 500, "Dashboard not built. Run: npm run build", "text/plain; charset=utf-8");
      }
      let file = normalize(join(UI_DIR, decodeURIComponent(p)));
      if (!file.startsWith(UI_DIR)) return send(res, 403, "forbidden", "text/plain");
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(UI_DIR, "index.html");
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(readFileSync(file));
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
  opts: { port?: number; open?: boolean; host?: string; token?: string; showToken?: boolean } = {},
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
  process.stdout.write(
    [
      `Scenaria ${VERSION} → ${uiUrl}`,
      `  project: ${s.root}`,
      `  API:     ${url}/api/v1/tools  (schemas: ?format=openai|anthropic|gemini|json)`,
      opts.token ? `  auth:    Authorization: Bearer <token>` : `  mode:    local only (127.0.0.1)`,
      "Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) openBrowser(uiUrl);
  return { server, url, close: () => { app.close(); server.close(); } };
}
