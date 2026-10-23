import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { Scenaria } from "./core/engine.js";
import { findRoot } from "./core/store.js";
import { ingestClaudeTranscript } from "./ingest.js";
import { windowsHead, type StartReason } from "./core/window.js";
import { isPlausibleProject, readGlobalConfig } from "./core/global.js";
import { promptReminder } from "./core/prompts.js";
import { applyBlocks } from "./core/blocks.js";
import { agentNotice, cutBullet, cutIfDue, cutMeta, cutOnce, personNotice, sessionStartLine, tellsPerson } from "./core/windowact.js";
import type { TaskHint } from "./core/engine.js";

/**
 * Claude Code hook handlers. Contract: never block the agent, never fail
 * loudly — every error is logged to .scenaria/hook-errors.log and we exit 0.
 *
 *   user-prompt   (UserPromptSubmit)  remember the prompt as the session's task; add a one-line reminder
 *   post-tool     (PostToolUse)       AskUserQuestion / ExitPlanMode → decision nodes
 *   pre-tool      (PreToolUse: Bash)  autosave before destructive commands, flag external side effects
 *   stop          (Stop)              checkpoint at the end of a turn if files changed
 *   session-start (SessionStart)      inject a compact resume capsule
 *
 * Context window (E3a-2, core/windowact.ts): from the yellow zone on the prompt reminder carries a notice; from orange
 * the end of a turn is saved as a checkpoint; from red a checkpoint is saved at once after a tool (mid-turn) and the
 * person sees a system message. None of this ever blocks: every error is caught like any other.
 */

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  source?: string;
}

interface Session {
  sessionId?: string;
  pendingPrompt?: string;
  pendingIrreversible?: string[];
  /** The session's task (becomes a goal node with the session's first real node). */
  taskTitle?: string;
  taskGoal?: string;
  /** How Claude Code started this session (SessionStart `source`): the start reason of its first window (E3a-1). */
  startSource?: string;
  /** The transcript this session first named (E3a-2): a different path for the same session is not read. */
  transcriptPath?: string;
}

const AGENT = "claude-code";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function excerpt(s: string, max: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export const DESTRUCTIVE = [
  /\brm\s+-[a-zA-Z]*[rRf]/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/,
  /\bgit\s+restore\s+(--\S+\s+)*\.(\s|$)/,
  /\bgit\s+(stash|rebase|switch|checkout\s+-b?)\b/,
  /\bfind\b.*\s-delete\b/,
  /\b(rsync)\b.*--delete\b/,
];

export const EXTERNAL = [
  /\bgit\s+push\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)\b|--data\b|\s-d\s|--form\b|\s-F\s)/i,
  /\b(kubectl|helm)\s+(apply|delete|install|upgrade|rollout)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\bgh\s+(pr|issue|release|repo)\s+(create|merge|close|edit|delete)\b/,
  /\b(vercel|netlify|flyctl|fly|firebase|wrangler)\b.*\bdeploy\b/,
  /\bdocker\s+push\b/,
  /\b(psql|mysql|sqlite3)\b.*\b(insert|update|delete|drop|alter|truncate)\b/i,
  /\b(sendmail|mail\s+-s)\b/,
];

export function classifyCommand(cmd: string): "destructive" | "external" | null {
  if (EXTERNAL.some((r) => r.test(cmd))) return "external";
  if (DESTRUCTIVE.some((r) => r.test(cmd))) return "destructive";
  return null;
}

/** Extract {question → answer} from an AskUserQuestion tool call, tolerating format changes. */
export function extractAnswers(input: any, response: any): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (obj: any) => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") out[k] = v;
        else if (Array.isArray(v)) out[k] = v.map(String).join(", ");
      }
    }
  };
  take(response?.answers);
  take(input?.answers);
  const asText = typeof response === "string" ? response : Array.isArray(response) ? response.map((r: any) => r?.text ?? "").join("\n") : typeof response?.content === "string" ? response.content : "";
  if (asText) {
    for (const m of asText.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)) out[m[1]] ??= m[2];
  }
  return out;
}

/** Last assistant text message from a Claude Code transcript (JSONL). */
export function lastAssistantText(transcriptPath?: string): string | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const size = statSync(transcriptPath).size;
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = (size > 4_000_000 ? raw.slice(-4_000_000) : raw).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      let e: any;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      const msg = e?.message ?? e;
      if ((e?.type === "assistant" || msg?.role === "assistant") && msg?.content) {
        const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
        const t = content
          .filter((c: any) => c?.type === "text" && c.text)
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        if (t) return t;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Turn a free-text summary into a few short output bullets. */
export function summaryToBullets(text: string, max = 6): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^#+\s*/, "").trim())
    .filter((l) => l.length > 1 && !/^```/.test(l) && !(l.endsWith(":") && l.length < 48));
  const bullets = (lines.length >= 2 ? lines : text.split(/(?<=[.!?])\s+/)).map((l) => excerpt(l, 200)).filter(Boolean);
  return bullets.slice(0, max);
}

function logError(root: string | null, err: unknown) {
  try {
    if (root) appendFileSync(`${root}/.scenaria/hook-errors.log`, `${new Date().toISOString()} ${(err as Error)?.stack ?? err}\n`);
  } catch {
    /* ignore */
  }
}

const givenTranscript = (input: HookInput) => (typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path.slice(0, 1000) : undefined);
/** A session reads only the transcript it named first (E3a-2 review M5). */
const boundTranscript = (given: string | undefined, session: Session) => (given && session.transcriptPath && given !== session.transcriptPath ? undefined : given);
const startReasonOf = (session: Session): StartReason => ({ clear: "clear", resume: "resume", compact: "compact" } as Record<string, StartReason>)[String(session.startSource ?? "")] ?? "new-session";
const windowKeyOf = (input: HookInput, transcript?: string) => `claude-code:${input.session_id ?? transcript}`;
const langOf = (): "de" | "en" => (readGlobalConfig().ui?.lang === "en" ? "en" : "de");

/** After an ordinary tool: from red on, a checkpoint at once (Kev n77). Never waits long, never throws. */
function afterTool(s: Scenaria, input: HookInput, session: Session, upd: (fn: (cur: Session) => void) => Session): string | null {
  const given = givenTranscript(input);
  const transcript = boundTranscript(given, session);
  if (!transcript) return null;
  let size: number;
  try {
    size = statSync(transcript).size;
  } catch {
    return null;
  }
  const offsets = s.store.readScratch<{ offsets: Record<string, number> }>("transcripts", { offsets: {} }).offsets ?? {};
  if (offsets[transcript] === size) return null; // nothing new since the last read: nothing to measure
  try {
    return s.store.withLock(
      () => {
        if (!session.transcriptPath) upd((cur) => (cur.transcriptPath ??= transcript));
        ingestClaudeTranscript(s, transcript, input.session_id, { startReason: startReasonOf(session) });
        const taskHint = session.taskTitle ? { key: `claude-code:${input.session_id ?? "session"}`, title: session.taskTitle, goal: session.taskGoal } : undefined;
        const { advice: adv, node } = cutIfDue(s, windowKeyOf(input, transcript), "now", { task: taskHint, source: "hook" });
        if (!adv || !node) return null;
        return JSON.stringify({
          systemMessage: personNotice(adv, node.id, langOf()),
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: agentNotice(adv, node.id) },
        });
      },
      { waitMs: 1500 },
    );
  } catch {
    return null; // busy: the next tool or the end of the turn acts
  }
}

export async function handleHook(event: string, input: HookInput): Promise<string | null> {
  const start = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let root = findRoot(process.env.CLAUDE_PROJECT_DIR || start) ?? findRoot(start);
  if (!root) {
    // Global setup: initialize real projects automatically on first use; otherwise stay out of the way.
    const candidate = process.env.CLAUDE_PROJECT_DIR || start;
    const evName = event || input.hook_event_name || "";
    if (readGlobalConfig().autoInit && (evName === "user-prompt" || evName === "UserPromptSubmit") && isPlausibleProject(candidate)) {
      try {
        Scenaria.init(candidate);
        root = candidate;
      } catch {
        return null;
      }
    } else return null;
  }
  try {
    const s = Scenaria.open(root);
    // One scratch entry per Claude Code session (parallel sessions must not overwrite each other).
    // Shared file, so every change is a read-modify-write under the lock.
    // Prefixed key: a crafted id like "__proto__" can never touch Object.prototype.
    const sid = `s:${String(input.session_id ?? "default").replace(/[^\w.-]/g, "_").slice(0, 80)}`;
    type SessionsFile = { sessions?: Record<string, Session & { touched?: string }> };
    const updSession = (fn: (cur: Session) => void): Session => {
      let out: Session = {};
      s.store.updateScratch<SessionsFile>("session", {}, (file) => {
        const all: Record<string, Session & { touched?: string }> = Object.create(null);
        if (file.sessions && typeof file.sessions === "object") for (const [k, v] of Object.entries(file.sessions)) if (k.startsWith("s:")) all[k] = v;
        const cur = all[sid] ?? {};
        fn(cur);
        all[sid] = { ...cur, touched: new Date().toISOString() };
        // Keep the 50 most recently used sessions.
        const ids = Object.keys(all).sort((a, b) => String(all[b].touched ?? "").localeCompare(String(all[a].touched ?? "")));
        for (const old of ids.slice(50)) delete all[old];
        for (const k of Object.keys(file)) if (k !== "sessions") delete (file as any)[k]; // drop the pre-0.4 single-session format
        file.sessions = { ...all };
        out = { ...all[sid] };
      });
      return out;
    };
    const readSession = (): Session => s.store.readScratch<SessionsFile>("session", {}).sessions?.[sid] ?? {};
    const name = event || input.hook_event_name || "";
    // E3a-2: after an ordinary tool (the hook runs after EVERY tool) only the context window is looked at, on a fast
    // path that holds nothing up (review 2, N1): nothing new in the transcript → nothing to do, without any lock;
    // otherwise read and act under the lock, waiting at most 1.5 s (busy → skip: the next tool or the turn's end acts).
    if ((name === "post-tool" || name === "PostToolUse") && input.tool_name !== "AskUserQuestion" && input.tool_name !== "ExitPlanMode") {
      return afterTool(s, input, readSession(), (fn) => updSession(fn));
    }
    // E3a-2 (review M5): a session's transcript is the one it named first. Someone calling the hook with the same
    // session and a transcript of their own cannot feed that session's window (the numbers become actions now).
    const given = givenTranscript(input);
    const session = updSession((cur) => {
      if (given && !cur.transcriptPath) cur.transcriptPath = given;
    });
    const transcript = boundTranscript(given, session);
    const taskKey = `claude-code:${input.session_id ?? "session"}`;
    // The conversation's key in the window records (as ingest.ts writes it).
    const windowKey = windowKeyOf(input, transcript);
    const lang = langOf;
    const startReason = startReasonOf(session);
    const task = (): TaskHint | undefined => {
      const cur = readSession();
      return cur.taskTitle ? { key: taskKey, title: cur.taskTitle, goal: cur.taskGoal } : undefined;
    };

    switch (name) {
      case "user-prompt":
      case "UserPromptSubmit": {
        const prompt = (input.prompt ?? "").trim();
        if (!prompt || prompt.startsWith("/")) break;
        // The session's task: titled after the request that leads to work (updated until the task node exists).
        s.noteTask(taskKey, excerpt(prompt, 80), excerpt(prompt, 600), { agent: "user", source: "hook" });
        const st = s.store.readState();
        const pendingHere = st.pendingTask?.key === taskKey;
        updSession((cur) => {
          cur.pendingPrompt = excerpt(prompt, 300);
          // Title the session's task after the request that leads to work (until its task node exists).
          if (pendingHere || !cur.taskTitle) {
            cur.taskTitle = excerpt(prompt, 80);
            cur.taskGoal = excerpt(prompt, 600);
          }
        });
        // Conversation overlay: catch up on the transcript, then record this prompt.
        ingestClaudeTranscript(s, transcript, input.session_id, { startReason });
        s.logMessages(
          { externalId: `claude-code:${input.session_id ?? transcript ?? "session"}`, source: "transcript", provider: "anthropic", agent: "claude-code" },
          [{ role: "user", text: prompt, agent: "claude-code" }],
          "append",
        );
        // E3a-2: the window's state after the last turn. A cut the last turn's end missed (interrupted) is made now.
        const { advice: adv, node: savedNode } = cutIfDue(s, windowKey, "turn-end", { task: task(), source: "hook" });
        const saved = savedNode?.id ?? null;
        const person = adv && saved && tellsPerson(adv) ? personNotice(adv, saved, lang()) : undefined;
        const notice = adv ? agentNotice(adv, saved) : "";
        const reminder = s.config().promptReminder !== false ? promptReminder(s) : "";
        const additionalContext = [reminder, notice].filter(Boolean).join(" ");
        if (additionalContext || person) {
          return JSON.stringify({ ...(person ? { systemMessage: person } : {}), hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } });
        }
        break;
      }

      case "post-tool":
      case "PostToolUse": {
        if (input.tool_name === "AskUserQuestion") {
          const questions: any[] = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
          const answers = extractAnswers(input.tool_input, input.tool_response);
          for (const q of questions) {
            const text = String(q?.question ?? q?.header ?? "Question");
            const answer = answers[text] ?? answers[q?.header ?? ""];
            const opts = (Array.isArray(q?.options) ? q.options : []).map((o: any) =>
              typeof o === "string" ? { label: o } : { label: String(o?.label ?? ""), description: o?.description },
            );
            if (!opts.length && !answer) continue;
            const first = answer?.split(/,\s*/)[0];
            s.decide({
              question: text,
              title: q?.header ? `${q.header}: ${excerpt(text, 120)}` : excerpt(text, 140),
              options: opts.length ? opts : [answer!],
              chosen: q?.multiSelect ? first : answer,
              rationale: answer ? `Answered by the user${q?.multiSelect && answer.includes(",") ? ` (multi-select: ${answer})` : ""}` : undefined,
              context: q?.header ? `Clarifying question (${q.header}) asked by the agent` : "Clarifying question asked by the agent",
              agent: "user",
              source: "hook",
              tags: ["clarifying-question"],
              task: task(),
            });
          }
        } else if (input.tool_name === "ExitPlanMode") {
          const plan = String(input.tool_input?.plan ?? "");
          s.decide({
            question: "Approve the implementation plan?",
            title: "Plan approved",
            options: [{ label: "Approve plan", description: excerpt(plan, 300) }, { label: "Revise plan" }],
            chosen: "Approve plan",
            rationale: "Plan approved by the user (plan mode)",
            context: "Plan mode: the agent proposed an implementation plan",
            agent: "user",
            source: "hook",
            tags: ["plan"],
            task: task(),
            meta: { plan: plan.slice(0, 6000) },
          });
        }
        // E3a-2: from red on, save at once — also in the middle of a turn (Kev n77). The newest answer is in the
        // transcript before the tool ran; reading it here is incremental.
        ingestClaudeTranscript(s, transcript, input.session_id, { startReason });
        const { advice: adv, node } = cutIfDue(s, windowKey, "now", { task: task(), source: "hook" });
        if (adv && node) {
          return JSON.stringify({
            systemMessage: personNotice(adv, node.id, lang()),
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: agentNotice(adv, node.id) },
          });
        }
        break;
      }

      case "pre-tool":
      case "PreToolUse": {
        if (input.tool_name !== "Bash") break;
        const cmd = String(input.tool_input?.command ?? "");
        const kind = classifyCommand(cmd);
        if (!kind) break;
        if (kind === "external") {
          updSession((cur) => {
            cur.pendingIrreversible = [...(cur.pendingIrreversible ?? []), excerpt(cmd, 160)];
          });
        }
        s.checkpoint({
          title: `Before ${kind === "external" ? "external action" : "risky command"}: ${excerpt(cmd, 90)}`,
          type: "autosave",
          onlyIfChanged: true,
          agent: AGENT,
          source: "hook",
          task: task(),
        });
        break;
      }

      case "stop":
      case "Stop": {
        // Record the turn's conversation first, so it links to the state it led away from.
        ingestClaudeTranscript(s, transcript, input.session_id, { startReason });
        const irreversible = session.pendingIrreversible ?? [];
        const summary = lastAssistantText(transcript);
        // Decisions written as ```scenaria blocks (agents without MCP tools).
        if (summary?.includes("```scenaria")) applyBlocks(s, summary, { agent: AGENT, source: "hook" }, task());
        const transcriptTokens = transcript && existsSync(transcript) ? Math.round(statSync(transcript).size / 4) : undefined;
        // E3a-2: from orange on, this turn's end is saved even without a file change (a clean cut before the change).
        // Check and write under one lock (parallel hooks cut once). A cut that saved nothing new is Scenaria's own.
        const { advice: cutAdv, node, cut: didCut } = cutOnce(s, windowKey, "turn-end", (adv, due) => {
          const cut = due ? adv : null;
          const quiet = Boolean(cut) && irreversible.length === 0 && Boolean(s.repo) && !s.isDirty(s.head());
          return s.checkpoint({
            title: quiet ? "Saved before the window change" : session.pendingPrompt ? excerpt(session.pendingPrompt, 110) : "End of turn",
            // A quiet cut is Scenaria's record: the agent's own words go to meta, labelled as the agent's (review 2, N2).
            outputs: quiet ? [cutBullet(cut!)] : cut ? [...(summary ? summaryToBullets(summary, 5) : []), cutBullet(cut)] : summary ? summaryToBullets(summary) : undefined,
            irreversible,
            onlyIfChanged: irreversible.length === 0 && !cut,
            ...(cut ? { tags: ["context-cut"] } : {}),
            agent: quiet ? "scenaria" : AGENT,
            source: "hook",
            // The chain of window records at this turn's end (E3a-1): rewriting older window lines shows later.
            meta: (() => {
              let w: ReturnType<typeof windowsHead> = null;
              try {
                w = windowsHead(s);
              } catch {
                w = null; // an unreadable record must never cost the turn its checkpoint (E3a-1 review M1)
              }
              const m = {
                ...(transcriptTokens ? { transcriptTokens } : {}),
                ...(w ? { windows: w } : {}),
                ...(cut ? { contextCut: cutMeta(cut, "turn-end") } : {}),
                ...(quiet && summary ? { agentSummary: { agent: AGENT, outputs: summaryToBullets(summary) } } : {}),
              };
              return Object.keys(m).length ? m : undefined;
            })(),
            task: task(),
          });
        });
        if (node || irreversible.length === 0) {
          updSession((cur) => {
            cur.pendingIrreversible = (cur.pendingIrreversible ?? []).filter((x) => !irreversible.includes(x));
            cur.pendingPrompt = undefined;
          });
        }
        if (didCut && node && cutAdv && tellsPerson(cutAdv)) return JSON.stringify({ systemMessage: personNotice(cutAdv, node.id, lang()) });
        break;
      }

      case "session-start":
      case "SessionStart": {
        if (typeof input.source === "string" && input.source)
          updSession((cur) => {
            cur.startSource = String(input.source).slice(0, 20);
          });
        if (!s.config().injectContextOnSessionStart || !s.head()) break;
        const c = s.context();
        const handover = sessionStartLine(s, AGENT);
        const additionalContext = `${c.markdown}${handover ? `\n\n${handover}` : ""}\n\n(Scenaria is active: ONE project tree. New work → scenaria_start_mission (task); real choices → scenaria_decide with context, rationale, servesGoal; steps → scenaria_checkpoint; older details → scenaria_recall.)`;
        return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
      }
    }
  } catch (err) {
    logError(root, err);
  }
  return null;
}

export async function runHook(event: string) {
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  try {
    const out = await handleHook(event, input);
    if (out) process.stdout.write(out);
  } catch {
    /* never block the agent */
  }
  process.exitCode = 0;
}
