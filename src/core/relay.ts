/**
 * The relay (canon stage 3): three isolated roles look at one high-impact decision.
 *
 *   archivist — only the past: dossier, rules, past canon → which constraints and earlier decisions
 *               bind this question, and why (with node / canon references).
 *   craftsman — only the present: the question, the archivist's constraints and the current state →
 *               2–4 concrete options with a plan, which canon each respects or breaks.
 *   oracle    — only the future: the options and the future canon events (with dates and checks) →
 *               which option survives which fixed point, risks, a recommendation.
 *
 * Each role gets its own call with only its slice of the context (no context collapse), and can use
 * its own model. The orchestrator (deterministic code, not an LLM) puts the result together and —
 * if asked — records it as an OPEN decision: the person chooses. Nothing becomes canon here.
 */
import type { Scenaria } from "./engine.js";
import { callLlm, dossier, type LlmRequest } from "./analysis.js";
import { canonState, type CanonEvent } from "./canon.js";
import { effectiveLlm, upstreams, type LlmRole } from "./settings.js";
import { writeJsonAtomic } from "./store.js";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ScenariaNode } from "./types.js";

export interface RelayOption {
  label: string;
  plan: string;
  respects: string[];
  breaks: string[];
  why?: string;
}
export interface RelayAssessment {
  option: string;
  survives: boolean;
  failsOn: string[];
  risks: string[];
  confidence?: number;
}
export interface RelayReport {
  id: string;
  question: string;
  createdAt: string;
  models: Partial<Record<LlmRole, string>>;
  archivist: { constraints: { text: string; refs: string[]; hard?: boolean }[]; history: { ref: string; why: string }[]; notes?: string };
  craftsman: { options: RelayOption[] };
  oracle: { assessments: RelayAssessment[]; recommendation?: { option: string; why: string } };
  /** Orchestrator: options that break no hard canon and survive every hard future event. */
  surviving: string[];
  decisionId?: string;
  warnings: string[];
}

type Lang = "de" | "en";
const langLine = (lang: Lang) => `Write all text values in ${lang === "de" ? "German" : "English"}.`;

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

const strs = (x: unknown, max = 12) => (Array.isArray(x) ? x.map((v) => String(v)).filter(Boolean).slice(0, max) : []);
const one = (x: unknown, max = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function canonBlock(events: CanonEvent[], kind: "past" | "future") {
  const list = events.filter((e) => e.status === "active" && e.kind === kind);
  return list.length ? list.map((e) => `- ${e.id} (${e.hard ? "hard" : "soft"}${e.due ? `, by ${e.due}` : ""}${e.check ? ", has a check" : ""}): ${e.text}`).join("\n") : "(none)";
}

const PROMPTS = {
  archivist: (lang: Lang) => `You are the ARCHIVIST. You only know the project's past (the dossier, its rules and its past fixed points). For the question below, find what binds it: constraints, earlier decisions and why they were taken, lessons from failures.
Cite node ids (n12) and canon ids (k3). Do not propose solutions. Do not invent anything the dossier does not say.
Answer ONLY with JSON: {"constraints": [{"text": "…", "refs": ["k1", "n7"], "hard": true}], "history": [{"ref": "n7", "why": "…"}], "notes": "…"}
${langLine(lang)}`,
  craftsman: (lang: Lang) => `You are the CRAFTSMAN. You work in the present: given the question, the archivist's constraints and the current state, propose 2–4 concrete, buildable options. Each option: a short label, a plan (3–6 steps in one paragraph), which canon ids it respects and which it would break (only if unavoidable — say why).
If options were given, refine exactly those. Answer ONLY with JSON: {"options": [{"label": "…", "plan": "…", "respects": ["k1"], "breaks": [], "why": "…"}]}
${langLine(lang)}`,
  oracle: (lang: Lang) => `You are the ORACLE. You only look at the future: for each option, simulate it against the future fixed points (dates, load, legal deadlines, budgets) and the hard past constraints. Be concrete about what fails and when; if nothing can be known, say so with a low confidence.
Answer ONLY with JSON: {"assessments": [{"option": "<label>", "survives": true, "failsOn": ["k4"], "risks": ["…"], "confidence": 0.0-1.0}], "recommendation": {"option": "<label>", "why": "…"}}
${langLine(lang)}`,
};

function relayDir(s: Scenaria) {
  return s.store.path("relays");
}

export function listRelays(s: Scenaria): RelayReport[] {
  const d = relayDir(s);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^rl\d+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), "utf8")) as RelayReport;
      } catch {
        return null;
      }
    })
    .filter((r): r is RelayReport => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RelayRequest {
  question: string;
  options?: string[];
  lang?: Lang;
  /** Record the result as an open decision on the current line (the person chooses later). */
  createDecision?: boolean;
  /** Per-request model override for all roles (keys only for this request). */
  llm?: Partial<LlmRequest>;
  actor?: { agent?: string; user?: string; model?: string };
}

export async function runRelay(s: Scenaria, req: RelayRequest): Promise<RelayReport> {
  const question = one(req.question, 500);
  if (question.length < 5) throw new Error("Ask a question for the relay (what should be decided?).");
  const lang: Lang = req.lang === "en" ? "en" : "de";
  const ups = upstreams(s);
  const pick = (role: LlmRole) => {
    const c = effectiveLlm(s, role, req.llm);
    if (!c) throw new Error("No model configured — choose one in Settings (or pass provider and model).");
    return c;
  };
  const cs = canonState(s.store);
  const warnings: string[] = [];
  if (cs.error) warnings.push(`canon could not be read: ${cs.error}`);
  const models: RelayReport["models"] = {};
  const ask = async (role: "archivist" | "craftsman" | "oracle", user: string) => {
    const out = await callLlm(pick(role), ups, PROMPTS[role](lang), user);
    models[role] = out.model;
    return json(out.text);
  };

  // 1. Archivist: the past only.
  const d = dossier(s, { maxTokens: 5000 });
  const rules = s.rules().map((r) => `- ${r.id}: ${r.text}`).join("\n") || "(none)";
  const a = await ask("archivist", `QUESTION: ${question}\n\nPAST FIXED POINTS:\n${canonBlock(cs.events, "past")}\n\nPROJECT RULES:\n${rules}\n\n--- DOSSIER ---\n${d.text}`);
  const archivist: RelayReport["archivist"] = {
    constraints: (Array.isArray(a.constraints) ? a.constraints : []).slice(0, 12).map((c: any) => ({ text: one(c?.text, 300), refs: strs(c?.refs, 8), hard: c?.hard !== false })).filter((c: any) => c.text),
    history: (Array.isArray(a.history) ? a.history : []).slice(0, 10).map((h: any) => ({ ref: one(h?.ref, 20), why: one(h?.why, 300) })).filter((h: any) => h.ref),
    notes: a.notes ? one(a.notes, 600) : undefined,
  };

  // 2. Craftsman: the present (question, constraints, current state) — not the whole history.
  const head = s.store.readState().head;
  // The present only: without future fixed points (those are the oracle's).
  const capsule = head ? s.context(head, { budget: 900 }).markdown.split("\n").filter((l) => !/^- k\d+ \(future/.test(l)).join("\n") : "(no history yet)";
  const constraintText = archivist.constraints.map((c) => `- ${c.hard ? "[hard] " : ""}${c.text} (${c.refs.join(", ") || "—"})`).join("\n") || "(none found)";
  const given = req.options?.filter((o) => o.trim()).slice(0, 4) ?? [];
  const c = await ask("craftsman", `QUESTION: ${question}\n${given.length ? `OPTIONS TO REFINE:\n${given.map((o) => `- ${one(o, 200)}`).join("\n")}\n` : ""}\nCONSTRAINTS (from the archivist):\n${constraintText}\n\nPAST FIXED POINTS:\n${canonBlock(cs.events, "past")}\n\nCURRENT STATE:\n${capsule}`);
  const known = new Set(cs.events.filter((e) => e.status === "active").map((e) => e.id));
  const craftsman: RelayReport["craftsman"] = {
    options: (Array.isArray(c.options) ? c.options : [])
      .slice(0, 4)
      .map((o: any) => ({ label: one(o?.label, 120), plan: one(o?.plan, 900), respects: strs(o?.respects).filter((k) => known.has(k)), breaks: strs(o?.breaks).filter((k) => known.has(k)), why: o?.why ? one(o.why, 400) : undefined }))
      .filter((o: RelayOption) => o.label)
      // one option per label: assessments are matched by label
      .filter((o: RelayOption, i: number, all: RelayOption[]) => all.findIndex((x) => x.label.toLowerCase() === o.label.toLowerCase()) === i),
  };
  if (!craftsman.options.length) throw new Error("The craftsman proposed no options.");

  // 3. Oracle: the future only (options + future canon + hard past constraints).
  const hardPast = cs.events.filter((e) => e.status === "active" && e.kind === "past" && e.hard);
  const o = await ask(
    "oracle",
    `QUESTION: ${question}\n\nOPTIONS:\n${craftsman.options.map((x) => `- ${x.label}: ${x.plan}${x.breaks.length ? ` (breaks ${x.breaks.join(", ")})` : ""}`).join("\n")}\n\nFUTURE FIXED POINTS:\n${canonBlock(cs.events, "future")}\n\nHARD PAST CONSTRAINTS:\n${hardPast.map((e) => `- ${e.id}: ${e.text}`).join("\n") || "(none)"}\n\nToday: ${new Date().toISOString().slice(0, 10)}`,
  );
  const labels = new Set(craftsman.options.map((x) => x.label));
  const oracle: RelayReport["oracle"] = {
    assessments: (Array.isArray(o.assessments) ? o.assessments : [])
      .map((x: any) => ({ option: one(x?.option, 120), survives: x?.survives === true, failsOn: strs(x?.failsOn).filter((k) => known.has(k)), risks: strs(x?.risks, 6).map((r) => one(r, 300)), confidence: typeof x?.confidence === "number" ? Math.max(0, Math.min(1, x.confidence)) : undefined }))
      .filter((x: RelayAssessment) => labels.has(x.option))
      .filter((x: RelayAssessment, i: number, all: RelayAssessment[]) => all.findIndex((y) => y.option === x.option) === i),
    recommendation: o.recommendation && labels.has(one(o.recommendation.option, 120)) ? { option: one(o.recommendation.option, 120), why: one(o.recommendation.why, 600) } : undefined,
  };
  const unassessed = craftsman.options.filter((x) => !oracle.assessments.some((y) => y.option === x.label)).map((x) => x.label);
  if (unassessed.length) warnings.push(`the oracle did not assess: ${unassessed.join(", ")} — treated as not proven`);

  // 4. Orchestrator (deterministic): cut branches that break hard canon or fail a hard future event.
  const hard = new Set(cs.events.filter((e) => e.status === "active" && e.hard).map((e) => e.id));
  const surviving = craftsman.options
    .filter((x) => !x.breaks.some((k) => hard.has(k)))
    .filter((x) => {
      const as = oracle.assessments.find((y) => y.option === x.label);
      // Not assessed = not proven: an option the oracle skipped never counts as surviving.
      return Boolean(as && as.survives && !as.failsOn.some((k) => hard.has(k)));
    })
    .map((x) => x.label);
  if (oracle.recommendation && !surviving.includes(oracle.recommendation.option)) warnings.push(`the oracle recommends "${oracle.recommendation.option}", which does not survive the hard canon`);

  const id = `rl${listRelays(s).reduce((m, r) => Math.max(m, parseInt(r.id.slice(2), 10) || 0), 0) + 1}`;
  const report: RelayReport = { id, question, createdAt: new Date().toISOString(), models, archivist, craftsman, oracle, surviving, warnings };

  if (req.createDecision) {
    const optionText = (x: RelayOption) => {
      const as = oracle.assessments.find((y) => y.option === x.label);
      const verdict = as ? `${as.survives ? "oracle: survives" : `oracle: fails${as.failsOn.length ? ` on ${as.failsOn.join(", ")}` : ""}`}${as.risks.length ? ` · risks: ${as.risks.slice(0, 2).join("; ")}` : ""}` : "oracle: not assessed";
      return `${x.plan} [${verdict}${surviving.includes(x.label) ? "" : " · cut by the orchestrator"}]`.slice(0, 1200);
    };
    const node: ScenariaNode = s.decide({
      question,
      options: craftsman.options.map((x) => ({ label: x.label, description: optionText(x) })),
      context: [`Relay ${id}.`, archivist.constraints.length ? `Constraints: ${archivist.constraints.map((c) => c.text).join("; ")}` : "", oracle.recommendation ? `Oracle recommends: ${oracle.recommendation.option} — ${oracle.recommendation.why}` : ""].filter(Boolean).join(" ").slice(0, 1500),
      tags: ["relay"],
      agent: req.actor?.agent ?? "relay",
      user: req.actor?.user,
      model: Object.values(models).join(" / "),
      source: "ui",
      meta: { relay: id },
    });
    report.decisionId = node.id;
  }
  mkdirSync(relayDir(s), { recursive: true });
  writeJsonAtomic(join(relayDir(s), `${id}.json`), report);
  s.store.appendEvent({ type: "analysis", nodeId: report.decisionId, data: { message: `relay ${id}: ${craftsman.options.length} option(s), ${surviving.length} surviving${report.decisionId ? `, open decision ${report.decisionId}` : ""}`, id } });
  return report;
}
