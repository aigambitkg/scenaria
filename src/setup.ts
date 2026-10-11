import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.js");
const TEMPLATES = join(here, "..", "templates");

/** Supported setup targets. Everything else can use MCP manually, HTTP or the CLI. */
export const TARGETS = ["claude", "cursor", "vscode", "gemini", "codex", "windsurf", "generic"] as const;
export type Target = (typeof TARGETS)[number];

export interface SetupResult {
  changes: string[];
  /** Snippets the user has to place themselves (global configs we don't touch). */
  notes: string[];
}

/** Strip line and block comments and trailing commas (JSONC, as used by VS Code configs). */
export function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface JsonFile {
  data: any;
  /** File had comments — rewriting it would destroy them, so we leave it alone. */
  commented: boolean;
}

function readJsonFile(file: string): JsonFile {
  if (!existsSync(file)) return { data: {}, commented: false };
  const raw = readFileSync(file, "utf8");
  try {
    return { data: JSON.parse(raw), commented: false };
  } catch {
    try {
      return { data: JSON.parse(stripJsonc(raw)), commented: true };
    } catch {
      throw new Error(`${file} is not valid JSON — fix it first, nothing was changed.`);
    }
  }
}

/** Merge an MCP entry into a JSON config — or, for commented files, leave a note instead of rewriting. */
function mergeMcpJson(root: string, rel: string, key: "mcpServers" | "servers", entry: unknown, label: string, r: SetupResult) {
  const file = join(root, rel);
  const { data, commented } = readJsonFile(file);
  if (commented) {
    r.notes.push(`${rel} contains comments, so it was left untouched. Add this under "${key}":\n${JSON.stringify({ scenaria: entry }, null, 2)}`);
    return;
  }
  data[key] ??= {};
  data[key].scenaria = entry;
  writeJson(file, data);
  r.changes.push(`${rel} → MCP server "scenaria" (${label})`);
}

/** Files each target will parse — validated up front so a bad file aborts before anything is written. */
const JSON_FILES: Partial<Record<Target, string[]>> = {
  claude: [".mcp.json", ".claude/settings.json"],
  cursor: [".cursor/mcp.json"],
  vscode: [".vscode/mcp.json"],
  gemini: [".gemini/settings.json"],
};

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Quote a path for the hook shell: single quotes on POSIX (no $, ` or \\ expansion), double quotes on Windows. */
const q = (s: string) => (process.platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`);

export function hookCommand(event: string) {
  return `${q(process.execPath)} ${q(CLI)} hook ${event}`;
}

/** MCP server entry; the agent label makes every node attributable. */
function mcpEntry(agent: string, withType = true) {
  return {
    ...(withType ? { type: "stdio" } : {}),
    command: process.execPath,
    args: [CLI, "mcp"],
    env: { SCENARIA_AGENT: agent },
  };
}

const READ_SAFE_TOOLS = [
  "scenaria_status",
  "scenaria_start_mission",
  "scenaria_decide",
  "scenaria_choose",
  "scenaria_checkpoint",
  "scenaria_tree",
  "scenaria_get_node",
  "scenaria_context",
  "scenaria_diff",
  "scenaria_verify",
  "scenaria_last_good",
].map((t) => `mcp__scenaria__${t}`);

/** Our hook commands end in `…cli.js' hook <event>` — matched precisely so user hooks are never touched. */
const OUR_HOOK = /cli\.js["']?\s+hook\s+(user-prompt|post-tool|pre-tool|stop|session-start)\s*$/;
const isOurs = (h: any) => typeof h?.command === "string" && OUR_HOOK.test(h.command);

/** Insert or replace a marker-delimited block (only complete start…end pairs are replaced). */
function upsertBlock(file: string, block: string, style: "html" | "hash" = "html") {
  const [start, end] = style === "html" ? ["<!-- scenaria:start -->", "<!-- scenaria:end -->"] : ["# scenaria:start", "# scenaria:end"];
  const wrapped = `${start}\n${block.trim()}\n${end}`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc(start)}(?:(?!${esc(start)})[\\s\\S])*?${esc(end)}`);
  const next = re.test(current)
    ? current.replace(re, () => wrapped)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${wrapped}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

function rules(autoCapture: boolean) {
  const raw = readFileSync(join(TEMPLATES, "rules", "agent-rules.md"), "utf8");
  return raw.replace(
    "{{AUTO_CAPTURE}}",
    autoCapture ? "- Clarifying questions and plan approvals are captured automatically; do not record them twice.\n" : "",
  );
}

// ------------------------------------------------------------------ targets

function setupClaudeTarget(root: string, r: SetupResult, claudeMd: boolean) {
  mergeMcpJson(root, ".mcp.json", "mcpServers", mcpEntry("claude-code"), "Claude Code", r);

  const settingsFile = join(root, ".claude", "settings.json");
  const settingsRead = readJsonFile(settingsFile);
  if (settingsRead.commented) {
    r.notes.push(".claude/settings.json contains comments, so hooks were not added automatically. Remove the comments and run init again.");
    return;
  }
  const settings = settingsRead.data;
  settings.hooks ??= {};
  const add = (event: string, entry: any) => {
    const list: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = list
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((m) => m.hooks.length > 0);
    cleaned.push(entry);
    settings.hooks[event] = cleaned;
  };
  const cmd = (event: string, timeout = 30) => ({ type: "command", command: hookCommand(event), timeout });
  add("UserPromptSubmit", { hooks: [cmd("user-prompt", 20)] });
  add("PostToolUse", { matcher: "AskUserQuestion|ExitPlanMode", hooks: [cmd("post-tool")] });
  add("PreToolUse", { matcher: "Bash", hooks: [cmd("pre-tool")] });
  add("Stop", { hooks: [cmd("stop", 60)] });
  add("SessionStart", { hooks: [cmd("session-start", 20)] });
  settings.permissions ??= {};
  settings.permissions.allow = Array.from(new Set([...(settings.permissions.allow ?? []), ...READ_SAFE_TOOLS]));
  settings.enabledMcpjsonServers = Array.from(new Set([...(settings.enabledMcpjsonServers ?? []), "scenaria"]));
  writeJson(settingsFile, settings);
  r.changes.push(".claude/settings.json → hooks (prompt, questions/plan, risky Bash, turn end, session start) + tool permissions");

  const agentFile = join(root, ".claude", "agents", "scenaria-verifier.md");
  if (!existsSync(agentFile)) {
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, readFileSync(join(TEMPLATES, "claude", "agents", "scenaria-verifier.md"), "utf8"));
    r.changes.push(".claude/agents/scenaria-verifier.md → verifier sub-agent");
  }
  if (claudeMd) {
    upsertBlock(join(root, "CLAUDE.md"), rules(true));
    r.changes.push("CLAUDE.md → Scenaria working rules");
  }
}

function setupCursor(root: string, r: SetupResult) {
  mergeMcpJson(root, ".cursor/mcp.json", "mcpServers", mcpEntry("cursor"), "Cursor", r);
}

function setupVscode(root: string, r: SetupResult) {
  mergeMcpJson(root, ".vscode/mcp.json", "servers", mcpEntry("vscode-copilot"), "VS Code / GitHub Copilot", r);
}

function setupGemini(root: string, r: SetupResult) {
  mergeMcpJson(root, ".gemini/settings.json", "mcpServers", mcpEntry("gemini-cli", false), "Gemini CLI", r);
  upsertBlock(join(root, "GEMINI.md"), rules(false));
  r.changes.push("GEMINI.md → Scenaria working rules");
}

function setupCodex(root: string, r: SetupResult) {
  const file = join(root, ".codex", "config.toml");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const outsideBlock = current.replace(/# scenaria:start[\s\S]*?# scenaria:end/g, "");
  if (codexDefinesScenaria(outsideBlock)) {
    r.notes.push(".codex/config.toml already defines [mcp_servers.scenaria] — left unchanged.");
    return;
  }
  const s = JSON.stringify;
  upsertBlock(
    file,
    [`[mcp_servers.scenaria]`, `command = ${s(process.execPath)}`, `args = [${s(CLI)}, "mcp"]`, ``, `[mcp_servers.scenaria.env]`, `SCENARIA_AGENT = "codex"`].join("\n"),
    "hash",
  );
  r.changes.push('.codex/config.toml → MCP server "scenaria" (Codex; project config is used for trusted projects)');
}

/** Does a TOML config already define mcp_servers.scenaria (table, dotted key or inline table)? */
export function codexDefinesScenaria(toml: string): boolean {
  if (/^\s*\[\s*mcp_servers\s*\.\s*["']?scenaria["']?\s*[\].]/m.test(toml)) return true;
  if (/^\s*mcp_servers\s*\.\s*["']?scenaria["']?\s*[.=]/m.test(toml)) return true;
  if (/^\s*mcp_servers\s*=\s*\{[^}]*\bscenaria\b/m.test(toml)) return true;
  // key inside a plain [mcp_servers] table
  const m = toml.match(/^\s*\[\s*mcp_servers\s*\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m);
  return Boolean(m && /^\s*["']?scenaria["']?\s*[.=]/m.test(m[1]));
}

function setupWindsurf(r: SetupResult) {
  const snippet = JSON.stringify({ mcpServers: { scenaria: { ...mcpEntry("windsurf", false), env: { SCENARIA_AGENT: "windsurf", SCENARIA_ROOT: "<project folder>" } } } }, null, 2);
  r.notes.push(`Windsurf only reads a global config. Add this to ~/.codeium/windsurf/mcp_config.json:\n${snippet}`);
}

function setupGeneric(root: string, r: SetupResult) {
  upsertBlock(join(root, "AGENTS.md"), rules(false));
  r.changes.push("AGENTS.md → Scenaria working rules (read by Codex, Cursor, Copilot, Windsurf and other AGENTS.md-aware agents)");
}

/** Idempotently wire Scenaria into a project for the given agents. */
export function setupAgents(root: string, targets: Target[], opts: { rulesFiles?: boolean } = {}): SetupResult {
  const r: SetupResult = { changes: [], notes: [] };
  const set = new Set(targets);
  // Preflight: parse every config we are going to touch before writing anything.
  for (const t of set) for (const rel of JSON_FILES[t] ?? []) readJsonFile(join(root, rel));
  const rulesOn = opts.rulesFiles !== false;
  if (set.has("claude")) setupClaudeTarget(root, r, rulesOn);
  if (set.has("cursor")) setupCursor(root, r);
  if (set.has("vscode")) setupVscode(root, r);
  if (set.has("gemini")) {
    setupGemini(root, r);
  }
  if (set.has("codex")) setupCodex(root, r);
  if (set.has("windsurf")) setupWindsurf(r);
  // AGENTS.md is the cross-vendor rules file — written for every non-Claude target.
  if (rulesOn && [...set].some((t) => t !== "claude" && t !== "gemini")) setupGeneric(root, r);
  if (set.has("generic")) {
    r.notes.push(
      [
        "Any other agent:",
        `  MCP (stdio):  ${process.execPath} ${CLI} mcp   (env SCENARIA_ROOT=<project>, SCENARIA_AGENT=<name>, SCENARIA_MODEL=<model>)`,
        "  Shell:        scenaria call scenaria_checkpoint '{\"title\":\"…\"}'",
        "  HTTP:         scenaria serve  →  POST /api/v1/tools/<tool>",
        "  Schemas:      scenaria tools --format openai|anthropic|gemini",
        "  No tools at all? scenaria watch  (auto-saves whenever files change)",
      ].join("\n"),
    );
  }
  return r;
}

/** Backwards compatible entry point (init --claude). */
export function setupClaude(root: string, opts: { claudeMd?: boolean } = {}): string[] {
  return setupAgents(root, ["claude"], { rulesFiles: opts.claudeMd }).changes;
}

export function parseTargets(spec: string): Target[] {
  const items = spec
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((s) => (s === "all" ? ["claude", "cursor", "vscode", "gemini", "codex", "generic"] : [s === "copilot" ? "vscode" : s]));
  for (const i of items) {
    if (!(TARGETS as readonly string[]).includes(i)) throw new Error(`Unknown target "${i}". Use: ${TARGETS.join(", ")}, all`);
  }
  return [...new Set(items)] as Target[];
}
