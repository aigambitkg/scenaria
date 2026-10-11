/**
 * Analysis: pattern recognition and optimization over the project's decisions.
 *
 *  1. metrics()  — deterministic health check, no LLM, no tokens: goal set? decisions with
 *                  context + rationale + goal link? failed work built upon? revised decisions?
 *                  per-agent / per-model quality.
 *  2. dossier()  — the same history as a compact, token-budgeted text for ANY LLM.
 *  3. runAnalysis() — sends the dossier to a configured LLM (OpenAI-compatible APIs incl.
 *                  Ollama / LM Studio / Gemini / Mistral / Groq / OpenRouter, or Anthropic)
 *                  and stores the structured result. Accepted recommendations become project
 *                  rules, which every later capsule and prompt carries → the loop closes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenaria } from "./engine.js";
import { DEFAULT_PROXY } from "./engine.js";
import { estimateTokens, optionLabel, taskNodes, taskRollup } from "./context.js";
import { writeJsonAtomic } from "./store.js";
import type { AnalysisConfig, ProjectRule, ScenariaNode } from "./types.js";
import type { CanonEvent } from "./canon.js";

export type Severity = "high" | "medium" | "low";

export interface Issue {
  code: string;
  severity: Severity;
  /** English text (CLI, agents); UIs can localize via code + subject + value. */
  message: string;
  nodeId?: string;
  /** The decision question / task title the issue is about. */
  subject?: string;
  value?: number;
}

export type DecisionOutcome = "kept" | "revised" | "abandoned" | "failed" | "passed" | "open";

export interface DecisionStat {
  id: string;
  task?: string;
  question: string;
  chosen?: string;
  quality: number; // 0..1
  missing: string[];
  outcome: DecisionOutcome;
  agent?: string;
  model?: string;
  confidence?: number;
}

export interface AgentStat {
  decisions: number;
  avgQuality: number;
  avgConfidence: number | null;
  failed: number;
  revised: number;
  withoutRationale: number;
}

export interface Metrics {
  health: number; // 0..100
  goalSet: boolean;
  counts: { nodes: number; tasks: number; decisions: number; checkpoints: number; branches: number; rewinds: number; failed: number; passed: number; openDecisions: number; irreversible: number };
  decisionQuality: number; // 0..1 average
  issues: Issue[];
  decisions: DecisionStat[];
  tasks: { id: string; title: string; status?: string; steps: number; decisions: number; failed: number; branches: number; summary: string }[];
  byAgent: Record<string, AgentStat>;
  byModel: Record<string, AgentStat>;
}

const FIELDS: { key: string; ok: (d: ScenariaNode) => boolean }[] = [
  { key: "chosen", ok: (d) => Boolean(d.chosen) },
  { key: "rationale", ok: (d) => Boolean(d.rationale) },
  { key: "context", ok: (d) => Boolean(d.context || d.trigger) },
  { key: "servesGoal", ok: (d) => Boolean(d.servesGoal) },
  { key: "alternatives", ok: (d) => (d.options?.length ?? 0) >= 2 },
  { key: "confidence", ok: (d) => d.confidence !== undefined },
];

export function decisionQuality(d: ScenariaNode): { score: number; missing: string[] } {
  const missing = FIELDS.filter((f) => !f.ok(d)).map((f) => f.key);
  return { score: (FIELDS.length - missing.length) / FIELDS.length, missing };
}

function pathSet(nodes: ScenariaNode[], head: string | null): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  let cur = head ? byId.get(head) : undefined;
  while (cur && !out.has(cur.id)) {
    out.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Nodes that follow a decision on its chosen line, up to the next decision or task. */
function consequences(d: ScenariaNode, kids: Map<string, ScenariaNode[]>): ScenariaNode[] {
  const out: ScenariaNode[] = [];
  const stack = (kids.get(d.id) ?? []).filter((k) => !k.viaOption || k.viaOption === d.chosen);
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    if (n.type === "decision" || n.type === "goal") continue;
    stack.push(...(kids.get(n.id) ?? []));
  }
  return out;
}

function emptyStat(): AgentStat {
  return { decisions: 0, avgQuality: 0, avgConfidence: null, failed: 0, revised: 0, withoutRationale: 0 };
}

export function metrics(
  nodes: ScenariaNode[],
  head: string | null,
  opts: { rewinds?: number; integrity?: Map<string, "ok" | "tampered" | "unsealed">; ledgerBrokenAt?: number | null; ledgerMissing?: boolean; canon?: CanonEvent[]; canonError?: string | null; canonMissing?: string[] } = {},
): Metrics {
  const issues: Issue[] = [];
  // Canon: fixed points broken, checks failed, deadlines passed, proposals waiting.
  {
    const canon = opts.canon ?? [];
    const act = canon.filter((k) => k.status === "active");
    const pathNow = pathSet(nodes, head);
    for (const n of nodes) {
      for (const id of n.breaksCanon ?? []) {
        const k = act.find((x) => x.id === id);
        if (k && pathNow.has(n.id)) issues.push({ code: "canon_broken", severity: k.hard ? "high" : "medium", message: `${n.id} breaks canon ${id} ("${short(k.text)}") on the current line.`, nodeId: n.id, subject: `${id}: ${short(k.text, 70)}` });
      }
    }
    for (const k of act) {
      if (k.lastCheck?.status === "failed") issues.push({ code: "canon_check_failed", severity: k.hard ? "high" : "medium", message: `Check of canon ${k.id} failed: "${short(k.text)}"`, subject: `${k.id}: ${short(k.text, 70)}` });
      else if (k.kind === "future" && k.due && k.due < new Date().toISOString().slice(0, 10) && k.lastCheck?.status !== "passed") {
        issues.push({ code: "canon_overdue", severity: "medium", message: `Canon ${k.id} was due ${k.due} and is not proven: "${short(k.text)}"`, subject: `${k.id}: ${short(k.text, 70)}` });
      }
    }
    for (const k of canon.filter((x) => x.status === "tampered")) issues.push({ code: "canon_tampered", severity: "high", message: `Canon ${k.id} was changed outside Scenaria (approval signature invalid) — not binding until you re-approve it: "${short(k.text)}"`, subject: `${k.id}: ${short(k.text, 70)}` });
    for (const k of canon.filter((x) => x.status === "untrusted")) issues.push({ code: "canon_untrusted", severity: "high", message: `Canon ${k.id} is signed by an approver key that is not trusted on this machine (${k.keyId ?? "?"}, says "${k.decidedBy ?? "?"}") — not binding. Re-approve it, or trust that teammate's key: scenaria canon trust <public key>.`, subject: `${k.id}: ${short(k.text, 70)}` });
    for (const k of act.filter((x) => x.checkTampered)) issues.push({ code: "canon_check_tampered", severity: "high", message: `The last check result of canon ${k.id} was changed outside Scenaria (signature invalid) — ignored. Run the check again: "${short(k.text)}"`, subject: `${k.id}: ${short(k.text, 70)}` });
    for (const id of opts.canonMissing ?? []) issues.push({ code: "canon_missing", severity: "high", message: `Approved canon ${id} is missing from canon.json — it was deleted outside Scenaria. Restore it (e.g. git checkout .scenaria/canon.json).`, subject: id });
    if (opts.canonError) issues.push({ code: "canon_unreadable", severity: "high", message: opts.canonError });
    const proposed = canon.filter((k) => k.status === "proposed").length;
    if (proposed) issues.push({ code: "canon_proposed", severity: "low", message: `${proposed} proposed canon event(s) await your approval.`, value: proposed });
    if (!act.length && nodes.filter((n) => n.type === "decision").length >= 5) issues.push({ code: "no_canon", severity: "low", message: "No canon events (fixed points) yet — decisions cannot be checked against hard constraints." });
  }
  if (opts.ledgerMissing) issues.push({ code: "ledger_missing", severity: "high", message: "The integrity ledger was deleted — changes since then cannot be verified. Review, then run: scenaria integrity --reseal" });
  if (opts.ledgerBrokenAt) issues.push({ code: "ledger_broken", severity: "high", message: `The integrity ledger was edited or truncated (line ${opts.ledgerBrokenAt}) — history may have been manipulated.`, value: opts.ledgerBrokenAt });
  for (const n of nodes) {
    if (opts.integrity?.get(n.id) === "tampered" && !opts.ledgerMissing) issues.push({ code: "tampered", severity: "high", message: `${n.id} was changed outside Scenaria ("${short(n.title)}") — its content no longer matches the ledger.`, nodeId: n.id, subject: short(n.title) });
  }
  const onPath = pathSet(nodes, head);
  const kids = new Map<string, ScenariaNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = nodes.find((n) => !n.parentId && n.type === "mission");
  const goalOf = (n: ScenariaNode): ScenariaNode | undefined => {
    let cur: ScenariaNode | undefined = n.parentId ? byId.get(n.parentId) : undefined;
    while (cur && cur.type !== "goal") cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    return cur;
  };

  if (!root?.goal) issues.push({ code: "goal_missing", severity: "high", message: "The project's main goal is not set — decisions cannot be checked against it.", nodeId: root?.id });

  const decisions: DecisionStat[] = [];
  const agentAcc = new Map<string, { q: number[]; c: number[]; s: AgentStat }>();
  const modelAcc = new Map<string, { q: number[]; c: number[]; s: AgentStat }>();
  const acc = (m: Map<string, { q: number[]; c: number[]; s: AgentStat }>, k: string | undefined) => {
    const key = k || "unknown";
    if (!m.has(key)) m.set(key, { q: [], c: [], s: emptyStat() });
    return m.get(key)!;
  };

  for (const d of nodes.filter((n) => n.type === "decision")) {
    const q = decisionQuality(d);
    const children = kids.get(d.id) ?? [];
    const cons = consequences(d, kids);
    const revised = children.some((k) => k.viaOption && d.chosen && k.viaOption !== d.chosen);
    const failed = cons.some((n) => n.verification?.status === "failed");
    const passed = cons.some((n) => n.verification?.status === "passed");
    let outcome: DecisionOutcome = !d.chosen ? "open" : failed ? "failed" : revised ? "revised" : !onPath.has(d.id) ? "abandoned" : passed ? "passed" : "kept";
    const stat: DecisionStat = {
      id: d.id,
      task: goalOf(d)?.id,
      question: d.question ?? d.title,
      chosen: optionLabel(d, d.chosen),
      quality: Math.round(q.score * 100) / 100,
      missing: q.missing,
      outcome,
      agent: d.agent,
      model: d.model,
      confidence: d.confidence,
    };
    decisions.push(stat);
    for (const a of [acc(agentAcc, d.agent), acc(modelAcc, d.model)]) {
      a.s.decisions++;
      a.q.push(q.score);
      if (d.confidence !== undefined) a.c.push(d.confidence);
      if (failed) a.s.failed++;
      if (revised) a.s.revised++;
      if (d.chosen && !d.rationale) a.s.withoutRationale++;
    }
    if (d.chosen && !d.rationale) issues.push({ code: "no_rationale", severity: "medium", message: `Decision without rationale: "${short(stat.question)}"`, nodeId: d.id, subject: short(stat.question) });
    if (!d.context && !d.trigger) issues.push({ code: "no_context", severity: "low", message: `Decision without context (why did it come up?): "${short(stat.question)}"`, nodeId: d.id, subject: short(stat.question) });
    else if (!d.servesGoal && root?.goal) issues.push({ code: "no_goal_link", severity: "low", message: `Decision not linked to the main goal: "${short(stat.question)}"`, nodeId: d.id, subject: short(stat.question) });
    if ((d.options?.length ?? 0) < 2) issues.push({ code: "single_option", severity: "low", message: `Only one option considered: "${short(stat.question)}"`, nodeId: d.id, subject: short(stat.question) });
    if (!d.chosen) issues.push({ code: "open_decision", severity: "medium", message: `Open decision (no option chosen): "${short(stat.question)}"`, nodeId: d.id, subject: short(stat.question) });
    if (d.confidence !== undefined && d.confidence < 0.5 && !passed && onPath.has(d.id)) {
      issues.push({ code: "low_confidence_unverified", severity: "medium", message: `Low-confidence decision (${Math.round(d.confidence * 100)} %) on the current path was never verified: "${short(stat.question)}"`, nodeId: d.id, subject: short(stat.question), value: Math.round(d.confidence * 100) });
    }
  }

  // Work continues on top of a failed node.
  for (const n of nodes) {
    if (n.verification?.status === "failed" && onPath.has(n.id) && n.id !== head) {
      issues.push({ code: "built_on_failure", severity: "high", message: `The current line continues after a failed check at ${n.id} ("${short(n.title)}") — rewind or fix it.`, nodeId: n.id, subject: short(n.title) });
    }
  }

  const tasks = nodes
    .filter((n) => n.type === "goal")
    .map((g) => {
      const inside = taskNodes(g.id, nodes);
      const t = {
        id: g.id,
        title: g.title,
        status: g.status,
        steps: inside.length,
        decisions: inside.filter((n) => n.type === "decision").length,
        failed: inside.filter((n) => n.verification?.status === "failed").length,
        branches: inside.filter((n) => n.type === "branch" || Boolean(n.forkedFrom)).length,
        summary: g.summary ?? taskRollup(g, inside),
      };
      if (t.branches >= 3) issues.push({ code: "many_branches", severity: "medium", message: `Task "${short(g.title)}" needed ${t.branches} branches/restarts — requirements or approach may be unclear.`, nodeId: g.id, subject: short(g.title), value: t.branches });
      if (g.status === "done" && !g.meta?.baseline && !inside.some((n) => n.type === "checkpoint")) issues.push({ code: "task_no_result", severity: "low", message: `Task "${short(g.title)}" is done but has no checkpoint (result not documented).`, nodeId: g.id, subject: short(g.title) });
      return t;
    });

  const finish = (m: Map<string, { q: number[]; c: number[]; s: AgentStat }>) =>
    Object.fromEntries(
      [...m.entries()].map(([k, v]) => [
        k,
        {
          ...v.s,
          avgQuality: Math.round((v.q.reduce((a, b) => a + b, 0) / Math.max(1, v.q.length)) * 100) / 100,
          avgConfidence: v.c.length ? Math.round((v.c.reduce((a, b) => a + b, 0) / v.c.length) * 100) / 100 : null,
        },
      ]),
    );

  const irreversible = nodes.reduce((s, n) => s + (n.irreversible?.length ?? 0), 0);
  const counts = {
    nodes: nodes.length,
    tasks: tasks.length,
    decisions: decisions.length,
    checkpoints: nodes.filter((n) => n.type === "checkpoint").length,
    branches: nodes.filter((n) => n.type === "branch").length,
    rewinds: opts.rewinds ?? 0,
    failed: nodes.filter((n) => n.verification?.status === "failed").length,
    passed: nodes.filter((n) => n.verification?.status === "passed").length,
    openDecisions: decisions.filter((d) => d.outcome === "open").length,
    irreversible,
  };
  const decisionQualityAvg = decisions.length ? decisions.reduce((s, d) => s + d.quality, 0) / decisions.length : 1;

  let health = 100;
  if (!root?.goal) health -= 20;
  health -= Math.min(40, issues.filter((i) => i.code === "tampered" || i.code === "ledger_broken" || i.code === "ledger_missing").length * 20);
  health -= Math.min(30, issues.filter((i) => ["canon_broken", "canon_check_failed", "canon_tampered", "canon_untrusted", "canon_missing", "canon_check_tampered", "canon_unreadable"].includes(i.code) && i.severity === "high").length * 15);
  health -= Math.min(25, Math.round((1 - decisionQualityAvg) * 40));
  health -= Math.min(30, issues.filter((i) => i.code === "built_on_failure").length * 15);
  health -= Math.min(10, counts.openDecisions * 2);
  health -= Math.min(10, issues.filter((i) => i.code === "low_confidence_unverified").length * 3);
  health -= Math.min(5, issues.filter((i) => i.code === "many_branches").length * 2);

  const sevRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  return {
    health: Math.max(0, Math.min(100, health)),
    goalSet: Boolean(root?.goal),
    counts,
    decisionQuality: Math.round(decisionQualityAvg * 100) / 100,
    issues,
    decisions,
    tasks,
    byAgent: finish(agentAcc),
    byModel: finish(modelAcc),
  };
}

function short(s: string | undefined, max = 90): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function projectMetrics(s: Scenaria): Metrics {
  const rewinds = s.store.readEvents().filter((e) => e.type === "rewind").length;
  const integ = s.integrity();
  return metrics(s.store.listNodes(), s.store.readState().head, { rewinds, integrity: integ.state, ledgerBrokenAt: integ.ledgerBrokenAt, ledgerMissing: integ.ledgerMissing, ...(() => {
    const cs = s.canonState();
    return { canon: cs.events, canonError: cs.error, canonMissing: cs.missing };
  })() });
}

// ------------------------------------------------------------------ dossier (for any LLM)

/** The project history as compact text, newest decisions kept when the budget is tight. */
export function dossier(s: Scenaria, opts: { maxTokens?: number } = {}): { text: string; tokens: number; decisions: number; omitted: number } {
  const max = Math.max(1500, opts.maxTokens ?? 8000);
  const nodes = s.store.listNodes();
  const m = projectMetrics(s);
  const root = s.project();
  const rules = s.rules();
  const stat = new Map(m.decisions.map((d) => [d.id, d]));

  const head: string[] = [
    `PROJECT: ${s.config().projectName}`,
    `MAIN GOAL: ${root?.goal ?? "(not set)"}`,
    `HEALTH: ${m.health}/100 · decisions ${m.counts.decisions} (avg quality ${Math.round(m.decisionQuality * 100)} %) · tasks ${m.counts.tasks} · branches ${m.counts.branches} · rewinds ${m.counts.rewinds} · failed checks ${m.counts.failed} · open decisions ${m.counts.openDecisions}`,
  ];
  if (rules.length) head.push("RULES:", ...rules.map((r) => `- ${r.id}: ${r.text}`));
  head.push("AGENTS/MODELS:");
  for (const [k, v] of Object.entries(m.byAgent)) head.push(`- agent ${k}: ${v.decisions} decisions, quality ${Math.round(v.avgQuality * 100)} %, failed ${v.failed}, revised ${v.revised}, no rationale ${v.withoutRationale}`);
  for (const [k, v] of Object.entries(m.byModel)) head.push(`- model ${k}: ${v.decisions} decisions, quality ${Math.round(v.avgQuality * 100)} %, avg confidence ${v.avgConfidence ?? "-"}, failed ${v.failed}`);
  if (m.tasks.length) head.push("TASKS (oldest first):", ...m.tasks.map((t) => `T ${t.id} "${short(t.title, 80)}" [${t.status ?? "?"}] steps ${t.steps}, decisions ${t.decisions}, branches ${t.branches}, failed ${t.failed} — ${short(t.summary, 220)}`));

  const decisionLines = nodes
    .filter((n) => n.type === "decision")
    .map((d) => {
      const st = stat.get(d.id)!;
      const alts = (d.options ?? []).filter((o) => o.id !== d.chosen).map((o) => short(o.label, 40));
      const parts = [
        `D ${d.id}${st.task ? ` task=${st.task}` : ""} by=${d.agent ?? "?"}${d.model ? `/${d.model}` : ""}${d.confidence !== undefined ? ` conf=${d.confidence}` : ""} outcome=${st.outcome}`,
        `Q: ${short(d.question ?? d.title, 140)}`,
        `chosen: ${short(st.chosen ?? "open", 60)}`,
      ];
      if (alts.length) parts.push(`alts: ${alts.join("; ")}`);
      if (d.rationale) parts.push(`why: ${short(d.rationale, 160)}`);
      if (d.context) parts.push(`ctx: ${short(d.context, 140)}`);
      else if (d.trigger) parts.push(`asked: ${short(d.trigger, 120)}`);
      if (d.servesGoal) parts.push(`goal: ${short(d.servesGoal, 120)}`);
      if (d.expectedOutcome) parts.push(`expected: ${short(d.expectedOutcome, 100)}`);
      if (st.missing.length) parts.push(`missing: ${st.missing.join(",")}`);
      return parts.join(" | ");
    });
  const lessons = nodes.flatMap((n) => (n.lessons ?? []).map((l) => `L ${n.id}: ${short(l, 180)}`));
  const failures = nodes.filter((n) => n.verification?.status === "failed").map((n) => `F ${n.id} "${short(n.title, 80)}": ${short(n.verification?.notes, 160)}`);

  let budget = max - estimateTokens(head.join("\n")) - estimateTokens([...lessons, ...failures].join("\n")) - 60;
  const kept: string[] = [];
  for (let i = decisionLines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(decisionLines[i]) + 1;
    if (budget - cost < 0) break;
    budget -= cost;
    kept.unshift(decisionLines[i]);
  }
  const omitted = decisionLines.length - kept.length;
  const text = [
    ...head,
    `DECISIONS (oldest first${omitted ? `, ${omitted} older omitted` : ""}; outcome: kept|passed|revised|abandoned|failed|open):`,
    ...kept,
    ...(lessons.length ? ["LESSONS:", ...lessons.slice(-30)] : []),
    ...(failures.length ? ["FAILED CHECKS:", ...failures.slice(-20)] : []),
  ].join("\n");
  return { text, tokens: estimateTokens(text), decisions: kept.length, omitted };
}

export function analysisPrompt(lang: "de" | "en" = "en"): string {
  return `You analyse the decision history of a software/knowledge project that AI agents and people worked on, recorded by Scenaria.
Main goal of your analysis: make future decisions better aligned with the project's main goal, with less rework and less token waste.

Look for:
1. Goal alignment — do tasks and decisions serve the MAIN GOAL? Name drift, side quests, contradictions.
2. Logic — decisions that contradict rules, lessons or earlier decisions; assumptions never verified; the same question decided repeatedly; work continued after failures.
3. Patterns — recurring good and bad habits (per agent/model too): e.g. revised decisions after low confidence, missing alternatives, missing context.
4. Optimisation — concrete rules agents should follow from now on (imperative, max 25 words each, only if backed by evidence).
5. Token economy — where context could be shorter without losing information.

Cite node ids (n12, …) as evidence. Be specific and concise; do not invent facts that are not in the dossier.
Answer ONLY with one JSON object, no prose around it:
{"summary": "3-5 sentences", "goalAlignment": {"score": 0-100, "notes": "…"}, "patterns": [{"title": "…", "kind": "good|bad", "evidence": ["n7"], "impact": "…"}], "issues": [{"title": "…", "severity": "high|medium|low", "evidence": ["n9"], "fix": "…"}], "rules": [{"text": "…", "why": "…", "evidence": ["n3"]}], "tokenTips": ["…"]}
Write all text values in ${lang === "de" ? "German" : "English"}.`;
}

// ------------------------------------------------------------------ LLM call (provider-neutral)

const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
};

export interface LlmRequest extends AnalysisConfig {
  /** Only for this request — never stored. */
  apiKey?: string;
}

export function resolveLlm(cfg: LlmRequest, upstreams: Record<string, string>) {
  const provider = (cfg.provider || "").trim().toLowerCase();
  if (!provider) throw new Error("No analysis provider configured (e.g. ollama, openai, anthropic).");
  if (!cfg.model?.trim()) throw new Error("No model configured for the analysis (e.g. llama3.3, gpt-5-mini, claude-sonnet-5-5).");
  const base = (cfg.baseUrl?.trim() || upstreams[provider] || (provider === "anthropic" ? "https://api.anthropic.com" : "")).replace(/\/+$/, "");
  if (!base) throw new Error(`Unknown provider "${provider}" — set a base URL (OpenAI-compatible, e.g. http://127.0.0.1:11434/v1).`);
  const envName = cfg.apiKeyEnv?.trim() || KEY_ENV[provider] || (provider === "gemini" ? "GOOGLE_API_KEY" : "");
  const key = cfg.apiKey?.trim() || (envName ? process.env[envName] : undefined) || (provider === "gemini" ? process.env.GOOGLE_API_KEY : undefined);
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(base + "/");
  if (!key && !local) throw new Error(`No API key for ${provider}: set ${envName || "an API key env var"} where Scenaria runs, or enter a key for this run (it is not stored).`);
  return { provider, model: cfg.model.trim(), base, key, kind: provider === "anthropic" || /anthropic\.com/.test(base) ? ("anthropic" as const) : ("openai" as const) };
}

export async function callLlm(cfg: LlmRequest, upstreams: Record<string, string>, system: string, user: string, timeoutMs = 240_000): Promise<{ text: string; model: string; usage?: unknown }> {
  const r = resolveLlm(cfg, upstreams);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    if (r.kind === "anthropic") {
      res = await fetch(`${r.base}${/\/v1$/.test(r.base) ? "" : "/v1"}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": r.key ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: r.model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
        signal: ctrl.signal,
      });
    } else {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (r.key) headers.authorization = `Bearer ${r.key}`;
      res = await fetch(`${r.base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: r.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2 }),
        signal: ctrl.signal,
      });
    }
    const raw = await res.text();
    if (!res.ok) throw new Error(`${r.provider} answered HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const text =
      r.kind === "anthropic"
        ? (json.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
        : String(json.choices?.[0]?.message?.content ?? "");
    return { text, model: json.model ?? r.model, usage: json.usage };
  } catch (err: any) {
    if (ctrl.signal.aborted) throw new Error(`${r.provider} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    if (err?.cause?.code === "ECONNREFUSED") throw new Error(`${r.provider} not reachable at ${r.base} (is it running?)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface Insights {
  summary?: string;
  goalAlignment?: { score?: number; notes?: string };
  patterns?: { title: string; kind?: string; evidence?: string[]; impact?: string }[];
  issues?: { title: string; severity?: string; evidence?: string[]; fix?: string }[];
  rules?: { text: string; why?: string; evidence?: string[] }[];
  tokenTips?: string[];
}

/** Tolerant JSON extraction (code fences, prose around the object). */
export function parseInsights(text: string): { insights: Insights; parsed: boolean } {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Insights) : null;
    } catch {
      return null;
    }
  };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((x): x is string => Boolean(x && x.trim()));
  for (const c of candidates) {
    const v = tryParse(c.trim());
    if (v) {
      const arr = <T,>(x: unknown) => (Array.isArray(x) ? (x as T[]) : undefined);
      return {
        parsed: true,
        insights: {
          summary: typeof v.summary === "string" ? v.summary : undefined,
          goalAlignment: v.goalAlignment && typeof v.goalAlignment === "object" ? v.goalAlignment : undefined,
          patterns: arr(v.patterns),
          issues: arr(v.issues),
          rules: arr<any>(v.rules)?.map((r) => (typeof r === "string" ? { text: r } : r)).filter((r) => r && typeof r.text === "string"),
          tokenTips: arr<string>(v.tokenTips)?.filter((t) => typeof t === "string"),
        },
      };
    }
  }
  return { parsed: false, insights: { summary: text.trim().slice(0, 4000) } };
}

export interface AnalysisRecord {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  lang: "de" | "en";
  health: number;
  dossierTokens: number;
  insights: Insights;
  parsed: boolean;
  /** Rules created from this analysis. */
  acceptedRules?: string[];
}

function analysesDir(s: Scenaria) {
  return s.store.path("analyses");
}

export function saveAnalysis(s: Scenaria, rec: Omit<AnalysisRecord, "id" | "createdAt">): AnalysisRecord {
  const now = new Date();
  const id = `a${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}${Math.random().toString(36).slice(2, 5)}`;
  const full: AnalysisRecord = { id, createdAt: now.toISOString(), ...rec };
  mkdirSync(analysesDir(s), { recursive: true });
  writeJsonAtomic(join(analysesDir(s), `${id}.json`), full);
  s.store.appendEvent({ type: "analysis", data: { message: `analysis ${id} (${rec.provider}/${rec.model})`, id } });
  return full;
}

export function listAnalyses(s: Scenaria): AnalysisRecord[] {
  const d = analysesDir(s);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^a[\w]+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), "utf8")) as AnalysisRecord;
      } catch {
        return null;
      }
    })
    .filter((x): x is AnalysisRecord => x !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getAnalysis(s: Scenaria, id: string): AnalysisRecord {
  if (!/^a[\w]+$/.test(id)) throw new Error("invalid analysis id");
  const f = join(analysesDir(s), `${id}.json`);
  if (!existsSync(f)) throw new Error(`Unknown analysis "${id}"`);
  return JSON.parse(readFileSync(f, "utf8"));
}

/** Turn a recommended rule of an analysis into a project rule (and remember that it was accepted). */
export function acceptRule(s: Scenaria, analysisId: string, index: number): ProjectRule {
  const rec = getAnalysis(s, analysisId);
  const r = rec.insights.rules?.[index];
  if (!r) throw new Error(`Analysis ${analysisId} has no rule #${index}`);
  const rule = s.addRule(r.text, "analysis", r.evidence);
  rec.acceptedRules = Array.from(new Set([...(rec.acceptedRules ?? []), rule.id]));
  writeJsonAtomic(join(analysesDir(s), `${rec.id}.json`), rec);
  return rule;
}

/** Full LLM analysis run: dossier → any configured LLM → stored insights. */
export async function runAnalysis(s: Scenaria, req: Partial<LlmRequest> & { lang?: "de" | "en"; maxTokens?: number } = {}): Promise<AnalysisRecord> {
  const cfg = { ...(s.config().analysis ?? {}), ...Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined && v !== "")) } as LlmRequest & { lang?: "de" | "en"; maxTokens?: number };
  const upstreams = { ...DEFAULT_PROXY.upstreams, ...(s.config().proxy?.upstreams ?? {}) } as Record<string, string>;
  const lang = cfg.lang === "de" ? "de" : "en";
  const d = dossier(s, { maxTokens: cfg.maxTokens });
  const out = await callLlm(cfg, upstreams, analysisPrompt(lang), d.text);
  const { insights, parsed } = parseInsights(out.text);
  return saveAnalysis(s, { provider: cfg.provider, model: out.model, lang, health: projectMetrics(s).health, dossierTokens: d.tokens, insights, parsed });
}

/** Store an analysis produced elsewhere (e.g. the dossier pasted into ChatGPT / Claude.ai / a local chat UI). */
export function importAnalysis(s: Scenaria, text: string, meta: { provider?: string; model?: string; lang?: "de" | "en" } = {}): AnalysisRecord {
  const { insights, parsed } = parseInsights(text);
  if (!parsed) throw new Error("No JSON analysis found in the pasted text.");
  return saveAnalysis(s, { provider: meta.provider ?? "pasted", model: meta.model ?? "unknown", lang: meta.lang ?? "en", health: projectMetrics(s).health, dossierTokens: 0, insights, parsed });
}

export function renderMetrics(m: Metrics, limit = 12): string {
  const lines = [
    `Health ${m.health}/100 · main goal ${m.goalSet ? "set" : "MISSING"} · decision quality ${Math.round(m.decisionQuality * 100)} %`,
    `${m.counts.tasks} tasks · ${m.counts.decisions} decisions (${m.counts.openDecisions} open) · ${m.counts.checkpoints} checkpoints · ${m.counts.branches} branches · ${m.counts.rewinds} rewinds · checks ${m.counts.passed} passed / ${m.counts.failed} failed`,
  ];
  if (m.issues.length) {
    lines.push("Issues:");
    for (const i of m.issues.slice(0, limit)) lines.push(`- [${i.severity}] ${i.nodeId ? `${i.nodeId}: ` : ""}${i.message}`);
    if (m.issues.length > limit) lines.push(`- … ${m.issues.length - limit} more`);
  } else lines.push("No issues found.");
  return lines.join("\n");
}
