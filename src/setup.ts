import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.js");
const TEMPLATES = join(here, "..", "templates");

function readJsonSafe(file: string): any {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON — fix it first, nothing was changed.`);
  }
}

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

export function hookCommand(event: string) {
  return `${q(process.execPath)} ${q(CLI)} hook ${event}`;
}

const READ_SAFE_TOOLS = [
  "scenaria_status",
  "scenaria_start_mission",
  "scenaria_decide",
  "scenaria_checkpoint",
  "scenaria_tree",
  "scenaria_get_node",
  "scenaria_context",
  "scenaria_diff",
  "scenaria_verify",
  "scenaria_last_good",
].map((t) => `mcp__scenaria__${t}`);

/** Our hook commands end in `…cli.js" hook <event>` — matched precisely so user hooks are never touched. */
const OUR_HOOK = /cli\.js"?\s+hook\s+(user-prompt|post-tool|pre-tool|stop|session-start)\s*$/;
const isOurs = (h: any) => typeof h?.command === "string" && OUR_HOOK.test(h.command);

/** Idempotently wire Scenaria into a Claude Code project. Returns human-readable change list. */
export function setupClaude(root: string, opts: { claudeMd?: boolean } = {}): string[] {
  const changes: string[] = [];

  // 1) MCP server (project scope)
  const mcpFile = join(root, ".mcp.json");
  const mcp = readJsonSafe(mcpFile);
  mcp.mcpServers ??= {};
  mcp.mcpServers.scenaria = {
    type: "stdio",
    command: process.execPath,
    args: [CLI, "mcp"],
    env: { SCENARIA_AGENT: "claude-code" },
  };
  writeJson(mcpFile, mcp);
  changes.push(".mcp.json → MCP server \"scenaria\"");

  // 2) Hooks + permissions
  const settingsFile = join(root, ".claude", "settings.json");
  const settings = readJsonSafe(settingsFile);
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
  changes.push(".claude/settings.json → hooks (prompt, questions/plan, risky Bash, turn end, session start) + tool permissions");

  // 3) Verifier sub-agent
  const agentFile = join(root, ".claude", "agents", "scenaria-verifier.md");
  if (!existsSync(agentFile)) {
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, readFileSync(join(TEMPLATES, "claude", "agents", "scenaria-verifier.md"), "utf8"));
    changes.push(".claude/agents/scenaria-verifier.md → verifier agent");
  }

  // 4) CLAUDE.md instructions (between markers, idempotent)
  if (opts.claudeMd !== false) {
    const file = join(root, "CLAUDE.md");
    const block = readFileSync(join(TEMPLATES, "claude", "CLAUDE.scenaria.md"), "utf8").trim();
    const wrapped = `<!-- scenaria:start -->\n${block}\n<!-- scenaria:end -->`;
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    // Only a complete start…end pair is replaced (an orphan start marker keeps its text).
    const re = /<!-- scenaria:start -->(?:(?!<!-- scenaria:start -->)[\s\S])*?<!-- scenaria:end -->/;
    const next = re.test(current) ? current.replace(re, wrapped) : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${wrapped}\n`;
    writeFileSync(file, next);
    changes.push("CLAUDE.md → Scenaria working rules");
  }
  return changes;
}
