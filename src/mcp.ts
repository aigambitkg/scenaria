import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Scenaria } from "./core/engine.js";
import { Store, resolveRoot } from "./core/store.js";
import { isPlausibleProject } from "./core/global.js";
import { registerProject } from "./core/projects.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { INSTRUCTIONS, TOOLS, type ToolContext } from "./tools.js";

/**
 * MCP server (stdio). Works with any MCP client; all tools come from the shared
 * registry in tools.ts. Attribution via env: SCENARIA_AGENT, SCENARIA_MODEL, SCENARIA_USER.
 */
export function createMcpServer(root?: string) {
  const explicitRoot = root && !root.includes("${") ? root : undefined;
  const open = () => {
    const r = resolveRoot(explicitRoot);
    if (new Store(r).exists) {
      const s = Scenaria.open(r);
      registerProject(s.root, s.config().projectName); // remembered for the dashboard's project switcher (throttled)
      return s;
    }
    const trusted = Boolean(explicitRoot || process.env.SCENARIA_ROOT) && resolve(r) !== resolve(homedir());
    if (!trusted && !isPlausibleProject(r)) {
      throw new Error(`No Scenaria project at ${r}. Open a project folder (or set SCENARIA_ROOT) — Scenaria never initializes your home folder.`);
    }
    const s = Scenaria.init(r);
    registerProject(s.root, s.config().projectName);
    return s;
  };
  const ctx: ToolContext = {
    agent: process.env.SCENARIA_AGENT || "mcp-agent",
    model: process.env.SCENARIA_MODEL || undefined,
    user: process.env.SCENARIA_USER || undefined,
    source: "mcp",
  };
  const server = new McpServer({ name: "scenaria", version: "0.9.1" }, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input as any, annotations: t.annotations },
      async (args: any) => ({ content: [{ type: "text" as const, text: t.run(open(), args ?? {}, ctx).text }] }),
    );
  }
  return server;
}

export async function startMcpServer(root?: string) {
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
}
