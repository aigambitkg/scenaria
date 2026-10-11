/**
 * The archivist with an LLM: reads the compact dossier and proposes fixed points (canon events)
 * with evidence. Any configured model works (local or API). Proposals are never binding:
 * they land as "proposed" and wait for a person's approval.
 */
import type { Scenaria } from "./engine.js";
import { callLlm, dossier, type LlmRequest } from "./analysis.js";
import { effectiveLlm, upstreams as upstreamsOf } from "./settings.js";
import { renderCanon, type CanonEvent } from "./canon.js";

function prompt(lang: "de" | "en") {
  return `You are the archivist of a software/knowledge project. From the decision history (dossier) extract FIXED POINTS ("canon events"):
- past: settled constraints every later decision must respect (platforms, languages, compliance, architecture choices that were verified or confirmed by the user).
- future: measurable milestones the work must survive (load, dates, legal deadlines, budgets) — only if the dossier states them.
Rules: only what the dossier supports, cite node ids as evidence, no duplicates of existing canon, at most 8 items, each text one short imperative or measurable sentence.
Answer ONLY with JSON: {"canon": [{"kind": "past|future", "text": "…", "due": "YYYY-MM-DD (future, optional)", "evidence": ["n12"], "why": "…"}]}
Write the text values in ${lang === "de" ? "German" : "English"}.`;
}

export async function archivistProposals(s: Scenaria, req: Partial<LlmRequest> & { lang?: "de" | "en" } = {}): Promise<{ proposed: CanonEvent[]; skipped: number; model: string }> {
  const cfg = effectiveLlm(s, "archivist", req);
  if (!cfg) throw new Error("No model configured — choose one in Settings (or pass provider and model).");
  const upstreams = upstreamsOf(s);
  const lang = req.lang === "de" ? "de" : "en";
  const existing = renderCanon(s.canon(), 40).join("\n") || "(none)";
  const d = dossier(s, { maxTokens: 6000 });
  const out = await callLlm(cfg, upstreams, prompt(lang), `EXISTING CANON:\n${existing}\n\n--- DOSSIER ---\n${d.text}`);
  const text = out.text;
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let items: any[] = [];
  try {
    items = JSON.parse(raw)?.canon ?? [];
  } catch {
    throw new Error("The model did not return the expected JSON.");
  }
  const proposed: CanonEvent[] = [];
  let skipped = 0;
  for (const it of Array.isArray(items) ? items.slice(0, 8) : []) {
    try {
      const before = s.canon().length;
      const ev = s.proposeCanon(
        { kind: it?.kind === "future" ? "future" : "past", text: String(it?.text ?? ""), due: typeof it?.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.due) ? it.due : undefined, evidence: Array.isArray(it?.evidence) ? it.evidence.map(String).filter((x: string) => /^n\d+/.test(x)) : undefined },
        { agent: `archivist:${out.model}`, archivist: true },
      );
      if (s.canon().length > before) proposed.push(ev);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { proposed, skipped, model: out.model };
}
