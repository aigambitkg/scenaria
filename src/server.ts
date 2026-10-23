import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { globalConfigPath } from "./core/global.js";

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
import { addAuditor, listAuditors, removeAuditor } from "./core/auditors.js";
import { buildAuditFile, parsePeriod } from "./core/auditfile.js";
import { exportAuditFile, renderAuditMarkdown } from "./core/auditexport.js";
import { CanonError, criterionAnchors, signRecord } from "./core/canon.js";
import { renderAuditHtml } from "./core/audithtml.js";
import { writeAuditPackage } from "./core/auditpackage.js";
import { addOrgEvidence, catalogueFingerprint, confirmOrgEvidence, copyOrgEvidence, entryDigest, OrgEvidenceError, orgEvidenceStates, planCopy, planRemove, removeOrgEvidence, validateInput } from "./core/orgevidence.js";
import { AUDIT_ACCESS_MODES, readAuditAccess, setAuditAccess, type AuditAccessMode } from "./core/auditaccess.js";
import { gateMatrix, runGate } from "./core/gate.js";
import { effectiveLlm, listModels, readSettings, upstreams, writeSettings } from "./core/settings.js";
import { listRelays, runRelay } from "./core/relay.js";
import { benchmarkInWorker, calibrationFor, forecastQuality } from "./core/predict.js";
import { autoBudget, evaluateForecasts, forecast, listForecasts, markUsed, openWithoutForecast, quickDecision, quickPrompt } from "./core/forecast.js";
import { auditForecast, auditOverview, auditReportMarkdown, deepAudit, listOracleBacktests, oracleBacktest, oracleQuality, pastDecisions } from "./core/auditor.js";
import { chat } from "./chat.js";
import { TARGETS, agentStatus, connectionSnippets, setupAgents, writeLauncher, type Target } from "./setup.js";
import { callLlm } from "./core/analysis.js";
import { projectProgress } from "./core/progress.js";
import { windowStatus } from "./core/window.js";
import { prepareHandover } from "./core/windowact.js";
import { CONTEXT_BOUNDS, CONTEXT_DEFAULTS, describeSettings, readContextSettings, setContextSettings } from "./core/contextsettings.js";
import { adoptRecommendation, expertAnalysis, factSheet, getReport, listPersonalReports, listReports } from "./core/expert.js";
import { forgetProject, listProjects, registerProject } from "./core/projects.js";
import { acceptRule, analysisPrompt, dossier, importAnalysis, listAnalyses, projectMetrics, runAnalysis } from "./core/analysis.js";

export const VERSION = "0.9.17";

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
  void launch(cmd, [path]);
}

/**
 * The operating system's own "open" program, by absolute path (S2-1): a program placed earlier in PATH
 * (or a BROWSER variable) must never receive the approval link.
 */
function systemOpener(): string | null {
  if (process.platform === "darwin") return "/usr/bin/open";
  if (process.platform === "win32") return join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  return ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open", "/bin/xdg-open"].find((x) => existsSync(x)) ?? null;
}

/** The environment for the opener: the caller's, without anything that redirects the link. */
function openerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BROWSER;
  if (process.platform !== "win32") env.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}

/** Start a helper program; resolves false when it does not exist (never crashes the server). */
function launch(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const c = spawn(cmd, args, { stdio: "ignore", detached: true, ...(env ? { env } : {}) });
      c.once("error", () => resolve(false)); // ENOENT arrives as an event, not as an exception
      c.once("spawn", () => {
        c.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
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
  linkState?: { secret?: string; extra?: Map<string, number> };
  /**
   * Auditor-mode browsers (C4c): sha256 of each read cookie → valid until. Shared by every app of one server
   * (project switches), kept only in the process (a restart ends every auditor mode).
   */
  auditViews?: Map<string, { until: number; seen: number }>;
  /** Least time between two auditor-mode starts (default 10 s; tests use 0). */
  auditViewEveryMs?: number;
  /** The server can switch the dashboard to another of the person's projects (local mode only). */
  onSwitch?: (root: string) => Promise<{ name: string; root: string }>;
  /** The project agents' HTTP/proxy endpoints of this server stay on (the one it was started with). */
  agentsProject?: { name: string; root: string };
  /**
   * Local mode only: open a fresh single-use approval link in the person's default browser. The code
   * never appears in an HTTP answer — it goes from this process straight to the OS browser.
   */
  openApproval?: (fromDashboard: boolean) => Promise<{ opened: true } | { opened: false; reason: "busy"; retryIn: number } | { opened: false; reason: "no_browser" }>;
  /** The project the dashboard shows right now (it can differ from the one agents write to). */
  viewRoot?: () => string;
}

/** Identifies a project folder without naming it (lets a second `scenaria start` find a running one). */
export function rootKey(root: string): string {
  return createHash("sha256").update(realRoot(root)).digest("hex").slice(0, 16);
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
  // Auditor mode on site (C4c, Kev 2026-10-16): the person hands this browser to an auditor. It gets a separate,
  // read-only cookie for the audit file (8 h, kept only in this process) and loses the approval cookie, so the
  // server refuses every person action from it. Ending the mode drops the read cookie; acting again needs the
  // person's approval (the lock).
  // The list is shared by every app of one server (review C4c-1 K2) and capped (K8); keys are sha256 of the cookie.
  const auditViews = opts.auditViews ?? new Map<string, { until: number; seen: number }>();
  const AUDIT_VIEW_MS = 8 * 3600_000;
  const AUDIT_VIEW_MAX = 5;
  const AUDIT_VIEW_IDLE_MS = 10 * 60_000;
  const viewKey = (v: string) => createHash("sha256").update(v).digest("hex");
  // Only cookies Scenaria issued count (review C4c-1 R1): "<random>.<valid until, ms>.<HMAC>", the HMAC key kept in
  // the person's config folder (mode 600; agents run without access to it, HANDOFF §2 rule 6). A cookie planted by
  // another page on 127.0.0.1 (cookies do not separate ports) is ignored: it neither locks nor reads anything.
  const viewSign = (body: string) => createHmac("sha256", auditViewKey()).update(`scenaria-auditview/v1|${body}`).digest("hex").slice(0, 32);
  const viewValue = (rand: string, until: number) => `${rand}.${until.toString(36)}.${viewSign(`${rand}.${until.toString(36)}`)}`;
  const ours = (v: string) => {
    const m = /^([0-9a-f]{48})\.([0-9a-z]{1,12})\.([0-9a-f]{32})$/.exec(v);
    if (!m) return false;
    try {
      return tokenMatches(m[3], viewSign(`${m[1]}.${m[2]}`));
    } catch {
      return false;
    }
  };
  const pruneViews = () => {
    const now = Date.now();
    for (const [k, e] of auditViews) if (e.until < now) auditViews.delete(k);
  };
  /** Every non-empty value of the auditor-mode cookie this request carries (valid or not). */
  const viewCookies = (req: IncomingMessage) => (opts.token ? [] : [...(req.headers.cookie ?? "").matchAll(/(?:^|;)\s*scenaria_auditview=([^;]*)/g)].map((m) => m[1].trim()).filter((v) => v !== "" && ours(v)));
  /** A valid, unexpired auditor mode: the browser may read the audit file. */
  const isAuditView = (req: IncomingMessage) => {
    const vs = viewCookies(req);
    if (!vs.length) return false;
    pruneViews();
    const e = vs.map((v) => auditViews.get(viewKey(v))).find(Boolean);
    if (e) e.seen = Date.now(); // the auditor's dashboard checks in every 2 min (review C4c-1 S1)
    return Boolean(e);
  };
  /** Any auditor-mode cookie Scenaria issued (also an expired one, or one from before a restart): this browser never writes (fail closed). Local mode only (R3). */
  const hasViewCookie = (req: IncomingMessage) => viewCookies(req).length > 0;
  const endViews = (req: IncomingMessage) => {
    let ended = false;
    for (const v of viewCookies(req)) if (auditViews.delete(viewKey(v))) ended = true;
    return ended;
  };
  const CLEAR_VIEW = "scenaria_auditview=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
  let lastViewStart = 0;
  let lastVersion = s.store.version();
  // Automatic multiverse forecasts for open decisions on the current line — only when the person
  // switched it on in Settings, only with the model the PERSON chose (never the project file), with a
  // daily limit. One at a time; at most two attempts per decision, then it is reported as failed.
  let forecasting: string | null = null;
  // What the person's model is doing right now (multiverse, AI check, backtest): shown while it runs.
  type Job = { kind: "multiverse" | "audit" | "backtest"; subject: string; step: string; index?: number; total?: number; startedAt: string };
  let job: Job | null = null;
  let jobCtrl: AbortController | null = null;
  const runJob = async <T>(j: Omit<Job, "startedAt" | "step">, fn: (step: (st: Partial<Job>) => void, signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (job) throw new Error(`Läuft gerade: ${job.kind} ${job.subject} — bitte warten. / Already running: ${job.kind} ${job.subject}.`);
    job = { ...j, step: "start", startedAt: new Date().toISOString() };
    jobCtrl = new AbortController();
    try {
      return await fn((st) => {
        if (job) job = { ...job, ...st };
      }, jobCtrl.signal);
    } finally {
      job = null;
      jobCtrl = null;
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

    // Auditor mode (C4c): a browser the person handed to an auditor only reads. Every write is refused — also the
    // ones agents may do (save now, goal, go back, tools, the LLM proxy) and the lock — except ending the mode.
    // Fail closed (review C4c-1 K2, K6): any auditor-mode cookie counts, also an expired or unknown one.
    if (req.method !== "GET" && req.method !== "HEAD" && p !== "/api/audit-file/auditor-mode/end" && hasViewCookie(req)) {
      return send(res, 403, { error: "This browser is in auditor mode (read only): nothing can be changed here.", code: "auditor_mode" });
    }

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
      // The code is used up FIRST, also when this browser is already approved — otherwise an unused
      // code would stay valid (in the browser history) for anyone who replays it.
      const given = url.searchParams.get("approve") ?? undefined;
      let redeemed = false;
      if (link.secret && tokenMatches(given, link.secret)) {
        redeemed = true;
        if (!opts.token) link.secret = undefined; // single use (also across project switches)
      } else if (link.extra) {
        const now = Date.now();
        for (const [code, until] of link.extra) {
          if (until < now) link.extra.delete(code);
          else if (tokenMatches(given, code)) {
            link.extra.delete(code);
            redeemed = true;
          }
        }
      }
      if (redeemed && hasViewCookie(req)) {
        // A browser in auditor mode never becomes approved by a link (review C4c-1 K1: an agent could have the link
        // opened in exactly that browser). The link is used up, the auditor mode ends here; the person unlocks again.
        if (endViews(req)) s.store.appendEvent({ type: "update", data: { message: "auditor mode ended in a browser (an approval link was opened there; no approval given)" } });
        res.writeHead(302, { location: "/?approval=auditor", "set-cookie": CLEAR_VIEW });
        return res.end();
      }
      if (redeemed) {
        res.writeHead(302, { location: "/", "set-cookie": `scenaria_approval=${encodeURIComponent(approvalSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
        return res.end();
      }
      if (isApprover(req)) {
        res.writeHead(302, { location: "/" });
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
        if (req.method === "GET" && p === "/api/head-at") {
          const until = url.searchParams.get("until") ?? "";
          if (Number.isNaN(Date.parse(until))) return send(res, 400, { error: "until must be a date (ISO 8601)" });
          return send(res, 200, { id: s.headAt(new Date(until).toISOString()) });
        }
        if (req.method === "GET" && p === "/api/v1/health") return send(res, 200, { ok: true, name: "scenaria", version: VERSION, project: s.config().projectName, rootKey: rootKey(s.root), viewKey: rootKey(opts.viewRoot?.() ?? s.root) });
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
        // Batch E2: progress per task and for the project, each with its derivation (read-only, computed from evidence).
        if (req.method === "GET" && p === "/api/progress") return send(res, 200, projectProgress(s));
        // Batch E3a-1: how full the agents' context windows are, each number with its derivation (read-only, measured).
        if (req.method === "GET" && p === "/api/windows") return send(res, 200, windowStatus(s));
        // E3b-1: the values of the context-window rule. Reading is open (rule 10: nothing secret); setting them is the
        // person's (POST under the personOnly prefix: approval session).
        if (req.method === "GET" && p === "/api/context-settings") {
          const cs = readContextSettings(s.store);
          return send(res, 200, { ...cs, text: describeSettings(cs), defaults: CONTEXT_DEFAULTS, bounds: CONTEXT_BOUNDS, approval: isApprover(req) });
        }
        if (req.method === "GET" && p === "/api/handover") {
          const w = url.searchParams.get("window") ?? undefined;
          return send(res, 200, prepareHandover(s, { window: w }));
        }
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
        if (req.method === "GET" && p === "/api/approval") return send(res, 200, { granted: isApprover(req), mode: token ? (opts.approverToken ? "team" : "disabled") : "local", auditView: isAuditView(req) ? true : hasViewCookie(req) ? "stale" : false });
        if (req.method === "GET" && p === "/api/canon") {
          const st = s.canonState();
          // letGo (E2): missing criteria the person can let go (they hold their task back until then).
          const anchored = criterionAnchors(s.store);
          return send(res, 200, { events: st.events, error: st.error, missing: st.missing, letGo: st.missing.filter((id) => anchored[id]).map((id) => ({ id, text: anchored[id].text ?? "" })), suggestions: st.error ? [] : s.suggestCanon(), approval: isApprover(req) });
        }
        // Binding canon actions, the person's settings, the built-in chat and the relay: only with the
        // approval session (not with the API/agent token) — they act for the person or use the person's keys.
        // (The archivist and the analysis also spend the person's quota with the person's keys.)
        const personOnly = p.startsWith("/api/auditors") || p.startsWith("/api/integrity") || p.startsWith("/api/canon") || p.startsWith("/api/settings") || p.startsWith("/api/agents") || p === "/api/chat" || p === "/api/relay" || p.startsWith("/api/forecast") || p === "/api/analysis/run" || p === "/api/analysis/config" || p.startsWith("/api/expert") || p.startsWith("/api/projects") || p.startsWith("/api/rules") || p === "/api/analysis/accept" || p.startsWith("/api/audit-file") || p.startsWith("/api/context-settings");
        // The person gets the approval mode without copying a link: Scenaria opens a fresh single-use link
        // in the default browser itself. Nothing secret is returned; at most once per 15 s; logged.
        if (req.method === "POST" && p === "/api/approval/open") {
          if (token) return send(res, 400, { error: "Team mode: open the dashboard with the approver link (SCENARIA_APPROVER_TOKEN).", code: "team_mode" });
          if (isApprover(req)) return send(res, 200, { ok: true, already: true });
          // While a browser is handed to an auditor, nobody opens an approval link: it would land in the default
          // browser — maybe the auditor's (review C4c-1 K1, S1; the dashboard mark is only a claim). An auditor
          // browser counts while its dashboard checked in during the last 10 minutes (it does so every 2 minutes),
          // so a browser that lost its cookie does not lock the person out for long (R2). A link redeemed in a
          // browser in auditor mode never approves it (see the approval link above).
          pruneViews();
          const recent = Date.now() - AUDIT_VIEW_IDLE_MS;
          if ([...auditViews.values()].some((e) => e.seen >= recent)) {
            return send(res, 409, { error: "A browser is in auditor mode: end the auditor mode there first, then unlock. (If that window was closed, the lock works again 10 minutes later, or after restarting Scenaria.)", code: "auditor_mode_active" });
          }
          if (!opts.openApproval) return send(res, 409, { error: "This Scenaria cannot open your browser. Start it with scenaria start (or the start icon).", code: "no_browser" });
          const fromDashboard = req.headers["x-scenaria-view"] === "dashboard";
          const r = await opts.openApproval(fromDashboard);
          if (!r.opened && r.reason === "busy") return send(res, 429, { error: `Just opened — try again in ${r.retryIn} s.`, code: "busy", retryIn: r.retryIn });
          if (!r.opened) return send(res, 409, { error: "This Scenaria cannot open your browser. Start it with scenaria start (or the start icon).", code: "no_browser" });
          // The dashboard mark is only a claim (any local client can send it): logged as such, with the client's name.
          s.store.appendEvent({ type: "update", data: { message: `approval link opened in the default browser (asked by ${fromDashboard ? "a client marked as the dashboard" : `${ctx.agent}, not marked as the dashboard`}; user agent: ${String(req.headers["user-agent"] ?? "-").slice(0, 80)})` } });
          return send(res, 200, { ok: true, opened: true });
        }
        // Ending the auditor mode only drops a read cookie: anyone in that browser may do it.
        if (req.method === "POST" && p === "/api/audit-file/auditor-mode/end") {
          // Logged only when this browser really was in auditor mode (anyone may call this route).
          if (endViews(req)) s.store.appendEvent({ type: "update", data: { message: "auditor mode ended in a browser" } });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": CLEAR_VIEW });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (personOnly && req.method === "POST" && !isApprover(req)) {
          return send(res, 403, { error: "This is the person's action (approvals, settings, chat, relay, analysis with your keys): click the lock (Open approval mode) in the dashboard (or open the approval link from the terminal running Scenaria). Agents can only propose.", code: "approval_required" });
        }
        // The approver is the person at this machine (local) — client-supplied names are only a claim in team mode.
        const approver = token ? `${ctx.user ?? "approver"} (team approver link)` : `${defaultUserName()} (local approval link)`;
        if (req.method === "GET" && p === "/api/v1/string") return send(res, 200, stringPayload(s, url.searchParams.get("at") ?? undefined));

        // ---------- ISO/IEC 42001 audit file (Batch C2): who may read it is the person's setting ----------
        // E3b-1: setting the context-window rule is the person's (personOnly prefix above: approval session only).
        if (req.method === "POST" && p === "/api/context-settings") {
          const b = await readBody(req);
          try {
            const cs = setContextSettings(s.store, { values: b?.values, models: b?.models, reset: b?.reset === true }, { by: approver, via: "dashboard" });
            return send(res, 200, { ...cs, text: describeSettings(cs), defaults: CONTEXT_DEFAULTS, bounds: CONTEXT_BOUNDS, approval: true });
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err), code: err?.code ?? "invalid", ...(typeof err?.key === "string" ? { key: err.key } : {}) });
          }
        }
        if (req.method === "GET" && p === "/api/audit-file/access") {
          const a = readAuditAccess(s.store);
          return send(res, 200, { ...a, modes: AUDIT_ACCESS_MODES, approval: isApprover(req) });
        }
        if (req.method === "POST" && p === "/api/audit-file/access") {
          const b = await readBody(req);
          const mode = String(b?.mode ?? "") as AuditAccessMode;
          if (!AUDIT_ACCESS_MODES.includes(mode)) return send(res, 400, { error: `mode must be one of: ${AUDIT_ACCESS_MODES.join(", ")}` });
          const a = setAuditAccess(s.store, mode, { by: approver, via: "dashboard" });
          return send(res, 200, { ...a, modes: AUDIT_ACCESS_MODES, approval: true });
        }
        if (req.method === "GET" && p === "/api/audit-file") {
          // Default "person": only the approval session (or the auditor mode the person opened) reads the audit file.
          if (readAuditAccess(s.store).mode !== "open" && !isApprover(req) && !isAuditView(req)) {
            // The setting protects the audit file itself; the raw records stay readable as before (rule 10).
            const how = token ? "open the dashboard with the approver link (SCENARIA_APPROVER_TOKEN)" : "click the lock (Open approval mode) in the dashboard";
            return send(res, 403, { error: `Only the person reads the audit file (their setting): ${how}. The person can open it to everyone: scenaria audit-file access open.`, code: "approval_required" });
          }
          let period;
          try {
            period = parsePeriod(url.searchParams.get("from"), url.searchParams.get("to"));
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
          return send(res, 200, buildAuditFile(s, period));
        }
        // Auditor mode on site (C4c): the person starts it; this browser becomes read-only.
        if (req.method === "POST" && p === "/api/audit-file/auditor-mode") {
          if (token) return send(res, 400, { error: "Team mode: give the auditor the audit package instead.", code: "team_mode" });
          if (Date.now() - lastViewStart < (opts.auditViewEveryMs ?? 10_000)) return send(res, 429, { error: "Just started — try again in a few seconds.", code: "busy" });
          lastViewStart = Date.now();
          const until = Date.now() + AUDIT_VIEW_MS;
          const secret = viewValue(randomBytes(24).toString("hex"), until);
          pruneViews();
          while (auditViews.size >= AUDIT_VIEW_MAX) auditViews.delete(auditViews.keys().next().value!);
          auditViews.set(viewKey(secret), { until, seen: Date.now() });
          s.store.appendEvent({ type: "update", data: { message: "auditor mode started in a browser (read-only, 8 h)", by: approver } });
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "set-cookie": [`scenaria_auditview=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUDIT_VIEW_MS / 1000}`, "scenaria_approval=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"],
          });
          return res.end(JSON.stringify({ ok: true, hours: 8 }));
        }
        // The audit package from the dashboard (C4c): local mode only; written to the person's Downloads folder.
        if (req.method === "POST" && p === "/api/audit-file/package") {
          if (token) return send(res, 400, { error: "Team mode: create the audit package with the CLI on the project's machine (scenaria audit-file export).", code: "team_mode" });
          const b = await readBody(req);
          let period;
          try {
            period = parsePeriod(typeof b?.from === "string" ? b.from : null, typeof b?.to === "string" ? b.to : null);
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
          const lang = b?.lang === "en" ? "en" : "de";
          // The folder is checked BEFORE signing (review C4c-1 K3, K4): an absolute home, a real folder, writable,
          // and never inside a project (a Downloads link into the project would put the package there).
          const home = homedir();
          if (!home || !isAbsolute(home)) return send(res, 400, { error: "Your home folder is not known: create the audit package with the CLI (scenaria audit-file export --out-dir <folder>).", code: "no_home" });
          const realDir = (d: string) => {
            try {
              return statSync(d).isDirectory() ? realpathSync.native(d) : null;
            } catch {
              return null;
            }
          };
          // macOS and Windows compare folder names without case (review C4c-1 R5).
          const fold = (x: string) => (process.platform === "darwin" || process.platform === "win32" ? x.toLowerCase() : x);
          const downloads = realDir(join(home, "Downloads"));
          const parent = downloads ?? realDir(home);
          const inside = (d: string, root: string) => {
            const a = fold(d);
            const b = fold(realDir(root) ?? realRoot(root));
            return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
          };
          if (!parent) return send(res, 400, { error: "No folder to write the audit package to (Downloads or your home folder).", code: "no_folder" });
          if ([s.root, opts.viewRoot?.() ?? s.root].some((r) => inside(parent, r))) {
            return send(res, 400, { error: "The Downloads folder points into a project: create the audit package with the CLI (scenaria audit-file export --out-dir <folder>).", code: "inside_project" });
          }
          try {
            accessSync(parent, fsConstants.W_OK);
          } catch {
            return send(res, 400, { error: "Scenaria cannot write to your Downloads folder.", code: "not_writable" });
          }
          const x = exportAuditFile(s, period, { names: b?.names === "roles-only" ? "roles-only" : "with-names", version: VERSION, by: approver, via: "dashboard" });
          let folder: string;
          try {
            folder = writeAuditPackage(parent, x, lang, (parts) => signRecord(s.store, parts));
          } catch (err: any) {
            // Never a machine path in an answer.
            return send(res, 400, { error: `The audit package could not be written${typeof err?.code === "string" ? ` (${err.code})` : ""}.`, code: "package_failed" });
          }
          if (b?.open !== false) void openLocalFile(join(folder, "audit-file.html"));
          return send(res, 200, { folder: basename(folder), where: downloads ? "downloads" : "home", digest: x.signature.digest, keyId: x.signature.keyId, names: x.names });
        }
        // Signed export (C4a): signing with the approver key is the person's (POST under the personOnly prefix).
        if (req.method === "POST" && p === "/api/audit-file/export") {
          const b = await readBody(req);
          let period;
          try {
            period = parsePeriod(typeof b?.from === "string" ? b.from : null, typeof b?.to === "string" ? b.to : null);
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
          const x = exportAuditFile(s, period, { names: b?.names === "roles-only" ? "roles-only" : "with-names", version: VERSION, by: approver, via: "dashboard" });
          const lang = b?.lang === "en" ? "en" : "de";
          return send(res, 200, { export: x, markdown: renderAuditMarkdown(x, lang), html: renderAuditHtml(x, lang) });
        }
        // The organisation's evidence per control (C3): read like the audit file; every change is the person's
        // (all POST /api/audit-file* are under the personOnly prefix above).
        if (req.method === "GET" && p === "/api/audit-file/evidence") {
          if (readAuditAccess(s.store).mode !== "open" && !isApprover(req) && !isAuditView(req)) {
            const how = token ? "open the dashboard with the approver link (SCENARIA_APPROVER_TOKEN)" : "click the lock (Open approval mode) in the dashboard";
            return send(res, 403, { error: `Only the person reads the audit file (their setting): ${how}.`, code: "approval_required" });
          }
          const st = orgEvidenceStates(s.store);
          return send(res, 200, { ...st, catalogue: catalogueFingerprint(), approval: isApprover(req) });
        }
        if (req.method === "POST" && p.startsWith("/api/audit-file/evidence")) {
          const b = await readBody(req);
          const who = { by: approver, via: "dashboard" as const };
          try {
            // C4c-2: the dashboard first shows exactly what would be signed (dryRun: the values checked and normalised,
            // nothing written), then sends those values; normalising is idempotent, so the signed entry is the one shown.
            if (p === "/api/audit-file/evidence" && b?.dryRun === true) return send(res, 200, { input: validateInput(b ?? {}) });
            if (p === "/api/audit-file/evidence") return send(res, 200, { entry: addOrgEvidence(s.store, b ?? {}, who) });
            if (p === "/api/audit-file/evidence/remove") {
              const id = String(b?.id ?? "");
              const discard = b?.discard === true;
              // dryRun: what removing would do and the digest of the entry concerned (the person sees it first).
              if (b?.dryRun === true) {
                const plan = planRemove(s.store, id, { discard });
                return send(res, 200, { ...plan, digest: entryDigest(plan.entry) });
              }
              // The plan comes first: the outcome and the digest the person saw are required (review C4c-2 K3).
              const ex = b?.expect;
              if (!ex || typeof ex !== "object" || typeof ex.outcome !== "string" || typeof ex.digest !== "string") {
                return send(res, 400, { error: "Show the plan first (dryRun: true), then remove with expect: {outcome, digest} as shown.", code: "plan_first" });
              }
              return send(res, 200, removeOrgEvidence(s.store, id, who, { discard, expect: { outcome: ex.outcome, digest: ex.digest } }));
            }
            // The digest of exactly what the person was shown (GET …/evidence lists it per entry).
            if (p === "/api/audit-file/evidence/confirm") return send(res, 200, { entry: confirmOrgEvidence(s.store, String(b?.id ?? ""), String(b?.digest ?? ""), who) });
            if (p === "/api/audit-file/evidence/copy") {
              // Only from a project the person has on this machine (the dashboard's project list), never any folder.
              const from = listProjects().find((x) => realRoot(x.root) === realRoot(String(b?.from ?? "")));
              if (!from) return send(res, 400, { error: "Choose one of your projects on this machine.", code: "not_a_project" });
              const controls = Array.isArray(b?.controls) ? b.controls.filter((x: unknown): x is string => typeof x === "string") : undefined;
              // First the plan (what would be taken over), then the copy of exactly the ids the person saw.
              if (b?.dryRun === true) return send(res, 200, planCopy(s.store, from.root, controls));
              // What the person saw: the project name that gets recorded and every entry's digest (review C4c-2 K1).
              const ex = b?.expect;
              if (!ex || typeof ex !== "object" || Array.isArray(ex) || typeof ex.name !== "string" || !Array.isArray(ex.entries)) {
                return send(res, 400, { error: "Show the plan first (dryRun: true), then copy with expect: {name, entries: [{id, digest}]} as shown.", code: "plan_first" });
              }
              const entries = ex.entries.filter((x: any) => x && typeof x.id === "string" && typeof x.digest === "string").map((x: any) => ({ id: x.id, digest: x.digest }));
              return send(res, 200, copyOrgEvidence(s.store, from.root, who, controls, { name: ex.name, entries }));
            }
          } catch (err: any) {
            if (err instanceof OrgEvidenceError) return send(res, 400, { error: err.message, code: err.code });
            throw err;
          }
        }

        // ---------- registered audit agents (rule 11): list is open (public keys), changes are the person's ----------
        if (req.method === "GET" && p === "/api/auditors") return send(res, 200, { auditors: listAuditors(), approval: isApprover(req) });
        if (req.method === "POST" && p === "/api/auditors/add") {
          const b = await readBody(req);
          const k = addAuditor(String(b?.pub ?? ""), b?.name ? String(b.name) : undefined);
          s.store.appendEvent({ type: "update", data: { message: `audit agent ${k.id}${k.name ? ` (${k.name})` : ""} registered by ${approver}` } });
          return send(res, 200, k);
        }
        // Reseal the integrity ledger: the person's (approval session), after reviewing the findings.
        if (req.method === "POST" && p === "/api/integrity/reseal") {
          const r = s.reseal({ kind: "person", via: "dashboard" }, { user: approver, agent: "dashboard", source: "ui" });
          return send(res, 200, { archived: r.archived, nodes: r.nodes, record: r.record.id });
        }
        if (req.method === "POST" && p === "/api/auditors/remove") {
          const b = await readBody(req);
          const ok = removeAuditor(String(b?.id ?? ""));
          if (ok) s.store.appendEvent({ type: "update", data: { message: `audit agent ${b.id} unregistered by ${approver}` } });
          return send(res, 200, { removed: ok });
        }

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
        if (req.method === "POST" && p === "/api/agents/launcher") {
          if (token) return send(res, 400, { error: "Start icons are for local use only." });
          const file = writeLauncher(s.root);
          s.store.appendEvent({ type: "update", data: { message: `start icon created by ${approver}` } });
          return send(res, 200, { ok: true, file });
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
        if (req.method === "POST" && p === "/api/forecast/cancel") {
          // The person stops a running model call (person-only like every POST under /api/forecast).
          const was = job;
          jobCtrl?.abort();
          return send(res, 200, { cancelled: Boolean(was), job: was });
        }
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
            const rec = await runJob({ kind: "audit", subject: String(b?.id ?? "") }, (step, signal) => {
              step({ step: "auditor" });
              return deepAudit(s, String(b?.id ?? ""), { lang, llm: b?.llm, signal });
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
            const rec = await runJob({ kind: "backtest", subject: decisions?.join(", ") ?? "last decisions" }, (step, signal) =>
              oracleBacktest(s, { limit: Number(b?.limit) || 5, decisions, lang: b?.lang === "en" ? "en" : "de", llm: b?.llm, signal, onStep: (st) => step({ step: st.role, subject: st.decision, index: st.index + 1, total: st.total }) }),
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
            return send(res, 200, await runJob({ kind: "multiverse", subject: fr.node ?? "prompt" }, (step, signal) => forecast(s, { ...fr, signal, onStep: (st) => step({ step: st }) })));
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
          return send(res, 200, s.addCanonAsUser({ kind: b?.kind, text: String(b?.text ?? ""), hard: b?.hard !== false, check: b?.check, due: b?.due || undefined, evidence: Array.isArray(b?.evidence) ? b.evidence : undefined, task: b?.task || undefined, weight: b?.weight ?? undefined, artifact: b?.artifact || undefined }, { user: approver, via: "dashboard" }));
        }
        if (req.method === "POST" && p === "/api/canon/decide") {
          const b = await readBody(req);
          if (!["approve", "reject", "retire", "confirm", "reweigh"].includes(b?.action)) return send(res, 400, { error: "action must be approve, reject, retire, confirm or reweigh" });
          const adoptCheck = typeof b?.adoptCheck === "string" ? b.adoptCheck : b?.adoptCheck === true;
          // What the person saw (text, task, weight, file): a criterion is approved only exactly so (E2a review M3).
          const x = b?.expect && typeof b.expect === "object" ? b.expect : null;
          const expect = x ? { text: String(x.text ?? ""), task: typeof x.task === "string" ? x.task : undefined, weight: typeof x.weight === "number" ? x.weight : undefined, artifact: typeof x.artifact === "string" ? x.artifact : undefined } : undefined;
          // A refusal carries its code (CanonError): the dashboard says it in the person's language (E2b review M3).
          return send(res, 200, s.decideCanon(String(b?.id ?? ""), b.action, { user: approver, via: "dashboard", reason: b?.reason, adoptCheck, weight: b?.weight ?? undefined, expect }));
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
          return send(res, 200, acceptRule(s, String(b?.id ?? ""), Number(b?.index), { by: approver, via: "dashboard" }));
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
            return send(res, 200, adoptRecommendation(s, String(b?.id ?? ""), Number(b?.index), { by: approver, via: "dashboard" }));
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) });
          }
        }
        // ---------- project rules: agents read the active ones; adding, accepting, rejecting and removing are the person's ----------
        if (req.method === "GET" && p === "/api/rules") return send(res, 200, s.rules());
        // The texts of proposals and of rules waiting for confirmation are for the person; agents only learn counts.
        if (req.method === "GET" && p === "/api/rules/proposals") {
          const proposals = s.ruleProposals();
          const issues = s.ruleIssues();
          const approval = isApprover(req);
          return send(res, 200, {
            proposals: approval ? proposals : [],
            count: proposals.length,
            unconfirmed: approval ? issues.unconfirmed : [],
            tampered: approval ? issues.tampered : [],
            missing: approval ? issues.missing : [],
            needsYou: issues.unconfirmed.length + issues.tampered.length,
            approval,
          });
        }
        if (req.method === "POST" && p === "/api/rules") {
          const b = await readBody(req);
          if (!String(b?.text ?? "").trim()) return send(res, 400, { error: "rule text is empty" });
          return send(res, 200, s.addRule(String(b.text), "manual", undefined, { by: approver, via: "dashboard" }));
        }
        if (req.method === "POST" && p === "/api/rules/delete") {
          const b = await readBody(req);
          const ok = s.removeRule(String(b?.id ?? ""), { by: approver, via: "dashboard" });
          return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: `No rule ${String(b?.id ?? "")}` });
        }
        if (req.method === "POST" && p === "/api/rules/approve") {
          const b = await readBody(req);
          // The person accepts the text they saw: without it (or if it changed) nothing is accepted.
          if (typeof b?.text !== "string" || !b.text.trim()) return send(res, 400, { error: "text required: the proposal's text as shown to you" });
          try {
            return send(res, 200, s.approveRule(String(b?.id ?? ""), { by: approver, via: "dashboard" }, b.text));
          } catch (err: any) {
            const msg = String(err?.message ?? err);
            return send(res, /^No rule/.test(msg) ? 404 : /busy/.test(msg) ? 503 : 409, { error: msg });
          }
        }
        if (req.method === "POST" && p === "/api/rules/confirm") {
          const b = await readBody(req);
          if (typeof b?.text !== "string" || !b.text.trim()) return send(res, 400, { error: "text required: the rule's text as shown to you" });
          try {
            return send(res, 200, s.confirmRule(String(b?.id ?? ""), { by: approver, via: "dashboard" }, b.text));
          } catch (err: any) {
            const msg = String(err?.message ?? err);
            return send(res, /^No rule/.test(msg) ? 404 : /busy/.test(msg) ? 503 : 409, { error: msg });
          }
        }
        if (req.method === "POST" && p === "/api/rules/reject") {
          const b = await readBody(req);
          const ok = s.rejectRule(String(b?.id ?? ""), { by: approver, via: "dashboard" });
          return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: `No open proposal ${String(b?.id ?? "")}` });
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
          // A verdict counts only from the person (rule 11): the approval session. Without it, only the automatic checks run.
          if (b?.status && !isApprover(req)) {
            return send(res, 403, { error: "A verdict is the person's: click the lock (Open approval mode) in the dashboard. Without it you can run the automatic checks; agents record self-reported verdicts with scenaria_verify.", code: "approval_required" });
          }
          return send(res, 200, s.verify(String(b.id), { status: b.status, notes: b.notes, by: b.status ? approver : "dashboard", auto: b.auto !== false, runCommand: Boolean(b.runCommand), ...(b.status ? { origin: "person" as const, via: "dashboard" } : {}) }));
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
      // A refused change to the fixed points says why with a code the dashboard translates (E2b review M3).
      if (err instanceof CanonError) send(res, err.status, { error: err.message, code: err.code });
      else send(res, 400, { error: err?.message ?? String(err) });
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

/** For tests: SCENARIA_NO_BROWSER=1 records the URL instead of opening a browser. */
export const browserLog: string[] = [];

function openBrowser(url: string): Promise<boolean> {
  if (process.env.SCENARIA_NO_BROWSER) {
    browserLog.push(url);
    return Promise.resolve(process.env.SCENARIA_NO_BROWSER !== "fail");
  }
  const cmd = systemOpener();
  if (!cmd) return Promise.resolve(false);
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return launch(cmd, args, openerEnv());
}

/** Open a local file with the system's own program (absolute paths only; tests: recorded in browserLog). */
function openLocalFile(path: string): Promise<boolean> {
  if (process.env.SCENARIA_NO_BROWSER) {
    browserLog.push(path);
    return Promise.resolve(true);
  }
  if (process.platform === "darwin") return launch("/usr/bin/open", [path], openerEnv());
  if (process.platform === "win32") return launch(join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", path], openerEnv());
  const x = ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open", "/bin/xdg-open"].find((f) => existsSync(f));
  return x ? launch(x, [path], openerEnv()) : Promise.resolve(false);
}

/**
 * The key that signs auditor-mode cookies (C4c, review R1): 32 random bytes in the person's config folder (mode 600),
 * created on first use. Agents run without access to that folder (HANDOFF §2 rule 6), so they cannot make a cookie
 * Scenaria would count. Kept across restarts, so a browser handed to an auditor stays read-only after a restart.
 */
let auditViewKeyCache: Buffer | null = null;
function auditViewKey(): Buffer {
  if (auditViewKeyCache) return auditViewKeyCache;
  const f = join(dirname(globalConfigPath()), "auditview.key");
  let tooShort = false;
  try {
    const k = readFileSync(f);
    if (k.length >= 32) return (auditViewKeyCache = k);
    tooShort = true;
  } catch {}
  const k = randomBytes(32);
  try {
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    if (tooShort) {
      // A damaged key is replaced on disk, never kept only in memory: otherwise an auditor's cookie would stop
      // counting after a restart and that browser could write again (C5, fail closed).
      const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, k, { mode: 0o600, flag: "wx" });
      renameSync(tmp, f);
      // Two processes replacing it at once: both use the one that ended up on disk.
      const onDisk = readFileSync(f);
      return (auditViewKeyCache = onDisk.length >= 32 ? onDisk : k);
    }
    writeFileSync(f, k, { mode: 0o600, flag: "wx" });
  } catch {
    // Another process created it at the same moment: use that one.
    try {
      const other = readFileSync(f);
      if (other.length >= 32) return (auditViewKeyCache = other);
    } catch {}
  }
  return (auditViewKeyCache = k);
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
  // The approval link is handed to the browser only, never printed (S1-1): a program that fakes a terminal
  // would read it. `--print-approval-link` exists for a machine without a browser, chosen by the person.
  const showLink = opts.showApprovalLink ?? false;
  const approverToken = opts.approverToken ?? process.env.SCENARIA_APPROVER_TOKEN;
  registerProject(s.root, s.config().projectName);
  // One server, one approval session for the person; the dashboard can switch between their projects.
  // Every app keeps its own project: requests already running finish in the project they started in.
  const approvalSecret = randomBytes(24).toString("hex");
  const linkState: { secret?: string; extra?: Map<string, number> } = { secret: opts.token ? approverToken : approvalCode, extra: new Map() };
  // One list of auditor-mode browsers for every app of this server (a project switch keeps the mode; C4c-1 K2).
  const auditViews = new Map<string, { until: number; seen: number }>();
  let current = s;
  const agentsProject = { name: s.config().projectName, root: s.root };
  let baseUrl = "";
  let lastOpen = 0;
  // Fresh links live next to the start link (which stays valid until used): each single use, 60 s.
  // A request that is not from the dashboard (an agent, a script) waits longer between openings.
  const openApproval: AppOptions["openApproval"] = opts.token
    ? undefined
    : async (fromDashboard) => {
        const wait = (fromDashboard ? 15_000 : 60_000) - (Date.now() - lastOpen);
        if (wait > 0) return { opened: false, reason: "busy", retryIn: Math.ceil(wait / 1000) };
        lastOpen = Date.now();
        const code = randomBytes(18).toString("base64url");
        const extra = linkState.extra!;
        extra.set(code, Date.now() + 60_000);
        while (extra.size > 3) extra.delete(extra.keys().next().value!);
        if (await openBrowser(`${baseUrl}/?approve=${code}`)) return { opened: true };
        extra.delete(code);
        lastOpen = 0;
        return { opened: false, reason: "no_browser" };
      };
  const make = (proj: Scenaria): ReturnType<typeof createApp> =>
    createApp(proj, {
      token: opts.token,
      approvalCode,
      approverToken,
      approvalSecret,
      linkState,
      auditViews,
      agentsProject,
      openApproval,
      viewRoot: () => current.root,
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
  baseUrl = url;
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
          ? `  approve: ${url}/?approve=<approver token>  (approvals: canon and project rules; keep this token away from agents)`
          : `  approve: off over HTTP (set SCENARIA_APPROVER_TOKEN to allow approvals of canon and project rules in team mode)`
        : showLink
          ? `  approve: ${url}/?approve=${approvalCode}  (approval link for canon and project rules — works once, only for you)`
          : `  approve: ${opts.open ? "opened in your browser" : "click the lock 🔒 in the dashboard — Scenaria opens the approval link in your browser"}`,
      "Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) void openBrowser(opts.token ? uiUrl : `${url}/?approve=${approvalCode}`);
  const approvalUrl = opts.token ? (approverToken ? `${url}/?approve=<approver token>` : null) : showLink ? `${url}/?approve=${approvalCode}` : null;
  return { server, url, approvalUrl, project: () => current, close: () => { app.close(); server.close(); } };
}
