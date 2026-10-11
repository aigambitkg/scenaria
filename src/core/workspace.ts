/**
 * Global workspace: the project as a structured board instead of a message chain.
 *
 *  - Sections (goals, decisions, facts, questions, rules, lessons, risks); readers pick only what they need.
 *  - Every item has a stable reference ("n12" a node, "n12.f2" its 2nd fact, ".q" open question,
 *    ".o" output, ".l" lesson, ".i" irreversible effect, "r3" a rule). Agents pass references instead
 *    of content and resolve them only when needed (resolveRefs).
 *  - Theory of mind: Scenaria remembers per reader which items (and which version of each) it has
 *    already received, and next time sends only the gap — new, changed and invalidated items.
 *  - Predictive coding: a reader states its expectations; checkExpectations returns only deviations.
 *  - Confidence travels with every statement (decisions, facts).
 *
 * The board is non-anticipative: it is built from the path root → HEAD (plus project rules).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Scenaria } from "./engine.js";
import { optionLabel } from "./context.js";
import { tokenize } from "./recall.js";
import { writeJsonAtomic } from "./store.js";
import type { ScenariaNode } from "./types.js";
import { canonState, readCanon } from "./canon.js";

export const SECTIONS = ["goals", "canon", "decisions", "facts", "questions", "rules", "lessons", "risks"] as const;
export type Section = (typeof SECTIONS)[number];

export interface BoardItem {
  ref: string;
  section: Section;
  text: string;
  confidence?: number;
  status?: string;
  basedOn?: string[];
  /** Node the item lives on. */
  node: string;
}

function one(s: string | undefined, max = 240) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function itemHash(i: BoardItem) {
  return createHash("sha1").update(`${i.text}|${i.confidence ?? ""}|${i.status ?? ""}`).digest("hex").slice(0, 12);
}

/** The board for the path root → `at` (default HEAD). */
export function board(s: Scenaria, opts: { sections?: Section[]; at?: string } = {}): BoardItem[] {
  const want = new Set<Section>(opts.sections?.length ? opts.sections : SECTIONS);
  const head = opts.at ?? s.store.readState().head;
  const path = head ? s.path(head) : [];
  const items: BoardItem[] = [];
  const add = (i: BoardItem) => want.has(i.section) && items.push(i);
  // Open questions are scoped to the current task (older tasks' questions are usually settled).
  let taskStart = 0;
  path.forEach((n, i) => n.type === "goal" && (taskStart = i));

  path.forEach((n, idx) => {
    const next = path[idx + 1];
    if (n.type === "mission") add({ ref: n.id, section: "goals", text: `Main goal: ${n.goal ? one(n.goal, 400) : "(not set)"}`, node: n.id });
    if (n.type === "goal") add({ ref: n.id, section: "goals", text: `Task: ${one(n.title, 160)}${n.goal && n.goal !== n.title ? ` — ${one(n.goal, 200)}` : ""}`, status: n.status, node: n.id });
    if (n.type === "decision") {
      const taken = next?.viaOption ?? n.chosen;
      add({
        ref: n.id,
        section: "decisions",
        text: `${one(n.question ?? n.title, 160)} → ${optionLabel(n, taken) ?? "open"}${n.rationale ? ` (why: ${one(n.rationale, 140)})` : ""}`,
        confidence: n.confidence,
        status: n.verification?.status !== "unverified" ? n.verification?.status : undefined,
        basedOn: n.basedOn,
        node: n.id,
      });
    }
    (n.facts ?? []).forEach((f, k) =>
      add({ ref: `${n.id}.f${k + 1}`, section: "facts", text: one(f), confidence: n.factInfo?.[k]?.confidence, basedOn: n.factInfo?.[k]?.basedOn, status: n.verification?.status === "failed" ? "failed" : undefined, node: n.id }),
    );
    if (idx >= taskStart) (n.openQuestions ?? []).forEach((q, k) => add({ ref: `${n.id}.q${k + 1}`, section: "questions", text: one(q), node: n.id }));
    (n.lessons ?? []).forEach((l, k) => add({ ref: `${n.id}.l${k + 1}`, section: "lessons", text: one(l), node: n.id }));
    (n.irreversible ?? []).forEach((x, k) => add({ ref: `${n.id}.i${k + 1}`, section: "risks", text: `irreversible: ${one(x)}`, node: n.id }));
    if (n.verification?.status === "failed") add({ ref: `${n.id}.v`, section: "risks", text: `failed check on ${n.id}: ${one(n.verification.notes ?? n.title, 200)}`, node: n.id });
  });
  for (const r of s.rules()) add({ ref: r.id, section: "rules", text: one(r.text, 300), node: "n0" });
  for (const k of readCanon(s.store)) {
    if (k.status !== "active" && k.status !== "proposed") continue;
    const status = k.status === "proposed" ? "proposed — not binding" : `${k.hard ? "hard" : "soft"}${k.lastCheck ? `, check ${k.lastCheck.status}` : ""}`;
    add({ ref: k.id, section: "canon", text: `${k.kind}${k.due ? ` (by ${k.due})` : ""}: ${one(k.text, 300)}`, status, basedOn: k.evidence, node: "n0" });
  }
  // A decision that breaks a canon event is a risk for everyone downstream.
  for (const n of path) if (n.breaksCanon?.length) add({ ref: `${n.id}.k`, section: "risks", text: `${n.id} breaks canon ${n.breaksCanon.join(", ")}: ${one(n.rationale ?? n.title, 160)}`, node: n.id });
  return items;
}

const REF = /^(n\d+)(?:\.([fqoli])(\d+))?$|^(r\d+)$|^(k\d+)$/;

/** Resolve references to their content (only what was asked for). */
export function resolveRefs(s: Scenaria, refs: string[]) {
  const head = s.store.readState().head;
  const onPath = new Set(head ? s.path(head).map((n) => n.id) : []);
  const rules = s.rules();
  return refs.slice(0, 50).map((raw) => {
    const ref = String(raw).trim();
    const m = ref.match(REF);
    if (!m) return { ref, error: "unknown reference format (use n12, n12.f2, n12.q1, n12.o1, n12.l1, n12.i1, r3 or k2)" };
    if (m[5]) {
      const k = readCanon(s.store).find((x) => x.id === m[5]);
      return k ? { ref, section: "canon", kind: k.kind, text: k.text, status: k.status, hard: k.hard, due: k.due, check: k.check, lastCheck: k.lastCheck, evidence: k.evidence } : { ref, error: "no such canon event" };
    }
    if (m[4]) {
      const r = rules.find((x) => x.id === m[4]);
      return r ? { ref, section: "rules", text: r.text, source: r.source } : { ref, error: "no such rule" };
    }
    if (!s.store.hasNode(m[1])) return { ref, error: "no such node" };
    const n = s.node(m[1]);
    const base = { ref, node: n.id, onPath: onPath.has(n.id), verification: n.verification?.status };
    if (!m[2]) return { ...base, section: n.type, node_: compactNode(n) };
    const k = Number(m[3]) - 1;
    const list = m[2] === "f" ? n.facts : m[2] === "q" ? n.openQuestions : m[2] === "o" ? n.outputs : m[2] === "l" ? n.lessons : n.irreversible;
    const text = list?.[k];
    if (text === undefined) return { ...base, error: "no such item on that node" };
    return { ...base, text, confidence: m[2] === "f" ? n.factInfo?.[k]?.confidence : undefined, basedOn: m[2] === "f" ? n.factInfo?.[k]?.basedOn : undefined };
  });
}

function compactNode(n: ScenariaNode) {
  const out: Record<string, unknown> = { id: n.id, type: n.type, title: n.title };
  for (const k of ["goal", "question", "rationale", "context", "servesGoal", "expectedOutcome", "confidence", "basedOn", "status", "summary"] as const) if (n[k] !== undefined) out[k] = n[k];
  if (n.options) out.options = n.options.map((o) => `${o.id}) ${o.label}${o.id === n.chosen ? " ✔" : ""}`);
  if (n.facts) out.facts = n.facts.map((f, i) => `${n.id}.f${i + 1}: ${f}`);
  if (n.outputs) out.outputs = n.outputs.map((f, i) => `${n.id}.o${i + 1}: ${f}`);
  if (n.openQuestions) out.openQuestions = n.openQuestions.map((f, i) => `${n.id}.q${i + 1}: ${f}`);
  return out;
}

// ------------------------------------------------------------------ theory of mind (per-reader knowledge)

type Readers = Record<string, { known: Record<string, string>; at: string }>;

function readersFile(s: Scenaria) {
  return s.store.path("readers.json");
}

function readReaders(s: Scenaria): Readers {
  const f = readersFile(s);
  if (!existsSync(f)) return Object.create(null);
  try {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const out: Readers = Object.create(null);
    for (const [k, v] of Object.entries(raw ?? {})) if (k.startsWith("reader:") && v && typeof v === "object") out[k] = v as Readers[string];
    return out;
  } catch {
    return Object.create(null);
  }
}

export interface WorkspaceResult {
  mode: "full" | "delta";
  items: BoardItem[];
  changed: string[];
  invalidated: { ref: string; text?: string }[];
  unchanged: number;
}

/**
 * The board for a reader. With a reader id, Scenaria remembers what that reader already
 * knows and returns only the gap (new + changed + invalidated); `full` forces everything.
 */
export function workspace(s: Scenaria, opts: { sections?: Section[]; reader?: string; full?: boolean } = {}): WorkspaceResult {
  const fullBoard = board(s);
  const scope = new Set<Section>(opts.sections?.length ? opts.sections : SECTIONS);
  const items = fullBoard.filter((i) => scope.has(i.section));
  const reader = opts.reader?.trim() ? `reader:${opts.reader.trim().slice(0, 80)}` : null;
  if (!reader) return { mode: "full", items, changed: [], invalidated: [], unchanged: 0 };
  return s.store.withLock(() => {
    const all = readReaders(s);
    // known[ref] = "<section>|<hash>"
    const prev = all[reader]?.known ?? {};
    const onBoard = new Map(fullBoard.map((i) => [i.ref, i]));
    const firstTime = !all[reader] || Boolean(opts.full);
    const prevHash = (ref: string) => prev[ref]?.split("|")[1];
    const prevSection = (ref: string) => prev[ref]?.split("|")[0] as Section | undefined;
    const fresh = firstTime ? items : items.filter((i) => prevHash(i.ref) !== itemHash(i));
    const changed = firstTime ? [] : fresh.filter((i) => prev[i.ref] !== undefined).map((i) => i.ref);
    // Invalidated = known refs that are gone from the WHOLE board (not merely outside the requested sections).
    const gone = Object.keys(prev).filter((ref) => !onBoard.has(ref));
    const invalidated = firstTime ? [] : gone.filter((ref) => scope.has(prevSection(ref) ?? "goals")).map((ref) => ({ ref }));
    const known: Record<string, string> = {};
    for (const [ref, v] of Object.entries(prev)) {
      if (onBoard.has(ref)) known[ref] = v; // still valid, keep what the reader saw
      else if (!scope.has(prevSection(ref) ?? "goals")) known[ref] = v; // gone, not reported yet (other section)
    }
    for (const i of items) known[i.ref] = `${i.section}|${itemHash(i)}`;
    const keys = Object.keys(known);
    for (const k of keys.slice(0, Math.max(0, keys.length - 4000))) delete known[k];
    all[reader] = { known, at: new Date().toISOString() };
    const names = Object.keys(all).sort((a, b) => all[b].at.localeCompare(all[a].at));
    for (const n of names.slice(100)) delete all[n];
    writeJsonAtomic(readersFile(s), { ...all });
    return { mode: firstTime ? "full" : "delta", items: fresh, changed, invalidated, unchanged: items.length - fresh.length };
  });
}

export function renderItems(items: BoardItem[], changed: string[] = []): string {
  const bySection = new Map<Section, BoardItem[]>();
  for (const i of items) bySection.set(i.section, [...(bySection.get(i.section) ?? []), i]);
  const lines: string[] = [];
  for (const sec of SECTIONS) {
    const list = bySection.get(sec);
    if (!list?.length) continue;
    lines.push(`## ${sec}`);
    for (const i of list) {
      const conf = i.confidence !== undefined ? ` (${Math.round(i.confidence * 100)} %${i.confidence < 0.7 ? " — verify" : ""})` : "";
      const st = i.status ? ` [${i.status}]` : "";
      const based = i.basedOn?.length ? ` ← ${i.basedOn.join(", ")}` : "";
      lines.push(`${changed.includes(i.ref) ? "~" : "-"} ${i.ref}${st}: ${i.text}${conf}${based}`);
    }
  }
  return lines.join("\n");
}

export function renderWorkspace(r: WorkspaceResult): string {
  const head =
    r.mode === "full"
      ? `Workspace (${r.items.length} items).`
      : `Workspace delta: ${r.items.length - r.changed.length} new, ${r.changed.length} changed (~), ${r.invalidated.length} invalidated, ${r.unchanged} unchanged items you already know (omitted).`;
  const inv = r.invalidated.length ? `\n## invalidated (no longer on the current path — do not rely on them)\n${r.invalidated.map((i) => `- ${i.ref}`).join("\n")}` : "";
  return `${head}\n${renderItems(r.items, r.changed)}${inv}`.trim();
}

/** Compact index of the board: references + short labels; resolve details on demand. */
export function referenceCapsule(s: Scenaria, at?: string): string {
  const items = board(s, { at });
  const lines = [`# Scenaria index — resolve details with scenaria_get_node {refs: [...]}`];
  let sec: Section | null = null;
  for (const i of items) {
    if (i.section !== sec) {
      sec = i.section;
      lines.push(`## ${sec}`);
    }
    const conf = i.confidence !== undefined && i.confidence < 0.7 ? " ?" : "";
    lines.push(`${i.ref}${i.status ? ` [${i.status}]` : ""}: ${one(i.text, 70)}${conf}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ predictive coding

export type ExpectationStatus = "confirmed" | "contradicted" | "unknown";

const CHANGE = /\b(drop|dropped|reject|rejected|replace|replaced|switch|switched|abandon|abandoned|remove|removed|revert|reverted|instead|deprecated|verworfen|ersetzt|gewechselt|abgelehnt|entfernt|zurückgenommen|abgeschafft)\b/i;
const NEGATION = /\b(not|no|never|without|none|isn't|aren't|doesn't|don't|didn't|won't|can't|cannot|nicht|kein|keine|keinen|keiner|nie|niemals|ohne|statt|anstatt)\b|n't\b/i;

export interface ExpectationResult {
  expectation: string;
  status: ExpectationStatus;
  evidence?: string;
  detail: string;
}

function stems(text: string) {
  return new Set(tokenize(text).map((t) => t.slice(0, 6)));
}

/**
 * The receiver states what it assumes; Scenaria answers with the deviations.
 * Precise forms: "n12 done", "n12 verified" / "passed" / "failed", "n7 = Postgres" (or "n7 chose b"),
 * "n12.f2" (still valid), "r3" (rule active). Free text is matched against decisions and facts on the path.
 */
export function checkExpectations(s: Scenaria, expectations: string[]): ExpectationResult[] {
  const head = s.store.readState().head;
  const path = head ? s.path(head) : [];
  const onPath = new Set(path.map((n) => n.id));
  const items = board(s);
  const takenOf = (n: ScenariaNode) => {
    const i = path.findIndex((p) => p.id === n.id);
    return (i >= 0 ? path[i + 1]?.viaOption : undefined) ?? n.chosen;
  };
  return expectations.slice(0, 40).map((raw): ExpectationResult => {
    const e = String(raw).trim();
    let m: RegExpMatchArray | null;
    if ((m = e.match(/^(n\d+)\s+(done|finished|complete|erledigt|fertig)$/i))) {
      if (!s.store.hasNode(m[1])) return { expectation: e, status: "contradicted", detail: `${m[1]} does not exist` };
      const n = s.node(m[1]);
      if (!onPath.has(n.id)) return { expectation: e, status: "contradicted", evidence: n.id, detail: `${n.id} is not on the current path (other branch)` };
      if (n.type === "goal") return n.status === "done" ? { expectation: e, status: "confirmed", evidence: n.id, detail: "task done" } : { expectation: e, status: "contradicted", evidence: n.id, detail: `task status is ${n.status ?? "active"}` };
      return { expectation: e, status: "confirmed", evidence: n.id, detail: "on the current path" };
    }
    if ((m = e.match(/^(n\d+)\s+(verified|passed|geprüft|failed|warning)$/i))) {
      if (!s.store.hasNode(m[1])) return { expectation: e, status: "contradicted", detail: `${m[1]} does not exist` };
      const v = s.node(m[1]).verification?.status ?? "unverified";
      const want = /fail/i.test(m[2]) ? "failed" : /warn/i.test(m[2]) ? "warning" : "passed";
      return v === want ? { expectation: e, status: "confirmed", evidence: m[1], detail: v } : { expectation: e, status: v === "unverified" ? "unknown" : "contradicted", evidence: m[1], detail: `verification is ${v}` };
    }
    if ((m = e.match(/^(n\d+)\s*(?:=|chose|chosen|→|->)\s*(.+)$/i))) {
      if (!s.store.hasNode(m[1])) return { expectation: e, status: "contradicted", detail: `${m[1]} does not exist` };
      const n = s.node(m[1]);
      if (n.type !== "decision") return { expectation: e, status: "unknown", evidence: n.id, detail: `${n.id} is not a decision` };
      const opt = s.resolveOption(n, m[2].trim());
      const taken = takenOf(n);
      if (!opt) return { expectation: e, status: "contradicted", evidence: n.id, detail: `"${m[2].trim()}" is not an option of ${n.id}; taken: ${optionLabel(n, taken) ?? "open"}` };
      return opt.id === taken ? { expectation: e, status: "confirmed", evidence: n.id, detail: `taken: ${opt.label}` } : { expectation: e, status: "contradicted", evidence: n.id, detail: `taken on this path: ${optionLabel(n, taken) ?? "open"}, not ${opt.label}` };
    }
    if ((m = e.match(/^(k\d+)(?:\s+(?:holds|gilt|valid|active|aktiv|passes|passed))?$/i))) {
      const k = readCanon(s.store).find((x) => x.id === m![1]);
      if (!k) return { expectation: e, status: "contradicted", detail: `${m[1]} does not exist` };
      if (k.status !== "active") return { expectation: e, status: "contradicted", evidence: k.id, detail: `${k.id} is ${k.status}, not binding` };
      const broken = path.filter((n) => n.breaksCanon?.includes(k.id)).map((n) => n.id);
      if (broken.length) return { expectation: e, status: "contradicted", evidence: broken[0], detail: `${k.id} is broken on this path by ${broken.join(", ")}` };
      if (k.lastCheck?.status === "failed") return { expectation: e, status: "contradicted", evidence: k.id, detail: `last check of ${k.id} failed: ${k.lastCheck.detail ?? ""}` };
      if (k.check && k.lastCheck?.status !== "passed") return { expectation: e, status: "unknown", evidence: k.id, detail: `${k.id} has a check that has not passed yet` };
      return { expectation: e, status: "confirmed", evidence: k.id, detail: one(k.text, 120) };
    }
    if ((m = e.match(/^(n\d+\.[fqoli]\d+|r\d+)(?:\s+(?:holds|gilt|valid|active|aktiv))?$/i))) {
      const it = items.find((i) => i.ref === m![1]);
      if (it) return { expectation: e, status: it.status === "failed" ? "contradicted" : "confirmed", evidence: it.ref, detail: it.status === "failed" ? "its node failed verification" : one(it.text, 120) };
      return { expectation: e, status: "contradicted", detail: `${m[1]} is not valid on the current path` };
    }
    // Free text. Word overlap can't see negation or opposite outcomes ("failed" vs "succeeded"),
    // so it never confirms on its own: only a clear option match or a near-identical statement does.
    const negated = NEGATION.test(e);
    const claim = stems(e);
    if (!claim.size) return { expectation: e, status: "unknown", detail: "nothing to check" };
    for (const n of [...path].reverse()) {
      if (n.type !== "decision" || !n.options?.length) continue;
      const qs = stems(n.question ?? n.title);
      const named = n.options.filter((o) => {
        const os = stems(o.label);
        if (!os.size || ![...os].every((t) => claim.has(t))) return false;
        // Avoid matching a short generic option ("None", "Ja") from an unrelated decision.
        return [...qs].some((t) => claim.has(t)) || os.size >= 2 || [...os][0].length >= 5;
      });
      if (!named.length) continue;
      const taken = takenOf(n);
      const label = optionLabel(n, taken) ?? "nothing yet";
      if (negated || named.length > 1) {
        return { expectation: e, status: "unknown", evidence: n.id, detail: `${n.id} (${one(n.question ?? n.title, 80)}) took ${label} — your statement names ${named.map((o) => o.label).join(" / ")}${negated ? " with a negation" : ""}; check it against that` };
      }
      // Confirm only a statement that essentially IS the choice ("database is Postgres"); anything that says
      // more ("Postgres was dropped", "replaced by SQLite") may mean the opposite → unknown with the evidence.
      const extra = [...claim].filter((t) => !stems(named[0].label).has(t) && !qs.has(t));
      if (CHANGE.test(e) || extra.length > 2) {
        return { expectation: e, status: "unknown", evidence: n.id, detail: `${n.id} (${one(n.question ?? n.title, 80)}) took ${label}; your statement says more than that — check it against ${n.id}` };
      }
      if (named[0].id === taken) return { expectation: e, status: "confirmed", evidence: n.id, detail: `${n.id}: ${label}` };
      return { expectation: e, status: "contradicted", evidence: n.id, detail: `${n.id} (${one(n.question ?? n.title, 80)}) took ${label}, not ${named[0].label}` };
    }
    let best: { item: BoardItem; cover: number; back: number } | null = null;
    for (const i of items) {
      if (i.section !== "facts" && i.section !== "decisions" && i.section !== "goals") continue;
      const ts = stems(i.text);
      if (!ts.size) continue;
      const shared = [...claim].filter((t) => ts.has(t)).length;
      const cover = shared / claim.size;
      const back = shared / ts.size;
      if (!best || cover + back > best.cover + best.back) best = { item: i, cover, back };
    }
    if (best && best.cover >= 0.5) {
      const same = best.cover >= 0.85 && best.back >= 0.85 && negated === NEGATION.test(best.item.text);
      const low = best.item.confidence !== undefined && best.item.confidence < 0.7;
      if (same && !low) return { expectation: e, status: "confirmed", evidence: best.item.ref, detail: one(best.item.text, 120) };
      return { expectation: e, status: "unknown", evidence: best.item.ref, detail: `${low ? "only a low-confidence statement" : "a similar but not identical statement"}: "${one(best.item.text, 120)}" — compare the wording` };
    }
    return { expectation: e, status: "unknown", detail: "nothing on the current path supports or contradicts this — check it" };
  });
}

export function renderExpectations(r: ExpectationResult[]): string {
  const ok = r.filter((x) => x.status === "confirmed").length;
  const dev = r.filter((x) => x.status !== "confirmed");
  const lines = [`${ok}/${r.length} expectations confirmed.${dev.length ? " Deviations:" : " No deviations — proceed."}`];
  for (const d of dev) lines.push(`- ${d.status === "contradicted" ? "✗" : "?"} "${d.expectation}" — ${d.detail}${d.evidence ? ` [${d.evidence}]` : ""}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ the "string" (one line of work as a payload)

export interface StringPayload {
  string: string;
  head: string;
  past_constraints: { ref: string; text: string; hard?: boolean }[];
  decisions: { ref: string; question: string; taken: string | null; why?: string; confidence?: number; respectsCanon?: string[]; breaksCanon?: string[] }[];
  present_decision: StringPayload["decisions"][number] | null;
  future_checks: { ref: string; text: string; due?: string; status: "passed" | "failed" | "not run" | "no check"; hard: boolean }[];
  verdict: "valid" | "unproven" | "invalid";
  reasons: string[];
}

/**
 * One line of work (root → node) as the payload that passes from past to present to future:
 * past fixed points, the decisions taken on this line, future fixed points with their check status,
 * and a verdict. Invalid = a hard canon event is broken or its check failed.
 */
export function stringPayload(s: Scenaria, at?: string): StringPayload {
  const head = at ?? s.store.readState().head;
  if (!head) throw new Error("No nodes yet.");
  const path = s.path(head);
  const cs = canonState(s.store);
  const canon = cs.events.filter((k) => k.status === "active");
  const decisions = path
    .map((n, i) => ({ n, next: path[i + 1] }))
    .filter(({ n }) => n.type === "decision")
    .map(({ n, next }) => ({
      ref: n.id,
      question: one(n.question ?? n.title, 160),
      taken: optionLabel(n, next?.viaOption ?? n.chosen) ?? null,
      why: n.rationale ? one(n.rationale, 160) : undefined,
      confidence: n.confidence,
      respectsCanon: n.respectsCanon,
      breaksCanon: n.breaksCanon,
    }));
  const reasons: string[] = [];
  const notes: string[] = [];
  const onLine = new Set(path.map((n) => n.id));
  // A check result counts for this line only if it ran on a node of this line with a clean tree.
  const checkOf = (k: (typeof canon)[number]) => (k.lastCheck && k.lastCheck.node && onLine.has(k.lastCheck.node) && k.lastCheck.clean ? k.lastCheck.status : undefined);
  const broken = new Set(path.flatMap((n) => n.breaksCanon ?? []));
  for (const k of canon) {
    if (!broken.has(k.id)) continue;
    const by = path.filter((n) => n.breaksCanon?.includes(k.id)).map((n) => n.id).join(", ");
    if (k.hard) reasons.push(`hard canon ${k.id} is broken on this line (${by})`);
    else notes.push(`soft canon ${k.id} is broken on this line (${by})`);
  }
  const future = canon
    .filter((k) => k.kind === "future")
    .map((k) => {
      const st = checkOf(k);
      return { ref: k.id, text: k.text, due: k.due, hard: k.hard, status: (st ?? (k.check ? "not run" : "no check")) as StringPayload["future_checks"][number]["status"] };
    });
  for (const f of future) if (f.status === "failed" && f.hard) reasons.push(`future canon ${f.ref} failed its check on this line`);
  for (const k of canon.filter((x) => x.kind === "past" && x.hard && checkOf(x) === "failed")) reasons.push(`past canon ${k.id} failed its check on this line`);
  const tampered = cs.events.filter((k) => k.status === "tampered").map((k) => k.id);
  const untrusted = cs.events.filter((k) => k.status === "untrusted").map((k) => k.id);
  const unproven = future.filter((f) => f.status !== "passed" && f.hard).map((f) => f.ref);
  const checkTampered = canon.filter((k) => k.checkTampered).map((k) => k.id);
  const verdict = reasons.length ? "invalid" : unproven.length || tampered.length || untrusted.length || cs.missing.length || checkTampered.length || cs.error ? "unproven" : "valid";
  if (checkTampered.length) reasons.push(`check result of canon ${checkTampered.join(", ")} was changed outside Scenaria — run the check again`);
  if (cs.missing.length) reasons.push(`approved canon ${cs.missing.join(", ")} is missing from canon.json (deleted outside Scenaria)`);
  if (cs.error) reasons.push(`canon could not be read (${cs.error.slice(0, 160)}) — the fixed points of this line are unknown`);
  if (!reasons.length && unproven.length) reasons.push(`not yet proven on this line: ${unproven.join(", ")} (run the canon checks on this line, or confirm them in the dashboard)`);
  if (tampered.length) reasons.push(`canon ${tampered.join(", ")} changed outside Scenaria — not binding until re-approved`);
  if (untrusted.length) reasons.push(`canon ${untrusted.join(", ")} signed by an untrusted approver key — not binding until re-approved or the key is trusted`);
  reasons.push(...notes);
  return {
    string: `${path[path.length - 1].scenarioId ?? "?"} · ${path.map((n) => n.id).join("→")}`,
    head,
    past_constraints: [
      ...canon.filter((k) => k.kind === "past").map((k) => ({ ref: k.id, text: k.text, hard: k.hard })),
      ...s.rules().map((r) => ({ ref: r.id, text: r.text })),
    ],
    decisions,
    present_decision: decisions[decisions.length - 1] ?? null,
    future_checks: future,
    verdict,
    reasons,
  };
}
