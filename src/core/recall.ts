/**
 * Recall: keyword search over the whole project memory (decisions, checkpoints,
 * tasks, lessons and conversations). Lets agents fetch old details on demand
 * instead of carrying long histories in every prompt — the capsule stays small.
 * Pure BM25, no embeddings, no network, no extra dependency.
 */
import type { ConversationMessage, ScenariaNode } from "./types.js";
import { optionLabel } from "./context.js";

export interface RecallHit {
  kind: "node" | "message";
  id: string;
  type?: string;
  label?: string;
  title: string;
  snippet: string;
  score: number;
  /** false = on another branch than HEAD (an alternative or abandoned attempt). */
  onPath?: boolean;
  ts?: string;
}

const STOP = new Set(
  "the a an and or of to in on for with is are was were be by as at it this that from not no but if then so we you i de der die das und oder ein eine einer zu im in am an auf für mit ist sind war wie was wer nicht kein keine aber wenn dann so wir ich du es den dem des sich auch noch nur als".split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}_.-]+/gu) ?? [])
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOP.has(t));
}

export function nodeText(n: ScenariaNode): string {
  // Hand-edited step files can hold a field of the wrong type: never throw on it (E1a review K1).
  const arr = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
  return [
    n.title,
    n.goal,
    n.summary,
    n.question,
    ...arr(n.options).map((o) => (o && typeof o === "object" ? `${o.label ?? ""} ${o.description ?? ""}` : String(o ?? ""))),
    n.rationale,
    n.context,
    n.servesGoal,
    n.expectedOutcome,
    ...arr(n.assumptions),
    ...arr(n.facts),
    ...arr(n.outputs),
    ...arr(n.openQuestions),
    ...arr(n.lessons),
    ...arr(n.irreversible),
    ...arr(n.changedFiles),
    n.verification && typeof n.verification === "object" ? n.verification.notes : undefined,
  ]
    .filter(Boolean)
    .join(" \n ");
}

function snippet(text: string, terms: string[], max = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  const low = one.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || one.length <= max) return one.slice(0, max) + (one.length > max ? "…" : "");
  const start = Math.max(0, at - 50);
  return (start ? "…" : "") + one.slice(start, start + max) + (start + max < one.length ? "…" : "");
}

export function recall(
  nodes: ScenariaNode[],
  messages: ConversationMessage[],
  query: string,
  opts: { limit?: number; pathIds?: Set<string>; includeMessages?: boolean } = {},
): RecallHit[] {
  const terms = Array.from(new Set(tokenize(query)));
  if (!terms.length) return [];
  type Doc = { hit: Omit<RecallHit, "score" | "snippet">; text: string; toks: string[]; boost: number };
  const docs: Doc[] = nodes.map((n) => {
    const text = nodeText(n);
    let title = n.type === "decision" ? `${n.question ?? n.title} → ${optionLabel(n, n.chosen) ?? "open"}` : n.title;
    if (title.length > 160) title = title.slice(0, 159) + "…";
    return {
      hit: { kind: "node", id: n.id, type: n.type, label: n.scenarioId ? `${n.scenarioId}/v${n.version}` : undefined, title, onPath: opts.pathIds ? opts.pathIds.has(n.id) : undefined, ts: n.createdAt },
      text,
      toks: tokenize(text),
      boost: n.type === "decision" || n.type === "goal" ? 1.4 : (n.lessons?.length ? 1.3 : 1.1),
    };
  });
  if (opts.includeMessages !== false) {
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (!m.text?.trim()) continue;
      docs.push({
        hit: { kind: "message", id: m.id, type: m.role, title: `${m.role} · ${m.sessionId}${m.headAt ? ` @ ${m.headAt}` : ""}`, onPath: opts.pathIds && m.headAt ? opts.pathIds.has(m.headAt) : undefined, ts: m.ts },
        text: m.text,
        toks: tokenize(m.text.slice(0, 20_000)),
        boost: 1,
      });
    }
  }
  if (!docs.length) return [];
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.toks.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.toks.some((x) => x === t || x.startsWith(t))).length);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs
    .map((d) => {
      let score = 0;
      for (const t of terms) {
        const n = df.get(t) ?? 0;
        if (!n) continue;
        // Prefix matches count (decision ↔ decisions, deploy ↔ deployment) at a discount.
        let tf = 0;
        for (const x of d.toks) tf += x === t ? 1 : x.startsWith(t) ? 0.6 : 0;
        if (!tf) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.toks.length) / avg)));
      }
      if (score > 0) score *= d.boost * (d.hit.onPath ? 1.1 : 1);
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, Number.isFinite(opts.limit) ? Number(opts.limit) : 8)));
  return scored.map(({ d, score }) => ({ ...d.hit, score: Math.round(score * 100) / 100, snippet: snippet(d.text, terms) }));
}

export function renderRecall(hits: RecallHit[]): string {
  if (!hits.length) return "No matches. Try other keywords (file names, option labels, error words).";
  return hits
    .map((h) => {
      const where = h.onPath === false ? " (other branch)" : "";
      const head = h.kind === "node" ? `${h.id} [${h.type}${h.label ? ` ${h.label}` : ""}]${where} ${h.title}` : `${h.id} [${h.title}]${where}`;
      return `- ${head}\n  ${h.snippet}`;
    })
    .join("\n");
}
