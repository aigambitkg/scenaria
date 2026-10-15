import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { readTemplate, selfInvocation } from "./assets.js";

/** [command, ...args] that starts this Scenaria (node + cli.js, or the standalone binary). */
const SELF = selfInvocation();
const CLI_DISPLAY = SELF.join(" ");

/** Supported setup targets. Everything else can use MCP manually, HTTP or the CLI. */
export const TARGETS = ["claude", "claude-desktop", "cursor", "vscode", "gemini", "codex", "windsurf", "generic"] as const;
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
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, ""); // Windows editors may add a byte-order mark
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
  return `${SELF.map(q).join(" ")} hook ${event}`;
}

/** MCP server entry; the agent label makes every node attributable. */
function mcpEntry(agent: string, withType = true) {
  return {
    ...(withType ? { type: "stdio" } : {}),
    command: SELF[0],
    args: [...SELF.slice(1), "mcp"],
    env: { SCENARIA_AGENT: agent },
  };
}

const READ_SAFE_TOOLS = [
  "scenaria_status",
  "scenaria_recall",
  "scenaria_health",
  "scenaria_workspace",
  "scenaria_expect",
  "scenaria_canon",
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
const OUR_HOOK = /(?:cli\.js|[\\/]scenaria(?:-[\w-]+)?(?:\.exe)?)["']?\s+hook\s+(user-prompt|post-tool|pre-tool|stop|session-start)\s*$/;
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
  const raw = readTemplate("rules/agent-rules.md");
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
    writeFileSync(agentFile, readTemplate("claude/agents/scenaria-verifier.md"));
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
    [`[mcp_servers.scenaria]`, `command = ${s(SELF[0])}`, `args = [${[...SELF.slice(1), "mcp"].map((a) => s(a)).join(", ")}]`, ``, `[mcp_servers.scenaria.env]`, `SCENARIA_AGENT = "codex"`].join("\n"),
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

// ------------------------------------------------------------------ Claude Desktop (the app)

/** Where the Claude Desktop app keeps its MCP servers (one file for all projects). */
export function claudeDesktopConfig(home = homedir()): string {
  if (process.env.SCENARIA_CLAUDE_DESKTOP_CONFIG) return process.env.SCENARIA_CLAUDE_DESKTOP_CONFIG; // tests, unusual installs
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function realOrResolved(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Claude Desktop's file must be an object with an object "mcpServers" — otherwise stop before writing. */
function checkDesktopShape(file: string) {
  const { data } = readJsonFile(file);
  const isObj = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
  if (!isObj(data) || (data.mcpServers !== undefined && !isObj(data.mcpServers))) {
    throw new Error(`${file} does not look like a Claude Desktop config ("mcpServers" must be an object) — fix it first, nothing was changed.`);
  }
}

/** The Desktop entry that already serves this project (its `--root` is this folder), if any. */
function desktopEntryFor(servers: Record<string, any> | undefined, root: string): string | undefined {
  if (!servers || typeof servers !== "object") return undefined;
  const want = realOrResolved(root);
  for (const [name, e] of Object.entries(servers)) {
    const args: unknown = e?.args;
    if (!Array.isArray(args)) continue;
    const i = args.indexOf("--root");
    if (i >= 0 && typeof args[i + 1] === "string" && realOrResolved(args[i + 1]) === want && args.includes("mcp")) return name;
  }
  return undefined;
}

/**
 * Claude Desktop has no project folder of its own, so every project gets its own entry with a fixed
 * `--root` ("scenaria-<folder>"). Other servers in the file are kept as they are.
 */
function setupClaudeDesktop(root: string, home: string, r: SetupResult) {
  const file = claudeDesktopConfig(home);
  const shown = file.replace(home, "~");
  const { data, commented } = readJsonFile(file);
  const entry = { command: SELF[0], args: [...SELF.slice(1), "mcp", "--root", realOrResolved(root)], env: { SCENARIA_AGENT: "claude-desktop" } };
  let name = desktopEntryFor(data.mcpServers, root);
  if (!name) {
    const slug = basename(realOrResolved(root)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
    name = `scenaria-${slug}`;
    for (let n = 2; data.mcpServers?.[name]; n++) name = `scenaria-${slug}-${n}`;
  }
  if (commented) {
    r.notes.push(`${shown} contains comments, so it was left untouched. Add this under "mcpServers":\n${JSON.stringify({ [name]: entry }, null, 2)}`);
    return;
  }
  data.mcpServers ??= {};
  data.mcpServers[name] = entry;
  writeJson(file, data);
  r.changes.push(`${shown} → MCP server "${name}" (Claude Desktop, this project)`);
  r.notes.push("Restart the Claude Desktop app (quit it completely, then open it again) so it loads Scenaria.");
}

/** Is this project connected in Claude Desktop? */
export function claudeDesktopStatus(root: string, home = homedir()) {
  const file = claudeDesktopConfig(home);
  let connected = false;
  try {
    connected = Boolean(desktopEntryFor(JSON.parse(readFileSync(file, "utf8"))?.mcpServers, root));
  } catch {}
  return { installed: existsSync(dirname(file)), connected, file };
}

/** Idempotently wire Scenaria into a project for the given agents. */
export function setupAgents(root: string, targets: Target[], opts: { rulesFiles?: boolean; home?: string } = {}): SetupResult {
  const r: SetupResult = { changes: [], notes: [] };
  const set = new Set(targets);
  const home = opts.home ?? homedir();
  // Preflight: parse every config we are going to touch before writing anything.
  for (const t of set) for (const rel of JSON_FILES[t] ?? []) readJsonFile(join(root, rel));
  if (set.has("claude-desktop")) checkDesktopShape(claudeDesktopConfig(home));
  const rulesOn = opts.rulesFiles !== false;
  if (set.has("claude")) setupClaudeTarget(root, r, rulesOn);
  if (set.has("claude-desktop")) setupClaudeDesktop(root, home, r);
  if (set.has("cursor")) setupCursor(root, r);
  if (set.has("vscode")) setupVscode(root, r);
  if (set.has("gemini")) {
    setupGemini(root, r);
  }
  if (set.has("codex")) setupCodex(root, r);
  if (set.has("windsurf")) setupWindsurf(r);
  // AGENTS.md is the cross-vendor rules file — written for every non-Claude target.
  // Claude Desktop reads no rules file: it gets the working rules from the MCP server's instructions.
  if (rulesOn && [...set].some((t) => t !== "claude" && t !== "gemini" && t !== "claude-desktop")) setupGeneric(root, r);
  if (set.has("generic")) {
    r.notes.push(
      [
        "Any other agent:",
        `  MCP (stdio):  ${CLI_DISPLAY} mcp   (env SCENARIA_ROOT=<project>, SCENARIA_AGENT=<name>, SCENARIA_MODEL=<model>)`,
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

// ------------------------------------------------------------------ detection & global setup

function onPath(cmd: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

/** Which agents are installed on this machine? Used by `scenaria start` and `setup --global`. */
export function detectAgents(home = homedir()): Target[] {
  const has = (p: string) => existsSync(join(home, p));
  const app = (name: string) => process.platform === "darwin" && existsSync(`/Applications/${name}.app`);
  const found: Target[] = [];
  if (onPath("claude") || has(".claude")) found.push("claude");
  if (has(".cursor") || app("Cursor")) found.push("cursor");
  if (onPath("code") || has(".vscode") || app("Visual Studio Code")) found.push("vscode");
  if (onPath("gemini") || has(".gemini")) found.push("gemini");
  if (onPath("codex") || has(".codex")) found.push("codex");
  if (has(".codeium/windsurf") || app("Windsurf")) found.push("windsurf");
  return found;
}

function vscodeUserDir(home: string) {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User");
  return join(home, ".config", "Code", "User");
}

/**
 * Register Scenaria once for every project (user-level configs). The MCP server then
 * resolves the project from the workspace / working directory and initializes it on
 * first use (only in folders that look like projects — never the home folder).
 */
export function setupGlobal(targets: Target[], home = homedir()): SetupResult {
  const r: SetupResult = { changes: [], notes: [] };
  const set = new Set(targets);
  const root = (rel: string) => join(home, rel);
  // Preflight all JSON files first.
  const files: string[] = [];
  if (set.has("claude")) files.push(root(".claude/settings.json"));
  if (set.has("cursor")) files.push(root(".cursor/mcp.json"));
  if (set.has("gemini")) files.push(root(".gemini/settings.json"));
  if (set.has("vscode")) files.push(join(vscodeUserDir(home), "mcp.json"));
  if (set.has("windsurf")) files.push(root(".codeium/windsurf/mcp_config.json"));
  for (const f of files) readJsonFile(f);

  const writeServer = (file: string, key: "mcpServers" | "servers", entry: unknown, label: string) => {
    const { data, commented } = readJsonFile(file);
    if (commented) {
      r.notes.push(`${file} contains comments — add this under "${key}" yourself:\n${JSON.stringify({ scenaria: entry }, null, 2)}`);
      return;
    }
    data[key] ??= {};
    data[key].scenaria = entry;
    writeJson(file, data);
    r.changes.push(`${file.replace(home, "~")} → MCP server "scenaria" (${label}, all projects)`);
  };

  if (set.has("claude")) {
    if (onPath("claude")) {
      // Name BEFORE -e (the -e option is variadic); only replace an existing entry if adding fails because it exists.
      const addArgs = ["mcp", "add", "--scope", "user", "scenaria", "-e", "SCENARIA_AGENT=claude-code", "--", ...SELF, "mcp"];
      let add = spawnSync("claude", addArgs, { encoding: "utf8" });
      if (add.status !== 0 && /already exists/i.test(`${add.stderr}${add.stdout}`)) {
        spawnSync("claude", ["mcp", "remove", "--scope", "user", "scenaria"], { stdio: "ignore" });
        add = spawnSync("claude", addArgs, { encoding: "utf8" });
      }
      if (add.status === 0) r.changes.push('Claude Code → MCP server "scenaria" (user scope, all projects)');
      else r.notes.push(`Could not run "claude mcp add" (${(add.stderr || "").trim()}). Run: claude mcp add --scope user scenaria -- ${CLI_DISPLAY} mcp`);
    } else {
      r.notes.push(`Claude Code CLI not on PATH. Run later: claude mcp add --scope user scenaria -- ${CLI_DISPLAY} mcp`);
    }
    // Hooks in the user settings: they act only in Scenaria projects (auto-initialized on first use).
    const settingsFile = root(".claude/settings.json");
    const read = readJsonFile(settingsFile);
    if (read.commented) r.notes.push("~/.claude/settings.json contains comments — hooks were not added.");
    else {
      const settings = read.data;
      settings.hooks ??= {};
      const add = (event: string, entry: any) => {
        const list: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
        const cleaned = list.map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h: any) => !isOurs(h)) })).filter((m) => m.hooks.length > 0);
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
      writeJson(settingsFile, settings);
      r.changes.push("~/.claude/settings.json → hooks + tool permissions (all projects)");
    }
    upsertBlock(root(".claude/CLAUDE.md"), rules(true));
    r.changes.push("~/.claude/CLAUDE.md → Scenaria working rules");
  }
  if (set.has("cursor")) {
    writeServer(root(".cursor/mcp.json"), "mcpServers", { ...mcpEntry("cursor"), args: [...SELF.slice(1), "mcp", "--root", "${workspaceFolder}"] }, "Cursor");
  }
  if (set.has("vscode")) {
    writeServer(join(vscodeUserDir(home), "mcp.json"), "servers", { ...mcpEntry("vscode-copilot"), args: [...SELF.slice(1), "mcp", "--root", "${workspaceFolder}"] }, "VS Code");
  }
  if (set.has("gemini")) {
    writeServer(root(".gemini/settings.json"), "mcpServers", mcpEntry("gemini-cli", false), "Gemini CLI");
    upsertBlock(root(".gemini/GEMINI.md"), rules(false));
    r.changes.push("~/.gemini/GEMINI.md → Scenaria working rules");
  }
  if (set.has("codex")) {
    const file = root(".codex/config.toml");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (codexDefinesScenaria(current.replace(/# scenaria:start[\s\S]*?# scenaria:end/g, ""))) {
      r.notes.push("~/.codex/config.toml already defines mcp_servers.scenaria — left unchanged.");
    } else {
      const j = JSON.stringify;
      upsertBlock(file, [`[mcp_servers.scenaria]`, `command = ${j(SELF[0])}`, `args = [${[...SELF.slice(1), "mcp"].map((a) => j(a)).join(", ")}]`, ``, `[mcp_servers.scenaria.env]`, `SCENARIA_AGENT = "codex"`].join("\n"), "hash");
      r.changes.push("~/.codex/config.toml → MCP server \"scenaria\" (all projects)");
    }
    upsertBlock(root(".codex/AGENTS.md"), rules(false));
    r.changes.push("~/.codex/AGENTS.md → Scenaria working rules");
  }
  if (set.has("windsurf")) {
    writeServer(root(".codeium/windsurf/mcp_config.json"), "mcpServers", mcpEntry("windsurf", false), "Windsurf");
  }
  if (set.has("claude-desktop")) {
    r.notes.push("Claude Desktop has no project folder, so it is connected per project: scenaria init --for claude-desktop (in the project), or Settings → Connect in the dashboard.");
  }
  return r;
}

export function parseTargets(spec: string): Target[] {
  const items = spec
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((s) => (s === "all" ? ["claude", "cursor", "vscode", "gemini", "codex", "generic"] : [s === "copilot" ? "vscode" : s === "desktop" || s === "claude-app" ? "claude-desktop" : s]));
  for (const i of items) {
    if (!(TARGETS as readonly string[]).includes(i)) throw new Error(`Unknown target "${i}". Use: ${TARGETS.join(", ")}, all`);
  }
  return [...new Set(items)] as Target[];
}

// ------------------------------------------------------------------ status (dashboard → Settings)

export interface AgentStatus {
  target: Target;
  label: string;
  /** Installed on this machine (best guess). */
  detected: boolean;
  /** This project is wired for it (MCP entry present). */
  connected: boolean;
  /** Where the entry lives / what to do by hand. */
  where: string;
}

const LABELS: Record<Target, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop (app)",
  cursor: "Cursor",
  vscode: "VS Code / GitHub Copilot",
  gemini: "Gemini CLI",
  codex: "Codex",
  windsurf: "Windsurf",
  generic: "Other agents (AGENTS.md, HTTP, CLI)",
};

/** Which agents are installed, and which ones this project is wired for. */
export function agentStatus(root: string, home = homedir()): AgentStatus[] {
  const detected = new Set(detectAgents(home));
  const jsonHas = (rel: string, key: string) => {
    try {
      const d = JSON.parse(readFileSync(join(root, rel), "utf8"));
      return Boolean(d?.[key]?.scenaria);
    } catch {
      return false;
    }
  };
  const textHas = (file: string, re: RegExp) => {
    try {
      return re.test(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  };
  const windsurfGlobal = join(home, ".codeium", "windsurf", "mcp_config.json");
  const desktop = claudeDesktopStatus(root, home);
  if (desktop.installed) detected.add("claude-desktop");
  const rows: [Target, boolean, string][] = [
    ["claude", jsonHas(".mcp.json", "mcpServers"), ".mcp.json + .claude/settings.json"],
    ["claude-desktop", desktop.connected, `${desktop.file.replace(home, "~")} (restart the app afterwards)`],
    ["cursor", jsonHas(".cursor/mcp.json", "mcpServers"), ".cursor/mcp.json"],
    ["vscode", jsonHas(".vscode/mcp.json", "servers"), ".vscode/mcp.json"],
    ["gemini", jsonHas(".gemini/settings.json", "mcpServers"), ".gemini/settings.json"],
    ["codex", textHas(join(root, ".codex", "config.toml"), /\[mcp_servers\.scenaria\]/) || textHas(join(home, ".codex", "config.toml"), /\[mcp_servers\.scenaria\]/), ".codex/config.toml"],
    ["windsurf", textHas(windsurfGlobal, /"scenaria"/), "~/.codeium/windsurf/mcp_config.json (global, by hand)"],
    ["generic", textHas(join(root, "AGENTS.md"), /scenaria/i), "AGENTS.md"],
  ];
  return rows.map(([target, connected, where]) => ({ target, label: LABELS[target], detected: target === "generic" || detected.has(target), connected, where }));
}

/** Copy-paste snippets for connecting any agent by hand. */
export function connectionSnippets(root: string, baseUrl?: string) {
  const mcp = { mcpServers: { scenaria: { command: SELF[0], args: [...SELF.slice(1), "mcp"], env: { SCENARIA_ROOT: root, SCENARIA_AGENT: "<agent name>" } } } };
  return {
    mcpCommand: `${CLI_DISPLAY} mcp`,
    mcpJson: JSON.stringify(mcp, null, 2),
    http: baseUrl ? { tools: `${baseUrl}/api/v1/tools?format=openai`, call: `${baseUrl}/api/v1/tools/<tool>` } : null,
    proxy: baseUrl ? { openai: `${baseUrl}/proxy/openai`, anthropic: `${baseUrl}/proxy/anthropic`, ollama: `${baseUrl}/proxy/ollama` } : null,
  };
}

// ------------------------------------------------------------------ start without a terminal

/** The folder the person sees as their desktop (localized on Linux, OneDrive-redirected on Windows). */
export function desktopDir(home = homedir()): string | null {
  const candidates: string[] = [];
  if (process.platform === "linux") {
    let x = process.env.XDG_DESKTOP_DIR;
    if (!x) {
      try {
        x = /^XDG_DESKTOP_DIR="?([^"\n]+)"?/m.exec(readFileSync(join(home, ".config", "user-dirs.dirs"), "utf8"))?.[1];
      } catch {}
    }
    if (x) candidates.push(x.replace(/^\$HOME/, home));
  }
  if (process.platform === "win32" && process.env.OneDrive) candidates.push(join(process.env.OneDrive, "Desktop"));
  candidates.push(join(home, "Desktop"));
  return candidates.find((d) => existsSync(d) && resolve(d) !== resolve(home)) ?? null;
}

/**
 * A file the person double-clicks to start Scenaria for one project: `.command` on macOS (opens
 * Terminal), `.cmd` on Windows, a `.desktop` entry (in a terminal) on Linux. It runs
 * `scenaria start --launcher --root <project>`: never sets up a project anywhere else (moved folder),
 * and a second double-click reuses the running Scenaria. Another project's icon is never overwritten.
 */
export function writeLauncher(root: string, dir?: string, home = homedir()): string {
  const project = realOrResolved(root);
  const target = dir ? resolve(dir) : desktopDir(home) ?? project;
  const name = basename(project).replace(/[\\/:*?"<>|\n\r]/g, "-") || "project";
  // Linux: a desktop entry (runs in a terminal) unless a path holds characters its Exec quoting makes risky.
  const plainPaths = [project, ...SELF].every((x) => !/["`$\\%\r\n]/.test(x));
  const kind = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "command" : plainPaths ? "desktop" : "sh";
  const ext = kind;
  let content: string;
  let marker: string;
  if (process.platform === "win32") {
    // cmd.exe reads batch files in the OEM code page: switch to UTF-8 first, so "Müller" stays "Müller".
    const w = (x: string) => `"${x.replace(/%/g, "%%").replace(/"/g, "")}"`;
    marker = `rem scenaria-launcher: ${w(project)}`;
    content = [
      "@echo off",
      "chcp 65001 >nul",
      marker,
      `pushd ${w(project)} || (echo Project folder not found: ${w(project)} & pause & exit /b 1)`,
      `${SELF.map(w).join(" ")} start --launcher --root ${w(project)}`,
      "pause",
      "",
    ].join("\r\n");
  } else if (kind !== "desktop") {
    const sq = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
    marker = `# scenaria-launcher: ${project.replace(/[\r\n]/g, " ")}`;
    content = [
      "#!/bin/sh",
      marker,
      `cd ${sq(project)} || { echo "Project folder not found: ${project.replace(/["$`\\\n]/g, "")}"; read -r _; exit 1; }`,
      `exec ${SELF.map(sq).join(" ")} start --launcher --root ${sq(project)}`,
      "",
    ].join("\n");
  } else {
    // Desktop entry: plain paths only (checked above), so double quotes are enough.
    const dq = (x: string) => `"${x}"`;
    marker = `X-Scenaria-Root=${project}`;
    content = [
      "[Desktop Entry]",
      "Type=Application",
      `Name=Scenaria – ${name}`,
      "Terminal=true",
      `Exec=${SELF.map(dq).join(" ")} start --launcher --root ${dq(project)}`,
      marker,
      "",
    ].join("\n");
  }
  // Same project → update its icon; another project with the same folder name → "(2)", "(3)" …
  let file = join(target, `Scenaria - ${name}.${ext}`);
  for (let n = 2; existsSync(file); n++) {
    let same = false;
    try {
      same = readFileSync(file, "utf8").split(/\r?\n/).includes(marker);
    } catch {}
    if (same) break;
    file = join(target, `Scenaria - ${name} (${n}).${ext}`);
  }
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
}
