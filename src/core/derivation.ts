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

export const FORMULAS: Record<string, Formula> = { [FIDELITY.id]: FIDELITY, [HEALTH.id]: HEALTH, [COUNT.id]: COUNT };

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
