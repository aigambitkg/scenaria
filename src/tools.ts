/**
 * The single, vendor-neutral tool registry.
 *
 * Every integration path uses these definitions:
 *   - MCP (any MCP client: Claude Code, Cursor, VS Code, Gemini CLI, Codex, Windsurf, …)
 *   - HTTP  POST /api/v1/tools/<name>  (n8n, Make, LangChain, CrewAI, custom apps)
 *   - CLI   scenaria call <name> '<json>'  (any agent that can run shell commands)
 *   - Function-calling schemas for any LLM API: scenaria tools --format openai|anthropic|gemini|json
 */
import { z } from "zod";
import { Scenaria } from "./core/engine.js";
import { optionLabel } from "./core/context.js";
import { recall, renderRecall } from "./core/recall.js";
import { projectMetrics, renderMetrics } from "./core/analysis.js";
import { SECTIONS, checkExpectations, referenceCapsule, renderExpectations, renderWorkspace, resolveRefs, workspace } from "./core/workspace.js";
import type { ScenariaNode, Source } from "./core/types.js";

export interface ToolContext {
  agent?: string;
  model?: string;
  user?: string;
  source: Source;
}

export interface ToolResult {
  /** Compact text for an LLM. */
  text: string;
  /** Structured result for programs. */
  data: unknown;
}

type Shape = Record<string, z.ZodType>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: Shape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  run(s: Scenaria, args: any, ctx: ToolContext): ToolResult;
}

export const INSTRUCTIONS = `Scenaria keeps ONE decision tree for the whole project (root n0 = project + main goal), so work can be rewound to any decision point (files + context) and alternatives can be explored.
Use it like a quicksave, on your own:
- Start: scenaria_status + scenaria_context. If the main goal is missing, ask the user and store it (scenaria_start_mission {projectGoal}).
- New piece of work: scenaria_start_mission {title, goal} — adds a task to the existing tree (never a second tree).
- Before acting on a real choice (or when the user answers a clarifying question): scenaria_decide with question, all options considered, chosen, rationale, context (the situation), servesGoal (link to the main goal), expectedOutcome, confidence.
- After a meaningful step: scenaria_checkpoint with short factual bullets (files in backticks); when the task is finished add taskDone + summary.
- Mistake or dead end: scenaria_last_good / scenaria_tree, then scenaria_rewind with a one-line lesson; continue ONLY from the returned context. Other option: scenaria_fork.
- Need older details: scenaria_recall instead of re-reading long histories. Refer to items by reference (n12, n12.f2, r3) instead of copying them; resolve with scenaria_get_node {refs}.
- Taking over work from another agent or session: scenaria_workspace {reader: "<your name>"} gives only what you do not know yet; scenaria_expect with your assumptions returns only the deviations.
- Give facts a confidence when you are not sure ({text, confidence}); low-confidence items are flagged for checking.
Keep entries short; never record facts you did not verify.`;

export function brief(n: ScenariaNode): string {
  let s = `${n.id} [${n.type}] ${n.type === "decision" ? n.question ?? n.title : n.title}`;
  if (n.type === "decision") {
    s += `\noptions: ${(n.options ?? []).map((o) => `${o.id}) ${o.label}${o.id === n.chosen ? " ✔" : ""}`).join("  ")}`;
  }
  if (n.snapshot) s += `\nsnapshot: ${n.snapshot.commit.slice(0, 10)} (${n.snapshot.files} files)`;
  if (n.changedFiles?.length) s += `\nchanged: ${n.changedFiles.slice(0, 12).join(", ")}${n.changedFiles.length > 12 ? " …" : ""}`;
  if (n.verification) s += `\nverification: ${n.verification.status}`;
  for (const w of n.snapshot?.warnings ?? []) s += `\nwarning: ${w}`;
  return s;
}

const str = z.string();
const list = z.array(z.string()).optional();
const actor = (c: ToolContext) => ({ agent: c.agent, model: c.model, user: c.user, source: c.source });

export const TOOLS: ToolDef[] = [
  {
    name: "scenaria_status",
    title: "Scenaria status",
    description: "Current mission, HEAD node, unsaved changes and counts. Call this first to orient yourself.",
    input: {},
    annotations: { readOnlyHint: true },
    run(s) {
      const st = s.status();
      const text = [
        `project: ${st.projectName}${st.project ? ` (${st.project.id})` : ""}`,
        `main goal: ${st.project?.goal ?? "NOT SET — ask the user, then scenaria_start_mission {projectGoal}"}`,
        `task: ${st.task ? `${st.task.id} ${st.task.title}` : "none — scenaria_start_mission {title, goal} when new work starts"}`,
        `HEAD: ${st.head ? `${st.head.id} [${st.head.type}${st.head.scenarioId ? ` ${st.head.scenarioId}/v${st.head.version}` : ""}] ${st.head.title}` : "—"}${st.dirty ? " (unsaved file changes)" : ""}`,
        `tasks ${st.counts.tasks}, decisions ${st.counts.decisions}, checkpoints ${st.counts.checkpoints}, branches ${st.counts.branches}, verified ${st.counts.verified}, failed ${st.counts.failed}, rules ${st.rules}`,
        st.counts.withoutRationale ? `quality: ${st.counts.withoutRationale} decision(s) without rationale` : "",
        st.snapshots ? "" : "warning: git not found, file snapshots disabled",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data: st };
    },
  },
  {
    name: "scenaria_start_mission",
    title: "Start task",
    description:
      "Start a new task (sub-goal) in the project's single decision tree — call it when a new piece of work begins. It is attached to the current HEAD; it never creates a second tree. Use projectGoal to set or change the project's overall main goal.",
    input: {
      title: str.describe("Short task title").optional(),
      goal: str.describe("What this task should achieve, in one or two sentences").optional(),
      brief: str.describe("The request as given by the user").optional(),
      projectGoal: str.describe("The overall main goal of the whole project (only when it is missing or changed)").optional(),
    },
    run(s, a, c) {
      if (!a.title && !a.projectGoal) throw new Error("Give a task title (and goal), or projectGoal.");
      const n = s.startMission({ ...a, ...actor(c) });
      const root = s.project();
      const note = root?.goal ? "" : "\nNOTE: the project's main goal is not set — ask the user and call scenaria_start_mission {projectGoal}.";
      return { text: `${n.type === "goal" ? "Task started" : "Project updated"}.\n${brief(n)}${note}`, data: n };
    },
  },
  {
    name: "scenaria_decide",
    title: "Record decision point",
    description:
      "Record a decision point BEFORE acting on it: the question, all options considered, the chosen one, rationale, assumptions and confidence. Snapshots the current files so this exact point can be restored and other options explored later.",
    input: {
      question: str.describe("The decision to make"),
      options: z
        .array(z.union([z.object({ label: str, description: str.optional() }), str]))
        .min(1)
        .describe("All options considered: objects {label, description} or plain strings"),
      chosen: z.union([str, z.number()]).optional().describe("Chosen option: its label, id (a, b, …) or 1-based index. Omit if still open."),
      rationale: str.optional().describe("Why this option (required when an option is chosen)"),
      context: str.optional().describe("The situation that made this decision necessary: constraints, facts, the user's request"),
      basedOn: list.describe("References this decision rests on, e.g. [\"n12.f2\", \"n7\", \"r3\"]"),
      servesGoal: str.optional().describe("How the chosen option serves the project's main goal / the current task"),
      expectedOutcome: str.optional().describe("What should be observable if the decision was right"),
      assumptions: list.describe("Assumptions this decision relies on"),
      confidence: z.number().min(0).max(1).optional().describe("0..1 — how sure you are"),
    },
    run(s, a, c) {
      const chosen = a.chosen !== undefined && a.chosen !== "";
      if (chosen && !a.rationale?.trim() && s.config().requireRationale !== false) {
        throw new Error("rationale is required when an option is chosen: say in one sentence why it beats the alternatives (and add context + servesGoal).");
      }
      const n = s.decide({ ...a, ...actor(c) });
      const missing = [!n.context && !n.trigger ? "context" : null, !n.servesGoal ? "servesGoal" : null, (n.options?.length ?? 0) < 2 ? "alternatives" : null].filter(Boolean);
      const hint = missing.length ? `\nquality: missing ${missing.join(", ")} — include them next time.` : "";
      return { text: `Decision recorded.\n${brief(n)}${hint}`, data: n };
    },
  },
  {
    name: "scenaria_choose",
    title: "Resolve open decision",
    description: "Set the chosen option of a decision that was recorded as open.",
    input: { id: str.describe("Decision node id"), option: z.union([str, z.number()]).describe("Label, id or 1-based index"), rationale: str.optional() },
    run(s, a) {
      const n = s.choose(a.id, a.option, a.rationale);
      return { text: `Decision ${n.id} → ${optionLabel(n, n.chosen)}`, data: n };
    },
  },
  {
    name: "scenaria_checkpoint",
    title: "Checkpoint (quicksave)",
    description:
      "Quicksave after a meaningful step: snapshot of files plus a compact fact capsule. Use short factual bullets; mention files in backticks so the verifier can check them.",
    input: {
      title: str.describe("What was achieved, in a few words"),
      outputs: list.describe("Output bullets: what was produced/changed"),
      facts: z
        .array(z.union([str, z.object({ text: str, confidence: z.number().min(0).max(1).optional(), basedOn: z.array(str).optional() })]))
        .optional()
        .describe("Facts established in this step: strings, or {text, confidence 0..1, basedOn: [refs]} when not fully sure"),
      basedOn: list.describe("References this step builds on (n12, n12.f2, r3)"),
      openQuestions: list.describe("Open questions / todos"),
      irreversible: list.describe("External side effects a rewind cannot undo (emails sent, pushes, API writes)"),
      onlyIfChanged: z.boolean().optional().describe("Skip if no file changed since HEAD"),
      taskDone: z.boolean().optional().describe("The current task is finished"),
      summary: str.optional().describe("With taskDone: 1–2 sentences on the task's result (what later sessions will read)"),
    },
    run(s, a, c) {
      const n = s.checkpoint({ ...a, ...actor(c) });
      const done = a.taskDone ? " Task marked done." : "";
      return { text: n ? `Checkpoint saved.${done}\n${brief(n)}` : `No file changes since HEAD — nothing saved.${done}`, data: n };
    },
  },
  {
    name: "scenaria_tree",
    title: "Decision tree",
    description:
      "Text view of the project's decision tree with HEAD marker and verification marks. Finished tasks are folded to one line; pass a node id to expand from there, or full=true for everything.",
    input: { from: str.optional().describe("Start at this node (e.g. a folded task id)"), full: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    run(s, a) {
      return { text: s.treeText(a.from, { full: a.full }), data: { head: s.store.readState().head } };
    },
  },
  {
    name: "scenaria_get_node",
    title: "Get node / resolve references",
    description:
      "Full JSON of one node (id), or resolve references to just their content (refs: [\"n12\", \"n12.f2\", \"n9.q1\", \"r3\"]). Use references instead of copying content around.",
    input: { id: str.optional(), refs: z.array(str).max(50).optional() },
    annotations: { readOnlyHint: true },
    run(s, a) {
      if (a.refs?.length) {
        const r = resolveRefs(s, a.refs);
        return { text: JSON.stringify(r, null, 2), data: r };
      }
      if (!a.id) throw new Error("Give id or refs.");
      if (a.id.includes(".")) {
        const r = resolveRefs(s, [a.id]);
        return { text: JSON.stringify(r[0], null, 2), data: r[0] };
      }
      const n = s.node(a.id);
      return { text: JSON.stringify(n, null, 2), data: n };
    },
  },
  {
    name: "scenaria_context",
    title: "Resume context",
    description:
      "Compact resume capsule for a node (default HEAD): goal, brief, decisions taken on the path, current facts/outputs, lessons. Use it instead of re-reading long histories. mode \"refs\" = an even shorter index of references to resolve on demand.",
    input: { id: str.optional(), mode: z.enum(["full", "refs"]).optional(), budget: z.number().int().min(300).max(20000).optional() },
    annotations: { readOnlyHint: true },
    run(s, a) {
      if (a.mode === "refs") {
        const text = referenceCapsule(s, a.id);
        return { text: `${text}\n\n(≈ ${Math.ceil(text.length / 4)} tokens)`, data: { markdown: text } };
      }
      const c = s.context(a.id, { budget: a.budget });
      return { text: `${c.markdown}\n\n(≈ ${c.tokens} tokens)`, data: c };
    },
  },
  {
    name: "scenaria_rewind",
    title: "Rewind",
    description:
      "Jump back to a node: restores files to its snapshot and moves HEAD there. Unsaved work is autosaved first, so this can be undone. Add a one-line lesson about what went wrong. Afterwards continue ONLY from the returned resume context.",
    input: {
      id: str.describe("Target node id, e.g. n7"),
      lesson: str.optional().describe("What went wrong / what to avoid"),
      restoreFiles: z.boolean().optional().describe("Default true. false = move decision state only"),
    },
    annotations: { destructiveHint: true },
    run(s, a, c) {
      const r = s.rewind(a.id, { lesson: a.lesson, restoreFiles: a.restoreFiles, ...actor(c) });
      const text = [
        `Rewound to ${r.target.id}.${r.autosave ? ` Previous state autosaved as ${r.autosave.id}.` : ""}`,
        ...r.warnings.map((w) => `WARNING: ${w}`),
        "",
        r.context.markdown,
      ].join("\n");
      return { text, data: r };
    },
  },
  {
    name: "scenaria_fork",
    title: "Explore alternative",
    description:
      "Explore a different option of an earlier decision: restores that decision's files and starts a new branch for the given option. Returns the resume context for the new branch.",
    input: {
      decisionId: str,
      option: z.union([str, z.number()]).describe("Option label, id (a, b, …) or 1-based index"),
      lesson: str.optional(),
    },
    annotations: { destructiveHint: true },
    run(s, a, c) {
      const r = s.fork(a.decisionId, a.option, { lesson: a.lesson, ...actor(c) });
      const dec = s.node(a.decisionId);
      const text = [
        `New branch ${r.branch.id}: ${optionLabel(dec, r.branch.viaOption)}.${r.autosave ? ` Previous state autosaved as ${r.autosave.id}.` : ""}`,
        ...r.warnings.map((w) => `WARNING: ${w}`),
        "",
        r.context.markdown,
      ].join("\n");
      return { text, data: r };
    },
  },
  {
    name: "scenaria_diff",
    title: "Diff",
    description: "File diff between two nodes, or a node and the current working tree (to = 'working').",
    input: { from: str, to: str.optional() },
    annotations: { readOnlyHint: true },
    run(s, a) {
      const d = s.diff(a.from, a.to);
      return { text: `${d.from} → ${d.to}\n${d.stat}\n\n${d.patch}`, data: d };
    },
  },
  {
    name: "scenaria_verify",
    title: "Verify node",
    description:
      "Verifier tool: runs deterministic checks (snapshot restorable, claimed files exist, decision documented, irreversible effects) and records your verdict. Use status 'failed' with notes when you find a hallucination or error.",
    input: {
      id: str,
      status: z.enum(["passed", "warning", "failed"]).optional().describe("Your verdict; omit to use the automatic result"),
      notes: str.optional(),
      runCommand: z.boolean().optional().describe("Also run the configured verifyCommand (only if node is HEAD and clean)"),
    },
    run(s, a, c) {
      const n = s.verify(a.id, { status: a.status, notes: a.notes, by: c.agent ?? c.user, runCommand: a.runCommand });
      const checks = (n.verification?.checks ?? []).map((x) => `- ${x.status.toUpperCase()} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`);
      return { text: [`${n.id}: ${n.verification?.status}`, ...checks].join("\n"), data: n };
    },
  },
  {
    name: "scenaria_recall",
    title: "Recall",
    description:
      "Search the whole project memory (decisions, rationales, tasks, lessons, checkpoints, conversations) by keywords. Use it to fetch older details on demand instead of loading long histories.",
    input: { query: str.describe("Keywords, e.g. file names, option labels, error words"), limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true },
    run(s, a) {
      const head = s.store.readState().head;
      const pathIds = head ? new Set(s.path(head).map((n) => n.id)) : undefined;
      const hits = recall(s.store.listNodes(), s.conversations.allMessages(), a.query, { limit: a.limit ?? 8, pathIds });
      return { text: renderRecall(hits), data: hits };
    },
  },
  {
    name: "scenaria_workspace",
    title: "Workspace (shared board)",
    description:
      "The project as a structured board instead of a chat history: goals, decisions, facts, questions, rules, lessons, risks — each item with a reference and confidence. Subscribe to the sections you need. With a reader name, Scenaria remembers what you already know and returns only new, changed and invalidated items.",
    input: {
      sections: z.array(z.enum(SECTIONS)).optional().describe("Only these sections (default: all)"),
      reader: str.optional().describe("Your stable reader name (agent/session). Enables delta mode: only what you do not know yet"),
      full: z.boolean().optional().describe("Return everything even if you read it before"),
    },
    run(s, a) {
      const r = workspace(s, { sections: a.sections, reader: a.reader, full: a.full });
      return { text: renderWorkspace(r), data: r };
    },
  },
  {
    name: "scenaria_expect",
    title: "Check expectations",
    description:
      "Predictive coding for handoffs: state what you assume before you start (\"n12 done\", \"n7 = Postgres\", \"n12.f2\", \"r3\", or free text) and get back only the deviations — contradicted or unknown assumptions to check.",
    input: { expectations: z.array(str).min(1).max(40) },
    annotations: { readOnlyHint: true },
    run(s, a) {
      const r = checkExpectations(s, a.expectations);
      return { text: renderExpectations(r), data: r };
    },
  },
  {
    name: "scenaria_health",
    title: "Project health",
    description:
      "Deterministic quality check of the whole tree: main goal set, decisions with context + rationale + goal link, work built on failed checks, open or low-confidence decisions, per-agent quality. No LLM involved.",
    input: {},
    annotations: { readOnlyHint: true },
    run(s) {
      const m = projectMetrics(s);
      return { text: renderMetrics(m), data: { ...m, decisions: undefined } };
    },
  },
  {
    name: "scenaria_last_good",
    title: "Last good node",
    description: "Nearest node on the path (from HEAD or given id) that was verified as passed — the safest rewind target.",
    input: { id: str.optional() },
    annotations: { readOnlyHint: true },
    run(s, a) {
      const n = s.lastGood(a.id);
      return { text: n ? brief(n) : "No verified-good node on this path yet. Use scenaria_tree to choose a target.", data: n };
    },
  },
];

export function getTool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name || x.name === `scenaria_${name}`);
  if (!t) throw new Error(`Unknown tool "${name}". Available: ${TOOLS.map((x) => x.name).join(", ")}`);
  return t;
}

/** Validate arguments and run a tool — shared by HTTP, CLI and custom integrations. */
export function callTool(s: Scenaria, name: string, args: unknown, ctx: ToolContext): ToolResult {
  const t = getTool(name);
  const parsed = z.object(t.input).safeParse(args ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${t.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  }
  return t.run(s, parsed.data, ctx);
}

// ------------------------------------------------------------------ schema export

export type SchemaFormat = "json" | "openai" | "openai-responses" | "anthropic" | "gemini" | "mcp";

function jsonSchema(t: ToolDef): Record<string, any> {
  const js = z.toJSONSchema(z.object(t.input)) as Record<string, any>;
  delete js.$schema;
  return js;
}

/** Gemini function declarations accept an OpenAPI subset: no type arrays, anyOf or additionalProperties. */
function simplifyForGemini(node: any): any {
  if (Array.isArray(node)) return node.map(simplifyForGemini);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = simplifyForGemini(v);
  }
  if (Array.isArray(out.type)) out.type = out.type[0];
  if (Array.isArray(out.anyOf)) {
    const pick = out.anyOf.find((x: any) => x.type === "object") ?? out.anyOf[0];
    delete out.anyOf;
    Object.assign(out, pick);
  }
  return out;
}

const FORMATS: SchemaFormat[] = ["json", "openai", "openai-responses", "anthropic", "gemini", "mcp"];

export function toolSchemas(format: SchemaFormat = "json") {
  if (!FORMATS.includes(format)) throw new Error(`Unknown format "${format}". Use: ${FORMATS.join(", ")}`);
  return TOOLS.map((t) => {
    const params = jsonSchema(t);
    switch (format) {
      case "openai":
        return { type: "function", function: { name: t.name, description: t.description, parameters: params } };
      case "openai-responses":
        return { type: "function", name: t.name, description: t.description, parameters: params };
      case "anthropic":
        return { name: t.name, description: t.description, input_schema: params };
      case "gemini":
        // Gemini rejects OBJECT schemas without properties — omit parameters for argument-less tools.
        return Object.keys(params.properties ?? {}).length
          ? { name: t.name, description: t.description, parameters: simplifyForGemini(params) }
          : { name: t.name, description: t.description };
      case "mcp":
        return { name: t.name, title: t.title, description: t.description, inputSchema: params, annotations: t.annotations };
      default:
        return { name: t.name, title: t.title, description: t.description, parameters: params, annotations: t.annotations };
    }
  });
}
