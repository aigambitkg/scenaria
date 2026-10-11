/**
 * Ready-to-paste prompts, so nobody has to explain Scenaria to an agent by hand.
 *
 *   mcp  — agents with MCP tools (Claude Code, Cursor, Codex, Gemini CLI, Windsurf, VS Code, …)
 *   cli  — agents that can run shell commands but have no MCP (scenaria call … / HTTP)
 *   chat — plain chats without tools (ChatGPT, Claude.ai, Gemini, Ollama / LM Studio UIs):
 *          the model appends ```scenaria blocks, which the proxy or the dashboard picks up.
 *
 * Plus the one-line reminder Claude Code gets with every prompt (≈60 tokens).
 */
import type { Scenaria } from "./engine.js";
import { nearestGoal } from "./context.js";
import { readCanon, renderCanon } from "./canon.js";

export type PromptKind = "mcp" | "cli" | "chat";
export type Lang = "de" | "en";

function oneLine(s: string | undefined, max: number) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function situation(s: Scenaria) {
  const root = s.project();
  const st = s.store.readState();
  const head = st.head && s.store.hasNode(st.head) ? s.store.readNode(st.head) : null;
  const task = head ? nearestGoal(s.path(head.id)) : null;
  return {
    project: s.config().projectName,
    goal: root?.goal,
    head: head ? `${head.id}${head.scenarioId ? ` (${head.scenarioId}/v${head.version})` : ""}` : null,
    task: task ? `${task.id} „${oneLine(task.title, 80)}“` : null,
    rules: s.rules().slice(0, 8),
  };
}

export function agentPrompt(s: Scenaria, opts: { kind?: PromptKind; lang?: Lang; withContext?: boolean } = {}): string {
  const kind = opts.kind ?? "mcp";
  const de = (opts.lang ?? "de") === "de";
  const x = situation(s);
  const lines: string[] = [];

  const header = de
    ? [
        `Für dieses Projekt ist Scenaria aktiv – das gemeinsame Entscheidungs- und Versionsgedächtnis. Nutze es die ganze Sitzung über von selbst, ohne dass ich dich erinnern muss.`,
        ``,
        `Projekt: ${x.project}`,
        `Hauptziel: ${x.goal ? oneLine(x.goal, 400) : "(noch nicht festgelegt – frag mich danach und halte es fest)"}`,
        x.head ? `Aktueller Stand: ${x.head}${x.task ? ` · Teilziel ${x.task}` : ""}` : ``,
      ]
    : [
        `Scenaria is active for this project – the shared decision and version memory. Use it on your own for the whole session; I will not remind you.`,
        ``,
        `Project: ${x.project}`,
        `Main goal: ${x.goal ? oneLine(x.goal, 400) : "(not set yet – ask me and record it)"}`,
        x.head ? `Current state: ${x.head}${x.task ? ` · task ${x.task}` : ""}` : ``,
      ];
  lines.push(...header.filter((l, i) => l !== "" || i === 1));

  if (kind === "mcp" || kind === "cli") {
    const call = (tool: string, args: string) =>
      kind === "mcp" ? `${tool} ${args}` : `\`scenaria call ${tool} '${args.replace(/'/g, "’")}'\``;
    const steps = de
      ? [
          `1. Zu Beginn: ${call("scenaria_status", "{}")} und ${call("scenaria_context", "{}")}. Es gibt genau EINEN Projektbaum – lege nie einen neuen an.`,
          x.goal ? null : `   Hauptziel fehlt → frag mich und speichere es mit ${call("scenaria_start_mission", '{"projectGoal": "…"}')}.`,
          `2. Neue Aufgabe → ${call("scenaria_start_mission", '{"title": "…", "goal": "…"}')} (Teilziel im bestehenden Baum).`,
          `3. Vor jeder echten Entscheidung → ${call("scenaria_decide", '{"question", "options" (alle erwogenen), "chosen", "rationale", "context", "servesGoal", "expectedOutcome", "confidence" 0–1}')}. context = Ausgangslage, servesGoal = wie es dem Hauptziel dient.`,
          `4. Nach jedem sinnvollen Schritt → ${call("scenaria_checkpoint", '{"title", "outputs": [2–6 belegte Stichpunkte, Dateien in `Backticks`], "irreversible": [externe Effekte]}')}. Aufgabe fertig → zusätzlich "taskDone": true, "summary": "1–2 Sätze".`,
          `5. Fehler oder Sackgasse → ${call("scenaria_last_good", "{}")}, dann ${call("scenaria_rewind", '{"id", "lesson"}')} und nur ab der zurückgegebenen Kapsel weiterarbeiten. Andere Option probieren → scenaria_fork.`,
          `6. Ältere Details → ${call("scenaria_recall", '{"query": "…"}')} statt lange Verläufe neu zu lesen. Verweise per Referenz (n12, n12.f2, r3) statt Inhalte zu kopieren; auflösen mit ${call("scenaria_get_node", '{"refs": ["n12.f2"]}')}.`,
          `7. Übernimmst du Arbeit von einem anderen Agenten/einer anderen Sitzung → ${call("scenaria_workspace", '{"reader": "<dein Name>"}')} (nur was du noch nicht kennst), dann ${call("scenaria_expect", '{"expectations": ["n12 done", "…"]}')} mit deinen Annahmen – prüfe nur die gemeldeten Abweichungen.`,
          `8. Unsichere Fakten mit Konfidenz festhalten: {"text": "…", "confidence": 0.6}. Einträge knapp, keine unbelegten Fakten.`,
          `9. Kanon-Events (k1, k2 …) sind die Fixpunkte des Projekts: prüfe jede Entscheidung dagegen (respectsCanon); einen zu brechen braucht breaksCanon + Begründung. Neuen Fixpunkt erkannt → ${call("scenaria_canon", '{"action": "propose", "kind": "past|future", "text": "…"}')} – gültig wird er erst nach meiner Freigabe.`,
        ]
      : [
          `1. At the start: ${call("scenaria_status", "{}")} and ${call("scenaria_context", "{}")}. There is exactly ONE project tree – never start a new one.`,
          x.goal ? null : `   Main goal missing → ask me and store it with ${call("scenaria_start_mission", '{"projectGoal": "…"}')}.`,
          `2. New piece of work → ${call("scenaria_start_mission", '{"title": "…", "goal": "…"}')} (a task in the existing tree).`,
          `3. Before every real decision → ${call("scenaria_decide", '{"question", "options" (all considered), "chosen", "rationale", "context", "servesGoal", "expectedOutcome", "confidence" 0–1}')}. context = the situation, servesGoal = how it serves the main goal.`,
          `4. After each meaningful step → ${call("scenaria_checkpoint", '{"title", "outputs": [2–6 verified bullets, files in `backticks`], "irreversible": [external effects]}')}. Task finished → also "taskDone": true, "summary": "1–2 sentences".`,
          `5. Mistake or dead end → ${call("scenaria_last_good", "{}")}, then ${call("scenaria_rewind", '{"id", "lesson"}')} and continue only from the returned capsule. Try another option → scenaria_fork.`,
          `6. Older details → ${call("scenaria_recall", '{"query": "…"}')} instead of re-reading long histories. Refer by reference (n12, n12.f2, r3) instead of copying content; resolve with ${call("scenaria_get_node", '{"refs": ["n12.f2"]}')}.`,
          `7. Taking over from another agent or session → ${call("scenaria_workspace", '{"reader": "<your name>"}')} (only what you do not know yet), then ${call("scenaria_expect", '{"expectations": ["n12 done", "…"]}')} with your assumptions — check only the reported deviations.`,
          `8. Record uncertain facts with a confidence: {"text": "…", "confidence": 0.6}. Keep entries short; never record unverified facts.`,
          `9. Canon events (k1, k2 …) are the project's fixed points: check every decision against them (respectsCanon); breaking one needs breaksCanon + a rationale. New fixed point noticed → ${call("scenaria_canon", '{"action": "propose", "kind": "past|future", "text": "…"}')} — it only becomes binding after my approval.`,
        ];
    lines.push("", ...(steps.filter(Boolean) as string[]));
    if (kind === "cli") {
      lines.push(
        "",
        de
          ? `Ohne Shell geht dasselbe per HTTP: POST http://127.0.0.1:4477/api/v1/tools/<tool> mit JSON-Body (Header X-Scenaria: 1).`
          : `Without a shell use HTTP: POST http://127.0.0.1:4477/api/v1/tools/<tool> with a JSON body (header X-Scenaria: 1).`,
      );
    }
  } else {
    lines.push(
      "",
      de
        ? `Halte jede echte Entscheidung und jedes Ergebnis maschinenlesbar fest: Hänge NUR dann, wenn es etwas festzuhalten gibt, am Ende deiner Antwort einen Block in genau diesem Format an:`
        : `Record every real decision and result in machine-readable form: ONLY when there is something to record, append a block in exactly this format at the end of your answer:`,
      "",
      "```scenaria",
      de
        ? `{"decision": {"question": "…", "options": ["A", "B"], "chosen": "A", "rationale": "warum A", "context": "Ausgangslage", "servesGoal": "Bezug zum Hauptziel", "confidence": 0.7}}`
        : `{"decision": {"question": "…", "options": ["A", "B"], "chosen": "A", "rationale": "why A", "context": "the situation", "servesGoal": "link to the main goal", "confidence": 0.7}}`,
      "```",
      "",
      de
        ? `Weitere Formen (auch mehrere als JSON-Liste): {"task": {"title": "…", "goal": "…"}} bei einer neuen Aufgabe · {"checkpoint": {"title": "…", "outputs": ["…"], "taskDone": false}} nach einem Ergebnis · {"lesson": "…"} nach einem Fehler · {"canon": {"kind": "past|future", "text": "…"}} für einen neuen Fixpunkt (ich gebe ihn frei)${x.goal ? "" : ` · {"projectGoal": "…"} sobald das Hauptziel feststeht`}. Ansonsten antworte ganz normal.`
        : `Other forms (several as a JSON list): {"task": {"title": "…", "goal": "…"}} for new work · {"checkpoint": {"title": "…", "outputs": ["…"], "taskDone": false}} after a result · {"lesson": "…"} after a mistake · {"canon": {"kind": "past|future", "text": "…"}} for a new fixed point (I approve it)${x.goal ? "" : ` · {"projectGoal": "…"} once the main goal is clear`}. Otherwise answer normally.`,
    );
  }

  const canon = renderCanon(readCanon(s.store), 12);
  if (canon.length) lines.push("", de ? "Kanon-Events (Fixpunkte, nie ohne Begründung brechen):" : "Canon events (fixed points, never break them without a rationale):", ...canon);
  if (x.rules.length) {
    lines.push("", de ? "Projektregeln (immer befolgen):" : "Project rules (always follow):", ...x.rules.map((r) => `- ${r.text}`));
  }
  if (opts.withContext && s.head()) {
    const c = s.context(undefined, { budget: 900 });
    lines.push("", de ? "Bisheriger Stand (Scenaria-Kapsel):" : "Where we are (Scenaria capsule):", "", c.markdown);
  }
  return lines.join("\n");
}

/** One-line reminder added to every Claude Code prompt — keeps the agent on the single project tree. */
export function promptReminder(s: Scenaria): string {
  const x = situation(s);
  const parts = [
    `[Scenaria] project "${x.project}"`,
    x.goal ? `main goal: ${oneLine(x.goal, 140)}` : `main goal NOT set (ask the user, then scenaria_start_mission {projectGoal})`,
    x.head ? `at ${x.head}${x.task ? `, task ${x.task.replace(/[„“]/g, '"')}` : ""}` : null,
    `new task → scenaria_start_mission (adds a task to the ONE project tree); real choice → scenaria_decide with context, rationale, servesGoal; step done → scenaria_checkpoint; details → scenaria_recall.`,
  ].filter(Boolean);
  const rules = x.rules.slice(0, 3).map((r) => oneLine(r.text, 120));
  const hard = readCanon(s.store).filter((k) => k.status === "active" && k.hard).slice(0, 4).map((k) => `${k.id} ${oneLine(k.text, 90)}`);
  return parts.join(" · ") + (hard.length ? ` Canon (respect; cite in respectsCanon): ${hard.join(" | ")}.` : "") + (rules.length ? ` Rules: ${rules.join(" | ")}` : "");
}
