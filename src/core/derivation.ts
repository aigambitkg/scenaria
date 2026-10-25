/**
 * Batch E1: the derivation of every number (Kev's decision 2026-10-17).
 *
 * Every number Scenaria shows can carry a `Derivation`: the value, the formula with its version, the inputs it
 * was computed from, and one sentence in plain words (DE/EN). The value is never stored next to the formula — it
 * is COMPUTED by the formula from the inputs (`derive`), so anyone can recompute it (`recompute`): the person,
 * an auditor with the signed audit file, a test. A model never supplies a number here, at most evidence.
 *
 * Formulas are versioned (`fidelity/1`, `health/1`, `count/1`). Changing a formula means a new version; old
 * derivations keep naming the version they were computed with.
 *
 * No imports: shared with the dashboard.
 */

export type Lang2 = { de: string; en: string };
export type InputValue = number | boolean | string | null | string[];

export interface DerivationInput {
  name: string;
  label: Lang2;
  value: InputValue;
}

export interface Derivation {
  /** Which number, e.g. "fidelity.score", "health", "count.decisions", "auditfile.partly". */
  key: string;
  value: number;
  /** Formula id with its version, e.g. "fidelity/1". */
  formula: string;
  /** The formula in plain notation. */
  expression: Lang2;
  inputs: DerivationInput[];
  /** One sentence in plain words, with the numbers. */
  sentence: Lang2;
}

type Values = Record<string, InputValue>;

interface Formula {
  id: string;
  expression: Lang2;
  inputs: { name: string; label: Lang2 }[];
  compute(v: Values): number;
  sentence(v: Values, value: number): Lang2;
}

const num = (x: InputValue): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const bool = (x: InputValue): boolean => x === true;
/** A list input counts its items (so the reader can recount them); a number counts as itself. */
const cnt = (x: InputValue): number => (Array.isArray(x) ? x.length : num(x));
const pct = (x: number) => Math.round(x * 100);
const n2 = (x: number, lang: "de" | "en") => {
  const s = (Math.round(x * 100) / 100).toFixed(2);
  return lang === "de" ? s.replace(".", ",") : s;
};

// ------------------------------------------------------------------ context fidelity (fidelity.ts)

/** The weights of context fidelity (shared by the measurement, the forecast and the derivation). */
export const FIDELITY_WEIGHTS = { anchor: 0.35, continuity: 0.35, integrity: 0.15, epistemic: 0.15 } as const;

/** The weighted fidelity 0..100 (without a goal the anchor's weight is spread over the rest). */
export function fidelityCombine(anchor: number | null, continuity: number, integScore: number, epistemic: number): number {
  const W = FIDELITY_WEIGHTS;
  const s =
    anchor === null
      ? (continuity * W.continuity + integScore * W.integrity + epistemic * W.epistemic) / (W.continuity + W.integrity + W.epistemic)
      : anchor * W.anchor + continuity * W.continuity + integScore * W.integrity + epistemic * W.epistemic;
  return Math.round(s * 100);
}

const FIDELITY: Formula = {
  id: "fidelity/1",
  expression: {
    de: "round(100 × (0,35·L + 0,35·A + 0,15·I + 0,15·B)); ohne Ziel fällt L weg: round(100 × (0,35·A + 0,15·I + 0,15·B) / 0,65); außerhalb geändert: höchstens 25; bricht einen Fixpunkt: höchstens 40; Projektstart: 100 (25, wenn außerhalb geändert)",
    en: "round(100 × (0.35·G + 0.35·C + 0.15·I + 0.15·R)); without a goal G is left out: round(100 × (0.35·C + 0.15·I + 0.15·R) / 0.65); changed outside: at most 25; breaks a fixed point: at most 40; project start: 100 (25 if changed outside)",
  },
  inputs: [
    { name: "anchor", label: { de: "L – Luftlinie zum Ziel (0–1, leer ohne Ziel)", en: "G – line to the goal (0–1, empty without a goal)" } },
    { name: "continuity", label: { de: "A – Anschluss an die vorigen Schritte (0–1)", en: "C – connection to the previous steps (0–1)" } },
    { name: "integrity", label: { de: "I – Integrität (1 unverändert, 0,5 baut auf Geändertem auf, 0 geändert)", en: "I – integrity (1 unchanged, 0.5 built on a changed step, 0 changed)" } },
    { name: "epistemic", label: { de: "B – Belastbarkeit (Prüfurteil, Konfidenz; 0–1)", en: "R – reliability (verdict, confidence; 0–1)" } },
    { name: "tampered", label: { de: "außerhalb von Scenaria geändert", en: "changed outside Scenaria" } },
    { name: "canonBroken", label: { de: "bricht einen Fixpunkt", en: "breaks a fixed point" } },
    { name: "root", label: { de: "Projektstart", en: "project start" } },
  ],
  compute(v) {
    if (bool(v.root)) return bool(v.tampered) ? 25 : 100;
    const anchor = v.anchor === null ? null : num(v.anchor);
    let s = fidelityCombine(anchor, num(v.continuity), num(v.integrity), num(v.epistemic));
    if (bool(v.tampered)) s = Math.min(s, 25);
    if (bool(v.canonBroken)) s = Math.min(s, 40);
    return s;
  },
  sentence(v, value) {
    if (bool(v.root))
      return bool(v.tampered)
        ? { de: `${value} %: Der Projektstart wurde außerhalb von Scenaria geändert, deshalb 25 %.`, en: `${value} %: the project start was changed outside Scenaria, so 25 %.` }
        : { de: `${value} %: Der Projektstart ist der Ausgangspunkt und zählt immer 100 %.`, en: `${value} %: the project start is the starting point and always counts 100 %.` };
    const caps = (lang: "de" | "en") =>
      [bool(v.tampered) ? (lang === "de" ? " Der Schritt wurde außerhalb von Scenaria geändert, deshalb höchstens 25 %." : " The step was changed outside Scenaria, so at most 25 %.") : "", bool(v.canonBroken) ? (lang === "de" ? " Er bricht einen Fixpunkt, deshalb höchstens 40 %." : " It breaks a fixed point, so at most 40 %.") : ""].join("");
    // Without a goal the weights are 35/15/15 rescaled to 100: 54/23/23 (E1a review K3).
    if (v.anchor === null)
      return {
        de: `${value} % ohne Ziel aus Anschluss ${n2(num(v.continuity), "de")}, Integrität ${n2(num(v.integrity), "de")}, Belastbarkeit ${n2(num(v.epistemic), "de")} (gewichtet 35/15/15, auf 100 umgerechnet: 54/23/23).${caps("de")}`,
        en: `${value} % without a goal, from connection ${n2(num(v.continuity), "en")}, integrity ${n2(num(v.integrity), "en")}, reliability ${n2(num(v.epistemic), "en")} (weighted 35/15/15, rescaled to 100: 54/23/23).${caps("en")}`,
      };
    return {
      de: `${value} % aus Luftlinie ${n2(num(v.anchor), "de")}, Anschluss ${n2(num(v.continuity), "de")}, Integrität ${n2(num(v.integrity), "de")}, Belastbarkeit ${n2(num(v.epistemic), "de")} (gewichtet 35/35/15/15).${caps("de")}`,
      en: `${value} % from line to the goal ${n2(num(v.anchor), "en")}, connection ${n2(num(v.continuity), "en")}, integrity ${n2(num(v.integrity), "en")}, reliability ${n2(num(v.epistemic), "en")} (weighted 35/35/15/15).${caps("en")}`,
    };
  },
};

// ------------------------------------------------------------------ project check: health (analysis.ts)

const HEALTH: Formula = {
  id: "health/1",
  expression: {
    de: "100 − 20·(Hauptziel fehlt) − min(40; 20·Fälschungsbefunde) − min(30; 15·Fixpunkt- und Regelbefunde) − min(25; round(40·(1 − Q))) − min(30; 15·Weiter nach Fehlschlag) − min(10; 2·offene Entscheidungen) − min(10; 3·unsichere Schritte) − min(5; 2·Aufgaben mit vielen Neustarts); begrenzt auf 0–100",
    en: "100 − 20·(main goal missing) − min(40; 20·tamper findings) − min(30; 15·fixed-point and rule findings) − min(25; round(40·(1 − Q))) − min(30; 15·continued after a failure) − min(10; 2·open decisions) − min(10; 3·uncertain steps) − min(5; 2·tasks with many restarts); kept within 0–100",
  },
  inputs: [
    { name: "goalMissing", label: { de: "Hauptziel fehlt", en: "main goal missing" } },
    { name: "tamper", label: { de: "Befunde zum Fälschungsschutz (Code: Schritt)", en: "tamper-protection findings (code: step)" } },
    { name: "canon", label: { de: "schwere Befunde zu Fixpunkten und Regeln (Code: Bezug)", en: "serious fixed-point and rule findings (code: subject)" } },
    { name: "quality", label: { de: "Q – mittlere Entscheidungsqualität (0–1)", en: "Q – average decision quality (0–1)" } },
    { name: "builtOnFailure", label: { de: "weitergearbeitet nach einem Fehlschlag (Schritte)", en: "continued after a failed check (steps)" } },
    { name: "openDecisions", label: { de: "offene Entscheidungen", en: "open decisions" } },
    { name: "lowConfidence", label: { de: "unsichere, ungeprüfte Schritte", en: "uncertain, unchecked steps" } },
    { name: "manyBranches", label: { de: "Aufgaben mit vielen Neustarts", en: "tasks with many restarts" } },
  ],
  compute(v) {
    let h = 100;
    if (bool(v.goalMissing)) h -= 20;
    h -= Math.min(40, cnt(v.tamper) * 20);
    h -= Math.min(30, cnt(v.canon) * 15);
    h -= Math.min(25, Math.round((1 - num(v.quality)) * 40));
    h -= Math.min(30, cnt(v.builtOnFailure) * 15);
    h -= Math.min(10, cnt(v.openDecisions) * 2);
    h -= Math.min(10, cnt(v.lowConfidence) * 3);
    h -= Math.min(5, cnt(v.manyBranches) * 2);
    return Math.max(0, Math.min(100, h));
  },
  sentence(v, value) {
    // "label: number" reads well for 1 and for many (review E1b K7).
    const terms: [number, string, string][] = [
      [bool(v.goalMissing) ? 20 : 0, "Hauptziel fehlt", "main goal missing"],
      [Math.min(40, cnt(v.tamper) * 20), `Befunde zum Fälschungsschutz: ${cnt(v.tamper)}`, `tamper-protection findings: ${cnt(v.tamper)}`],
      [Math.min(30, cnt(v.canon) * 15), `Befunde zu Fixpunkten und Regeln: ${cnt(v.canon)}`, `fixed-point and rule findings: ${cnt(v.canon)}`],
      [Math.min(25, Math.round((1 - num(v.quality)) * 40)), `Entscheidungsqualität ${pct(num(v.quality))} %`, `decision quality ${pct(num(v.quality))} %`],
      [Math.min(30, cnt(v.builtOnFailure) * 15), `nach Fehlschlag weitergearbeitet: ${cnt(v.builtOnFailure)}`, `continued after a failure: ${cnt(v.builtOnFailure)}`],
      [Math.min(10, cnt(v.openDecisions) * 2), `offene Entscheidungen: ${cnt(v.openDecisions)}`, `open decisions: ${cnt(v.openDecisions)}`],
      [Math.min(10, cnt(v.lowConfidence) * 3), `unsichere, ungeprüfte Schritte: ${cnt(v.lowConfidence)}`, `uncertain, unchecked steps: ${cnt(v.lowConfidence)}`],
      [Math.min(5, cnt(v.manyBranches) * 2), `Aufgaben mit vielen Neustarts: ${cnt(v.manyBranches)}`, `tasks with many restarts: ${cnt(v.manyBranches)}`],
    ];
    const used = terms.filter(([p]) => p > 0);
    if (!used.length) return { de: `${value} von 100: kein Abzug.`, en: `${value} of 100: no deduction.` };
    const raw = 100 - used.reduce((a, [p]) => a + p, 0);
    // Below 0 the score is kept at 0: said, so the sentence adds up (E1a review K4).
    const clampDe = raw !== value ? ` = ${raw}, begrenzt auf ${value}` : "";
    const clampEn = raw !== value ? ` = ${raw}, kept at ${value}` : "";
    return {
      de: `${value} von 100 = 100 − ${used.map(([p, d]) => `${p} (${d})`).join(" − ")}${clampDe}.`,
      en: `${value} of 100 = 100 − ${used.map(([p, , e]) => `${p} (${e})`).join(" − ")}${clampEn}.`,
    };
  },
};

// ------------------------------------------------------------------ counts

const COUNT: Formula = {
  id: "count/1",
  expression: { de: "Anzahl der aufgeführten Einträge", en: "number of the listed items" },
  inputs: [
    { name: "rule", label: { de: "Was gezählt wird", en: "What is counted" } },
    { name: "items", label: { de: "Gezählte Einträge", en: "Counted items" } },
  ],
  compute(v) {
    return Array.isArray(v.items) ? v.items.length : 0;
  },
  sentence(v, value) {
    const rule = typeof v.rule === "string" ? v.rule : "";
    const show = Array.isArray(v.items) ? v.items.slice(0, 12).join(", ") + (v.items.length > 12 ? " …" : "") : "";
    return { de: `${value}: ${rule}${show ? ` (${show})` : ""}.`, en: `${value}: ${rule}${show ? ` (${show})` : ""}.` };
  },
};

// ------------------------------------------------------------------ progress (progress.ts, Batch E2)

/** The gates of a task's progress, in order: each one caps the value until it is met (cumulative). */
export const PROGRESS_GATES: { cap: number; name: Lang2 }[] = [
  { cap: 10, name: { de: "Ziel und ein freigegebenes Kriterium", en: "goal and an approved criterion" } },
  { cap: 20, name: { de: "alle Kriterien gewichtet und freigegeben, Lösungsweg entschieden", en: "all criteria weighted and approved, approach decided" } },
  { cap: 40, name: { de: "erste Ergebnisse liegen vor", en: "first results exist" } },
  { cap: 60, name: { de: "alle Kriterien umgesetzt", en: "all criteria implemented" } },
  { cap: 80, name: { de: "alle Kriterien geprüft", en: "all criteria checked" } },
  { cap: 90, name: { de: "alle Kriterien bestätigt", en: "all criteria confirmed" } },
  { cap: 100, name: { de: "Aufgabe von der Person abgenommen", en: "task accepted by the person" } },
];
/** The levels of one criterion (0 open … 1 confirmed). */
export const PROGRESS_LEVELS = [0, 0.25, 0.5, 0.75, 1] as const;

/** One criterion as an input: "k3 w=40 s=0.75 checked" (id, weight, level, how the level was reached). */
function parseCriterion(x: unknown): { w: number; s: number } | null {
  if (typeof x !== "string") return null;
  const w = /(?:^|\s)w=(\d{1,3})(?=\s|$)/.exec(x);
  const s = /(?:^|\s)s=(0|0\.25|0\.5|0\.75|1)(?=\s|$)/.exec(x);
  if (!w || !s) return null;
  const wn = Number(w[1]);
  return wn >= 1 && wn <= 100 ? { w: wn, s: Number(s[1]) } : null;
}
/** One gate as an input: "40 met" or "40 open". */
function parseGate(x: unknown): { cap: number; met: boolean } | null {
  const m = typeof x === "string" ? /^(\d{1,3}) (met|open)\b/.exec(x) : null;
  return m && PROGRESS_GATES.some((g) => g.cap === Number(m[1])) ? { cap: Number(m[1]), met: m[2] === "met" } : null;
}
/** The cap: the highest gate met with every gate before it met; the gates are taken in their fixed order. */
function progressCap(gates: InputValue): { cap: number; blocked: number | null } {
  const list = Array.isArray(gates) ? gates.map(parseGate) : [];
  let cap = 0;
  for (const g of PROGRESS_GATES) {
    const found = list.find((x) => x && x.cap === g.cap);
    if (!found || !found.met) return { cap, blocked: g.cap };
    cap = g.cap;
  }
  return { cap, blocked: null };
}
function progressRaw(criteria: InputValue): { raw: number; n: number } {
  const list = (Array.isArray(criteria) ? criteria : []).map(parseCriterion).filter((x): x is { w: number; s: number } => x !== null);
  const sw = list.reduce((a, c) => a + c.w, 0);
  return { raw: sw ? (list.reduce((a, c) => a + c.w * c.s, 0) / sw) * 100 : 0, n: list.length };
}
/** E5: a task's progress without the gates' cap (rounded) and the gate that holds it (null: none open). */
export function progressParts(criteria: InputValue, gates: InputValue): { raw: number; cap: number; blocked: number | null } {
  const { cap, blocked } = progressCap(gates);
  return { raw: Math.round(progressRaw(criteria).raw), cap, blocked };
}
export const gateLabel = (cap: number, lang: "de" | "en"): string => gateName(cap, lang);
const gateName = (cap: number, lang: "de" | "en") => PROGRESS_GATES.find((g) => g.cap === cap)?.name[lang] ?? String(cap);

const PROGRESS: Formula = {
  id: "progress/1",
  expression: {
    de: "round(min(100 × Σ(Gewicht × Stufe) / Σ Gewicht; Deckel)); Stufe je Kriterium 0 offen, 0,25 begonnen, 0,5 umgesetzt, 0,75 geprüft, 1 bestätigt; Deckel = höchstes Tor, vor dem alle Tore erfüllt sind (10, 20, 40, 60, 80, 90, 100)",
    en: "round(min(100 × Σ(weight × level) / Σ weight; cap)); level per criterion 0 open, 0.25 started, 0.5 implemented, 0.75 checked, 1 confirmed; cap = the highest gate with every gate before it met (10, 20, 40, 60, 80, 90, 100)",
  },
  inputs: [
    { name: "criteria", label: { de: "Kriterien (Kennung, w = Gewicht, s = Stufe, Nachweis)", en: "criteria (id, w = weight, s = level, evidence)" } },
    { name: "gates", label: { de: "Tore (Deckel in %, erfüllt/offen)", en: "gates (cap in %, met/open)" } },
  ],
  compute(v) {
    const { raw } = progressRaw(v.criteria);
    return Math.round(Math.min(raw, progressCap(v.gates).cap));
  },
  sentence(v, value) {
    const { raw, n } = progressRaw(v.criteria);
    const { cap, blocked } = progressCap(v.gates);
    if (!n)
      return { de: `${value} %: Die Aufgabe hat kein freigegebenes Kriterium, Fortschritt ist nicht messbar.`, en: `${value} %: the task has no approved criterion, progress cannot be measured.` };
    const r = Math.round(raw);
    // Capped only when it shows: 60.4 % rounds to 60 and is not "capped at 60" (E2a review, LOW).
    const capped = r > cap;
    const next = (lang: "de" | "en") => (blocked === null ? "" : lang === "de" ? ` Nächstes Tor: ${gateName(blocked, "de")} (${blocked} %).` : ` Next gate: ${gateName(blocked, "en")} (${blocked} %).`);
    const subjDe = n === 1 ? "Das eine Kriterium ist" : `Die ${n} Kriterien sind`;
    const subjEn = n === 1 ? "the one criterion is" : `the ${n} criteria are`;
    return {
      de: `${value} %: ${subjDe} gewichtet zu ${r} % erfüllt${capped ? `; gedeckelt auf ${cap} %, weil das Tor „${gateName(blocked ?? cap, "de")}“ noch offen ist` : ""}.${capped ? "" : next("de")}`,
      en: `${value} %: ${subjEn} ${r} % met, weighted${capped ? `; capped at ${cap} % because the gate "${gateName(blocked ?? cap, "en")}" is still open` : ""}.${capped ? "" : next("en")}`,
    };
  },
};

function parseTask(x: unknown): number | null {
  const m = typeof x === "string" ? /(?:^|\s)p=(\d{1,3})(?=\s|$)/.exec(x) : null;
  return m && Number(m[1]) <= 100 ? Number(m[1]) : null;
}
function projectMean(tasks: InputValue): { mean: number; n: number } {
  const ps = (Array.isArray(tasks) ? tasks : []).map(parseTask).filter((x): x is number => x !== null);
  return { mean: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0, n: ps.length };
}

const PROGRESS_PROJECT: Formula = {
  id: "progress-project/1",
  expression: { de: "round(Mittelwert des Fortschritts der Aufgaben mit Kriterien); jede Aufgabe zählt gleich", en: "round(mean progress of the tasks with criteria); every task counts the same" },
  inputs: [
    { name: "tasks", label: { de: "Aufgaben mit Kriterien (p = Fortschritt in %)", en: "tasks with criteria (p = progress in %)" } },
    { name: "without", label: { de: "Aufgaben ohne Kriterien (zählen nicht mit)", en: "tasks without criteria (not counted)" } },
  ],
  compute(v) {
    return Math.round(projectMean(v.tasks).mean);
  },
  sentence(v, value) {
    const { n } = projectMean(v.tasks);
    const w = cnt(v.without);
    const wDe = w ? ` ${w} Aufgabe${w === 1 ? "" : "n"} ohne Kriterien ${w === 1 ? "zählt" : "zählen"} nicht mit.` : "";
    const wEn = w ? ` ${w} task${w === 1 ? "" : "s"} without criteria ${w === 1 ? "is" : "are"} not counted.` : "";
    if (!n) return { de: `${value} %: Keine Aufgabe hat Kriterien, Fortschritt ist nicht messbar.${wDe}`, en: `${value} %: no task has criteria, progress cannot be measured.${wEn}` };
    return { de: `${value} %: Mittelwert über ${n} Aufgabe${n === 1 ? "" : "n"} mit Kriterien, jede zählt gleich.${wDe}`, en: `${value} %: mean over ${n} task${n === 1 ? "" : "s"} with criteria, each counts the same.${wEn}` };
  },
};

// ------------------------------------------------------------------ context window (window.ts, Batch E3)

/**
 * The context-window rule, version 1.0 (Kev 2026-10-18, n75–n79). Every value is a start value: only the person
 * changes them (E3b), and every derivation carries the rule it was computed with.
 */
export const CONTEXT_RULE = "v1.0 yellow=50 red=70 emergency=85 floor=50 p95start=5 margin=2 minSteps=20";
export type ContextZone = "green" | "yellow" | "orange" | "red" | "emergency";
export const CONTEXT_ZONES: Record<ContextZone, Lang2> = {
  green: { de: "grün", en: "green" },
  yellow: { de: "gelb", en: "yellow" },
  orange: { de: "orange", en: "orange" },
  red: { de: "rot", en: "red" },
  emergency: { de: "Notsicherung", en: "emergency" },
};
interface ContextRule {
  version: string;
  yellow: number;
  red: number;
  emergency: number;
  floor: number;
  p95start: number;
  margin: number;
  minSteps: number;
}
export function parseContextRule(x: InputValue): ContextRule {
  const s = typeof x === "string" ? x : CONTEXT_RULE;
  const get = (k: string, d: number) => {
    const m = new RegExp(`(?:^|\\s)${k}=(\\d{1,7}(?:\\.\\d+)?)(?=\\s|$)`).exec(s);
    return m ? Number(m[1]) : d;
  };
  return {
    // "v1.0" = the start values; "v1.0-p3" = the person's revision 3 of them (E3b-1).
    version: /^v\d+(?:\.\d+)*(?:-p\d+)?/.exec(s)?.[0] ?? "v1.0",
    yellow: get("yellow", 50),
    red: get("red", 70),
    emergency: get("emergency", 85),
    floor: get("floor", 50),
    p95start: get("p95start", 5),
    margin: get("margin", 2),
    minSteps: get("minSteps", 20),
  };
}
/** One decimal, rounded down: 69.96 % shows as 69.9 % and is still below the 70 % line. */
const floor1 = (x: number) => Math.floor(x * 10 + 1e-9) / 10;
/** One decimal, rounded up: the buffer as shown, so "70 % minus the buffer" is exactly the soft threshold. */
const ceil1 = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;
/** A window size below 1,000 or above a billion tokens is no window size (the rule does not apply). */
const MIN_WINDOW = 1000;
const MAX_WINDOW = 1_000_000_000;
const cEffOf = (v: Values) => {
  const ok = (x: number) => x >= MIN_WINDOW && x <= MAX_WINDOW;
  const cMax = num(v.cMax);
  const a = num(v.aModel);
  // Without a documented window size the rule does not apply, whatever A_model says.
  return ok(cMax) ? Math.min(cMax, ok(a) ? a : Infinity) : Infinity;
};
/** Step sizes (tokens between two checkpoints), as listed: non-negative whole numbers only. */
function stepSizes(x: InputValue): number[] {
  return (Array.isArray(x) ? x : []).map((s) => (/^\d{1,9}$/.test(String(s)) ? Number(s) : NaN)).filter((n) => Number.isFinite(n));
}
/** P95 by nearest rank: the smallest step size that at least 95 % of the steps do not exceed. */
export function p95Of(steps: number[]): number {
  if (!steps.length) return 0;
  const sorted = [...steps].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}
function softParts(v: Values) {
  const r = parseContextRule(v.rule);
  const cEff = cEffOf(v);
  const steps = stepSizes(v.steps);
  const measured = steps.length >= r.minSteps;
  const p95 = measured ? p95Of(steps) : (r.p95start / 100) * cEff;
  const handover = Math.max(0, num(v.handover));
  const margin = (r.margin / 100) * cEff;
  const bufferPct = Number.isFinite(cEff) ? ceil1((100 * (p95 + handover + margin)) / cEff) : Infinity;
  return { r, cEff, steps, measured, p95, handover, margin, bufferPct, soft: Math.max(r.floor, Math.round((r.red - bufferPct) * 10) / 10) };
}
/** Whole tokens with a thousands mark (de 140.000, en 140,000). */
const tok = (x: number, lang: "de" | "en") => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, lang === "de" ? "." : ",");
const p1 = (x: number, lang: "de" | "en") => (lang === "de" ? String(x).replace(".", ",") : String(x));

const CONTEXT_SOFT: Formula = {
  id: "context-soft/1",
  expression: {
    de: "max(Boden; Rot-Linie − Puffer), auf 0,1 abgerundet; Puffer = 100 × (P95(Schrittgröße) + Übergabekosten + Marge) / C_eff; C_eff = min(C_max; A_modell); P95 ab 20 gemessenen Schritten, vorher der P95-Startwert (in % von C_eff); Rot-Linie, Boden, P95-Startwert und Marge laut der Eingabe „Regel“ (Startwerte v1.0: 70 %, 50 %, 5 %, 2 %)",
    en: "max(floor; red line − buffer), rounded down to 0.1; buffer = 100 × (P95(step size) + handover cost + margin) / C_eff; C_eff = min(C_max; A_model); P95 from 20 measured steps, before that the P95 start value (in % of C_eff); red line, floor, P95 start value and margin per the input \"rule\" (start values v1.0: 70 %, 50 %, 5 %, 2 %)",
  },
  inputs: [
    { name: "cMax", label: { de: "C_max: Fenstergröße (Tokens)", en: "C_max: window size (tokens)" } },
    { name: "cMaxSource", label: { de: "Herkunft von C_max: Doku des Anbieters mit Datum, oder von der Person eingetragen", en: "where C_max comes from: the provider's documentation with its date, or entered by the person" } },
    { name: "aModel", label: { de: "A_modell: Obergrenze für gute Arbeit (Tokens, Setzung)", en: "A_model: upper limit for good work (tokens, a setting)" } },
    { name: "steps", label: { de: "Schrittgrößen: Tokens zwischen zwei Checkpoints (dieses Projekt und Modell, die letzten 200)", en: "step sizes: tokens between two checkpoints (this project and model, the last 200)" } },
    { name: "handover", label: { de: "Übergabekosten: Größe der Übergabe-Kapsel (Tokens, Zeichen / 4)", en: "handover cost: size of the handover capsule (tokens, characters / 4)" } },
    { name: "rule", label: { de: "Regel (Version und Grenzen in %)", en: "rule (version and limits in %)" } },
  ],
  compute(v) {
    return softParts(v).soft;
  },
  sentence(v, value) {
    const x = softParts(v);
    const pDe = x.measured ? `P95 aus ${x.steps.length} gemessenen Schritten ${tok(x.p95, "de")}` : `P95-Startwert ${p1(x.r.p95start, "de")} % = ${tok(x.p95, "de")} (erst ${x.steps.length} von ${x.r.minSteps} Schritten gemessen)`;
    const pEn = x.measured ? `P95 from ${x.steps.length} measured steps ${tok(x.p95, "en")}` : `P95 start value ${x.r.p95start} % = ${tok(x.p95, "en")} (only ${x.steps.length} of ${x.r.minSteps} steps measured)`;
    if (!Number.isFinite(x.cEff)) return { de: `${p1(value, "de")} %: Ohne Fenstergröße greift die Regel nicht.`, en: `${value} %: without a window size the rule does not apply.` };
    const atFloor = value <= x.r.floor && x.r.red - x.bufferPct < x.r.floor;
    return {
      de: `${p1(value, "de")} %: ${x.r.red} % minus Puffer ${p1(x.bufferPct, "de")} % (${pDe} + Übergabe ${tok(x.handover, "de")} + Marge ${tok(x.margin, "de")} Tokens, bezogen auf C_eff ${tok(x.cEff, "de")})${atFloor ? `; nie unter ${x.r.floor} %` : ""}. Regel ${x.r.version}.`,
      en: `${value} %: ${x.r.red} % minus a buffer of ${x.bufferPct} % (${pEn} + handover ${tok(x.handover, "en")} + margin ${tok(x.margin, "en")} tokens, relative to C_eff ${tok(x.cEff, "en")})${atFloor ? `; never below ${x.r.floor} %` : ""}. Rule ${x.r.version}.`,
    };
  },
};

/** The zone of a fill value (both in %, the soft threshold from context-soft/1). */
export function contextZone(fill: number, soft: number, rule: InputValue = CONTEXT_RULE): ContextZone {
  const r = parseContextRule(rule);
  if (fill >= r.emergency) return "emergency";
  if (fill >= r.red) return "red";
  if (fill >= softLine(soft, r)) return "orange";
  if (fill >= r.yellow) return "yellow";
  return "green";
}
/** The soft threshold as a line between yellow and red (a soft threshold at 50 % leaves no yellow zone). */
const softLine = (soft: number, r: ContextRule) => Math.min(r.red, Math.max(r.yellow, Number.isFinite(soft) ? soft : r.yellow));
/** The next line above a fill value, and its name. */
export function contextNextLimit(fill: number, soft: number, rule: InputValue = CONTEXT_RULE): { at: number; zone: ContextZone } | null {
  const r = parseContextRule(rule);
  const s = softLine(soft, r);
  const lines: { at: number; zone: ContextZone }[] = [
    ...(s > r.yellow ? [{ at: r.yellow, zone: "yellow" as const }] : []),
    ...(s < r.red ? [{ at: s, zone: "orange" as const }] : []),
    { at: r.red, zone: "red" },
    { at: r.emergency, zone: "emergency" },
  ];
  return lines.find((l) => l.at > fill) ?? null;
}

const CONTEXT_FILL: Formula = {
  id: "context-fill/1",
  expression: {
    de: "100 × Tokens / C_eff, auf 0,1 abgerundet; C_eff = min(C_max; A_modell); Tokens = Eingabe + Cache-Schreiben + Cache-Lesen der letzten Antwort laut Anbieter; Zonen laut der Eingabe „Regel“: grün unter der Gelb-Linie, gelb ab ihr, orange ab der weichen Schwelle, rot ab der Rot-Linie, Notsicherung ab ihrer Linie (Startwerte v1.0: 50 %, 70 %, 85 %)",
    en: "100 × tokens / C_eff, rounded down to 0.1; C_eff = min(C_max; A_model); tokens = input + cache write + cache read of the last answer as reported by the provider; zones per the input \"rule\": green below the yellow line, yellow from it, orange from the soft threshold, red from the red line, emergency from its line (start values v1.0: 50 %, 70 %, 85 %)",
  },
  inputs: [
    { name: "tokens", label: { de: "Tokens im Fenster laut Anbieter (letzte Antwort)", en: "tokens in the window as reported by the provider (last answer)" } },
    { name: "cMax", label: { de: "C_max: Fenstergröße (Tokens)", en: "C_max: window size (tokens)" } },
    { name: "cMaxSource", label: { de: "Herkunft von C_max: Doku des Anbieters mit Datum, oder von der Person eingetragen", en: "where C_max comes from: the provider's documentation with its date, or entered by the person" } },
    { name: "aModel", label: { de: "A_modell: Obergrenze für gute Arbeit (Tokens, Setzung)", en: "A_model: upper limit for good work (tokens, a setting)" } },
    { name: "soft", label: { de: "weiche Schwelle in % (context-soft/1)", en: "soft threshold in % (context-soft/1)" } },
    { name: "rule", label: { de: "Regel (Version und Grenzen in %)", en: "rule (version and limits in %)" } },
  ],
  compute(v) {
    const cEff = cEffOf(v);
    return Number.isFinite(cEff) ? floor1((100 * Math.max(0, num(v.tokens))) / cEff) : 0;
  },
  sentence(v, value) {
    const cEff = cEffOf(v);
    if (!Number.isFinite(cEff)) return { de: `${p1(value, "de")} %: Ohne Fenstergröße greift die Regel nicht.`, en: `${value} %: without a window size the rule does not apply.` };
    const soft = num(v.soft);
    const zone = contextZone(value, soft, v.rule);
    const next = contextNextLimit(value, soft, v.rule);
    const r = parseContextRule(v.rule);
    const lim = (lang: "de" | "en") => {
      const cMax = num(v.cMax);
      const a = num(v.aModel);
      const which = a > 0 && a < cMax ? (lang === "de" ? "A_modell" : "A_model") : "C_max";
      return lang === "de" ? `C_eff ${tok(cEff, "de")} (${which}; C_max ${tok(cMax, "de")}, A_modell ${tok(a, "de")})` : `C_eff ${tok(cEff, "en")} (${which}; C_max ${tok(cMax, "en")}, A_model ${tok(a, "en")})`;
    };
    const nDe = next ? ` Nächste Grenze: ${p1(next.at, "de")} % (${CONTEXT_ZONES[next.zone].de}).` : "";
    const nEn = next ? ` Next line: ${next.at} % (${CONTEXT_ZONES[next.zone].en}).` : "";
    return {
      de: `${p1(value, "de")} %: ${tok(num(v.tokens), "de")} Tokens von ${lim("de")}. Zone ${CONTEXT_ZONES[zone].de}.${nDe} Regel ${r.version}.`,
      en: `${value} %: ${tok(num(v.tokens), "en")} tokens of ${lim("en")}. Zone ${CONTEXT_ZONES[zone].en}.${nEn} Rule ${r.version}.`,
    };
  },
};

// ------------------------------------------------------------------ progress per window, handover check (Batch E4)

/**
 * The rule for progress per window and the handover check, version 1.0 (Kev 2026-10-17, answer 2: at least 10 points
 * of progress per window, 5 points tolerance for a handover; adjustable only by the person, E3b-1). `k` = how many
 * first steps of the new window the handover check compares (Kev 2026-10-24: 3).
 */
export const WINDOW_PROGRESS_RULE = "v1.0 min=10 tolerance=5 k=3";
export interface WindowProgressRule {
  version: string;
  min: number;
  tolerance: number;
  k: number;
}
export function parseWindowProgressRule(x: InputValue): WindowProgressRule {
  const s = typeof x === "string" ? x : WINDOW_PROGRESS_RULE;
  const get = (k: string, d: number) => {
    const m = new RegExp(`(?:^|\\s)${k}=(\\d{1,3})(?=\\s|$)`).exec(s);
    return m ? Number(m[1]) : d;
  };
  return { version: /^v\d+(?:\.\d+)*(?:-p\d+)?/.exec(s)?.[0] ?? "v1.0", min: get("min", 10), tolerance: get("tolerance", 5), k: Math.max(1, get("k", 3)) };
}

/** What became of a window (shared by window-progress/1 and windowprogress.ts). */
export type WindowVerdict = "progress" | "none" | "not-full" | "no-fill" | "no-criteria" | "waiting" | "no-work" | "capped";
/** "n1 p=40" lists → task → value (the first entry of a task counts). */
function taskValues(x: InputValue): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of Array.isArray(x) ? x : []) {
    const id = typeof s === "string" ? /^(\S+)\s/.exec(s)?.[1] : undefined;
    const p = parseTask(s);
    if (id && p !== null && !m.has(id)) m.set(id, p);
  }
  return m;
}
/** E5: how much the focus task's progress without the cap rose in the window ("n1 r=30" inputs), when a gate holds it. */
function cappedRise(v: Values): number {
  const raw = (x: InputValue) => {
    const s = typeof x === "string" ? x : Array.isArray(x) ? x.find((y) => typeof y === "string" && y.startsWith(`${v.focus} `)) : undefined;
    const m = typeof s === "string" ? /(?:^|\s)r=(\d{1,3})(?=\s|$)/.exec(s) : null;
    return m ? Number(m[1]) : null;
  };
  const to = raw(v.rawEnd);
  if (to === null || typeof v.gate !== "number") return 0;
  return to - (raw(v.rawStart) ?? 0);
}
function windowPoints(v: Values): { points: number; tasks: { task: string; from: number; best: number | null; to: number }[] } {
  const a = taskValues(v.start);
  const best = taskValues(v.best);
  const b = taskValues(v.end);
  const tasks = [...b].map(([task, to]) => ({ task, from: a.get(task) ?? 0, best: best.has(task) ? best.get(task)! : null, to }));
  // Only progress above the best level the task had before (with the same criteria) counts: going back and doing the
  // same work again is no progress (E4a review H4).
  return { points: tasks.reduce((s, t) => s + (t.to - Math.max(t.from, t.best ?? 0)), 0), tasks };
}
/** Is the window full: its highest fill reached the yellow line, or it ended by compaction? Null: not measurable. */
export function windowFull(v: Values): boolean | null {
  if (bool(v.compacted)) return true;
  if (v.peak === null || v.peak === undefined || typeof v.peak !== "number" || !Number.isFinite(v.peak)) return null;
  return v.peak >= num(v.yellow);
}
/**
 * The verdict for one window: progress from `min` points on (always — also a short window). Below it only a FULL window
 * (Kev 2026-10-24) on a task WITH criteria, whose next step is not the person's, counts as "none".
 */
export function windowVerdict(v: Values, points: number): WindowVerdict {
  const r = parseWindowProgressRule(v.rule);
  if (points >= r.min) return "progress";
  if (typeof v.focus !== "string" || !v.focus) return "no-criteria";
  // E5 (Kev 2026-10-25): a window without a single work step (questions and answers only) is not assessed.
  if (typeof v.steps === "number" && v.steps === 0) return "no-work";
  if (bool(v.waiting)) return "waiting";
  // E5 (Kev 2026-10-25): held at a gate — the work rose by at least the minimum, the gate's cap kept the value.
  if (cappedRise(v) >= r.min) return "capped";
  const full = windowFull(v);
  if (full === null) return "no-fill";
  if (!full) return "not-full";
  return "none";
}
const pts = (x: number, lang: "de" | "en") => `${x > 0 ? `+${x}` : x} ${lang === "de" ? (Math.abs(x) === 1 ? "Punkt" : "Punkte") : Math.abs(x) === 1 ? "point" : "points"}`;

const WINDOW_PROGRESS: Formula = {
  id: "window-progress/1",
  expression: {
    de: "Σ über die Aufgaben mit Kriterien am Ende des Fensters (Fortschritt am Ende − max(Fortschritt am Anfang; bisher bester Fortschritt mit denselben Kriterien)), in Punkten; ohne Kriterien am Anfang zählt der Anfang 0. Ab der Mindestzahl laut der Eingabe „Regel“ ist es Fortschritt (Startwert v1.0: 10 Punkte). Darunter zählt nur ein volles Fenster (höchste Füllung ab der Gelb-Linie, oder komprimiert) an einer Aufgabe mit Kriterien, deren nächster Schritt nicht bei der Person liegt, als „ohne Fortschritt“; nicht bewertet wird ein Fenster ohne Arbeitsschritt und eines, dessen Aufgabe ohne Deckel um mindestens die Mindestzahl stieg, während ein offenes Tor den Wert hält",
    en: "Σ over the tasks with criteria at the window's end (progress at the end − max(progress at the start; best progress so far with the same criteria)), in points; without criteria at the start the start counts 0. From the minimum per the input \"rule\" on it is progress (start value v1.0: 10 points). Below it only a full window (highest fill at or above the yellow line, or compacted) on a task with criteria whose next step is not the person's counts as \"no progress\"; a window without a work step is not assessed, nor one whose task rose by at least the minimum without the cap while an open gate holds the value",
  },
  inputs: [
    { name: "start", label: { de: "Fortschritt am Anfang des Fensters (Aufgabe p = %, progress/1)", en: "progress at the window's start (task p = %, progress/1)" } },
    { name: "best", label: { de: "bisher bester Fortschritt vor dem Fenster, mit denselben Kriterien (Aufgabe p = %)", en: "best progress before the window, with the same criteria (task p = %)" } },
    { name: "end", label: { de: "Fortschritt am Ende des Fensters (Aufgabe p = %, progress/1)", en: "progress at the window's end (task p = %, progress/1)" } },
    { name: "focus", label: { de: "Aufgabe, an der das Fenster zuletzt arbeitete (leer: keine mit Kriterien)", en: "task the window worked on last (empty: none with criteria)" } },
    { name: "waiting", label: { de: "der nächste Schritt dieser Aufgabe liegt bei der Person (Freigabe, Gewicht, Prüfung, Bestätigung, Abnahme)", en: "the next step of this task is the person's (approval, weight, check, confirmation, acceptance)" } },
    { name: "peak", label: { de: "höchste Füllung des Fensters in % (context-fill/1; leer: nicht messbar)", en: "highest fill of the window in % (context-fill/1; empty: not measurable)" } },
    { name: "yellow", label: { de: "Gelb-Linie in % (Regel des Kontextfensters)", en: "yellow line in % (context-window rule)" } },
    { name: "compacted", label: { de: "das Fenster endete mit einer Komprimierung", en: "the window ended with a compaction" } },
    { name: "running", label: { de: "das Fenster läuft noch (Ende = jetzt)", en: "the window is still running (end = now)" } },
    { name: "rule", label: { de: "Regel (Version, Mindestzahl, Toleranz)", en: "rule (version, minimum, tolerance)" } },
    { name: "steps", label: { de: "Arbeitsschritte im Fenster: Antworten der KI mit einem Werkzeug, das etwas tut (nicht Lesen, Suchen, Fragen, Planen), und ihre festgehaltenen Schritte (leer: unbekannt)", en: "work steps in the window: the agent's answers with a tool that does something (not reading, searching, asking, planning) and the steps it recorded (empty: unknown)" } },
    { name: "rawStart", label: { de: "Fortschritt der Aufgabe ohne Deckel am Anfang (r = %)", en: "the task's progress without the cap at the start (r = %)" } },
    { name: "rawEnd", label: { de: "Fortschritt der Aufgabe ohne Deckel am Ende (r = %)", en: "the task's progress without the cap at the end (r = %)" } },
    { name: "gate", label: { de: "das offene Tor, das die Aufgabe am Ende deckelt (Deckel in %)", en: "the open gate capping the task at the end (cap in %)" } },
  ],
  compute(v) {
    return windowPoints(v).points;
  },
  sentence(v, value) {
    const r = parseWindowProgressRule(v.rule);
    const { tasks } = windowPoints(v);
    const list = (lang: "de" | "en") =>
      tasks.length
        ? ` (${tasks.map((t) => `${t.task} ${t.from} → ${t.to} %${t.best !== null && t.best > t.from ? (lang === "de" ? `, bisher bestes ${t.best} %` : `, best so far ${t.best} %`) : ""}`).join("; ")})`
        : "";
    const verdict = windowVerdict(v, value);
    const pk = (lang: "de" | "en") => (typeof v.peak === "number" ? (lang === "de" ? String(v.peak).replace(".", ",") : String(v.peak)) : "–");
    const why: Record<WindowVerdict, Lang2> = {
      progress: { de: `mindestens ${r.min} Punkte: Fortschritt`, en: `at least ${r.min} points: progress` },
      none: {
        de: `weniger als ${r.min} Punkte in einem vollen Fenster (${bool(v.compacted) ? "komprimiert" : `höchste Füllung ${pk("de")} %, Gelb ab ${num(v.yellow)} %`}): ohne Fortschritt`,
        en: `fewer than ${r.min} points in a full window (${bool(v.compacted) ? "compacted" : `highest fill ${pk("en")} %, yellow from ${num(v.yellow)} %`}): no progress`,
      },
      "not-full": { de: `weniger als ${r.min} Punkte, aber das Fenster war nicht voll (höchste Füllung ${pk("de")} %, Gelb ab ${num(v.yellow)} %): wird nicht bewertet`, en: `fewer than ${r.min} points, but the window was not full (highest fill ${pk("en")} %, yellow from ${num(v.yellow)} %): not assessed` },
      "no-fill": { de: `weniger als ${r.min} Punkte, die Füllung des Fensters ist nicht messbar: wird nicht bewertet`, en: `fewer than ${r.min} points, the window's fill cannot be measured: not assessed` },
      "no-criteria": { de: "die Aufgabe hat keine Fertig-Kriterien: wird nicht bewertet", en: "the task has no completion criteria: not assessed" },
      waiting: { de: `weniger als ${r.min} Punkte, aber der nächste Schritt liegt bei der Person: wird nicht bewertet`, en: `fewer than ${r.min} points, but the next step is the person's: not assessed` },
      "no-work": { de: "im Fenster gab es keinen Arbeitsschritt (nur Lesen, Fragen und Antworten): wird nicht bewertet", en: "the window had no work step (only reading, questions and answers): not assessed" },
      capped: {
        de: `weniger als ${r.min} Punkte, aber die Arbeit stieg um ${cappedRise(v)} Punkte ohne Deckel; das offene Tor „${gateName(num(v.gate), "de")}“ (${num(v.gate)} %) hält den Wert: wird nicht bewertet`,
        en: `fewer than ${r.min} points, but the work rose by ${cappedRise(v)} points without the cap; the open gate "${gateName(num(v.gate), "en")}" (${num(v.gate)} %) holds the value: not assessed`,
      },
    };
    if (bool(v.running))
      return {
        de: `${pts(value, "de")} bisher${list("de")}; das Fenster läuft noch – bewertet wird es, wenn es endet (mindestens ${r.min} Punkte). Regel ${r.version}.`,
        en: `${pts(value, "en")} so far${list("en")}; the window is still running – it is assessed when it ends (at least ${r.min} points). Rule ${r.version}.`,
      };
    return {
      de: `${pts(value, "de")}${list("de")}; ${why[verdict].de}. Regel ${r.version}.`,
      en: `${pts(value, "en")}${list("en")}; ${why[verdict].en}. Rule ${r.version}.`,
    };
  },
};

/** One step as an input of handover-loss/1: "n12 a=0.8 c=0.6" (a = line to the goal, "-" without a goal; c = connection). */
function parseStep(x: unknown): { id: string; h: number } | null {
  const m = typeof x === "string" ? /^(\S+)\s+a=(-|0(?:\.\d{1,2})?|1(?:\.0{1,2})?)\s+c=(0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/.exec(x) : null;
  if (!m) return null;
  const c = Number(m[3]);
  const h = m[2] === "-" ? c : (Number(m[2]) + c) / 2;
  return { id: m[1], h: Math.round(h * 100) };
}
function handoverParts(v: Values) {
  const before = (Array.isArray(v.before) ? v.before : []).map(parseStep).filter((x): x is { id: string; h: number } => x !== null)[0] ?? null;
  const r = parseWindowProgressRule(v.rule);
  const after = (Array.isArray(v.after) ? v.after : []).map(parseStep).filter((x): x is { id: string; h: number } => x !== null).slice(0, r.k);
  const mean = after.length ? after.reduce((a, s) => a + s.h, 0) / after.length : null;
  return { r, before, after, mean, loss: before && mean !== null ? Math.round(before.h - mean) : 0 };
}

const HANDOVER_LOSS: Formula = {
  id: "handover-loss/1",
  expression: {
    de: "round(T(letzter Schritt im alten Fenster) − Mittelwert T(erste k Schritte im neuen Fenster)), in Punkten; T = round(100 × (Luftlinie + Anschluss) / 2), ohne Ziel nur der Anschluss (Kontext-Treue, fidelity/1); k und die Toleranz laut der Eingabe „Regel“ (Startwerte v1.0: 3 Schritte, 5 Punkte); über der Toleranz: Übergabe verbessern",
    en: "round(T(last step in the old window) − mean T(first k steps in the new window)), in points; T = round(100 × (line to the goal + connection) / 2), without a goal the connection alone (context fidelity, fidelity/1); k and the tolerance per the input \"rule\" (start values v1.0: 3 steps, 5 points); above the tolerance: improve the handover",
  },
  inputs: [
    { name: "before", label: { de: "letzter Schritt im alten Fenster (a = Luftlinie, c = Anschluss)", en: "last step in the old window (a = line to the goal, c = connection)" } },
    { name: "after", label: { de: "erste Schritte im neuen Fenster (a = Luftlinie, c = Anschluss)", en: "first steps in the new window (a = line to the goal, c = connection)" } },
    { name: "rule", label: { de: "Regel (Version, Mindestzahl, Toleranz, k)", en: "rule (version, minimum, tolerance, k)" } },
  ],
  compute(v) {
    return handoverParts(v).loss;
  },
  sentence(v, value) {
    const x = handoverParts(v);
    if (!x.before || x.mean === null)
      return { de: `${value}: nicht messbar – ${!x.before ? "kein Schritt im alten Fenster" : "noch kein Schritt im neuen Fenster"}. Regel ${x.r.version}.`, en: `${value}: not measurable – ${!x.before ? "no step in the old window" : "no step in the new window yet"}. Rule ${x.r.version}.` };
    const n = x.after.length;
    const partial = n < x.r.k;
    const ok = value <= x.r.tolerance;
    const m = Math.round(x.mean * 10) / 10;
    return {
      de: `${Math.abs(value)} ${Math.abs(value) === 1 ? "Punkt" : "Punkte"} ${value < 0 ? "Gewinn" : "Verlust"}: ${x.before.id} (${x.before.h}) → ${n === 1 ? `${x.after[0].id} (${x.after[0].h})` : `${x.after.map((s) => s.id).join(", ")} (Mittel ${String(m).replace(".", ",")})`}${partial ? `, erst ${n} von ${x.r.k} Schritten` : ""}; ${ok ? `höchstens ${x.r.tolerance} Punkte: Übergabe in Ordnung` : `mehr als ${x.r.tolerance} Punkte: Übergabe verbessern`}. Regel ${x.r.version}.`,
      en: `${Math.abs(value)} ${Math.abs(value) === 1 ? "point" : "points"} ${value < 0 ? "gained" : "lost"}: ${x.before.id} (${x.before.h}) → ${n === 1 ? `${x.after[0].id} (${x.after[0].h})` : `${x.after.map((s) => s.id).join(", ")} (mean ${m})`}${partial ? `, only ${n} of ${x.r.k} steps so far` : ""}; ${ok ? `at most ${x.r.tolerance} points: the handover is fine` : `more than ${x.r.tolerance} points: improve the handover`}. Rule ${x.r.version}.`,
    };
  },
};

export const FORMULAS: Record<string, Formula> = {
  [FIDELITY.id]: FIDELITY,
  [HEALTH.id]: HEALTH,
  [COUNT.id]: COUNT,
  [PROGRESS.id]: PROGRESS,
  [PROGRESS_PROJECT.id]: PROGRESS_PROJECT,
  [CONTEXT_SOFT.id]: CONTEXT_SOFT,
  [CONTEXT_FILL.id]: CONTEXT_FILL,
  [WINDOW_PROGRESS.id]: WINDOW_PROGRESS,
  [HANDOVER_LOSS.id]: HANDOVER_LOSS,
};

/** Only the value of a formula (no texts): for many numbers at once, e.g. the hook on every tool call (E4a review H3). */
export function formulaValue(formula: string, values: Values): number {
  const f = Object.prototype.hasOwnProperty.call(FORMULAS, formula) ? FORMULAS[formula] : undefined;
  if (!f) throw new Error(`unknown formula ${formula}`);
  return f.compute({ ...values });
}

/** Build a derivation: the value is computed by the formula from the inputs, never passed in. */
export function derive(key: string, formula: string, values: Values, rule?: Lang2): Derivation {
  const f = Object.prototype.hasOwnProperty.call(FORMULAS, formula) ? FORMULAS[formula] : undefined;
  if (!f) throw new Error(`unknown formula ${formula}`);
  const v: Values = { ...values };
  const value = f.compute(v);
  const inputs = f.inputs.filter((i) => i.name in v).map((i) => ({ name: i.name, label: i.label, value: v[i.name] }));
  let sentence = f.sentence(v, value);
  // A count names what it counts in the reader's language.
  if (rule) {
    v.rule = rule.de;
    const de = f.sentence(v, value).de;
    v.rule = rule.en;
    const en = f.sentence(v, value).en;
    sentence = { de, en };
    for (const i of inputs) if (i.name === "rule") i.value = `${rule.de} / ${rule.en}`;
  }
  return { key, value, formula, expression: f.expression, inputs, sentence };
}

/** A count of listed items (count/1), with what is counted in both languages. */
export function countOf(key: string, items: string[], rule: Lang2): Derivation {
  return derive(key, "count/1", { rule: rule.de, items: [...items] }, rule);
}

/**
 * Recompute a derivation from its own inputs. Returns null for an unknown formula. A value that differs from
 * `d.value` means the derivation was changed after it was computed (or a different formula version).
 */
export function recompute(d: Derivation | CompactDerivation | null | undefined): number | null {
  // Derivations can come from outside (an auditor's file, the dashboard): never throw (E1a review K5).
  if (!d || typeof d !== "object" || typeof d.formula !== "string" || !Object.prototype.hasOwnProperty.call(FORMULAS, d.formula)) return null;
  const f = FORMULAS[d.formula];
  const allowed = new Set(f.inputs.map((i) => i.name));
  const v: Values = Object.create(null);
  if (Array.isArray((d as Derivation).inputs)) {
    for (const i of (d as Derivation).inputs) if (i && typeof i === "object" && allowed.has(i.name)) v[i.name] = i.value;
  } else if ((d as CompactDerivation).inputs && typeof (d as CompactDerivation).inputs === "object") {
    for (const [k, x] of Object.entries((d as CompactDerivation).inputs)) if (allowed.has(k)) v[k] = x;
  } else return null;
  try {
    const r = f.compute(v);
    return Number.isFinite(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * The short form for numbers that occur many times (every step's fidelity, E1a review K6): value, formula and
 * the input values only. `expand` adds the expression, the labels and the sentence from the same formula, so
 * nothing is lost and nothing can disagree.
 */
export interface CompactDerivation {
  key: string;
  value: number;
  formula: string;
  inputs: Record<string, InputValue>;
}

export function compact(d: Derivation): CompactDerivation {
  return { key: d.key, value: d.value, formula: d.formula, inputs: Object.fromEntries(d.inputs.map((i) => [i.name, i.value])) };
}

/** The full derivation from the short form (null for an unknown formula). The value is computed again. */
export function expand(c: CompactDerivation | null | undefined): Derivation | null {
  if (!c || typeof c !== "object" || typeof c.formula !== "string" || !Object.prototype.hasOwnProperty.call(FORMULAS, c.formula) || !c.inputs || typeof c.inputs !== "object") return null;
  const allowed = new Set(FORMULAS[c.formula].inputs.map((i) => i.name));
  const values: Values = {};
  for (const [k, x] of Object.entries(c.inputs)) if (allowed.has(k)) values[k] = x;
  try {
    return derive(String(c.key), c.formula, values);
  } catch {
    return null;
  }
}
