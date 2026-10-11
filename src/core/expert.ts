/**
 * The analyst: a specialised agent that turns the recorded history of one line, one project or ALL
 * the person's Scenaria projects into a professional, fact-based expert report to optimise with.
 *
 * Fact-based by construction:
 *   1. Facts are computed deterministically (no model): KPIs, every line with its verdict and
 *      fidelity, agents/models, canon, forecasts' hit rate, issues — each with node evidence.
 *   2. Rule-based findings work without any model (a baseline report is always possible).
 *   3. The expert layer (role "analyst", any model) reads ONLY the fact sheet and a compact dossier and
 *      writes findings through four expert lenses (architecture & technical decisions, goal & product
 *      alignment, AI-agent workflow & context engineering, governance & risk à la ISO/IEC 42001).
 *   4. Validation: every finding must cite evidence that exists in the scope and every metric it
 *      quotes must match the fact sheet; otherwise it is corrected or marked unverified.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Scenaria } from "./engine.js";
import type { ScenariaNode } from "./types.js";
import { callLlm, dossier, projectMetrics, type LlmRequest } from "./analysis.js";
import { canonState } from "./canon.js";
import { evaluateForecasts } from "./forecast.js";
import { gateLines } from "./gate.js";
import { stringPayload } from "./workspace.js";
import { effectiveLlm, upstreams } from "./settings.js";
import { listProjects } from "./projects.js";
import { writeJsonAtomic } from "./store.js";

export type Lens = "architecture" | "goal" | "workflow" | "governance";
export const LENSES: Lens[] = ["architecture", "goal", "workflow", "governance"];
type Lang = "de" | "en";

export interface Kpis {
  nodes: number;
  tasks: number;
  decisions: number;
  openDecisions: number;
  lines: number;
  rewinds: number;
  verifiedPassed: number;
  verifiedFailed: number;
  /** % of decisions with a rationale */
  rationaleRate: number;
  /** 0..100 */
  decisionQuality: number;
  /** average context fidelity 0..100 */
  fidelity: number;
  fidelityBreaks: number;
  drifts: number;
  health: number;
  goalSet: number;
  canonActive: number;
  canonBroken: number;
  canonProposed: number;
  linesValid: number;
  linesInvalid: number;
  forecastsEvaluated: number;
  forecastMeanError: number;
  rules: number;
  lessons: number;
  conversations: number;
}

export interface LineFact {
  head: string;
  scenario: string;
  title: string;
  current: boolean;
  steps: number;
  decisions: number;
  fidelity: number;
  breaks: string[];
  verdict: string;
  reasons: string[];
}

export interface FactSheet {
  project: string;
  root: string;
  mainGoal: string | null;
  scope: { kind: "project" } | { kind: "line"; head: string };
  kpis: Kpis;
  lines: LineFact[];
  agents: { name: string; decisions: number; quality: number; failed: number; revised: number; withoutRationale: number }[];
  issues: { code: string; severity: string; message: string; node?: string }[];
  /** All ids that can serve as evidence in this scope. */
  evidence: string[];
}

export interface Finding {
  lens: Lens;
  title: string;
  severity: "high" | "medium" | "low";
  evidence: string[];
  metric?: { name: string; value: number };
  impact: string;
  source: "rule" | "expert";
  project?: string;
  verified: boolean;
  note?: string;
}

export interface Recommendation {
  title: string;
  action: string;
  lens: Lens;
  priority: "P1" | "P2" | "P3";
  effort: "S" | "M" | "L";
  metric?: string;
  expected: string;
  evidence: string[];
  source: "rule" | "expert";
  verified: boolean;
}

export interface ExpertReport {
  id: string;
  createdAt: string;
  scope: { kind: "project" } | { kind: "line"; head: string } | { kind: "all" };
  lang: Lang;
  model: string | null;
  facts: FactSheet[];
  summary: string;
  maturity: { score: number; level: string; reasoning: string };
  findings: Finding[];
  recommendations: Recommendation[];
  strengths: string[];
  rootCauses: string[];
  validation: { dropped: number; corrected: number; unverified: number };
  markdown: string;
  /** Indexes of recommendations the person adopted as project rules. */
  adopted?: number[];
}

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const one = (x: unknown, max = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const strs = (x: unknown, max = 8, len = 240) => (Array.isArray(x) ? x.map((v) => one(v, len)).filter(Boolean).slice(0, max) : []);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

// ------------------------------------------------------------------ facts (deterministic)

export function factSheet(s: Scenaria, scope: FactSheet["scope"] = { kind: "project" }): FactSheet {
  const all = s.store.listNodes();
  const m = projectMetrics(s);
  const fid = s.fidelity().points;
  const head = s.store.readState().head;
  const onScope = scope.kind === "line" ? new Set(s.path(scope.head).map((n) => n.id)) : null;
  const nodes = onScope ? all.filter((n) => onScope.has(n.id)) : all;
  const decisions = nodes.filter((n) => n.type === "decision");
  const fidVals = nodes.map((n) => fid[n.id]?.score).filter((x): x is number => typeof x === "number");
  const breaks = nodes.filter((n) => fid[n.id]?.flags.includes("break")).map((n) => n.id);
  const drifts = nodes.filter((n) => fid[n.id]?.flags.includes("drift")).map((n) => n.id);
  const cs = canonState(s.store);
  const brokenCanon = new Set(nodes.flatMap((n) => n.breaksCanon ?? []));
  const ev = evaluateForecasts(s);
  const lines: LineFact[] = gateLines(s)
    .filter((l) => !onScope || onScope.has(l.head))
    .map((l) => {
      const path = s.path(l.head);
      const sc = path.map((n) => fid[n.id]?.score).filter((x): x is number => typeof x === "number");
      let verdict = "unknown";
      let reasons: string[] = [];
      try {
        const pl = stringPayload(s, l.head);
        verdict = pl.verdict;
        reasons = pl.reasons.slice(0, 4);
      } catch {}
      return {
        head: l.head,
        scenario: l.scenario,
        title: one(l.title, 120),
        current: l.current,
        steps: path.length,
        decisions: path.filter((n) => n.type === "decision").length,
        fidelity: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : 0,
        breaks: path.filter((n) => fid[n.id]?.flags.includes("break")).map((n) => n.id),
        verdict,
        reasons,
      };
    });
  const quality = decisions.length ? m.decisions.filter((d) => decisions.some((x) => x.id === d.id)).reduce((a, d) => a + d.quality, 0) / decisions.length : m.decisionQuality;
  const kpis: Kpis = {
    nodes: nodes.length,
    tasks: nodes.filter((n) => n.type === "goal").length,
    decisions: decisions.length,
    openDecisions: decisions.filter((d) => !d.chosen).length,
    lines: lines.length,
    rewinds: onScope ? nodes.filter((n) => (n.lessons ?? []).length).length : m.counts.rewinds,
    verifiedPassed: nodes.filter((n) => n.verification?.status === "passed").length,
    verifiedFailed: nodes.filter((n) => n.verification?.status === "failed").length,
    rationaleRate: pct(decisions.filter((d) => d.rationale).length, decisions.filter((d) => d.chosen).length),
    decisionQuality: clamp((quality || 0) * 100),
    fidelity: fidVals.length ? Math.round(fidVals.reduce((a, b) => a + b, 0) / fidVals.length) : 0,
    fidelityBreaks: breaks.length,
    drifts: drifts.length,
    health: m.health,
    goalSet: m.goalSet ? 1 : 0,
    canonActive: cs.events.filter((e) => e.status === "active").length,
    canonBroken: [...brokenCanon].filter((k) => cs.events.some((e) => e.id === k && e.status === "active")).length,
    canonProposed: cs.events.filter((e) => e.status === "proposed").length,
    linesValid: lines.filter((l) => l.verdict === "valid").length,
    linesInvalid: lines.filter((l) => l.verdict === "invalid").length,
    forecastsEvaluated: ev.calibration.evaluated,
    forecastMeanError: ev.calibration.meanError ?? 0,
    rules: s.rules().length,
    lessons: all.reduce((a, n) => a + (n.lessons?.length ?? 0), 0),
    conversations: s.conversations.listSessions().length,
  };
  const agents = Object.entries(m.byAgent).map(([name, a]) => ({ name, decisions: a.decisions, quality: clamp(a.avgQuality * 100), failed: a.failed, revised: a.revised, withoutRationale: a.withoutRationale }));
  const evidence = [...new Set([...nodes.map((n) => n.id), ...cs.events.map((e) => e.id), ...s.rules().map((r) => r.id), ...lines.map((l) => l.scenario), ...ev.forecasts.map((f) => f.id)])];
  return {
    project: s.config().projectName,
    root: s.root,
    mainGoal: s.project()?.goal ?? null,
    scope,
    kpis,
    lines,
    agents,
    issues: m.issues.filter((i) => !onScope || !i.nodeId || onScope.has(i.nodeId)).slice(0, 30).map((i) => ({ code: i.code, severity: i.severity, message: one(i.message, 240), node: i.nodeId })),
    evidence,
  };
}

// ------------------------------------------------------------------ rule-based findings (no model)

function ruleFindings(f: FactSheet, lang: Lang): { findings: Finding[]; recommendations: Recommendation[] } {
  const de = lang === "de";
  const k = f.kpis;
  const out: Finding[] = [];
  const recs: Recommendation[] = [];
  const add = (x: Omit<Finding, "source" | "verified" | "project">, r?: Omit<Recommendation, "source" | "verified" | "lens" | "evidence">) => {
    out.push({ ...x, source: "rule", verified: true, project: f.project });
    if (r) recs.push({ ...r, lens: x.lens, evidence: x.evidence, source: "rule", verified: true });
  };
  if (!k.goalSet)
    add(
      { lens: "goal", title: de ? "Kein Hauptziel gesetzt" : "No main goal set", severity: "high", evidence: [], metric: { name: "goalSet", value: 0 }, impact: de ? "Kontext-Treue und Prognosen messen gegen das Hauptziel – ohne es sind sie ungenau." : "Context fidelity and forecasts measure against the main goal — without it they are imprecise." },
      { title: de ? "Hauptziel festlegen" : "Set the main goal", action: de ? "Im Dashboard oben „Hauptziel festlegen“ oder scenaria goal \"…\"." : "Dashboard → \"Set main goal\" or scenaria goal \"…\".", priority: "P1", effort: "S", metric: "goalSet", expected: de ? "Prognosen und Treue werden aussagekräftig." : "Forecasts and fidelity become meaningful." },
    );
  if (k.decisions >= 3 && k.rationaleRate < 70) {
    const missing = f.issues.filter((i) => /rationale/.test(i.code)).map((i) => i.node).filter((x): x is string => Boolean(x)).slice(0, 6);
    add(
      { lens: "workflow", title: de ? "Entscheidungen ohne Begründung" : "Decisions without rationale", severity: k.rationaleRate < 40 ? "high" : "medium", evidence: missing, metric: { name: "rationaleRate", value: k.rationaleRate }, impact: de ? "Spätere Agenten kennen das Warum nicht – Wiederholungen und Widersprüche werden wahrscheinlicher." : "Later agents do not know the why — repeats and contradictions become likely." },
      { title: de ? "Begründung erzwingen" : "Enforce rationales", action: de ? "requireRationale aktiv lassen und im Agent-Prompt „Begründung + Kontext + Zielbezug“ verlangen." : "Keep requireRationale on and ask for \"rationale + context + goal link\" in the agent prompt.", priority: "P1", effort: "S", metric: "rationaleRate", expected: "≥ 90 %" },
    );
  }
  if (k.fidelityBreaks > 0)
    add(
      { lens: "workflow", title: de ? `${k.fidelityBreaks} Kontextabbrüche` : `${k.fidelityBreaks} context breaks`, severity: k.fidelityBreaks >= 3 ? "high" : "medium", evidence: f.lines.flatMap((l) => l.breaks).slice(0, 8), metric: { name: "fidelityBreaks", value: k.fidelityBreaks }, impact: de ? "An diesen Stellen hat der nächste Schritt den Faden verloren." : "At these points the next step lost the thread." },
      { title: de ? "Übergaben mit Kapsel" : "Handoffs with the capsule", action: de ? "Bei Agentenwechsel die Kontext-Kapsel (scenaria_context) übergeben und basedOn nutzen." : "On agent switches hand over the capsule (scenaria_context) and use basedOn.", priority: "P2", effort: "S", metric: "fidelityBreaks", expected: de ? "weniger Abbrüche" : "fewer breaks" },
    );
  if (k.verifiedFailed > 0)
    add({ lens: "architecture", title: de ? `${k.verifiedFailed} fehlgeschlagene Prüfungen` : `${k.verifiedFailed} failed verifications`, severity: "medium", evidence: f.issues.filter((i) => i.code.includes("failed")).map((i) => i.node).filter((x): x is string => Boolean(x)).slice(0, 6), metric: { name: "verifiedFailed", value: k.verifiedFailed }, impact: de ? "Arbeit baut möglicherweise auf fehlerhaften Ständen auf." : "Work may build on faulty states." });
  if (k.canonActive === 0 && k.decisions >= 5)
    add(
      { lens: "governance", title: de ? "Keine Fixpunkte (Kanon)" : "No fixed points (canon)", severity: "medium", evidence: [], metric: { name: "canonActive", value: 0 }, impact: de ? "Nichts schützt harte Vorgaben vor dem nächsten Agenten." : "Nothing protects hard constraints from the next agent." },
      { title: de ? "Fixpunkte festlegen" : "Define fixed points", action: de ? "Kanon → Archivar fragen und die Vorschläge prüfen/freigeben." : "Canon → ask the archivist and review/approve proposals.", priority: "P2", effort: "S", metric: "canonActive", expected: "≥ 3" },
    );
  if (k.canonBroken > 0) add({ lens: "governance", title: de ? `${k.canonBroken} gebrochene Fixpunkte` : `${k.canonBroken} broken fixed points`, severity: "high", evidence: f.issues.filter((i) => i.code === "canon_broken").map((i) => i.node).filter((x): x is string => Boolean(x)), metric: { name: "canonBroken", value: k.canonBroken }, impact: de ? "Linien mit gebrochenem harten Kanon sind ungültig." : "Lines with broken hard canon are invalid." });
  if (k.linesInvalid > 0) add({ lens: "architecture", title: de ? `${k.linesInvalid} ungültige Arbeitslinien` : `${k.linesInvalid} invalid lines of work`, severity: "high", evidence: f.lines.filter((l) => l.verdict === "invalid").map((l) => l.head), metric: { name: "linesInvalid", value: k.linesInvalid }, impact: de ? "Diese Linien überstehen die Fixpunkte nicht." : "These lines do not survive the fixed points." });
  if (k.forecastsEvaluated >= 3 && k.forecastMeanError > 20)
    add({ lens: "workflow", title: de ? "Prognosen weichen stark ab" : "Forecasts deviate strongly", severity: "low", evidence: [], metric: { name: "forecastMeanError", value: k.forecastMeanError }, impact: de ? "Das Prognosemodell kennt das Projekt noch schlecht (z. B. Ziel fehlt, kleines Modell)." : "The forecast model does not know the project well yet (e.g. goal missing, small model)." });
  if (k.openDecisions > 0) add({ lens: "goal", title: de ? `${k.openDecisions} offene Entscheidungen` : `${k.openDecisions} open decisions`, severity: "low", evidence: f.issues.filter((i) => i.code.includes("open")).map((i) => i.node).filter((x): x is string => Boolean(x)).slice(0, 6), metric: { name: "openDecisions", value: k.openDecisions }, impact: de ? "Arbeit wartet auf eine Wahl – Prognosen helfen bei der Entscheidung." : "Work waits for a choice — forecasts help to decide." });
  for (const a of f.agents.filter((x) => x.decisions >= 3 && (x.withoutRationale >= 2 || x.failed >= 2)).slice(0, 3))
    add({ lens: "workflow", title: de ? `Agent ${a.name}: Qualität ${a.quality} %` : `Agent ${a.name}: quality ${a.quality}%`, severity: "medium", evidence: [], impact: de ? `${a.withoutRationale} ohne Begründung, ${a.failed} fehlgeschlagen, ${a.revised} revidiert.` : `${a.withoutRationale} without rationale, ${a.failed} failed, ${a.revised} revised.` });
  return { findings: out, recommendations: recs };
}

// ------------------------------------------------------------------ expert layer (any model)

function prompt(lang: Lang, all: boolean) {
  return `You are a senior ANALYST panel for AI-assisted software and knowledge projects. You review ${all ? "several projects" : "one project"} recorded by Scenaria (a decision tree of agent work with checkpoints, decisions, rewinds, context-fidelity scores, canon fixed points and forecasts).
Work through four expert lenses:
- architecture: technical decisions, consistency, verification, lines that do not survive fixed points;
- goal: alignment of tasks and decisions with the main goal, focus, open decisions;
- workflow: AI-agent workflow and context engineering (handoffs, rationale, context breaks, rewinds, prompts, forecasts accuracy);
- governance: human oversight, traceability, fixed points and risk management (in the spirit of ISO/IEC 42001).
RULES — fact-based only:
- Use ONLY the FACT SHEET and DOSSIER. Every finding must cite evidence ids from the fact sheet (n12, k3, r2, s1, f4) and, when it quotes a number, name the KPI exactly as in the fact sheet with its exact value.
- No generic advice without evidence. If data is thin, say so and lower the maturity score.
- Recommendations: concrete action, priority P1–P3, effort S/M/L, the KPI it should move and the expected effect.
Answer ONLY with JSON:
{"summary": "5-8 sentences", "maturity": {"score": 0-100, "level": "initial|managed|defined|measured|optimizing", "reasoning": "…"}, "findings": [{"lens": "architecture|goal|workflow|governance", "title": "…", "severity": "high|medium|low", "evidence": ["n12"], "metric": {"name": "<kpi>", "value": 0}, "impact": "…", "project": "<name, only for several projects>"}], "rootCauses": ["…"], "recommendations": [{"title": "…", "action": "…", "lens": "…", "priority": "P1|P2|P3", "effort": "S|M|L", "metric": "<kpi>", "expected": "…", "evidence": ["n12"]}], "strengths": ["…"]}
Write all text values in ${lang === "de" ? "German" : "English"}.`;
}

function json(text: string): any {
  const cands = [text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of cands) {
    if (!c?.trim()) continue;
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object") return v;
    } catch {}
  }
  throw new Error("The model did not return the expected JSON.");
}

const asLens = (x: unknown): Lens => (LENSES.includes(String(x) as Lens) ? (String(x) as Lens) : "workflow");
const asSev = (x: unknown): Finding["severity"] => (x === "high" || x === "low" ? x : "medium");

// ------------------------------------------------------------------ report

function dir(s: Scenaria) {
  return s.store.path("reports");
}

export function listReports(s: Scenaria): ExpertReport[] {
  const d = dir(s);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^x\d+\.json$/.test(f))
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(join(d, f), "utf8"));
        return r && typeof r.id === "string" && Array.isArray(r.findings) ? (r as ExpertReport) : null;
      } catch {
        return null;
      }
    })
    .filter((r): r is ExpertReport => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ExpertRequest {
  scope?: "project" | "line" | "all";
  /** For scope "line": the head node of the line. */
  head?: string;
  lang?: Lang;
  /** Rule-based report only (no model). */
  noModel?: boolean;
  /** false: compute only (agents' read-only baseline), nothing is written. */
  persist?: boolean;
  llm?: Partial<LlmRequest>;
}

interface Draft {
  lang: Lang;
  scopeKind: "project" | "line" | "all";
  facts: FactSheet[];
  base: { findings: Finding[]; recommendations: Recommendation[] }[];
  det: number;
  summary: string;
  maturity: ExpertReport["maturity"];
}

function maturityOf(k: Kpis) {
  return clamp(k.goalSet * 15 + Math.min(15, k.rationaleRate * 0.15) + Math.min(20, k.fidelity * 0.2) + Math.min(15, k.canonActive * 5) + (k.verifiedPassed ? 10 : 0) + Math.max(0, 15 - k.fidelityBreaks * 5) + (k.forecastsEvaluated ? 10 : 0));
}
const levelOf = (x: number) => (x >= 80 ? "measured" : x >= 60 ? "defined" : x >= 40 ? "managed" : "initial");

/** Facts + rule-based findings + deterministic maturity (no model, nothing written). */
function draft(s: Scenaria, req: ExpertRequest): Draft {
  const lang: Lang = req.lang === "en" ? "en" : "de";
  const de = lang === "de";
  const scopeKind = req.scope ?? "project";
  let facts: FactSheet[];
  if (scopeKind === "all") {
    facts = [factSheet(s)];
    const seen = new Set([s.root]);
    for (const p of listProjects()) {
      if (facts.length >= 12) break;
      let other: Scenaria;
      try {
        other = Scenaria.open(p.root);
      } catch {
        continue; // a project that cannot be opened is skipped
      }
      if (seen.has(other.root)) continue;
      seen.add(other.root);
      try {
        facts.push(factSheet(other));
      } catch {
        /* skip */
      }
    }
  } else if (scopeKind === "line") {
    const head = req.head ?? s.store.readState().head;
    if (!head) throw new Error(de ? "Noch keine Arbeitslinie zum Analysieren." : "No line to analyse yet.");
    s.node(head); // unknown id → clear error
    facts = [factSheet(s, { kind: "line", head })];
  } else facts = [factSheet(s)];

  const base = facts.map((f) => ruleFindings(f, lang));
  const scores = facts.map((f) => maturityOf(f.kpis));
  const det = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const brief = (f: FactSheet) => {
    const k = f.kpis;
    return de
      ? `${f.project}: ${k.nodes} Schritte, ${k.decisions} Entscheidungen (${k.rationaleRate} % begründet), Kontext-Treue Ø ${k.fidelity} %, ${k.fidelityBreaks} Abbrüche, ${k.lines} Arbeitslinien (${k.linesValid} gültig, ${k.linesInvalid} ungültig), ${k.canonActive} Fixpunkte.`
      : `${f.project}: ${k.nodes} steps, ${k.decisions} decisions (${k.rationaleRate}% with rationale), context fidelity avg ${k.fidelity}%, ${k.fidelityBreaks} breaks, ${k.lines} lines (${k.linesValid} valid, ${k.linesInvalid} invalid), ${k.canonActive} fixed points.`;
  };
  const summary = (facts.length > 1 ? (de ? `${facts.length} Projekte. ` : `${facts.length} projects. `) : "") + facts.map(brief).join(" ");
  return {
    lang,
    scopeKind,
    facts,
    base,
    det,
    summary,
    maturity: { score: det, level: levelOf(det), reasoning: de ? "Regelbasiert aus Hauptziel, Begründungen, Kontext-Treue, Fixpunkten, Prüfungen und Prognosen." : "Rule-based from main goal, rationales, context fidelity, fixed points, verification and forecasts." },
  };
}

interface ExpertPart {
  model: string;
  findings: Finding[];
  recommendations: Recommendation[];
  summary: string;
  maturity?: ExpertReport["maturity"];
  strengths: string[];
  rootCauses: string[];
  validation: ExpertReport["validation"];
}

/** Validates the model's answer against the facts: evidence must exist, quoted KPIs must match. */
export function validateExpert(d: Draft, x: any, model: string): ExpertPart {
  const de = d.lang === "de";
  const validation = { dropped: 0, corrected: 0, unverified: 0 };
  const evidence = new Set(d.facts.flatMap((f) => f.evidence));
  const kpiOf = (name: string, project?: string) => {
    const f = (project && d.facts.find((ff) => ff.project === project)) || d.facts[0];
    const v = (f.kpis as unknown as Record<string, number>)[name];
    return Object.prototype.hasOwnProperty.call(f.kpis, name) && typeof v === "number" ? v : undefined;
  };
  const findings: Finding[] = [];
  for (const it of Array.isArray(x?.findings) ? x.findings.slice(0, 20) : []) {
    const title = one(it?.title, 160);
    if (!title) continue;
    const ev = strs(it?.evidence, 10, 12);
    const valid = ev.filter((e) => evidence.has(e));
    if (ev.length > valid.length) validation.dropped += ev.length - valid.length;
    let metric: Finding["metric"];
    let note: string | undefined;
    const project = it?.project ? one(it.project, 80) : undefined;
    if (it?.metric && typeof it.metric === "object") {
      const name = one(it.metric.name, 40);
      const real = kpiOf(name, project);
      if (real !== undefined) {
        if (Number(it.metric.value) !== real) {
          validation.corrected++;
          note = de ? `Wert korrigiert (Modell: ${one(it.metric.value, 20)}, Fakten: ${real})` : `value corrected (model: ${one(it.metric.value, 20)}, facts: ${real})`;
        }
        metric = { name, value: real };
      } else note = de ? `unbekannte Kennzahl „${name}“ verworfen` : `unknown metric "${name}" dropped`;
    }
    const verified = valid.length > 0 || Boolean(metric);
    if (!verified) validation.unverified++;
    findings.push({ lens: asLens(it?.lens), title, severity: asSev(it?.severity), evidence: valid, metric, impact: one(it?.impact, 500), source: "expert", verified, project: project && d.facts.some((f) => f.project === project) ? project : d.facts[0].project, note });
  }
  const recommendations: Recommendation[] = [];
  for (const r of Array.isArray(x?.recommendations) ? x.recommendations.slice(0, 12) : []) {
    const title = one(r?.title, 160);
    if (!title) continue;
    const raw = strs(r?.evidence, 10, 12);
    const ev = raw.filter((e) => evidence.has(e));
    if (raw.length > ev.length) validation.dropped += raw.length - ev.length;
    const metric = one(r?.metric, 40);
    const known = metric ? kpiOf(metric) !== undefined : false;
    const verified = ev.length > 0 || known;
    if (!verified) validation.unverified++;
    recommendations.push({ title, action: one(r?.action, 600), lens: asLens(r?.lens), priority: ["P1", "P2", "P3"].includes(r?.priority) ? r.priority : "P2", effort: ["S", "M", "L"].includes(r?.effort) ? r.effort : "M", metric: known ? metric : undefined, expected: one(r?.expected, 300), evidence: ev, source: "expert", verified });
  }
  const m = x?.maturity && typeof x.maturity === "object" ? x.maturity : null;
  const score = m && Number.isFinite(Number(m.score)) ? clamp(Number(m.score)) : d.det;
  return {
    model,
    findings,
    recommendations,
    summary: one(x?.summary, 2000),
    maturity: m ? { score, level: ["initial", "managed", "defined", "measured", "optimizing"].includes(String(m.level)) ? String(m.level) : levelOf(score), reasoning: one(m.reasoning, 600) } : undefined,
    strengths: strs(x?.strengths, 8, 300),
    rootCauses: strs(x?.rootCauses, 8, 300),
    validation,
  };
}

function finish(s: Scenaria, req: ExpertRequest, d: Draft, e: ExpertPart | null): ExpertReport {
  const findings = [...(e?.findings ?? []), ...d.base.flatMap((b) => b.findings)];
  const recommendations = [...(e?.recommendations ?? []), ...d.base.flatMap((b) => b.recommendations)];
  const sev = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => Number(b.verified) - Number(a.verified) || sev[a.severity] - sev[b.severity]);
  recommendations.sort((a, b) => a.priority.localeCompare(b.priority) || Number(b.verified) - Number(a.verified));
  const scope: ExpertReport["scope"] = d.scopeKind === "all" ? { kind: "all" } : d.scopeKind === "line" ? { kind: "line", head: (d.facts[0].scope as { head: string }).head } : { kind: "project" };
  const report: ExpertReport = {
    id: "x0",
    createdAt: new Date().toISOString(),
    scope,
    lang: d.lang,
    model: e?.model ?? null,
    facts: d.facts,
    summary: e?.summary || d.summary,
    maturity: e?.maturity ?? d.maturity,
    findings,
    recommendations,
    strengths: e?.strengths ?? [],
    rootCauses: e?.rootCauses ?? [],
    validation: e?.validation ?? { dropped: 0, corrected: 0, unverified: 0 },
    markdown: "",
  };
  if (req.persist === false) {
    report.markdown = renderReport(report);
    return report;
  }
  // Reserve the id exclusively (two runs at once never overwrite each other).
  mkdirSync(dir(s), { recursive: true });
  let n = listReports(s).reduce((m, r) => Math.max(m, parseInt(r.id.slice(1), 10) || 0), 0) + 1;
  for (;; n++) {
    try {
      closeSync(openSync(join(dir(s), `x${n}.json`), "wx"));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  report.id = `x${n}`;
  report.markdown = renderReport(report);
  writeJsonAtomic(join(dir(s), `${report.id}.json`), report);
  s.store.appendEvent({ type: "analysis", data: { message: `expert analysis ${report.id} (${scope.kind}${report.model ? `, ${report.model}` : ", rule-based"}): ${findings.length} findings, ${recommendations.length} recommendations`, id: report.id } });
  return report;
}

/** Rule-based report, synchronous (no model). persist:false → nothing is written. */
export function baselineReport(s: Scenaria, req: ExpertRequest = {}): ExpertReport {
  return finish(s, req, draft(s, req), null);
}

export async function expertAnalysis(s: Scenaria, req: ExpertRequest = {}): Promise<ExpertReport> {
  const d = draft(s, req);
  if (req.noModel) return finish(s, req, d, null);
  const de = d.lang === "de";
  const cfg = effectiveLlm(s, "analyst", req.llm);
  if (!cfg) throw new Error(de ? "Kein Modell eingestellt – wähle eins in den Einstellungen, oder starte die Analyse ohne Modell." : "No model configured — choose one in Settings, or run the analysis without a model.");
  const sheet = d.facts.map((f, i) => ({ project: f.project, mainGoal: f.mainGoal, scope: f.scope, kpis: f.kpis, lines: f.lines.slice(0, 15), agents: f.agents.slice(0, 10), issues: f.issues.slice(0, 15), ruleFindings: d.base[i].findings.map((x) => x.title) }));
  const dossierText = d.scopeKind === "all" ? "" : `\n\n--- DOSSIER ---\n${dossier(s, { maxTokens: 4000 }).text}`;
  const out = await callLlm(cfg, upstreams(s), prompt(d.lang, d.facts.length > 1), `--- FACT SHEET ---\n${JSON.stringify(sheet, null, 1)}${dossierText}`);
  return finish(s, req, d, validateExpert(d, json(out.text), out.model));
}

export function getReport(s: Scenaria, id: string): ExpertReport {
  if (!/^x\d+$/.test(id)) throw new Error(`Unknown report ${id}`);
  const r = listReports(s).find((x) => x.id === id);
  if (!r) throw new Error(`Unknown report ${id}`);
  return r;
}

/** The person adopts a recommendation as a project rule (agents get it in their context from then on). */
export function adoptRecommendation(s: Scenaria, id: string, index: number) {
  const r = getReport(s, id);
  const rec = r.recommendations[index];
  if (!rec) throw new Error(`Report ${id} has no recommendation #${index}`);
  const rule = s.addRule(`${rec.title}: ${rec.action}`.slice(0, 400), "analysis", rec.evidence);
  r.adopted = [...new Set([...(r.adopted ?? []), index])];
  writeJsonAtomic(join(dir(s), `${r.id}.json`), r);
  return rule;
}

// ------------------------------------------------------------------ markdown (export)

const LENS_NAMES: Record<Lang, Record<Lens, string>> = {
  de: { architecture: "Architektur & technische Entscheidungen", goal: "Ziel- & Produktausrichtung", workflow: "Agenten-Workflow & Kontext-Engineering", governance: "Governance & Risiko (ISO/IEC 42001)" },
  en: { architecture: "Architecture & technical decisions", goal: "Goal & product alignment", workflow: "Agent workflow & context engineering", governance: "Governance & risk (ISO/IEC 42001)" },
};

export function renderReport(r: ExpertReport): string {
  const de = r.lang === "de";
  const L = LENS_NAMES[r.lang];
  const k = r.facts[0].kpis;
  const scope = r.scope.kind === "all" ? (de ? "alle Projekte" : "all projects") : r.scope.kind === "line" ? `${de ? "Linie bis" : "line up to"} ${r.scope.head}` : de ? "ganzes Projekt" : "whole project";
  const lines: string[] = [
    `# ${de ? "Experten-Analyse" : "Expert analysis"} ${r.id} — ${r.facts.map((f) => f.project).join(", ")}`,
    "",
    `${de ? "Umfang" : "Scope"}: ${scope} · ${new Date(r.createdAt).toLocaleString(de ? "de-DE" : "en-GB")} · ${r.model ?? (de ? "regelbasiert (ohne Modell)" : "rule-based (no model)")}`,
    "",
    `## ${de ? "Zusammenfassung" : "Summary"}`,
    r.summary,
    "",
    `**${de ? "Reifegrad" : "Maturity"}: ${r.maturity.score}/100 (${r.maturity.level})** — ${r.maturity.reasoning}`,
    "",
    `## ${de ? "Kennzahlen" : "Key figures"}`,
    `| ${de ? "Kennzahl" : "KPI"} | ${r.facts.map((f) => f.project).join(" | ")} |`,
    `|---|${r.facts.map(() => "---").join("|")}|`,
    ...Object.keys(k).map((key) => `| ${key} | ${r.facts.map((f) => (f.kpis as unknown as Record<string, number>)[key]).join(" | ")} |`),
    "",
    `## ${de ? "Arbeitslinien" : "Lines of work"}`,
    ...r.facts.flatMap((f) => f.lines.map((l) => `- ${r.facts.length > 1 ? `[${f.project}] ` : ""}${l.head} (${l.scenario}${l.current ? ", aktuell" : ""}): ${l.title} — ${l.steps} ${de ? "Schritte" : "steps"}, ${de ? "Treue" : "fidelity"} ${l.fidelity}%, ${l.verdict}${l.breaks.length ? `, ${de ? "Abbrüche" : "breaks"} ${l.breaks.join(", ")}` : ""}`)),
    "",
    `## ${de ? "Befunde" : "Findings"}`,
  ];
  for (const lens of LENSES) {
    const fs = r.findings.filter((f) => f.lens === lens);
    if (!fs.length) continue;
    lines.push(`### ${L[lens]}`);
    for (const f of fs) lines.push(`- **[${f.severity}] ${f.title}**${f.verified ? "" : de ? " _(unbelegt)_" : " _(unverified)_"} — ${f.impact}${f.metric ? ` (${f.metric.name} = ${f.metric.value})` : ""}${f.evidence.length ? ` · ${de ? "Belege" : "evidence"}: ${f.evidence.join(", ")}` : ""}${f.note ? ` · ${f.note}` : ""}`);
  }
  if (r.rootCauses.length) lines.push("", `## ${de ? "Ursachen" : "Root causes"}`, ...r.rootCauses.map((x) => `- ${x}`));
  lines.push("", `## ${de ? "Empfehlungen" : "Recommendations"}`);
  for (const x of r.recommendations) lines.push(`- **${x.priority} · ${x.title}** (${L[x.lens]}, ${de ? "Aufwand" : "effort"} ${x.effort}) — ${x.action}${x.metric ? ` → ${x.metric}: ${x.expected}` : x.expected ? ` → ${x.expected}` : ""}${x.evidence.length ? ` · ${x.evidence.join(", ")}` : ""}${x.verified ? "" : de ? " _(unbelegt)_" : " _(unverified)_"}`);
  if (r.strengths.length) lines.push("", `## ${de ? "Stärken" : "Strengths"}`, ...r.strengths.map((x) => `- ${x}`));
  lines.push("", `_${de ? "Prüfung" : "Validation"}: ${r.validation.corrected} ${de ? "Werte korrigiert" : "values corrected"}, ${r.validation.dropped} ${de ? "Belege verworfen" : "evidence dropped"}, ${r.validation.unverified} ${de ? "unbelegt" : "unverified"}._`);
  return lines.join("\n");
}

export type { ScenariaNode };
