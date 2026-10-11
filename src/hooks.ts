import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { Scenaria } from "./core/engine.js";
import { findRoot } from "./core/store.js";
import { ingestClaudeTranscript } from "./ingest.js";
import { isPlausibleProject, readGlobalConfig } from "./core/global.js";

/**
 * Claude Code hook handlers. Contract: never block the agent, never fail
 * loudly — every error is logged to .scenaria/hook-errors.log and we exit 0.
 *
 *   user-prompt   (UserPromptSubmit)  remember the prompt; auto-start a mission
 *   post-tool     (PostToolUse)       AskUserQuestion / ExitPlanMode → decision nodes
 *   pre-tool      (PreToolUse: Bash)  autosave before destructive commands, flag external side effects
 *   stop          (Stop)              checkpoint at the end of a turn if files changed
 *   session-start (SessionStart)      inject a compact resume capsule
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
    // Session scratch is shared by parallel hook processes → always read-modify-write under the lock.
    const updSession = (fn: (cur: Session) => void) => s.store.updateScratch<Session>("session", {}, fn);
    const session = updSession((cur) => {
      if (input.session_id && cur.sessionId !== input.session_id) {
        cur.sessionId = input.session_id;
        cur.pendingIrreversible = [];
        cur.pendingPrompt = undefined;
      }
    });
    const name = event || input.hook_event_name || "";

    switch (name) {
      case "user-prompt":
      case "UserPromptSubmit": {
        const prompt = (input.prompt ?? "").trim();
        if (!prompt || prompt.startsWith("/")) break;
        s.claimMission(excerpt(prompt, 80), excerpt(prompt, 600), { agent: "user", source: "hook" });
        updSession((cur) => {
          cur.pendingPrompt = excerpt(prompt, 300);
        });
        // Conversation overlay: catch up on the transcript, then record this prompt.
        ingestClaudeTranscript(s, input.transcript_path, input.session_id);
        s.logMessages(
          { externalId: `claude-code:${input.session_id ?? input.transcript_path ?? "session"}`, source: "transcript", provider: "anthropic", agent: "claude-code" },
          [{ role: "user", text: prompt, agent: "claude-code" }],
          "append",
        );
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
              agent: "user",
              source: "hook",
              tags: ["clarifying-question"],
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
            agent: "user",
            source: "hook",
            tags: ["plan"],
            meta: { plan: plan.slice(0, 6000) },
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
        });
        break;
      }

      case "stop":
      case "Stop": {
        // Record the turn's conversation first, so it links to the state it led away from.
        ingestClaudeTranscript(s, input.transcript_path, input.session_id);
        const irreversible = session.pendingIrreversible ?? [];
        const summary = lastAssistantText(input.transcript_path);
        const transcriptTokens = input.transcript_path && existsSync(input.transcript_path) ? Math.round(statSync(input.transcript_path).size / 4) : undefined;
        const node = s.checkpoint({
          title: session.pendingPrompt ? excerpt(session.pendingPrompt, 110) : "End of turn",
          outputs: summary ? summaryToBullets(summary) : undefined,
          irreversible,
          onlyIfChanged: irreversible.length === 0,
          agent: AGENT,
          source: "hook",
          meta: transcriptTokens ? { transcriptTokens } : undefined,
        });
        if (node || irreversible.length === 0) {
          updSession((cur) => {
            cur.pendingIrreversible = (cur.pendingIrreversible ?? []).filter((x) => !irreversible.includes(x));
            cur.pendingPrompt = undefined;
          });
        }
        break;
      }

      case "session-start":
      case "SessionStart": {
        if (!s.config().injectContextOnSessionStart || !s.head()) break;
        const c = s.context();
        const body = c.markdown.length > 3500 ? c.markdown.slice(0, 3500) + "\n…" : c.markdown;
        const additionalContext = `${body}\n\n(Scenaria is active: use scenaria_decide at decision points, scenaria_checkpoint after steps, scenaria_rewind/fork to go back.)`;
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
