import type { ScenariaNode } from "./types.js";

export function estimateTokens(text: string): number {
  // Rough heuristic (~4 chars per token for mixed EN/DE prose + code).
  return Math.ceil(text.length / 4);
}

export function optionLabel(node: ScenariaNode, optId?: string): string | undefined {
  if (!optId) return undefined;
  return node.options?.find((o) => o.id === optId)?.label ?? optId;
}

function bullets(items: string[] | undefined, indent = ""): string[] {
  return (items ?? []).filter(Boolean).map((i) => `${indent}- ${i}`);
}

function short(s: string | undefined, max = 220): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/**
 * Build the resume capsule for the path root → target.
 *
 * Non-anticipativity: only nodes ON the path are included. Content of sibling
 * branches (abandoned or alternative futures) is deliberately excluded — the
 * only thing that crosses branches are explicit `lessons`.
 */
export function composeContext(
  path: ScenariaNode[],
  opts: { fullCheckpoints?: number; lastGood?: string | null; lastUserRequest?: string | null } = {},
): string {
  const full = opts.fullCheckpoints ?? 3;
  const mission = path[0];
  const target = path[path.length - 1];
  const lines: string[] = [];

  const label = target.scenarioId !== undefined && target.version !== undefined ? ` (${target.scenarioId}/v${target.version})` : "";
  lines.push(`# Scenaria resume context — ${target.id}${label}`);
  lines.push("");
  lines.push(`Mission ${mission.id}: **${mission.title}**`);
  if (mission.goal) {
    lines.push("", "## Main goal", short(mission.goal, 1200));
  }
  if (mission.brief && mission.brief !== mission.goal) {
    lines.push("", "## Brief", short(mission.brief, 1500));
  }

  // Which checkpoints get full detail: the last `full` of them.
  const cpIdx = path
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type === "checkpoint" || n.type === "autosave" || n.type === "branch")
    .map(({ i }) => i);
  const fullSet = new Set(cpIdx.slice(-full));

  const steps: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const n = path[i];
    const next = path[i + 1];
    if (n.type === "decision") {
      const takenId = next?.viaOption ?? n.chosen;
      const taken = optionLabel(n, takenId);
      const alts = (n.options ?? []).filter((o) => o.id !== takenId).map((o) => o.label);
      let s = `${n.id} ❖ ${short(n.question || n.title, 300)} → ${taken ? `**${taken}**` : "_(open — no option chosen yet)_"}`;
      if (takenId && n.chosen && takenId !== n.chosen) {
        s += ` — alternative branch (originally chosen: ${optionLabel(n, n.chosen)})`;
      } else if (n.rationale) s += ` — why: ${short(n.rationale, 300)}`;
      if (alts.length) s += ` (alternatives: ${alts.join(" | ")})`;
      steps.push(`- ${s}`);
      for (const a of n.assumptions ?? []) steps.push(`  - assumption: ${short(a, 200)}`);
    } else {
      const label = n.type === "branch" ? "⑂" : n.type === "autosave" ? "⟲" : "◆";
      steps.push(`- ${n.id} ${label} ${short(n.title, 200)}`);
      if (fullSet.has(i) && n !== target) {
        steps.push(...bullets(n.outputs?.slice(0, 8), "  "));
      }
    }
    for (const l of n.lessons ?? []) steps.push(`  - lesson: ${short(l, 300)}`);
    for (const x of n.irreversible ?? []) steps.push(`  - ⚠ irreversible: ${short(x, 200)}`);
    if (n.verification && n.verification.status !== "unverified") {
      steps.push(`  - verification: ${n.verification.status}${n.verification.notes ? ` — ${short(n.verification.notes, 200)}` : ""}`);
    }
  }
  if (steps.length) {
    lines.push("", "## Path so far (decisions taken)", ...steps);
  }

  if (target.type !== "mission") {
    lines.push("", `## Current state (${target.id}: ${short(target.title, 160)})`);
    if (target.facts?.length) lines.push("Facts:", ...bullets(target.facts));
    if (target.outputs?.length) lines.push("Outputs:", ...bullets(target.outputs));
    if (target.openQuestions?.length) lines.push("Open questions:", ...bullets(target.openQuestions));
    if (target.changedFiles?.length) {
      const cf = target.changedFiles.slice(0, 25);
      lines.push(`Changed files vs. previous snapshot (${target.changedFiles.length}):`, ...bullets(cf));
      if (target.changedFiles.length > cf.length) lines.push(`- … ${target.changedFiles.length - cf.length} more`);
    }
  }

  // Facts accumulated earlier on the path (deduplicated, newest last).
  const earlierFacts = Array.from(
    new Set(path.slice(0, -1).flatMap((n) => n.facts ?? [])),
  ).slice(-15);
  if (earlierFacts.length) lines.push("", "## Established facts (earlier on this path)", ...bullets(earlierFacts));

  if (opts.lastUserRequest) lines.push("", "## Latest user request on this path", short(opts.lastUserRequest, 800));
  if (opts.lastGood) lines.push("", `Last verified-good node on this path: ${opts.lastGood}`);
  if (target.snapshot) {
    lines.push("", `Files are at snapshot ${target.snapshot.commit.slice(0, 10)} (${target.snapshot.files} files).`);
  }
  lines.push(
    "",
    "_Only this path is included. Other branches are intentionally excluded; continue from the current state above._",
  );
  return lines.join("\n");
}
