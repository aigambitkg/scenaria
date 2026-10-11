import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Scenaria } from "./core/engine.js";
import { optionLabel } from "./core/context.js";
import type { ScenariaNode } from "./core/types.js";

const INSTRUCTIONS = `Scenaria records the decision tree of this task so work can be rewound to any decision point (files + context) and alternatives can be explored.
Use it like a quicksave:
- At the start of a complex task: scenaria_start_mission (main goal + brief).
- Whenever you choose between approaches, or a user answers a clarifying question: scenaria_decide (question, all options considered, chosen, rationale, confidence).
- After finishing a meaningful step: scenaria_checkpoint with short factual output bullets (name files in backticks).
- If you notice a mistake, hallucination or dead end: scenaria_last_good / scenaria_tree, then scenaria_rewind with a one-line lesson. Continue ONLY from the returned resume context.
- To try another option of an earlier decision: scenaria_fork.
Keep bullets factual and short; never invent facts you did not verify.`;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function brief(n: ScenariaNode): string {
  let s = `${n.id} [${n.type}] ${n.type === "decision" ? n.question ?? n.title : n.title}`;
  if (n.type === "decision") {
    s += `\noptions: ${(n.options ?? []).map((o) => `${o.id}) ${o.label}${o.id === n.chosen ? " ✔" : ""}`).join("  ")}`;
  }
  if (n.snapshot) s += `\nsnapshot: ${n.snapshot.commit.slice(0, 10)} (${n.snapshot.files} files)`;
  if (n.changedFiles?.length) s += `\nchanged: ${n.changedFiles.slice(0, 12).join(", ")}${n.changedFiles.length > 12 ? " …" : ""}`;
  if (n.verification) s += `\nverification: ${n.verification.status}`;
  return s;
}

const str = z.string();
const list = z.array(z.string()).optional();

export function createMcpServer(root?: string) {
  const open = () => Scenaria.openOrInit(root);
  const agent = process.env.SCENARIA_AGENT || "mcp-agent";

  const server = new McpServer({ name: "scenaria", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "scenaria_status",
    {
      title: "Scenaria status",
      description: "Current mission, HEAD node, unsaved changes and counts. Call this first to orient yourself.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = open();
      const st = s.status();
      return text(
        [
          `project: ${st.projectName}`,
          `mission: ${st.mission ? `${st.mission.id} ${st.mission.title}` : "none — call scenaria_start_mission"}`,
          `HEAD: ${st.head ? `${st.head.id} [${st.head.type}] ${st.head.title}` : "—"}${st.dirty ? " (unsaved file changes)" : ""}`,
          `nodes ${st.counts.nodes}, decisions ${st.counts.decisions}, checkpoints ${st.counts.checkpoints}, branches ${st.counts.branches}, verified ${st.counts.verified}, failed ${st.counts.failed}`,
          st.snapshots ? "" : "warning: git not found, file snapshots disabled",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "scenaria_start_mission",
    {
      title: "Start mission",
      description: "Start a new mission (root of a decision tree) with its main goal and brief. Takes a baseline snapshot of the files.",
      inputSchema: {
        title: str.describe("Short mission title"),
        goal: str.describe("The main goal (Hauptziel) in one or two sentences").optional(),
        brief: str.describe("The task/brief as given by the user").optional(),
      },
    },
    async (a) => {
      const n = open().startMission({ ...a, agent, source: "mcp" });
      return text(`Mission started.\n${brief(n)}`);
    },
  );

  server.registerTool(
    "scenaria_decide",
    {
      title: "Record decision point",
      description:
        "Record a decision point BEFORE acting on it: the question, all options considered, the chosen one, rationale, assumptions and confidence. Snapshots the current files so this exact point can be restored and other options explored later.",
      inputSchema: {
        question: str.describe("The decision to make"),
        options: z
          .array(z.union([str, z.object({ label: str, description: str.optional() })]))
          .min(1)
          .describe("All options considered (strings or {label, description})"),
        chosen: z.union([str, z.number()]).optional().describe("Chosen option: label, id (a, b, …) or 1-based index. Omit if still open."),
        rationale: str.optional().describe("Why this option"),
        assumptions: list.describe("Assumptions this decision relies on"),
        confidence: z.number().min(0).max(1).optional().describe("0..1"),
      },
    },
    async (a) => {
      const n = open().decide({ ...a, agent, source: "mcp" });
      return text(`Decision recorded.\n${brief(n)}`);
    },
  );

  server.registerTool(
    "scenaria_checkpoint",
    {
      title: "Checkpoint (quicksave)",
      description:
        "Quicksave after a meaningful step: snapshot of files plus a compact fact capsule. Use short factual bullets; mention files in backticks so the verifier can check them.",
      inputSchema: {
        title: str.describe("What was achieved, in a few words"),
        outputs: list.describe("Output bullets: what was produced/changed"),
        facts: list.describe("Verified facts established in this step"),
        openQuestions: list.describe("Open questions / todos"),
        irreversible: list.describe("External side effects a rewind cannot undo (emails sent, pushes, API writes)"),
        onlyIfChanged: z.boolean().optional().describe("Skip if no file changed since HEAD"),
      },
    },
    async (a) => {
      const n = open().checkpoint({ ...a, agent, source: "mcp" });
      return text(n ? `Checkpoint saved.\n${brief(n)}` : "No file changes since HEAD — nothing saved.");
    },
  );

  server.registerTool(
    "scenaria_tree",
    {
      title: "Decision tree",
      description: "Text view of the current mission's decision tree with HEAD marker and verification marks.",
      inputSchema: { missionId: str.optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => text(open().treeText(a.missionId)),
  );

  server.registerTool(
    "scenaria_get_node",
    {
      title: "Get node",
      description: "Full JSON of one node (decision, checkpoint, …).",
      inputSchema: { id: str },
      annotations: { readOnlyHint: true },
    },
    async (a) => text(JSON.stringify(open().node(a.id), null, 2)),
  );

  server.registerTool(
    "scenaria_context",
    {
      title: "Resume context",
      description:
        "Compact resume capsule for a node (default HEAD): goal, brief, decisions taken on the path, current facts/outputs, lessons. Use it instead of re-reading long histories.",
      inputSchema: { id: str.optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const c = open().context(a.id);
      return text(`${c.markdown}\n\n(≈ ${c.tokens} tokens)`);
    },
  );

  server.registerTool(
    "scenaria_rewind",
    {
      title: "Rewind",
      description:
        "Jump back to a node: restores files to its snapshot and moves HEAD there. Unsaved work is autosaved first, so this can be undone. Add a one-line lesson about what went wrong. Afterwards continue ONLY from the returned resume context.",
      inputSchema: {
        id: str.describe("Target node id, e.g. n7"),
        lesson: str.optional().describe("What went wrong / what to avoid"),
        restoreFiles: z.boolean().optional().describe("Default true. false = move decision state only"),
      },
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const r = open().rewind(a.id, { lesson: a.lesson, restoreFiles: a.restoreFiles, agent, source: "mcp" });
      return text(
        [
          `Rewound to ${r.target.id}.${r.autosave ? ` Previous state autosaved as ${r.autosave.id}.` : ""}`,
          ...r.warnings.map((w) => `WARNING: ${w}`),
          "",
          r.context.markdown,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "scenaria_fork",
    {
      title: "Explore alternative",
      description:
        "Explore a different option of an earlier decision: restores that decision's files and starts a new branch for the given option. Returns the resume context for the new branch.",
      inputSchema: {
        decisionId: str,
        option: z.union([str, z.number()]).describe("Option label, id (a, b, …) or 1-based index"),
        lesson: str.optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const s = open();
      const r = s.fork(a.decisionId, a.option, { lesson: a.lesson, agent, source: "mcp" });
      const dec = s.node(a.decisionId);
      return text(
        [
          `New branch ${r.branch.id}: ${optionLabel(dec, r.branch.viaOption)}.${r.autosave ? ` Previous state autosaved as ${r.autosave.id}.` : ""}`,
          ...r.warnings.map((w) => `WARNING: ${w}`),
          "",
          r.context.markdown,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "scenaria_diff",
    {
      title: "Diff",
      description: "File diff between two nodes, or a node and the current working tree (to = 'working').",
      inputSchema: { from: str, to: str.optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const d = open().diff(a.from, a.to);
      return text(`${d.from} → ${d.to}\n${d.stat}\n\n${d.patch}`);
    },
  );

  server.registerTool(
    "scenaria_verify",
    {
      title: "Verify node",
      description:
        "Verifier tool: runs deterministic checks (snapshot restorable, claimed files exist, decision documented, irreversible effects) and records your verdict. Use status 'failed' with notes when you find a hallucination or error.",
      inputSchema: {
        id: str,
        status: z.enum(["passed", "warning", "failed"]).optional().describe("Your verdict; omit to use the automatic result"),
        notes: str.optional(),
        runCommand: z.boolean().optional().describe("Also run the configured verifyCommand (only if node is HEAD and clean)"),
      },
    },
    async (a) => {
      const n = open().verify(a.id, { status: a.status, notes: a.notes, by: agent, runCommand: a.runCommand });
      const checks = (n.verification?.checks ?? []).map((c) => `- ${c.status.toUpperCase()} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      return text([`${n.id}: ${n.verification?.status}`, ...checks].join("\n"));
    },
  );

  server.registerTool(
    "scenaria_last_good",
    {
      title: "Last good node",
      description: "Nearest node on the path (from HEAD or given id) that was verified as passed — the safest rewind target.",
      inputSchema: { id: str.optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const n = open().lastGood(a.id);
      return text(n ? brief(n) : "No verified-good node on this path yet. Use scenaria_tree to choose a target.");
    },
  );

  return server;
}

export async function startMcpServer(root?: string) {
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
}
