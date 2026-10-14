import type { ScenariaEvent, ScenariaNode } from "./types.js";
import { optionLabel } from "./context.js";
import { isUnconfirmedPass, verdictOrigin, type VerdictOrigin } from "./verdict.js";

const ORIGIN_LABEL: Record<VerdictOrigin, string> = { person: "the person", auditor: "a registered audit agent", agent: "the agent (self-reported)", auto: "the automatic checks", legacy: "an earlier version (origin not recorded)" };

const TYPE_LABEL: Record<string, string> = {
  mission: "Project",
  goal: "Task",
  decision: "Decision",
  checkpoint: "Checkpoint",
  branch: "Branch",
  autosave: "Autosave",
};

function yamlStr(s: string) {
  return JSON.stringify(s ?? "");
}

/** One Obsidian-compatible markdown note per node (local knowledge base). */
export function renderNodeNote(n: ScenariaNode, children: ScenariaNode[], confirmed?: boolean): string {
  const fm = [
    "---",
    `id: ${n.id}`,
    `type: ${n.type}`,
    `title: ${yamlStr(n.title)}`,
    `mission: ${n.missionId}`,
    `parent: ${n.parentId ?? "null"}`,
    n.viaOption ? `via_option: ${n.viaOption}` : null,
    `created: ${n.createdAt}`,
    n.agent ? `agent: ${yamlStr(n.agent)}` : null,
    `source: ${n.source}`,
    `verification: ${n.verification?.status ?? "unverified"}`,
    n.verification && n.verification.status !== "unverified" ? `verification_by: ${verdictOrigin(n.verification)}` : null,
    n.confidence !== undefined ? `confidence: ${n.confidence}` : null,
    n.snapshot ? `snapshot: ${n.snapshot.commit}` : null,
    `tags: [scenaria, ${n.type}${(n.tags ?? []).map((t) => ", " + t).join("")}]`,
    "---",
  ].filter(Boolean);

  const body: string[] = [`# ${n.id} · ${TYPE_LABEL[n.type] ?? n.type}: ${n.title}`, ""];
  if (n.parentId) body.push(`Parent: [[${n.parentId}]]`);
  if (children.length) body.push(`Children: ${children.map((c) => `[[${c.id}]]`).join(", ")}`);
  body.push("");
  if (n.goal) body.push(n.type === "goal" ? "## Task goal" : "## Main goal", n.goal, "");
  if (n.summary) body.push("## Summary", n.summary, "");
  if (n.brief && n.brief !== n.goal) body.push("## Brief", n.brief, "");
  if (n.type === "decision") {
    body.push("## Decision", n.question ?? n.title, "");
    for (const o of n.options ?? []) {
      const mark = o.id === n.chosen ? "x" : " ";
      body.push(`- [${mark}] **${o.label}**${o.description ? ` — ${o.description}` : ""}`);
    }
    if (n.rationale) body.push("", `**Rationale:** ${n.rationale}`);
    if (n.context) body.push(`**Context:** ${n.context}`);
    if (n.servesGoal) body.push(`**Serves the goal:** ${n.servesGoal}`);
    if (n.expectedOutcome) body.push(`**Expected outcome:** ${n.expectedOutcome}`);
    if (n.trigger) body.push(`**Triggered by:** ${n.trigger}`);
    if (n.confidence !== undefined) body.push(`**Confidence:** ${Math.round(n.confidence * 100)} %`);
    body.push("");
  }
  const section = (title: string, items?: string[]) => {
    if (items?.length) body.push(`## ${title}`, ...items.map((i) => `- ${i}`), "");
  };
  section("Assumptions", n.assumptions);
  section("Facts", n.facts);
  section("Outputs", n.outputs);
  section("Open questions", n.openQuestions);
  section("Lessons", n.lessons);
  section("Irreversible side effects", n.irreversible);
  section("Changed files", n.changedFiles);
  if (n.verification && n.verification.status !== "unverified") {
    const counts = n.verification.status === "passed" ? confirmed ?? !isUnconfirmedPass(n.verification) : true;
    body.push(`## Verification: ${n.verification.status} — by ${ORIGIN_LABEL[verdictOrigin(n.verification) ?? "legacy"]}${!counts ? (isUnconfirmedPass(n.verification) ? " (does not count as verified)" : " (NOT CONFIRMED: signature, key or content does not check out — does not count)") : ""}`);
    if (n.verification.report) body.push(`Later report (${n.verification.report.origin}): ${n.verification.report.status}${n.verification.report.notes ? ` — ${n.verification.report.notes}` : ""}`);
    if (n.verification.notes) body.push(n.verification.notes);
    for (const c of n.verification.checks ?? []) body.push(`- ${c.status.toUpperCase()} · ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    body.push("");
  }
  return fm.join("\n") + "\n\n" + body.join("\n");
}

/** Chronological, human-readable audit protocol. */
export function renderProtocol(projectName: string, events: ScenariaEvent[], nodes: ScenariaNode[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [
    `# Scenaria protocol — ${projectName}`,
    "",
    `Generated ${new Date().toISOString()} · ${nodes.length} nodes · ${events.length} events`,
    "",
    "| Time (UTC) | Event | Node | Details |",
    "|---|---|---|---|",
  ];
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const e of events) {
    const n = e.nodeId ? byId.get(e.nodeId) : undefined;
    let details = "";
    const d = (e.data ?? {}) as Record<string, any>;
    switch (e.type) {
      case "mission":
      case "goal":
        details = n?.goal ? `${n.title} — goal: ${n.goal}` : n?.title ?? "";
        break;
      case "decision":
      case "choose":
        details = n ? `${n.question ?? n.title} → ${optionLabel(n, n.chosen) ?? "open"}` : "";
        break;
      case "checkpoint":
      case "autosave":
      case "branch":
        details = n?.title ?? "";
        break;
      case "rewind":
        details = `from ${d.from ?? "?"} to ${d.to ?? "?"}${d.restoreFiles === false ? " (state only)" : ""}${d.autosave ? `, autosave ${d.autosave}` : ""}${d.lesson ? ` · lesson: ${d.lesson}` : ""}`;
        break;
      case "verify":
        details = `${d.status ?? ""}${d.notes ? ` — ${d.notes}` : ""}${d.by ? ` (by ${d.by}${d.origin ? `, ${d.origin}` : ""})` : ""}${d.ignored ? ` — not applied: ${d.ignored}` : ""}${d.kept ? ` — kept next to the ${d.kept}'s verdict` : ""}`;
        break;
      default:
        details = d.message ? String(d.message) : "";
    }
    out.push(`| ${e.ts.replace("T", " ").slice(0, 19)} | ${e.type} | ${e.nodeId ?? ""} | ${esc(details).slice(0, 400)} |`);
  }
  return out.join("\n") + "\n";
}
