/**
 * The Prüf-Experte (auditor): secures every forecast before anyone relies on it.
 *
 *   1. Checklist (deterministic, free, always): made before the choice? signed? enough line and goal?
 *      options distinguishable within the uncertainty band? core better than the naive forecast on this
 *      project? warnings resolved? every oracle correction backed by a reason and existing evidence, and
 *      does the reason talk about what the evidence says? oracle consistent with its own numbers? how
 *      much is the oracle trusted (γ)? → verdict: reliable / with caution / not reliable.
 *   2. Skeptic (a model in the role "auditor", on the person's request): judges each claim of the
 *      oracle ONLY against the quoted evidence — supported / unsupported / contradicted. Corrections
 *      that are not supported are removed in the "audited forecast". Signed record.
 *   3. Oracle backtest (on the person's request, uses the model): past decisions forecast again as of
 *      their own time, with and without the oracle — does the oracle make forecasts better? This also
 *      teaches γ, together with the live forecasts that were later checked against reality.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Scenaria } from "./engine.js";
import { callLlm, type LlmRequest } from "./analysis.js";
import { signRecord, verifyRecord } from "./canon.js";
import { effectiveLlm, upstreams } from "./settings.js";
import { writeJsonAtomic } from "./store.js";
import { listForecasts, evaluateForecasts, type Forecast } from "./forecast.js";
import { applyOracle, fitGamma, material, parseJson, reasonFitsEvidence, runMultiverse, type OracleAdjust, type OracleCase } from "./oracle.js";
import { backtestCases, fit, forecastQuality, predictOption, readHistory, viewAsOf, viewNow, UNCALIBRATED, type Calibration } from "./predict.js";

type Lang = "de" | "en";
const one = (x: unknown, max = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ------------------------------------------------------------------ trust in the oracle

interface BacktestRecord {
  id: string;
  createdAt: string;
  model: string | null;
  cases: (OracleCase & { decision: string; option: string; label: string; core: number; oracle: number })[];
  sig?: string;
  pub?: string;
  verified?: boolean;
}

const btDir = (s: Scenaria) => s.store.path("forecast-backtests");
const auditDir = (s: Scenaria) => s.store.path("audits");
const digest = (x: object) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

function readSigned<T extends { id: string; sig?: string; pub?: string; verified?: boolean }>(s: Scenaria, dir: string, prefix: string, kind: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => new RegExp(`^${prefix}\\d+\\.json$`).test(f))
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as T;
        if (!r || `${r.id}.json` !== f) return null;
        const { sig, pub, verified, ...content } = r as any;
        void verified;
        r.verified = verifyRecord(s.store, [kind, r.id, digest(content)], pub, sig);
        return r;
      } catch {
        return null;
      }
    })
    .filter((r): r is T => r !== null);
}

function saveSigned<T extends { id: string }>(s: Scenaria, dir: string, prefix: string, kind: string, body: Omit<T, "id">): T & { sig: string; pub: string; verified: boolean } {
  mkdirSync(dir, { recursive: true });
  let n = readdirSync(dir).reduce((m, x) => Math.max(m, parseInt(x.match(new RegExp(`^${prefix}(\\d+)\\.json$`))?.[1] ?? "0", 10)), 0) + 1;
  for (;; n++) {
    try {
      closeSync(openSync(join(dir, `${prefix}${n}.json`), "wx"));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST" || n > 100000) throw err;
    }
  }
  const rec = { id: `${prefix}${n}`, ...body } as unknown as T;
  const sg = signRecord(s.store, [kind, rec.id, digest(rec)]);
  const out = { ...rec, sig: sg.sig, pub: sg.pub };
  writeJsonAtomic(join(dir, `${rec.id}.json`), out);
  return { ...out, verified: true };
}

/** A correction that counts at least this many points needs the skeptic's agreement for "reliable". */
const BIG = 10;
/** Like the core's quality: the oracle-vs-core comparison is meaningful from 10 decisions. */
const MIN_ORACLE_DECISIONS = 10;
const raw = (a: OracleAdjust | undefined, confidence: number) => (a?.backed ? a.proposed * confidence : 0);

/** Live multiverse forecasts (oracle v2) that were later checked against reality. */
function liveOracleCases(s: Scenaria): (OracleCase & { core: number; oracle: number; decision: string })[] {
  const ev = evaluateForecasts(s);
  const out: (OracleCase & { core: number; oracle: number; decision: string })[] = [];
  for (const f of ev.forecasts) {
    if (!f.verified || f.mode !== "multiverse" || (f.oracle ?? 1) < 2 || !f.actual) continue;
    for (const a of f.actual) {
      const o = f.options.find((x) => x.key === a.option);
      const e = o?.quick.explain;
      const u = o?.universe;
      if (!o || !e || !u || u.core === undefined) continue;
      out.push({ own: e.own.score, inContext: e.inContext.score, line: e.line, risk: e.risk.lessons + e.risk.canon, alpha: e.alpha, beta: e.beta, rawOwn: raw(u.own, u.confidence), rawCtx: raw(u.ctx, u.confidence), capped: Boolean(u.capped), actual: a.measured, core: u.core, oracle: o.score, decision: f.subject.kind === "decision" ? f.subject.node : f.id });
    }
  }
  return out;
}

export function listOracleBacktests(s: Scenaria): BacktestRecord[] {
  return readSigned<BacktestRecord>(s, btDir(s), "b", "forecast-backtest/v1").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const trustCache = new Map<string, { v: string; t: { gamma: number; n: number } }>();
/** γ: how much the oracle's corrections are trusted on this project (learned, shrunk towards 1). */
export function oracleTrust(s: Scenaria): { gamma: number; n: number } {
  const v = String(s.store.version());
  const hit = trustCache.get(s.root);
  if (hit && hit.v === v) return hit.t;
  let t = { gamma: 1, n: 0 };
  try {
    const cases = [...liveOracleCases(s), ...listOracleBacktests(s).filter((r) => r.verified).flatMap((r) => r.cases)];
    t = fitGamma(cases);
  } catch {
    /* defaults */
  }
  trustCache.set(s.root, { v, t });
  return t;
}

export interface OracleQuality {
  gamma: number;
  gammaN: number;
  live: { n: number; maeCore: number | null; maeOracle: number | null };
  backtest: { n: number; runs: number; maeCore: number | null; maeOracle: number | null };
  /** 1 − maeOracle/maeCore over the checked cases where the oracle corrected something: > 0 = it improves the core. */
  skillVsCore: number | null;
  /** Checked cases in which the oracle changed the number at all. */
  corrected: number;
  /** Distinct decisions among them, and whether that is enough to trust the comparison (same rule as the core). */
  decisions: number;
  minDecisions: number;
  enough: boolean;
}

export function oracleQuality(s: Scenaria): OracleQuality {
  const live = liveOracleCases(s);
  const runs = listOracleBacktests(s).filter((r) => r.verified);
  const bt = runs.flatMap((r) => r.cases);
  const mae = (xs: { actual: number }[], k: "core" | "oracle") => (xs.length ? Math.round(mean(xs.map((c) => Math.abs((c as any)[k] - c.actual))) * 10) / 10 : null);
  // Only cases where the oracle changed the number say whether it helps.
  const all = [...live, ...bt].filter((c) => c.oracle !== c.core);
  const mc = mae(all, "core");
  const mo = mae(all, "oracle");
  const tr = oracleTrust(s);
  return {
    gamma: tr.gamma,
    gammaN: tr.n,
    live: { n: live.length, maeCore: mae(live, "core"), maeOracle: mae(live, "oracle") },
    backtest: { n: bt.length, runs: runs.length, maeCore: mae(bt, "core"), maeOracle: mae(bt, "oracle") },
    skillVsCore: mc && mo !== null ? Math.round((1 - mo / mc) * 100) / 100 : null,
    corrected: all.length,
    decisions: new Set(all.map((c) => c.decision)).size,
    minDecisions: MIN_ORACLE_DECISIONS,
    enough: new Set(all.map((c) => c.decision)).size >= MIN_ORACLE_DECISIONS,
  };
}

/**
 * Oracle backtest: the last `limit` decisions whose branches can be measured, forecast again as of
 * their own time — core (weights learned without that decision) and core + oracle (γ = 1). Uses the
 * person's model: 3 calls per decision.
 */
export async function oracleBacktest(s: Scenaria, opts: { limit?: number; lang?: Lang; llm?: Partial<LlmRequest> } = {}): Promise<BacktestRecord> {
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const h = readHistory(s);
  const { cases } = backtestCases(s, h);
  const decisions = [...new Set(cases.map((c) => c.decision))].slice(-limit);
  if (!decisions.length) throw new Error("No past decision with a measurable line yet (each option needs 2 steps after it).");
  const now = viewNow(s);
  const out: BacktestRecord["cases"] = [];
  let model: string | null = null;
  for (const id of decisions) {
    const d = now.nodes.get(id)!;
    const w = fit(cases.filter((c) => c.decision !== id));
    const cal: Calibration = { ...UNCALIBRATED, alpha: w.alpha, beta: w.beta, n: new Set(cases.filter((c) => c.decision !== id).map((c) => c.decision)).size };
    const past = viewAsOf(s, d.createdAt, h, d.id);
    const pd = past.nodes.get(d.id);
    if (!pd) continue;
    // Question and options as they were at the decision's time (field history), not as edited later.
    const opts2 = (pd.options ?? []).map((o) => ({ key: o.id, label: o.label, text: o.description, explain: predictOption(past, pd, o, cal).explain }));
    const mv = await runMultiverse(s, past, { kind: "decision", node: pd.id, question: pd.question ?? pd.title }, opts2, { lang: opts.lang, llm: opts.llm, gamma: 1 });
    model = mv.models.oracle ?? model;
    for (const c of cases.filter((x) => x.decision === id)) {
      const u = mv.options.find((x) => x.key === c.option);
      const e = opts2.find((x) => x.key === c.option)?.explain;
      if (!u || !e) continue;
      out.push({ decision: id, option: c.option, label: c.label, own: e.own.score, inContext: e.inContext.score, line: e.line, risk: e.risk.lessons + e.risk.canon, alpha: e.alpha, beta: e.beta, rawOwn: raw(u.own, u.confidence), rawCtx: raw(u.ctx, u.confidence), capped: u.capped, actual: c.actual, core: e.predicted, oracle: u.predicted });
    }
  }
  const rec = saveSigned<BacktestRecord>(s, btDir(s), "b", "forecast-backtest/v1", { createdAt: new Date().toISOString(), model, cases: out });
  s.store.appendEvent({ type: "analysis", data: { message: `oracle backtest ${rec.id}: ${out.length} options from ${decisions.length} decisions`, id: rec.id } });
  return rec;
}

// ------------------------------------------------------------------ the checklist

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export interface Check {
  id: string;
  status: CheckStatus;
  text: string;
}
export interface Audit {
  forecast: string;
  verdict: "reliable" | "caution" | "unreliable";
  checks: Check[];
  deep: DeepAudit[];
}

const T = {
  de: {
    timingOk: "Vor der Wahl erstellt – ein fairer Test.",
    timingOpen: "Entscheidung noch offen – die Prognose kommt vor der Wahl.",
    timingFail: "Nach der Wahl erstellt – kein fairer Test, zählt nur als Rückblick.",
    sigOk: "Signiert von Scenaria.",
    sigFail: "Nicht von Scenaria signiert (außerhalb geschrieben) – nicht verwenden.",
    legacy: "Älteres Prognosemodell (v1) – nicht mit der Messung vergleichbar.",
    goalOk: "Hauptziel gesetzt.",
    goalWarn: "Kein Hauptziel – nur die Nähe zum Teilziel wird gemessen.",
    lineOk: (n: number) => `Linie mit ${n} Schritten als Grundlage.`,
    lineWarn: (n: number) => `Kurze Linie (${n} Schritte) – das Niveau L ist unsicher.`,
    lowSignal: (k: string) => `Option(en) ${k} sagen zu wenig – Wortbasis schwach.`,
    distinctOk: (d: number, b: number) => `Optionen unterscheidbar (Abstand ${d} ≥ Band ±${b}).`,
    distinctWarn: (d: number, b: number) => `Optionen innerhalb der Unsicherheit (Abstand ${d} < Band ±${b}) – keine klare Empfehlung.`,
    calibOk: (n: number, sk: number) => `Kern auf diesem Projekt besser als die naive Fortschreibung (${n} Entscheidungen, Skill ${sk}).`,
    calibBad: (n: number, sk: number) => `Kern auf diesem Projekt bisher NICHT besser als die naive Fortschreibung (${n} Entscheidungen, Skill ${sk}).`,
    calibFew: (n: number, min: number) => `Erst ${n} auswertbare Entscheidungen (aussagekräftig ab ${min}) – Zahlen als Tendenz lesen.`,
    flagOpen: (k: string) => `Warnflagge offen bei ${k}: eigene Worte ohne Bezug zum Kontext – Multiversum oder Mensch prüfen lassen.`,
    flagResolved: (k: string) => `Warnflagge bei ${k} vom Orakel mit Belegen entkräftet – von der KI-Prüfung bestätigt.`,
    flagPending: (k: string) => `Warnflagge bei ${k}: das Orakel nennt passende Belege – erst entkräftet, wenn die KI-Prüfung sie bestätigt.`,
    generic: (k: string) => `Zu allgemeine Verweise (Projekt, Aufgabe, die Entscheidung selbst) zählen nicht als Beleg: ${k}.`,
    bigUnchecked: (k: string) => `Große Korrektur(en) ohne KI-Prüfung: ${k} – vor dem Verlassen darauf die KI-Prüfung starten.`,
    backedOk: (n: number) => `Alle ${n} Korrekturen des Orakels mit Grund und gültigen Belegen.`,
    backedWarn: (u: number, n: number, dr: number) => `${u} von ${n} Korrekturen ohne Grund/gültige Belege (nicht gewertet)${dr ? `, ${dr} erfundene Belege verworfen` : ""}.`,
    noCorrections: "Das Orakel hat den Kern nicht korrigiert.",
    relevanceWarn: (k: string) => `Hinweis (Wortvergleich): Begründung teilt keine Wörter mit ihren Belegen bei ${k} – die KI-Prüfung klärt, ob die Belege sie tragen.`,
    relevanceOk: "Begründungen beziehen sich auf ihre Belege.",
    recWarn: (r: string, b: string) => `Orakel empfiehlt ${r}, die korrigierte Prognose spricht für ${b}.`,
    trustInfo: (g: number, n: number) => `Vertrauen ins Orakel γ = ${g} (aus ${n} geprüften Fällen${n ? "" : " – Standard"}).`,
    trustLow: (g: number, n: number) => `Orakel hat Prognosen bisher eher verschlechtert (γ = ${g}, ${n} Fälle) – Korrekturen werden gedämpft.`,
    canon: (k: string) => `Harter Fixpunkt in Gefahr (${k}) – Prognose auf ${40} gedeckelt.`,
    deepOk: (n: number) => `KI-Prüfung: alle ${n} Aussagen des Orakels von ihren Belegen getragen.`,
    deepWarn: (bad: string) => `KI-Prüfung: nicht belegt/widerlegt – ${bad}. Die geprüfte Prognose ohne diese Korrekturen verwenden.`,
    deepUnsigned: (n: number) => `${n} KI-Prüfung(en) nicht von Scenaria signiert (außerhalb geschrieben/geändert) – ignoriert.`,
  },
  en: {
    timingOk: "Made before the choice — a fair test.",
    timingOpen: "Decision still open — the forecast comes before the choice.",
    timingFail: "Made after the choice — not a fair test, counts as hindsight only.",
    sigOk: "Signed by Scenaria.",
    sigFail: "Not signed by Scenaria (written outside) — do not use.",
    legacy: "Older forecast model (v1) — not comparable with the measurement.",
    goalOk: "Main goal set.",
    goalWarn: "No main goal — only closeness to the task is measured.",
    lineOk: (n: number) => `A line of ${n} steps as the basis.`,
    lineWarn: (n: number) => `Short line (${n} steps) — the level L is uncertain.`,
    lowSignal: (k: string) => `Option(s) ${k} say too little — weak word basis.`,
    distinctOk: (d: number, b: number) => `Options distinguishable (gap ${d} ≥ band ±${b}).`,
    distinctWarn: (d: number, b: number) => `Options within the uncertainty (gap ${d} < band ±${b}) — no clear recommendation.`,
    calibOk: (n: number, sk: number) => `Core better than the naive forecast on this project (${n} decisions, skill ${sk}).`,
    calibBad: (n: number, sk: number) => `Core NOT better than the naive forecast on this project so far (${n} decisions, skill ${sk}).`,
    calibFew: (n: number, min: number) => `Only ${n} measurable decisions (meaningful from ${min}) — read the numbers as a tendency.`,
    flagOpen: (k: string) => `Warning open for ${k}: own words without connection to the context — have the multiverse or a person check it.`,
    flagResolved: (k: string) => `Warning for ${k} resolved by the oracle with evidence — confirmed by the AI check.`,
    flagPending: (k: string) => `Warning for ${k}: the oracle cites fitting evidence — resolved only once the AI check confirms it.`,
    generic: (k: string) => `Too general references (project, task, the decision itself) do not count as evidence: ${k}.`,
    bigUnchecked: (k: string) => `Large correction(s) without an AI check: ${k} — run the AI check before relying on them.`,
    backedOk: (n: number) => `All ${n} corrections of the oracle with a reason and valid evidence.`,
    backedWarn: (u: number, n: number, dr: number) => `${u} of ${n} corrections without a reason/valid evidence (not counted)${dr ? `, ${dr} invented evidence ids dropped` : ""}.`,
    noCorrections: "The oracle did not correct the core.",
    relevanceWarn: (k: string) => `Hint (word comparison): the reason shares no words with its evidence for ${k} — the AI check clarifies whether the evidence carries it.`,
    relevanceOk: "Reasons refer to their evidence.",
    recWarn: (r: string, b: string) => `The oracle recommends ${r}; the corrected forecast favours ${b}.`,
    trustInfo: (g: number, n: number) => `Trust in the oracle γ = ${g} (from ${n} checked cases${n ? "" : " — default"}).`,
    trustLow: (g: number, n: number) => `The oracle has made forecasts worse so far (γ = ${g}, ${n} cases) — its corrections are damped.`,
    canon: (k: string) => `Hard fixed point at risk (${k}) — forecast capped at ${40}.`,
    deepOk: (n: number) => `AI check: all ${n} claims of the oracle carried by their evidence.`,
    deepWarn: (bad: string) => `AI check: not supported/contradicted — ${bad}. Use the audited forecast without these corrections.`,
    deepUnsigned: (n: number) => `${n} AI check(s) not signed by Scenaria (written/changed outside) — ignored.`,
  },
};

function choiceTime(s: Scenaria, node: string): string | null {
  const ev = s.store.readEvents().filter((e) => e.type === "choose" && e.nodeId === node);
  return ev.length ? ev[0].ts : null;
}

/**
 * What the oracle's evidence said WHEN the forecast was made: the texts kept (signed) with the forecast;
 * for older forecasts the material rebuilt as of the forecast's time — never today's (edited) texts.
 */
function evidenceOf(s: Scenaria, f: Forecast): { texts: Map<string, string>; goal: string } {
  const at = f.subject.kind === "decision" ? f.subject.node : f.subject.at;
  const past = material(viewAsOf(s, f.createdAt, undefined, at ?? undefined), at, f.subject.kind === "decision" ? { excludeDecisionOptions: f.subject.node } : {});
  return { texts: f.evidence ? new Map(Object.entries(f.evidence)) : past.texts, goal: past.goal };
}

/** The newest deep audit signed by Scenaria (an unsigned file never hides it). */
function latestDeep(deep: DeepAudit[]): { ok?: DeepAudit; unsigned: number } {
  return { ok: deep.find((d) => d.verified), unsigned: deep.filter((d) => !d.verified).length };
}

/** The checklist of one forecast (deterministic, nothing stored). */
export function auditForecast(s: Scenaria, f: Forecast, lang: Lang = "de"): Audit {
  const t = T[lang];
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, text: string) => checks.push({ id, status, text });
  // 1. timing
  if (f.subject.kind === "decision") {
    const ct = choiceTime(s, f.subject.node);
    if (!ct) add("timing", "ok", t.timingOpen);
    else add("timing", f.createdAt <= ct ? "ok" : "fail", f.createdAt <= ct ? t.timingOk : t.timingFail);
  }
  // 2. signature, model
  add("signature", f.verified ? "ok" : "fail", f.verified ? t.sigOk : t.sigFail);
  if ((f.model ?? 1) < 2) add("model", "warn", t.legacy);
  const ex = f.options.map((o) => o.quick.explain).filter(Boolean);
  // 3. goal, line, signal
  const kind = ex[0]?.goalKind;
  if (kind) add("goal", kind === "main" ? "ok" : "warn", kind === "main" ? t.goalOk : t.goalWarn);
  if (ex[0]) add("line", ex[0].lineN >= 3 ? "ok" : "warn", ex[0].lineN >= 3 ? t.lineOk(ex[0].lineN) : t.lineWarn(ex[0].lineN));
  const low = f.options.filter((o) => o.quick.signal === "low").map((o) => o.key);
  if (low.length) add("signal", "warn", t.lowSignal(low.join(", ")));
  // 4. distinguishable within the band
  if (f.options.length > 1 && ex[0]) {
    const scores = f.options.map((o) => o.score);
    const gap = Math.max(...scores) - Math.min(...scores);
    add("distinct", gap >= ex[0].band ? "ok" : "warn", gap >= ex[0].band ? t.distinctOk(gap, ex[0].band) : t.distinctWarn(gap, ex[0].band));
  }
  // 5. calibration of the core on this project
  const q = forecastQuality(s);
  if (!q.enough) add("calibration", "warn", t.calibFew(q.decisions, q.minDecisions));
  else add("calibration", (q.skill ?? 0) > 0 ? "ok" : "warn", (q.skill ?? 0) > 0 ? t.calibOk(q.decisions, q.skill!) : t.calibBad(q.decisions, q.skill ?? 0));
  const deep = listDeepAudits(s, f.id);
  const { ok: d0, unsigned } = latestDeep(deep);
  const supported = (claim: string) => Boolean(d0?.verdicts.some((v) => v.claim === claim && v.verdict === "supported"));
  // 6. warning flags — resolved only when the skeptic agrees with the oracle's evidence.
  const flagged = f.options.filter((o) => o.quick.explain?.breakRisk);
  const resolved = flagged.filter((o) => o.universe?.flagResolved && supported(`${o.key}.own`)).map((o) => o.key);
  const pending = flagged.filter((o) => o.universe?.flagResolved && !supported(`${o.key}.own`)).map((o) => o.key);
  const open = flagged.filter((o) => !o.universe?.flagResolved).map((o) => o.key);
  if (resolved.length) add("flags", "ok", t.flagResolved(resolved.join(", ")));
  if (pending.length) add("flags", "warn", t.flagPending(pending.join(", ")));
  if (open.length) add("flags", "warn", t.flagOpen(open.join(", ")));
  // 7. the oracle
  if (f.mode === "multiverse" && (f.oracle ?? 1) >= 2) {
    const adj = f.options.flatMap((o) => [o.universe?.own, o.universe?.ctx].filter((a): a is OracleAdjust => Boolean(a && a.proposed)).map((a) => ({ o, a })));
    const unbacked = adj.filter((x) => !x.a.backed).length;
    const dropped = adj.reduce((n, x) => n + x.a.dropped.length, 0);
    if (!adj.length) add("evidence", "info", t.noCorrections);
    else add("evidence", unbacked || dropped ? "warn" : "ok", unbacked || dropped ? t.backedWarn(unbacked, adj.length, dropped) : t.backedOk(adj.length));
    const ignored = adj.flatMap((x) => x.a.ignored ?? []);
    if (ignored.length) add("generic", "info", t.generic([...new Set(ignored)].join(", ")));
    // Large corrections move the number a lot: without the skeptic's agreement, at most "with caution".
    const big = adj.filter((x) => x.a.backed && Math.abs(x.a.applied) >= BIG && !supported(`${x.o.key}.${x.o.universe!.own === x.a ? "own" : "ctx"}`)).map((x) => `${x.o.key} (${x.a.applied > 0 ? "+" : ""}${x.a.applied})`);
    if (big.length) add("unchecked", "warn", t.bigUnchecked(big.join(", ")));
    if (adj.some((x) => x.a.backed)) {
      const mat = evidenceOf(s, f);
      const off = adj.filter((x) => x.a.backed && !reasonFitsEvidence(x.a.why, x.a.refs, mat)).map((x) => `${x.o.key} (${x.a.refs.join(", ")})`);
      // A weak, word-based hint (another language or synonyms also share no words): info, not a warning.
      add("relevance", off.length ? "info" : "ok", off.length ? t.relevanceWarn(off.join("; ")) : t.relevanceOk);
    }
    const best = [...f.options].sort((a, b) => b.score - a.score)[0];
    if (f.recommended && best && f.recommended.key !== best.key) add("consistency", "warn", t.recWarn(f.recommended.key, best.key));
    const capped = f.options.filter((o) => o.universe?.capped).map((o) => `${o.key}: ${o.universe!.canonRisks.join(", ")}`);
    if (capped.length) add("canon", "info", t.canon(capped.join("; ")));
    const tr = oracleTrust(s);
    add("trust", tr.n >= 5 && tr.gamma < 0.5 ? "warn" : "info", tr.n >= 5 && tr.gamma < 0.5 ? t.trustLow(tr.gamma, tr.n) : t.trustInfo(tr.gamma, tr.n));
  }
  if (unsigned) add("deepUnsigned", "info", t.deepUnsigned(unsigned));
  if (d0 && d0.verdicts.length) {
    // Only corrections and risks decide; the recommendation is checked against the numbers above.
    // Corrections that did not count anyway (unbacked) change nothing.
    const counted = (v: DeepAudit["verdicts"][number]) => v.part === "risk" || ((v.part === "own" || v.part === "ctx") && Boolean(f.options.find((o) => o.key === v.option)?.universe?.[v.part]?.backed));
    const bad = d0.verdicts.filter((v) => v.verdict !== "supported" && counted(v)).map((v) => v.claim);
    add("deep", bad.length ? "warn" : "ok", bad.length ? t.deepWarn(bad.join(", ")) : t.deepOk(d0.verdicts.length));
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  // The verified audit first; unsigned files only as a hint (they are flagged in the list).
  return { forecast: f.id, verdict: fails ? "unreliable" : warns ? "caution" : "reliable", checks, deep: d0 ? [d0, ...deep.filter((d) => d !== d0)] : deep };
}

// ------------------------------------------------------------------ the skeptic (model)

export interface DeepAudit {
  id: string;
  forecast: string;
  createdAt: string;
  model: string | null;
  verdicts: { claim: string; option: string; part: "own" | "ctx" | "risk" | "recommendation"; text: string; refs: string[]; verdict: "supported" | "unsupported" | "contradicted"; reason: string }[];
  /** Per option: the forecast with only the supported corrections. */
  audited: Record<string, number>;
  sig?: string;
  pub?: string;
  verified?: boolean;
}

export function listDeepAudits(s: Scenaria, forecastId?: string): DeepAudit[] {
  return readSigned<DeepAudit>(s, auditDir(s), "a", "forecast-audit/v1")
    .filter((a) => !forecastId || a.forecast === forecastId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const SKEPTIC = (lang: Lang) => `You are the AUDITOR (Prüf-Experte) of a forecast. You are skeptical. For EACH claim below, judge it ONLY against the quoted evidence — not against your own knowledge:
- "supported": the evidence clearly backs the claim,
- "unsupported": the evidence does not say this (or says too little),
- "contradicted": the evidence says the opposite.
Give a one-sentence reason each. Answer ONLY with JSON: {"verdicts": [{"claim": "<claim id>", "verdict": "supported|unsupported|contradicted", "reason": "…"}]}
Write the reasons in ${lang === "de" ? "German" : "English"}.`;

/** The skeptic: each oracle claim against its evidence; unsupported corrections are removed. */
export async function deepAudit(s: Scenaria, forecastId: string, opts: { lang?: Lang; llm?: Partial<LlmRequest> } = {}): Promise<DeepAudit> {
  const lang: Lang = opts.lang === "en" ? "en" : "de";
  const f = listForecasts(s).find((x) => x.id === forecastId);
  if (!f) throw new Error(`Unknown forecast ${forecastId}`);
  if (!f.verified) throw new Error(`${forecastId} is not signed by Scenaria — it is not audited.`);
  if (f.mode !== "multiverse" || (f.oracle ?? 1) < 2) throw new Error(lang === "de" ? "Nur Multiversum-Prognosen (Orakel v2) haben Aussagen zum Prüfen — die Schnellprognose prüft die Checkliste." : "Only multiverse forecasts (oracle v2) have claims to check — the quick forecast is covered by the checklist.");
  const mat = evidenceOf(s, f);
  const claims: DeepAudit["verdicts"] = [];
  for (const o of f.options) {
    const u = o.universe;
    if (!u) continue;
    for (const part of ["own", "ctx"] as const) {
      const a = u[part];
      if (a && a.proposed) claims.push({ claim: `${o.key}.${part}`, option: o.key, part, text: `${part === "own" ? "The option's own words" : "The next step in context"} ${a.proposed > 0 ? "connect better" : "connect worse"} than the word count shows (${a.proposed > 0 ? "+" : ""}${a.proposed}): ${a.why}`, refs: a.refs, verdict: "unsupported", reason: "" });
    }
    u.risks.slice(0, 3).forEach((r, i) => {
      const refs = (r.match(/\b[nk]\d+\b/g) ?? []).filter((x) => mat.texts.has(x));
      if (refs.length) claims.push({ claim: `${o.key}.risk${i}`, option: o.key, part: "risk", text: r, refs, verdict: "unsupported", reason: "" });
    });
  }
  if (f.recommended) claims.push({ claim: "recommendation", option: f.recommended.key, part: "recommendation", text: `Recommend ${f.recommended.key}: ${f.recommended.why}`, refs: [], verdict: "unsupported", reason: "" });
  let model: string | null = null;
  if (claims.length) {
    const cfg = effectiveLlm(s, "auditor", opts.llm);
    if (!cfg) throw new Error(lang === "de" ? "Kein Modell für den Prüf-Experten eingestellt." : "No model set for the auditor.");
    const evidence = [...new Set(claims.flatMap((c) => c.refs))].map((id) => `- ${id}: ${one(mat.texts.get(id), 400)}`).join("\n");
    const user = `CLAIMS:\n${claims.map((c) => `- ${c.claim}: ${c.text}${c.refs.length ? ` [evidence: ${c.refs.join(", ")}]` : " [no evidence given]"}`).join("\n")}\n\nEVIDENCE:\n${evidence || "(none)"}\n\nMAIN GOAL: ${mat.goal}`;
    const out = await callLlm(cfg, upstreams(s), SKEPTIC(lang), user);
    model = out.model;
    const x = parseJson(out.text);
    for (const v of Array.isArray(x.verdicts) ? x.verdicts : []) {
      const c = claims.find((cl) => cl.claim === one(v?.claim, 40));
      if (!c) continue;
      c.verdict = v?.verdict === "supported" || v?.verdict === "contradicted" ? v.verdict : "unsupported";
      c.reason = one(v?.reason, 300);
      // A claim with no evidence at all can never be "supported".
      if (!c.refs.length && c.part !== "recommendation" && c.verdict === "supported") c.verdict = "unsupported";
    }
  }
  const audited: Record<string, number> = {};
  for (const o of f.options) {
    const e = o.quick.explain;
    const u = o.universe;
    if (!e || !u) continue;
    const keep = (part: "own" | "ctx") => {
      const a = u[part];
      const v = claims.find((c) => c.claim === `${o.key}.${part}`);
      return a && v?.verdict === "supported" ? a : ({ ...(a ?? { proposed: 0, why: "", refs: [], backed: false, dropped: [] }), applied: 0 } as OracleAdjust);
    };
    audited[o.key] = applyOracle(e, keep("own"), keep("ctx"), Boolean(u.capped)).predicted;
  }
  const rec = saveSigned<DeepAudit>(s, auditDir(s), "a", "forecast-audit/v1", { forecast: f.id, createdAt: new Date().toISOString(), model, verdicts: claims, audited });
  s.store.appendEvent({ type: "analysis", data: { message: `audit ${rec.id} of ${f.id}: ${claims.filter((c) => c.verdict === "supported").length}/${claims.length} claims supported`, id: rec.id } });
  return rec;
}

/** Plain text of an audit (agents, chat). */
export function auditText(a: Audit, lang: Lang = "en"): string {
  const de = lang === "de";
  const verdict = { reliable: de ? "belastbar" : "reliable", caution: de ? "mit Vorsicht" : "with caution", unreliable: de ? "nicht belastbar" : "not reliable" }[a.verdict];
  const mark = { ok: "✔", warn: "!", fail: "✘", info: "·" } as const;
  const d = a.deep[0];
  return [
    `${de ? "Prüf-Experte" : "Auditor"} ${a.forecast}: ${verdict}`,
    ...a.checks.map((c) => `  ${mark[c.status]} ${c.text}`),
    ...(d
      ? [
          `  ${de ? "KI-Prüfung" : "AI check"} ${d.id}${d.verified ? "" : " (unsigned — ignore)"}: ${d.verdicts.filter((x) => x.verdict === "supported").length}/${d.verdicts.length} ${de ? "Aussagen belegt" : "claims supported"}; ${de ? "geprüfte Prognose" : "audited forecast"} ${Object.entries(d.audited).map(([k, n]) => `${k} ${n}`).join(", ")}`,
          ...d.verdicts.filter((x) => x.verdict !== "supported").map((x) => `    ${x.claim}: ${x.verdict} — ${x.reason}`),
        ]
      : []),
  ].join("\n");
}
