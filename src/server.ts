import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenaria } from "./core/engine.js";

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

export function createApp(s: Scenaria) {
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    // DNS-rebinding protection: only answer to loopback host names.
    if (!isLoopbackHost(req.headers.host)) return send(res, 421, { error: "unexpected Host header" });
    if (req.method === "POST" && req.headers.origin && !isLoopbackHost(safeHost(req.headers.origin))) {
      return send(res, 403, { error: "cross-origin request rejected" });
    }
    try {
      if (p.startsWith("/api/")) {
        if (req.method === "POST" && req.headers["x-scenaria"] !== "1") return send(res, 403, { error: "missing X-Scenaria header" });

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
          const r = s.rewind(String(b.id), { lesson: b.lesson, restoreFiles: b.restoreFiles !== false, agent: "dashboard", source: "ui" });
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

export async function startServer(s: Scenaria, opts: { port?: number; open?: boolean; host?: string } = {}) {
  const app = createApp(s);
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
  process.stdout.write(`Scenaria dashboard → ${url}  (project: ${s.root})\nCtrl+C to stop.\n`);
  if (opts.open) openBrowser(url);
  return { server, url, close: () => { app.close(); server.close(); } };
}
