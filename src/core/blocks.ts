/**
 * Decision blocks: the capture path for LLMs WITHOUT tool calling (plain chats in
 * ChatGPT, Claude.ai, Gemini, Ollama/LM Studio UIs, …). The model is asked (see the
 * "chat" agent prompt) to append a fenced block when it decides something:
 *
 *   ```scenaria
 *   {"decision": {"question": "…", "options": ["A", "B"], "chosen": "A", "rationale": "…",
 *                 "context": "…", "servesGoal": "…", "confidence": 0.7}}
 *   ```
 *
 * Also accepted: {"task": {title, goal}}, {"checkpoint": {title, outputs, taskDone, summary}},
 * {"lesson": "…"}, {"projectGoal": "…"}, {"rule": "…"} and {"canon": {…}} (both only proposals: the
 * person approves them), or a JSON list of such items. Blocks are read from
 * proxy traffic, Claude Code transcripts and text pasted into the dashboard; each block is
 * applied once (content hash), so resent histories never duplicate decisions.
 */
import { createHash } from "node:crypto";
import type { Actor, Scenaria, TaskHint } from "./engine.js";
import type { ScenariaNode } from "./types.js";

const FENCE = /```scenaria[^\n]*\n([\s\S]*?)```/g;

export function extractBlocks(text: string): { items: any[]; errors: string[]; hashes: string[] } {
  const items: any[] = [];
  const errors: string[] = [];
  const hashes: string[] = [];
  for (const m of (text ?? "").matchAll(FENCE)) {
    const raw = m[1].trim();
    if (!raw) continue;
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      // Common LLM slip: trailing commas.
      try {
        v = JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
      } catch (err: any) {
        errors.push(`invalid JSON in scenaria block: ${String(err?.message ?? err).slice(0, 120)}`);
        continue;
      }
    }
    const list = Array.isArray(v) ? v : [v];
    for (const it of list) {
      if (it && typeof it === "object") {
        items.push(it);
        hashes.push(createHash("sha1").update(JSON.stringify(it)).digest("hex").slice(0, 16));
      }
    }
  }
  return { items, errors, hashes };
}

const strList = (x: unknown) => (Array.isArray(x) ? x.map(String).filter((s) => s.trim()) : typeof x === "string" && x.trim() ? [x] : undefined);

/** Apply the blocks in `text`. Already applied blocks are skipped. */
export function applyBlocks(s: Scenaria, text: string, actor: Actor = {}, task?: TaskHint): { created: ScenariaNode[]; errors: string[]; skipped: number } {
  const { items, errors, hashes } = extractBlocks(text);
  const created: ScenariaNode[] = [];
  if (!items.length) return { created, errors, skipped: 0 };
  // Claim the hashes first (under the lock) so concurrent readers of the same text apply nothing twice.
  const fresh = new Set<number>();
  s.store.updateScratch<{ seen: string[] }>("blocks", { seen: [] }, (cur) => {
    const seen = new Set(cur.seen ?? []);
    hashes.forEach((h, i) => {
      if (!seen.has(h)) {
        fresh.add(i);
        seen.add(h);
      }
    });
    cur.seen = [...seen].slice(-2000);
  });
  const failed: string[] = [];
  items.forEach((it, i) => {
    if (!fresh.has(i)) return;
    const before = errors.length;
    try {
      const type = String(it.type ?? Object.keys(it).find((k) => ["decision", "task", "checkpoint", "lesson", "projectGoal", "rule", "canon"].includes(k)) ?? "");
      const body = it[type] !== undefined && typeof it[type] === "object" && !Array.isArray(it[type]) ? it[type] : it;
      switch (type) {
        case "decision": {
          const options = Array.isArray(body.options) ? body.options : [];
          if (!body.question || !options.length) throw new Error("decision needs question and options");
          created.push(
            s.decide({
              question: String(body.question),
              options: options.map((o: any) => (typeof o === "string" ? o : { label: String(o?.label ?? ""), description: o?.description })),
              chosen: body.chosen,
              rationale: body.rationale,
              context: body.context,
              servesGoal: body.servesGoal ?? body.serves_goal,
              expectedOutcome: body.expectedOutcome ?? body.expected,
              confidence: typeof body.confidence === "number" ? body.confidence : undefined,
              assumptions: strList(body.assumptions),
              basedOn: strList(body.basedOn),
              respectsCanon: strList(body.respectsCanon),
              breaksCanon: strList(body.breaksCanon),
              tags: ["from-chat"],
              ...actor,
              task,
            }),
          );
          break;
        }
        case "task": {
          if (!body.title) throw new Error("task needs a title");
          created.push(s.startMission({ title: String(body.title), goal: body.goal, brief: body.brief, ...actor, key: task?.key }));
          break;
        }
        case "checkpoint": {
          const n = s.checkpoint({
            title: String(body.title ?? "Step done"),
            outputs: strList(body.outputs),
            facts: Array.isArray(body.facts)
              ? body.facts.map((f: any) => (f && typeof f === "object" ? { text: String(f.text ?? ""), confidence: typeof f.confidence === "number" ? f.confidence : undefined, basedOn: strList(f.basedOn) } : String(f)))
              : strList(body.facts),
            basedOn: strList(body.basedOn),
            openQuestions: strList(body.openQuestions),
            irreversible: strList(body.irreversible),
            fulfills: strList(body.fulfills),
            taskDone: Boolean(body.taskDone),
            summary: body.summary,
            tags: ["from-chat"],
            ...actor,
            task,
          });
          if (n) created.push(n);
          break;
        }
        case "lesson": {
          const text = typeof it.lesson === "string" ? it.lesson : String(body.text ?? "");
          const head = s.head();
          if (head && text.trim()) created.push(s.update(head.id, { lessons: [...(head.lessons ?? []), text.trim()] }));
          break;
        }
        case "projectGoal": {
          const g = typeof it.projectGoal === "string" ? it.projectGoal : String(body.text ?? "");
          if (g.trim()) created.push(s.setProjectGoal(g, actor));
          break;
        }
        case "canon": {
          // From a chat: always a proposal; the user approves it in the dashboard.
          s.proposeCanon({ kind: body.kind === "future" ? "future" : "past", text: String(body.text ?? ""), due: body.due, evidence: strList(body.evidence), task: typeof body.task === "string" ? body.task : undefined, weight: typeof body.weight === "number" ? body.weight : undefined, artifact: typeof body.artifact === "string" ? body.artifact : undefined }, actor);
          break;
        }
        case "rule": {
          // From a chat: always a proposal; the person accepts it in the dashboard (security rule 5).
          const r = typeof it.rule === "string" ? it.rule : String(body.text ?? "");
          if (r.trim()) s.proposeRule(r, { by: actor.agent });
          break;
        }
        default:
          errors.push(`unknown scenaria block (expected decision, task, checkpoint, lesson, projectGoal or rule)`);
      }
    } catch (err: any) {
      errors.push(String(err?.message ?? err));
    }
    if (errors.length > before) failed.push(hashes[i]);
  });
  // A block that could not be applied (e.g. store busy) may be retried with the same text.
  if (failed.length) {
    try {
      s.store.updateScratch<{ seen: string[] }>("blocks", { seen: [] }, (cur) => {
        cur.seen = (cur.seen ?? []).filter((h) => !failed.includes(h));
      });
    } catch {}
  }
  return { created, errors, skipped: items.length - fresh.size };
}
