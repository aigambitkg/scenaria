#!/usr/bin/env node
import { showFolderCommand } from "./core/folders.js";
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { Scenaria } from "./core/engine.js";
import { Store, resolveRoot } from "./core/store.js";
import { optionLabel } from "./core/context.js";
import { agentPrompt, type PromptKind } from "./core/prompts.js";
import { recall, renderRecall } from "./core/recall.js";
import { applyBlocks } from "./core/blocks.js";
import { SECTIONS, checkExpectations, renderExpectations, renderWorkspace, resolveRefs, stringPayload, workspace, type Section } from "./core/workspace.js";
import { publicKeyId, renderCanon } from "./core/canon.js";
import { addAuditor, auditorKeygen, buildAuditorRequest, listAuditors, normalizePub, removeAuditor, signAuditorRequest } from "./core/auditors.js";
import { dossier, analysisPrompt, projectMetrics, renderMetrics, runAnalysis } from "./core/analysis.js";
import { progressForAgents, projectProgress, renderProgress } from "./core/progress.js";
import { renderWindows, windowsForAgents, windowStatus } from "./core/window.js";
import { liftStop, renderWindowProgress, stopState, windowProgress, windowProgressForAgents } from "./core/windowprogress.js";
import { prepareHandover } from "./core/windowact.js";
import { checkModels, checkProgress, checkValues, CONTEXT_BOUNDS, CONTEXT_DEFAULTS, describeSettings, PROGRESS_BOUNDS, PROGRESS_DEFAULTS, readContextSettings, setContextSettings, type ContextValues, type ProgressValues } from "./core/contextsettings.js";
import { normaliseModel } from "./core/models.js";
import type { ScenariaNode } from "./core/types.js";
import { isUnconfirmedPass, verdictOrigin } from "./core/verdict.js";
import { buildAuditFile, parsePeriod } from "./core/auditfile.js";
import { AUDIT_ACCESS_MODES, readAuditAccess, setAuditAccess, type AuditAccessMode } from "./core/auditaccess.js";

const HELP = `Scenaria — quicksave & checkpoints for AI agents (any LLM, any framework)

Usage: scenaria <command> [options]

Quick start
  start [--for <targets>] [--no-open] [--no-watch] [--port 4477]
                                        One command: init, auto-detect & wire your agents, dashboard + proxy + auto-save
  setup --global [--for <targets>]      Register Scenaria once for ALL projects (user-level agent configs)
  launcher [--to <folder>]              A start icon to double-click (desktop by default): starts Scenaria
                                        for this project without typing a command; a second click reuses it

Setup
  init [--for <targets>] [--no-rules]   Initialize .scenaria/ and wire agents:
                                        claude, claude-desktop, cursor, vscode, gemini, codex, windsurf,
                                        generic, all (all = every agent except the Claude Desktop app)
  ui [--port 4477] [--no-open] [--print-approval-link]
                                        Dashboard / scenario map (local only). The approval link goes to your
                                        browser; --print-approval-link only on a machine without a browser
  serve [--host 0.0.0.0] [--port 4477] [--token ..]
                                        Dashboard + HTTP API for teams (token required off-localhost)
  mcp                                   MCP server (stdio) for any MCP client
  watch [--interval 3] [--quiet 15]     Auto-save whenever files change (agents without MCP/hooks)

Record (one project tree: n0 = project + main goal, tasks hang on the line)
  goal ["<main goal>"]                  Show or set the project's main goal
  task "<title>" [--goal ..] [--brief ..]   Start a task (alias: mission)
  decide "<question>" -o A -o B [--chosen A] [--why ..] [--context ..] [--serves ..] [--expect ..]
         [--assume ..] [--confidence 0.8]
  choose <decisionId> <option> [--why ..]
  checkpoint "<title>" [--out ..] [--fact ..] [--open ..] [--irreversible ..] [--if-changed] [--done [--summary ..]]

Navigate
  status | tree [id] [--full] | show <id> | context [id] [--budget 1500]
  recall "<keywords>" [--limit 8]       Search decisions, lessons, tasks and conversations

Context integrity & handoffs
  fidelity [id]                         Context fidelity (0–100 %) along the path to a node, with breaks/drift/manipulation
  integrity [--reseal]                  Ledger check: nodes changed outside Scenaria, deleted or replaced ledger, reseals
                                        (--reseal: accept the current state, keep the old ledger — the person only, interactive)
  workspace [--sections facts,decisions] [--reader <name>] [--full]
                                        Shared board; with --reader only what that reader does not know yet
  resolve <ref> [<ref> …]               Resolve references (n12, n12.f2, n9.q1, r3)
  expect "<assumption>" […]             Check assumptions; prints only deviations
  string [id]                           One line of work as a payload: past constraints, decisions, future checks, verdict

Canon events (fixed points; agents only propose — you approve)
  canon [list]                          Active fixed points and open proposals
  canon add --past|--future "<text>" [--check "<cmd>"] [--due YYYY-MM-DD] [--soft]
            [--task n12 --weight 1-100 --artifact <path>]   (future + task = completion criterion)
  canon approve|reject|retire <id> [--why ..] [--weight 1-100]   (interactive terminal or dashboard only)
  canon reweigh <id> --weight 1-100 [--why ..]   (new weight of a completion criterion)
  progress [<task>]          progress per task and for the project, with how it is computed
  window [<w>]               how full the agent's context window is (measured, not estimated)
  handover [<w>]             the prepared handover to a new context window (read-only)
  window settings [set k=v … | model <id> <tokens|remove> | reset]
                             the values of the context-window rule (setting them: the person, interactive only)
  canon suggest [--llm <provider> --model <m>]  The archivist's candidates (with --llm: stored as proposals)
  canon check [id …]                    Run the check commands of approved events (interactive only)
  canon gate [node …] [--show]          Run the checks on every line's snapshot ("surviving strings"; interactive)
  canon key                             Your approver public key (give it to teammates who should trust you)
  canon trust <public key> [--name ..]  Trust a teammate's approvals on this machine (interactive only)
  rewind <id> [--lesson ..] [--no-files]
  fork <decisionId> <option> [--lesson ..]
  diff <fromId> [toId|working]

Versions, folders & conversations
  versions [missionId]                  Every version with its ids (node, uid, scenario/version, snapshot, folder)
  open <id> [--copy-to <dir>] [--print] [--rebuild]
                                        Open a version's snapshot folder (or copy it out as a writable folder)
  mirror [--enable|--disable]           Publish refs/scenaria/* into the project's own git repo
  conversations                         Recorded conversations (all providers)
  conversation <id>                     Print one conversation
  import <file> [--format auto|chatgpt|claude-ai|claude-code|openai|jsonl]
                                        Import chat history (ChatGPT/Claude.ai exports, transcripts, message lists)
  log-message --role user|assistant --text ".." [--session <id>] [--title ..]
                                        Record a message from any tool

Prompts, analysis & rules
  prompt [--kind mcp|cli|chat] [--lang de|en] [--with-context]
                                        Ready-to-paste prompt so any agent/chat uses Scenaria on its own
  ingest-text [file|-]                  Read \`\`\`scenaria blocks from a chat answer (stdin or file)
  analyze [--llm <provider> --model <m> [--base-url ..]] [--lang de|en] [--dossier]
  relay "<question>" [--options "A|B"] [--decide]   Archivist → craftsman → oracle for one high-impact decision
  analyst [<report id>] [--scope project|line|all] [--head <node>] [--no-model] [--adopt <index>] [--out-file report.md]
                                        Expert analysis to optimise with (list · run · show a report · adopt a recommendation as rule)
  forecast --quality | --benchmark        Forecast quality: backtest against reality / test bench
  forecast --audit <f3> [--deep]          Prüf-Experte: checklist of a forecast; --deep: the skeptic checks
                                        each oracle claim against its evidence (uses your model)
  forecast --oracle-backtest [--limit 5]  Does the oracle improve forecasts? Past decisions again, as of
                                        their own time, with and without the oracle (uses your model)
  forecast [<decision> | --prompt "<text>" [--options "variant A|variant B"]] [--quick]
                                        Multiverse forecast: does each option / prompt keep the context? (no args: list + hit rate)
                                        Health check; with --llm: pattern analysis by ANY LLM (Ollama, OpenAI, Anthropic, …)
  rules [add "<rule>" | rm <id> | approve <id> | reject <id> | confirm <id>]
                                        Project rules every capsule carries (yours only, signed; agents propose)

Verify & document
  verify <id> [--status passed|warning|failed] [--notes ..] [--by ..] [--run] [--no-auto]
                                        In an interactive terminal your verdict counts (person); from an agent's
                                        shell it is recorded as self-reported and never counts as verified
  last-good [id]                        Newest step the person or a registered audit agent verified

Independent audit agents (own key outside Scenaria; only they and you can verify or reseal)
  auditor [list]                        Registered audit agents on this machine
  auditor add <public key|file> [--name ..]   Register an audit agent's public key (interactive only)
  auditor remove <id>                   Unregister (interactive only)
  auditor keygen --dir <folder>         Create a key pair for an audit agent (folder outside every project)
  auditor request verdict <id> --status passed|warning|failed [--notes ..] | auditor request reseal
                                        The payload the audit agent signs (bound to the node / the ledger, 24 h)
  auditor sign --key <pem> [file|-]     Sign a payload with an audit key (or use: openssl pkeyutl -sign -rawin)
  auditor submit [file|-]               Hand in a signed request (verdict or reseal)
  audit-file [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
                                        ISO/IEC 42001 audit file: every Annex A control with its status from this
                                        project's records, integrity warnings, approvals and reseals (whole project
                                        unless a period is given). Only the person reads it, unless they open it;
                                        --out-file <f> saves it as JSON. The setting protects the audit file, not
                                        the raw records (steps, export), which stay readable as before
  audit-file access [person|open]       Who may read the audit file (setting it: the person, interactive only)
  audit-file export [--from ..] [--to ..] [--roles-only] [--lang de|en] [--out-dir <dir>] [--no-open]
                                        Sign the audit file with your approver key (the person, interactive) and
                                        write the audit package: JSON (the evidence), a print-ready page (PDF via
                                        the browser, opened for you), Markdown and a note on how to check it
  audit-file verify [<file.json> | <package folder>]
                                        Check a signed audit file (no project needed); without a name: the newest
                                        one in this folder. For a package also the reading copies' fingerprint
  audit-file evidence [--json]          The organisation's documents per control (read like the audit file)
  audit-file evidence add --control A.2.2 --url https://… (--hash sha256:… | --doc-file <file>)
                      --role "AI officer" --name "…" --date YYYY-MM-DD [--title ..] [--notes ..]
                                        Record a document for a control (the person, interactive; signed).
                                        --doc-file only computes the hash; the file's path is never stored
  audit-file evidence rm <id> [--discard]  Remove a document (kept as a signed record of the removal);
                                        entries you did not sign are discarded
  audit-file evidence confirm <id>      Confirm a teammate's, an unsigned or a re-worded control's document
  audit-file evidence copy --from <project name or folder> [--control A.2.2]
                                        Take over the documents of another of your projects (signed anew)
  protocol                              Write .scenaria/protocol.md
  export [--format json|md] [--out-file f]  Full export for audits / BI / governance tools

Universal tool layer (same tools as MCP)
  tools [--format openai|openai-responses|anthropic|gemini|json|mcp]
                                        Function-calling schemas for any LLM API
  call <tool> ['<json args>'] [--args-file f]
                                        Run a tool from any shell-capable agent

Global: --root <dir>  --json  --agent <name>  --model <model>  --user <name>
`;

/** A Scenaria dashboard on this machine already serving the project with this key, if any. */
async function findRunning(key: string): Promise<{ url: string; otherView: boolean } | null> {
  for (let port = 4477; port < 4487; port++) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const r = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(400) });
      const h: any = await r.json();
      // Only the server that records THIS project (auto-save, agents) counts; its dashboard may show another one.
      if (h?.name === "scenaria" && h.rootKey === key) return { url, otherView: Boolean(h.viewKey && h.viewKey !== key) };
    } catch {}
  }
  return null;
}

const opts = {
  root: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  claude: { type: "boolean" },
  "no-claude-md": { type: "boolean" },
  "no-rules": { type: "boolean" },
  for: { type: "string" },
  to: { type: "string" },
  from: { type: "string" },
  launcher: { type: "boolean" },
  model: { type: "string" },
  user: { type: "string" },
  host: { type: "string" },
  token: { type: "string" },
  format: { type: "string" },
  "out-file": { type: "string" },
  control: { type: "string" },
  url: { type: "string" },
  hash: { type: "string" },
  date: { type: "string" },
  "doc-file": { type: "string" },
  discard: { type: "boolean" },
  "roles-only": { type: "boolean" },
  "out-dir": { type: "string" },
  "args-file": { type: "string" },
  interval: { type: "string" },
  quiet: { type: "string" },
  global: { type: "boolean" },
  force: { type: "boolean" },
  rebuild: { type: "boolean" },
  "no-watch": { type: "boolean" },
  "copy-to": { type: "string" },
  show: { type: "boolean" },
  print: { type: "boolean" },
  enable: { type: "boolean" },
  disable: { type: "boolean" },
  role: { type: "string" },
  text: { type: "string" },
  session: { type: "string" },
  title: { type: "string" },
  name: { type: "string" },
  port: { type: "string" },
  "no-open": { type: "boolean" },
  "print-approval-link": { type: "boolean" },
  goal: { type: "string" },
  brief: { type: "string" },
  option: { type: "string", short: "o", multiple: true },
  chosen: { type: "string" },
  why: { type: "string" },
  assume: { type: "string", multiple: true },
  confidence: { type: "string" },
  out: { type: "string", multiple: true },
  fact: { type: "string", multiple: true },
  open: { type: "string", multiple: true },
  irreversible: { type: "string", multiple: true },
  "if-changed": { type: "boolean" },
  lesson: { type: "string" },
  "no-files": { type: "boolean" },
  status: { type: "string" },
  notes: { type: "string" },
  by: { type: "string" },
  run: { type: "boolean" },
  "no-auto": { type: "boolean" },
  agent: { type: "string" },
  context: { type: "string" },
  serves: { type: "string" },
  expect: { type: "string" },
  done: { type: "boolean" },
  summary: { type: "string" },
  full: { type: "boolean" },
  budget: { type: "string" },
  kind: { type: "string" },
  lang: { type: "string" },
  "with-context": { type: "boolean" },
  llm: { type: "string" },
  options: { type: "string" },
  prompt: { type: "string" },
  quick: { type: "boolean" },
  benchmark: { type: "boolean" },
  quality: { type: "boolean" },
  audit: { type: "string" },
  deep: { type: "boolean" },
  "oracle-backtest": { type: "boolean" },
  scope: { type: "string" },
  head: { type: "string" },
  "no-model": { type: "boolean" },
  adopt: { type: "string" },
  decide: { type: "boolean" },
  "base-url": { type: "string" },
  "api-key-env": { type: "string" },
  "max-tokens": { type: "string" },
  dossier: { type: "boolean" },
  limit: { type: "string" },
  sections: { type: "string" },
  reader: { type: "string" },
  reseal: { type: "boolean" },
  key: { type: "string" },
  dir: { type: "string" },
  past: { type: "string" },
  future: { type: "string" },
  check: { type: "string" },
  due: { type: "string" },
  soft: { type: "boolean" },
  task: { type: "string" },
  weight: { type: "string" },
  artifact: { type: "string" },
} as const;

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" }
  : { dim: "", bold: "", green: "", red: "", yellow: "", cyan: "", reset: "" };

function describe(n: ScenariaNode): string {
  const lines = [`${C.bold}${n.id}${C.reset} ${C.dim}[${n.type}]${C.reset} ${n.title}`];
  if (n.goal) lines.push(`  goal: ${n.goal}`);
  if (n.type === "decision") {
    lines.push(`  question: ${n.question}`);
    for (const o of n.options ?? []) lines.push(`   ${o.id === n.chosen ? C.green + "●" : "○"} ${o.id}) ${o.label}${C.reset}${o.description ? C.dim + " — " + o.description + C.reset : ""}`);
    if (n.rationale) lines.push(`  why: ${n.rationale}`);
    if (n.confidence !== undefined) lines.push(`  confidence: ${Math.round(n.confidence * 100)} %`);
  }
  const sec = (label: string, l?: string[]) => l?.length && lines.push(`  ${label}:`, ...l.map((x) => `   - ${x}`));
  sec("assumptions", n.assumptions);
  sec("facts", n.facts);
  sec("outputs", n.outputs);
  sec("open questions", n.openQuestions);
  sec("lessons", n.lessons);
  sec("irreversible", n.irreversible);
  sec("changed files", n.changedFiles?.slice(0, 30));
  if (n.snapshot) lines.push(`  ${C.dim}snapshot ${n.snapshot.commit.slice(0, 10)} · ${n.snapshot.files} files${C.reset}`);
  if (n.verification) {
    const col = n.verification.status === "passed" ? C.green : n.verification.status === "failed" ? C.red : C.yellow;
    lines.push(`  verification: ${col}${n.verification.status}${C.reset} ${C.dim}(by ${verdictOrigin(n.verification) ?? "?"}${isUnconfirmedPass(n.verification) ? " — does not count as verified" : ""})${C.reset}${n.verification.notes ? " — " + n.verification.notes : ""}`);
    for (const c of n.verification.checks ?? []) lines.push(`   ${c.status === "passed" ? "✔" : c.status === "failed" ? "✘" : "!"} ${c.name}${c.detail ? C.dim + " — " + c.detail + C.reset : ""}`);
  }
  return lines.join("\n");
}

/** Auto-save loop: cheap fingerprint per tick, a version after a quiet period. */
function startWatch(s: Scenaria, o: { interval: number; quiet: number; agent: string; model?: string; user?: string; log: boolean }) {
  let lastPrint = "";
  let changedAt = 0;
  let saves = 0;
  const tick = () => {
    try {
      const fp = s.repo!.fingerprint();
      if (fp !== lastPrint) {
        const first = lastPrint === "";
        lastPrint = fp;
        if (!first || s.isDirty()) changedAt = Date.now();
        return;
      }
      if (changedAt && Date.now() - changedAt >= o.quiet) {
        changedAt = 0;
        const n = s.autoCheckpoint({ agent: o.agent, model: o.model, user: o.user });
        if (n) {
          if (o.log) process.stdout.write(`${C.green}◆${C.reset} ${n.id} ${n.scenarioId}/v${n.version} ${n.title}\n`);
          if (++saves % 20 === 0) s.repo!.git(["gc", "--auto", "-q"], { allowFail: true });
        }
      }
    } catch (err: any) {
      process.stderr.write(`${C.yellow}! ${err?.message ?? err}${C.reset}\n`);
    }
  };
  tick();
  return setInterval(tick, o.interval);
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Pipe the text in (… | scenaria ingest-text) or pass a file.");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The person at an interactive terminal (stdin and stdout are TTYs). Agents' shells are not. */
function isPersonTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * `--print-approval-link`: only for a machine without a browser, and only the person's choice at an
 * interactive terminal with a typed confirmation (S2-1) — never from an agent's shell.
 */
async function allowPrintedApprovalLink(v: Record<string, unknown>): Promise<boolean> {
  if (!v["print-approval-link"]) return false;
  await personConfirm(
    "print",
    "Print the approval link in this terminal? Use this only on a machine without a browser: anyone who can read this terminal gets your approval rights.",
    "--print-approval-link is the person's choice: run it in an interactive terminal. Without it, Scenaria opens the approval link in your browser.",
  );
  return true;
}

/**
 * `scenaria window stop [lift --why "<reason>"]` (E4): show the stop after two full windows without progress; the
 * PERSON lifts it at an interactive terminal (typed confirmation), with a reason.
 */
async function windowStopCommand(s: Scenaria, p: string[], out: (text: string, data?: unknown) => unknown, lang: "de" | "en", whyFlag: string) {
  const wp = windowProgress(s, { handovers: false });
  if (!p[0]) {
    const st = wp.stop ?? stopState(s);
    return out(st ? renderWindowProgress(wp, lang) : lang === "de" ? "Kein Stopp." : "No stop.", { stop: st, lift: wp.lift });
  }
  if (p[0] !== "lift") throw new Error('Usage: scenaria window stop [lift --why "the task was cut smaller"]');
  const why = whyFlag.trim();
  if (!wp.stop) throw new Error("There is no stop to lift.");
  if (!why) throw new Error('Say why the stop is lifted: scenaria window stop lift --why "the task was cut smaller"');
  const by = process.env.SCENARIA_USER || userInfo().username || "person";
  await personConfirm(
    "lift",
    `Lift the stop on task ${wp.stop.task} (windows ${wp.stop.windows.map((w) => w.split("@")[0]).join(", ")} made too little progress)? Reason: ${why}. The AI may write again; two more full windows without progress stop it again.`,
    "Lifting a stop is the person's action: run this in an interactive terminal, or use the dashboard (lock → approval mode).",
  );
  const after = liftStop(s, { why }, { by, via: "terminal" });
  return out(renderWindowProgress(after, lang), { stop: after.stop, lift: after.lift });
}

/** A person's action: an interactive terminal AND typing the confirmation word on it. */
/** `scenaria window settings …` (E3b-1): show, or — the person, at a terminal — set the context-window rule. */
async function windowSettingsCommand(s: Scenaria, p: string[], out: (text: string, data?: unknown) => unknown) {
  const show = () => {
    const cs = readContextSettings(s.store);
    const v = cs.values;
    const head =
      cs.trust === "verified"
        ? `Context-window rule ${cs.rule.split(" ")[0]} — set by ${cs.set!.by} via ${cs.set!.via} on ${cs.set!.at.slice(0, 16).replace("T", " ")} (signed; ${cs.history.length} revision${cs.history.length === 1 ? "" : "s"} kept)`
        : cs.trust === "invalid"
          ? `${C.red}${describeSettings(cs).en}${C.reset}`
          : `Context-window rule ${cs.rule.split(" ")[0]} — start values (not set for this folder)${cs.elsewhere ? `\n  ${describeSettings(cs).en}` : ""}`;
    const lines = [
      head,
      `  yellow from ${v.yellow} %, red from ${v.red} %, emergency from ${v.emergency} % (of C_eff)`,
      `  P95 start value ${v.p95start} %, margin ${v.margin} %, A_model ${v.aModel} tokens`,
      `  progress per window: at least ${cs.progress.minProgress} points per full window; handover tolerance ${cs.progress.tolerance} points`,
      cs.models.length ? `  local models: ${cs.models.map((m) => `${m.id} ${m.cMax} tokens`).join(", ")}` : "  local models: none entered",
      ...(cs.trust === "verified" && (cs.looser.length || cs.dropped.length) ? [`  ${describeSettings(cs).en.replace(/^[^.]*\.\s*/, "")}`] : []),
    ];
    return out(lines.join("\n"), cs);
  };
  if (!p[0]) return show();
  const notPerson = "The context-window rule is the person's setting: run this in an interactive terminal, or use the dashboard (lock → approval mode).";
  const by = process.env.SCENARIA_USER || userInfo().username || "person";
  const cur = readContextSettings(s.store);
  // Checked BEFORE the person is asked: nothing to confirm that would be refused (review E3b-1 L5).
  const precheck = (values: Partial<ContextValues>, models: { id: string; cMax: number }[], progress: Partial<ProgressValues> = {}) => {
    const next = { ...cur.values, ...values };
    const nextP = { ...cur.progress, ...progress };
    const bad = checkValues(next) ?? checkProgress(nextP) ?? checkModels(models);
    if (bad) throw new Error(bad.message);
    if (
      cur.trust !== "invalid" &&
      JSON.stringify(next) === JSON.stringify(cur.values) &&
      JSON.stringify(nextP) === JSON.stringify(cur.progress) &&
      JSON.stringify(models.map((m) => ({ id: normaliseModel(m.id), cMax: m.cMax }))) === JSON.stringify(cur.models)
    )
      throw new Error("Nothing changes: these values are already in force.");
    return { ...next, ...nextP };
  };
  if (p[0] === "reset") {
    precheck(CONTEXT_DEFAULTS, [], PROGRESS_DEFAULTS);
    await personConfirm("reset", "Go back to the start values v1.0 of the context-window rule (and remove the local models you entered)?", notPerson);
    setContextSettings(s.store, { reset: true }, { by, via: "terminal" });
    return show();
  }
  if (p[0] === "set") {
    const values: Partial<ContextValues> = {};
    const progress: Partial<ProgressValues> = {};
    for (const a of p.slice(1)) {
      const m = /^(yellow|red|emergency|p95start|margin|aModel|minProgress|tolerance)=(\d+(?:\.\d+)?)$/.exec(a);
      if (!m)
        throw new Error(
          `Usage: scenaria window settings set yellow=50 red=70 emergency=85 p95start=5 margin=2 aModel=200000 minProgress=10 tolerance=5 (bounds: ${Object.entries({ ...CONTEXT_BOUNDS, ...PROGRESS_BOUNDS })
            .map(([k, b]) => `${k} ${b[0]}–${b[1]}`)
            .join(", ")})`,
        );
      if (m[1] === "minProgress" || m[1] === "tolerance") progress[m[1]] = Number(m[2]);
      else values[m[1] as keyof ContextValues] = Number(m[2]);
    }
    if (!Object.keys(values).length && !Object.keys(progress).length) throw new Error("Name at least one value, e.g. scenaria window settings set red=72");
    const next = precheck(values, cur.models, progress);
    await personConfirm(
      "set",
      `Set the context-window rule to: yellow ${next.yellow} %, red ${next.red} %, emergency ${next.emergency} %, P95 start ${next.p95start} %, margin ${next.margin} %, A_model ${next.aModel} tokens; at least ${next.minProgress} points of progress per full window, handover tolerance ${next.tolerance} points (start values: ${CONTEXT_DEFAULTS.yellow}/${CONTEXT_DEFAULTS.red}/${CONTEXT_DEFAULTS.emergency} %, ${CONTEXT_DEFAULTS.p95start} %, ${CONTEXT_DEFAULTS.margin} %, ${CONTEXT_DEFAULTS.aModel}; ${PROGRESS_DEFAULTS.minProgress} and ${PROGRESS_DEFAULTS.tolerance} points)?`,
      notPerson,
    );
    setContextSettings(s.store, { values, progress }, { by, via: "terminal" });
    return show();
  }
  if (p[0] === "model") {
    const id = p[1];
    const size = p[2];
    if (!id || !size) throw new Error("Usage: scenaria window settings model <model id> <window size in tokens, e.g. 32768 or 128k (= 128,000) | remove>   (Ollama: the CONTEXT column of `ollama ps`)");
    const models = cur.models.filter((m) => m.id !== normaliseModel(id));
    let n = 0;
    if (size !== "remove") {
      const k = /^(\d+(?:[.,]\d+)?)\s*([kKmM]?)$/.exec(size.replace(/_/g, ""));
      if (!k) throw new Error(`"${size}" is no window size: give tokens (e.g. 32768, 128k or 1m)`);
      n = Math.round(Number(k[1].replace(",", ".")) * (k[2].toLowerCase() === "k" ? 1000 : k[2].toLowerCase() === "m" ? 1_000_000 : 1)); // k = 1,000 (the confirmation shows the exact number)
      models.push({ id, cMax: n });
    } else if (models.length === cur.models.length) throw new Error(`No window size was entered for ${id}.`);
    precheck({}, models);
    await personConfirm("model", size === "remove" ? `Remove the window size you entered for ${id}?` : `Enter ${n} tokens as the window size of ${id} (your entry, not the provider's documentation)?`, notPerson);
    setContextSettings(s.store, { models }, { by, via: "terminal" });
    return show();
  }
  throw new Error("Usage: scenaria window settings [set k=v … | model <id> <tokens|remove> | reset]");
}

async function personConfirm(confirm: string, what: string, notInteractive: string) {
  if (!isPersonTerminal()) throw new Error(notInteractive);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${what}\nType "${confirm}" to confirm: `)).trim();
    if (answer !== confirm) throw new Error("Not confirmed — nothing changed.");
  } finally {
    rl.close();
  }
}

/**
 * Starting over in a folder whose earlier project this machine anchored: only the person may archive the
 * old integrity anchor (typed confirmation). Without a terminal the old anchor stays (the new ledger then
 * shows as "replaced" until the person reviews and reseals).
 */
async function confirmNewProject(root?: string): Promise<boolean> {
  const since = Scenaria.previousProjectSince(root);
  if (!since) return false;
  if (!isPersonTerminal()) {
    process.stderr.write(`! An earlier Scenaria project in this folder (since ${since.slice(0, 10)}) is still anchored on this machine. The new project will show "ledger replaced" until you review and reseal it (dashboard or: scenaria integrity --reseal).\n`);
    return false;
  }
  await personConfirm("new", `An earlier Scenaria project in this folder (since ${since.slice(0, 10)}) is anchored on this machine. Start a NEW project here and archive the old integrity anchor?`, "");
  return true;
}

/** `scenaria audit-file evidence …` (Batch C3): reading follows the audit file's setting; every change is the person's. */
async function evidenceCommand(s: Scenaria, p: string[], v: Record<string, any>, out: (human: string, data: unknown) => void) {
  const { addOrgEvidence, confirmOrgEvidence, copyOrgEvidence, documentHash, orgEvidenceStates, readOrgEvidence } = await import("./core/orgevidence.js");
  const who = { by: process.env.SCENARIA_USER || userInfo().username || "person", via: "terminal" as const };
  const notPerson = "The organisation's evidence is the person's: run this in an interactive terminal, or use the dashboard (lock → approval mode).";
  const show = (e: { id: string; control: string; url: string; hash: string; title?: string; owner: { role: string; name: string }; date: string; status: string }) =>
    `${e.id} ${e.control} ${e.status === "removed" ? "(removed) " : ""}${e.title ? `“${e.title}” ` : ""}${e.url}\n     ${e.hash} · ${e.owner.role}: ${e.owner.name} · ${e.date}`;
  const sub = p[0];
  if (!sub || sub === "list") {
    if (readAuditAccess(s.store).mode !== "open" && !isPersonTerminal()) throw new Error("Only the person reads the audit file (their setting): run this in an interactive terminal, or open the dashboard in approval mode.");
    const st = orgEvidenceStates(s.store);
    const lines = [
      st.error ? `${C.red}${st.error}${C.reset}` : `The organisation's documents: ${st.entries.filter((x) => x.entry.status === "active").length} active`,
      ...st.entries.map((x) => `${x.trust === "verified" ? (x.catalogueChanged ? `${C.yellow}confirm${C.reset} ` : `${C.green}signed${C.reset}  `) : x.trust === "tampered" ? `${C.red}CHANGED${C.reset} ` : `${C.yellow}${x.trust}${C.reset} `} ${show(x.entry)}`),
      ...(st.missing.length ? [`${C.red}Deleted outside Scenaria: ${st.missing.join(", ")}${C.reset}`] : []),
    ];
    return out(lines.join("\n"), st);
  }
  if (sub === "add") {
    let hash = v.hash as string | undefined;
    if (v["doc-file"]) {
      if (hash) throw new Error("Give either --hash or --doc-file, not both.");
      hash = documentHash(readFileSync(v["doc-file"]));
    }
    const input = { control: v.control, url: v.url, hash, role: v.role, name: v.name, date: v.date, title: v.title, note: v.notes };
    const { validateInput } = await import("./core/orgevidence.js");
    const x = validateInput(input);
    await personConfirm("record", `Record for ${x.control}: ${x.title ? `“${x.title}” ` : ""}${x.url}\n  ${x.hash}\n  owner: ${x.role}: ${x.name} · document date ${x.date}\nSigned with your approver key; it never changes the control's status.`, notPerson);
    const e = addOrgEvidence(s.store, x, who);
    return out(`Recorded and signed: ${show(e)}`, e);
  }
  if (sub === "rm" || sub === "remove") {
    const id = p[1] ?? "";
    const e = readOrgEvidence(s.store).entries.find((x) => x.id === id);
    if (!e) throw new Error(`No entry ${id}. See: scenaria audit-file evidence`);
    const { planRemove, removeOrgEvidence } = await import("./core/orgevidence.js");
    // The core says what will happen (one reading of the file); the prompt shows exactly that.
    const plan = planRemove(s.store, id, { discard: Boolean(v.discard) });
    if (plan.outcome === "restore_first") throw new Error(`${id} was recorded by you but changed outside Scenaria. To keep its history, restore .scenaria/org-evidence.json from git first; or discard it: scenaria audit-file evidence rm ${id} --discard`);
    if (plan.outcome === "already_removed") throw new Error(`${id} is already removed.`);
    const dropNote = plan.dropped ? `\n${plan.dropped} copy(ies) added outside Scenaria under the same id are dropped.` : "";
    await personConfirm(
      "remove",
      plan.outcome === "discard"
        ? `DISCARD ${id}${e.control ? ` (${e.control})` : ""}: it is not your signed entry; its content is dropped and it never counts.`
        : plan.outcome === "drop_copies"
          ? `${id} is already removed.${dropNote}`
          : `Remove ${show(plan.entry)}\n(kept as a signed record of the removal)${dropNote}`,
      notPerson,
    );
    // Exactly what was shown: decided again under the lock, refused if the file changed (review C4c-2 K3).
    const { entryDigest } = await import("./core/orgevidence.js");
    const r = removeOrgEvidence(s.store, id, who, { discard: Boolean(v.discard), expect: { outcome: plan.outcome, digest: entryDigest(plan.entry) } });
    return out(r.discarded ? `Discarded: ${id}` : `Removed: ${r.entry.id} (${r.entry.control})${r.dropped ? ` · ${r.dropped} copy(ies) added outside Scenaria dropped` : ""}`, r);
  }
  if (sub === "confirm") {
    const id = p[1] ?? "";
    const st = orgEvidenceStates(s.store).entries.find((x) => x.entry.id === id);
    if (!st) throw new Error(`No entry ${id}. See: scenaria audit-file evidence`);
    const e = st.entry;
    await personConfirm("confirm", `Confirm ${show(e)}${e.copiedFrom ? `\n     (says: taken over from “${e.copiedFrom}”)` : ""}\nas evidence for ${e.control}, signed with your approver key${st.trust === "verified" ? "" : ", in force from now"}?`, notPerson);
    // Exactly what was shown: if the file changed meanwhile, the digest no longer matches and nothing is signed.
    const r = confirmOrgEvidence(s.store, id, st.digest, who);
    return out(`Confirmed and signed: ${r.id} (${r.control})`, r);
  }
  if (sub === "copy") {
    const want = String(v.from ?? "").trim();
    if (!want) throw new Error("Usage: scenaria audit-file evidence copy --from <project name or folder>");
    const { listProjects, realRoot } = await import("./core/projects.js");
    const here = realRoot(s.root);
    const cands = listProjects().filter((x) => realRoot(x.root) !== here && (x.name === want || realRoot(x.root) === realRoot(want)));
    if (cands.length !== 1) throw new Error(cands.length ? `"${want}" is the name of several projects: give its folder.` : `"${want}" is none of the projects you opened with Scenaria on this machine.`);
    const { planCopy } = await import("./core/orgevidence.js");
    const controls = v.control ? [String(v.control)] : undefined;
    const plan = planCopy(s.store, cands[0].root, controls);
    if (!plan.take.length) return out(`Nothing to take over from “${plan.from.name}”${plan.skipped.length ? ` (skipped: ${plan.skipped.map((x) => `${x.id} ${x.reason}`).join(", ")})` : ""}.`, plan);
    await personConfirm(
      "copy",
      `${plan.sameIdElsewhere ? `${C.yellow}Note: ${plan.sameIdElsewhere} other folder(s) on this machine claim the same project id (a second checkout or a copy). Make sure this is the project you mean.${C.reset}\n` : ""}Take over from “${plan.from.name}” into this project, each signed anew, in force from now:\n${plan.take.map((t) => `  ${t.control} ${t.title ? `“${t.title}” ` : ""}${t.url}\n     ${t.hash} · ${t.owner.role}: ${t.owner.name} · ${t.date}${t.note ? `\n     note: ${t.note}` : ""}`).join("\n")}${plan.skipped.length ? `\nSkipped: ${plan.skipped.map((x) => `${x.id} (${x.reason})`).join(", ")}` : ""}`,
      notPerson,
    );
    // Every signed value shown and the recorded project name (review C4c-2 K1).
    const r = copyOrgEvidence(s.store, cands[0].root, who, controls, { name: plan.from.name, entries: plan.take.map((t) => ({ id: t.id, digest: t.digest })) });
    return out(`Taken over: ${r.copied.length}${r.skipped.length ? ` · skipped: ${r.skipped.map((x) => `${x.id} (${x.reason})`).join(", ")}` : ""}`, r);
  }
  throw new Error("Usage: scenaria audit-file evidence [add|rm <id>|confirm <id>|copy --from <project>]");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "hook") {
    const { runHook } = await import("./hooks.js");
    await runHook(argv[1] ?? "");
    return;
  }
  if (cmd === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    const rootIdx = argv.indexOf("--root");
    await startMcpServer(rootIdx > -1 ? argv[rootIdx + 1] : undefined);
    return;
  }

  const { values: v, positionals } = parseArgs({ args: argv.slice(1), options: opts, allowPositionals: true, strict: true });
  const p = positionals;
  const out = (human: string, data: unknown) => {
    if (v.json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    else process.stdout.write(human + "\n");
  };
  const actor = { agent: v.agent ?? process.env.SCENARIA_AGENT ?? "cli", model: v.model, user: v.user, source: "cli" as const };

  switch (cmd) {
    case "init": {
      const s = Scenaria.init(v.root, { projectName: v.name, force: v.force, newProjectInFolder: await confirmNewProject(v.root) });
      (await import("./core/projects.js")).registerProject(s.root, s.config().projectName);
      let msg = `${C.green}✔${C.reset} Scenaria initialized in ${s.store.dir}${s.repo ? "" : `\n${C.yellow}! git not found — file snapshots disabled${C.reset}`}`;
      const spec = [v.for, v.claude ? "claude" : ""].filter(Boolean).join(",");
      if (spec) {
        const { setupAgents, parseTargets } = await import("./setup.js");
        const r = setupAgents(s.root, parseTargets(spec), { rulesFiles: !(v["no-rules"] || v["no-claude-md"]) });
        msg += "\n" + r.changes.map((c) => `${C.green}✔${C.reset} ${c}`).join("\n");
        if (r.notes.length) msg += "\n\n" + r.notes.map((n) => `${C.yellow}→${C.reset} ${n}`).join("\n\n");
        msg += `\n\nRestart your agent in this folder. Then: ${C.cyan}scenaria ui${C.reset}`;
      } else {
        msg += `\n\nWire an agent: ${C.cyan}scenaria init --for claude|cursor|vscode|gemini|codex|windsurf|generic|all${C.reset}`;
      }
      return out(msg, { root: s.root });
    }
    case "ui":
    case "serve": {
      const { startServer } = await import("./server.js");
      const s = Scenaria.open(v.root);
      const token = v.token ?? process.env.SCENARIA_TOKEN;
      let host = v.host ?? (cmd === "serve" && token ? "0.0.0.0" : "127.0.0.1");
      let tok = token;
      if (cmd === "serve" && v.host && !tok && !["127.0.0.1", "localhost", "::1"].includes(v.host)) {
        const { randomBytes } = await import("node:crypto");
        tok = randomBytes(18).toString("base64url");
        process.stdout.write(`${C.yellow}No token given — generated one for this session:${C.reset} ${tok}\n`);
      }
      await startServer(s, { port: v.port ? Number(v.port) : 4477, open: cmd === "ui" && !v["no-open"], host, token: tok, showToken: tok !== token, showApprovalLink: await allowPrintedApprovalLink(v) });
      return;
    }
    case "watch": {
      const s = Scenaria.open(v.root);
      if (!s.repo) throw new Error("watch needs git for snapshots");
      const quiet = Math.max(0, Number(v.quiet ?? 15)) * 1000;
      process.stdout.write(`Watching ${s.root} — auto-save after ${quiet / 1000}s without changes. Ctrl+C to stop.\n`);
      startWatch(s, { interval: Math.max(1, Number(v.interval ?? 3)) * 1000, quiet, agent: v.agent ?? process.env.SCENARIA_AGENT ?? "watch", model: v.model, user: v.user, log: true });
      return;
    }
    case "launcher": {
      const { writeLauncher } = await import("./setup.js");
      const s = Scenaria.open(v.root);
      const file = writeLauncher(s.root, v.to);
      out(`${C.green}✔${C.reset} Start icon: ${file}\n  Double-click it to start Scenaria for ${s.root}. The dashboard opens in your browser, ready for your approvals.`, { file });
      return;
    }
    case "start": {
      const { setupAgents, parseTargets, detectAgents } = await import("./setup.js");
      const { startServer, rootKey } = await import("./server.js");
      const startRoot = v.root ?? process.cwd();
      // From the start icon: never set up a new project (the folder may have moved, or the icon runs elsewhere).
      if (v.launcher && !new Store(resolveRoot(startRoot)).exists) {
        throw new Error(`No Scenaria project in ${resolve(startRoot)} — was the folder moved or renamed? Start Scenaria there once with "scenaria start", then create a new start icon.`);
      }
      // Already running for this project (second double-click)? Open its dashboard instead of a second server.
      if (!v.port) {
        const running = await findRunning(rootKey(resolveRoot(startRoot)));
        if (running) {
          let opened = false;
          let why = "";
          if (!v["no-open"]) {
            try {
              // Logged as asked by "scenaria start" (not the dashboard), with the longer wait between openings.
              const r = await fetch(`${running.url}/api/approval/open`, { method: "POST", headers: { "x-scenaria": "1", "x-scenaria-agent": "scenaria start", "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(4000) });
              opened = r.ok;
              if (!r.ok) why = String(((await r.json().catch(() => ({}))) as any)?.error ?? `HTTP ${r.status}`);
            } catch {}
          }
          process.stdout.write(
            `${C.bold}Scenaria is already running${C.reset} for this project: ${C.cyan}${running.url}${C.reset}\n` +
              (opened ? "  Opened the dashboard in your browser (with approval).\n" : why ? `  Did not open a new window: ${why} Open ${running.url} in your browser.\n` : "") +
              (running.otherView ? "  Its dashboard currently shows another project — click the project name at the top to switch back.\n" : ""),
          );
          return;
        }
      }
      const s = new Store(resolveRoot(startRoot)).exists ? Scenaria.open(startRoot) : Scenaria.init(startRoot, { force: v.force, newProjectInFolder: await confirmNewProject(startRoot) });
      const targets = v.for ? parseTargets(v.for) : detectAgents();
      const r = setupAgents(s.root, [...targets, "generic"].filter((t, i, a) => a.indexOf(t) === i) as any, { rulesFiles: !v["no-rules"] });
      // Baseline AFTER wiring, so agent config files are part of the starting state.
      if (!v["no-watch"]) s.ensureBaseline({ agent: "scenaria", user: v.user, source: "cli" });
      const port = v.port ? Number(v.port) : 4477;
      const srv = await startServer(s, { port, open: !v["no-open"], host: "127.0.0.1", quiet: true, showApprovalLink: await allowPrintedApprovalLink(v) });
      const base = srv.url;
      const lines = [
        "",
        `${C.bold}Scenaria is running${C.reset} for ${s.root}`,
        "",
        `  Dashboard      ${C.cyan}${base}${C.reset}`,
        srv.approvalUrl
          ? `  Approval link  ${C.cyan}${srv.approvalUrl}${C.reset}  ${C.dim}(approvals: canon and project rules — works once${v["no-open"] ? "" : "; already opened in your browser"})${C.reset}`
          : `  Approval       ${C.dim}${v["no-open"] ? "click the lock 🔒 in the dashboard — Scenaria opens the approval link in your browser" : "opened in your browser (never printed here)"}${C.reset}`,
        `  Agents wired   ${targets.length ? targets.join(", ") : "none detected (MCP/HTTP/CLI still available)"}`,
        `  Auto-save      ${v["no-watch"] ? "off" : "on — every file change becomes a version"}`,
        "",
        `  ${C.bold}Record conversations from ANY provider${C.reset} — set your app's base URL to:`,
        `    OpenAI / compatible   ${base}/proxy/openai`,
        `    Anthropic             ${base}/proxy/anthropic`,
        `    Ollama (local)        ${base}/proxy/ollama`,
        `    Mistral · Groq · OpenRouter · Gemini · LM Studio   ${base}/proxy/<mistral|groq|openrouter|gemini|lmstudio>`,
        "",
        `  Snapshot folders   ${s.folderConfig().enabled ? join(s.root, s.folderConfig().path) : "off"}`,
        ...r.notes.map((n) => `\n${C.yellow}→${C.reset} ${n}`),
        "",
        "Ctrl+C to stop.",
        "",
      ];
      process.stdout.write(lines.join("\n"));
      if (!v["no-watch"] && s.repo) startWatch(s, { interval: 3000, quiet: 10000, agent: v.agent ?? "watch", model: v.model, user: v.user, log: false });
      return;
    }
    case "setup": {
      const { setupGlobal, parseTargets, detectAgents } = await import("./setup.js");
      if (!v.global) throw new Error("Usage: scenaria setup --global [--for claude,cursor,…]   (per project: scenaria init --for …)");
      const { writeGlobalConfig, globalConfigPath } = await import("./core/global.js");
      const targets = v.for ? parseTargets(v.for) : detectAgents();
      const r = setupGlobal(targets);
      writeGlobalConfig({ autoInit: true, setupAt: new Date().toISOString(), targets });
      const msg = [
        `${C.green}✔${C.reset} Global setup for: ${targets.join(", ") || "no agents detected"}`,
        ...r.changes.map((c) => `${C.green}✔${C.reset} ${c}`),
        `${C.green}✔${C.reset} ${globalConfigPath()} → auto-initialize projects on first use`,
        ...r.notes.map((n) => `${C.yellow}→${C.reset} ${n}`),
        "",
        "Restart your agents. Every project now gets decision checkpoints automatically.",
      ];
      return out(msg.join("\n"), r);
    }
    case "versions": {
      const s = Scenaria.open(v.root);
      const vs = s.versions(p[0]);
      const human = vs
        .map((x) => `${(x.label ?? "").padEnd(8)} ${x.id.padEnd(5)} ${x.type.padEnd(10)} ${C.dim}${(x.snapshot ?? "").slice(0, 10)} ${x.uid}${C.reset}  ${x.title}`)
        .join("\n");
      return out(human || "(no versions yet)", vs);
    }
    case "open": {
      const s = Scenaria.open(v.root);
      if (!p[0]) throw new Error("Usage: scenaria open <id> [--copy-to <dir>] [--print]");
      const folder = s.ensureFolder(p[0], { rebuild: v.rebuild });
      if (!folder) throw new Error(`${p[0]} has no file snapshot`);
      if (v["copy-to"]) {
        const { cpSync, chmodSync, readdirSync, lstatSync } = await import("node:fs");
        cpSync(folder, v["copy-to"], { recursive: true, dereference: false, filter: (src) => !src.includes(".scenaria-version") });
        // copies are writable (snapshot files are read-only on purpose)
        const walk = (d: string) => {
          for (const e of readdirSync(d)) {
            const f = join(d, e);
            const st = lstatSync(f); // never follow symlinks out of the copy
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) walk(f);
            else chmodSync(f, st.mode | 0o200);
          }
        };
        walk(v["copy-to"]);
        return out(`Copied ${p[0]} to ${v["copy-to"]} (writable)`, { folder, copy: v["copy-to"] });
      }
      if (!v.print) {
        const { cmd, args } = showFolderCommand(folder);
        const { spawn } = await import("node:child_process");
        try {
          spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
        } catch {}
      }
      return out(folder, { folder });
    }
    case "mirror": {
      const s = Scenaria.open(v.root);
      if (v.enable || v.disable) {
        const cfg = s.config();
        cfg.mirrorToProjectGit = Boolean(v.enable);
        s.store.writeConfig(cfg);
      }
      const r = s.mirrorToProjectGit();
      return out(`${r.ok ? C.green + "✔" : C.yellow + "!"}${C.reset} ${r.message}${v.enable ? " (now automatic after every version)" : ""}\n  e.g. git log refs/scenaria/heads/s1   ·   git worktree add ../try-s2 refs/scenaria/scenarios/s2/v3`, r);
    }
    case "conversations": {
      const s = Scenaria.open(v.root);
      const list = s.conversations.listSessions();
      const human = list.map((c) => `${c.id.padEnd(5)} ${(c.provider ?? "").padEnd(10)} ${(c.model ?? "").padEnd(18)} ${String(c.messageCount).padStart(4)} msgs  ${C.dim}${c.source}${C.reset}  ${c.title ?? ""}`).join("\n");
      return out(human || "(no conversations recorded yet)", list);
    }
    case "conversation": {
      const s = Scenaria.open(v.root);
      const { renderConversation } = await import("./core/conversations.js");
      const sess = s.conversations.getSession(p[0] ?? "");
      const msgs = s.conversations.messages(sess.id);
      return out(`# ${sess.id} ${sess.title ?? ""} (${sess.provider ?? ""} ${sess.model ?? ""})\n\n${renderConversation(msgs)}`, { session: sess, messages: msgs });
    }
    case "import": {
      const s = Scenaria.openOrInit(v.root);
      const { importConversations } = await import("./ingest.js");
      if (!p[0]) throw new Error("Usage: scenaria import <file> [--format auto|chatgpt|claude-ai|claude-code|openai|jsonl]");
      const r = importConversations(s, p[0], (v.format ?? "auto") as any);
      return out(`${C.green}✔${C.reset} Imported ${r.messages} messages from ${r.conversations} conversation(s)`, r);
    }
    case "log-message": {
      const s = Scenaria.openOrInit(v.root);
      if (!v.text) throw new Error('Usage: scenaria log-message --role user|assistant --text "…" [--session <id>]');
      const r = s.logMessages(
        { externalId: v.session ?? `cli:${actor.agent}`, title: v.title, agent: actor.agent, model: v.model, source: "cli" },
        [{ role: (v.role ?? "user") as any, text: v.text, model: v.model }],
        "append",
      );
      return out(r.added.length ? `${r.added[0].id} recorded in ${r.session.id}` : "Duplicate — not recorded again", r);
    }
    case "tools": {
      const { toolSchemas } = await import("./tools.js");
      process.stdout.write(JSON.stringify(toolSchemas((v.format ?? "json") as any), null, 2) + "\n");
      return;
    }
    case "call": {
      const { callTool } = await import("./tools.js");
      const { readFileSync } = await import("node:fs");
      if (!p[0]) throw new Error("Usage: scenaria call <tool> '<json args>'");
      const raw = v["args-file"] ? readFileSync(v["args-file"], "utf8") : p[1] ?? "{}";
      let args: unknown;
      try {
        args = JSON.parse(raw);
      } catch {
        throw new Error("Arguments must be a JSON object, e.g. '{\"title\":\"Login form done\"}'");
      }
      const s = Scenaria.openOrInit(v.root);
      const r = callTool(s, p[0], args, actor);
      return out(r.text, r.data);
    }
    case "export": {
      const s = Scenaria.open(v.root);
      const { writeFileSync } = await import("node:fs");
      const fmt = v.format ?? "json";
      const content = fmt === "md" ? s.protocolMarkdown() : JSON.stringify(s.exportJson(), null, 2) + "\n";
      if (v["out-file"]) {
        writeFileSync(v["out-file"], content);
        return out(`Exported to ${v["out-file"]}`, { file: v["out-file"] });
      }
      process.stdout.write(content);
      return;
    }
    case "task":
    case "mission": {
      const s = Scenaria.openOrInit(v.root);
      if (!p[0]) throw new Error('Usage: scenaria task "<title>" [--goal ..]');
      const n = s.startMission({ title: p[0], goal: v.goal, brief: v.brief, ...actor });
      return out(describe(n), n);
    }
    case "goal": {
      const s = Scenaria.openOrInit(v.root);
      if (p[0]) {
        const n = s.setProjectGoal(p.join(" "), actor);
        return out(`Main goal of ${s.config().projectName}: ${n.goal}`, n);
      }
      const root = s.project();
      return out(root?.goal ? `Main goal of ${s.config().projectName}: ${root.goal}` : `No main goal set. Set it: scenaria goal "<what the project must achieve>"`, { goal: root?.goal ?? null });
    }
    case "prompt": {
      const s = Scenaria.openOrInit(v.root);
      const kind = (v.kind ?? "mcp") as PromptKind;
      if (!["mcp", "cli", "chat"].includes(kind)) throw new Error("--kind must be mcp, cli or chat");
      const text = agentPrompt(s, { kind, lang: v.lang === "en" ? "en" : "de", withContext: v["with-context"] });
      return out(text, { text });
    }
    case "recall": {
      const s = Scenaria.open(v.root);
      if (!p[0]) throw new Error('Usage: scenaria recall "<keywords>"');
      const head = s.store.readState().head;
      const hits = recall(s.store.listNodes(), s.conversations.allMessages(), p.join(" "), { limit: v.limit ? Number(v.limit) : 8, pathIds: head ? new Set(s.path(head).map((n) => n.id)) : undefined });
      return out(renderRecall(hits), hits);
    }
    case "ingest-text": {
      const s = Scenaria.openOrInit(v.root);
      const text = !p[0] || p[0] === "-" ? await readStdinText() : readFileSync(p[0], "utf8");
      const r = applyBlocks(s, text, actor);
      return out([`${r.created.length} node(s) recorded${r.skipped ? `, ${r.skipped} block(s) already known` : ""}.`, ...r.created.map((n) => `- ${n.id} [${n.type}] ${n.title}`), ...r.errors.map((e) => `! ${e}`)].join("\n"), r);
    }
    case "forecast": {
      const s = Scenaria.open(v.root);
      const { forecast, quickDecision, quickPrompt, evaluateForecasts } = await import("./core/forecast.js");
      const P = await import("./core/predict.js");
      const de = v.lang !== "en";
      if (v.quality) {
        // Quality: every past decision forecast as of its own time vs. what really happened.
        const q = P.forecastQuality(s);
        const pctS = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
        const human = [
          `${C.bold}${de ? "Prognose-Güte (Backtest, ohne Wissen über die Zukunft)" : "Forecast quality (backtest, no knowledge of the future)"}${C.reset}`,
          `${de ? "Entscheidungen" : "decisions"}: ${q.decisions} (${q.n} ${de ? "Optionen" : "options"})${q.excluded ? ` · ${q.excluded} ${de ? "ausgelassen (manipulierte Historie)" : "left out (tampered history)"}` : ""}${q.enough ? "" : `  ${C.yellow}${de ? `zu wenig Daten (ab ${q.minDecisions} Entscheidungen aussagekräftig)` : `too little data (meaningful from ${q.minDecisions} decisions)`}${C.reset}`}`,
          `${de ? "Fehler Ø" : "mean error"}: ${q.mae ?? "–"} ${de ? "Punkte · naive Fortschreibung" : "points · naive persistence"}: ${q.maeBaseline ?? "–"} · Skill: ${q.skill ?? "–"} ${q.skill !== null ? (q.skill > 0 ? `${C.green}(${de ? "besser als Fortschreibung" : "better than persistence"})${C.reset}` : `${C.yellow}(${de ? "nicht besser als Fortschreibung" : "not better than persistence"})${C.reset}`) : ""}`,
          `Bias: ${q.bias ?? "–"} · ${de ? "im Band" : "within band"}: ${pctS(q.coverage)} · ${de ? "Abbrüche erkannt" : "breaks found"}: ${q.breaks.hits}/${q.breaks.actual} (precision ${pctS(q.breaks.precision)}, recall ${pctS(q.breaks.recall)}) · ${de ? "Rangfolge" : "ranking"}: ${q.ranking.concordant}/${q.ranking.pairs}`,
          `α ${q.calibration.alpha.toFixed(2)} · β ${q.calibration.beta.toFixed(2)} · ${de ? "Band" : "band"} ±${q.calibration.band}${q.calibration.calibrated ? "" : de ? " (Standard, noch nicht kalibriert)" : " (default, not calibrated yet)"} · ${de ? "jede Entscheidung mit Gewichten und Band aus den ANDEREN Entscheidungen bewertet" : "each decision scored with weights and band from the OTHER decisions"}`,
          ...q.cases.map((c) => `  ${c.decision} ${c.label.slice(0, 40)}: ${de ? "Prognose" : "forecast"} ${c.predicted} · ${de ? "real" : "actual"} ${c.actual} (${c.actualNodes}) · ${de ? "Fehler" : "error"} ${c.error} · ${de ? "Fortschreibung" : "persistence"} ${c.line}${c.broke ? " · broke" : ""}${c.predictedBreak ? " · ⚠" : ""}`),
        ];
        return out(human.join("\n"), q);
      }
      if (v.audit || v["oracle-backtest"]) {
        const A = await import("./core/auditor.js");
        const lang = de ? "de" : "en";
        const needTty = () => {
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("This uses your model settings and keys: it needs an interactive terminal (a person). The checklist alone: scenaria forecast --audit <id>.");
        };
        const llm = v.llm ? { provider: v.llm, model: v.model, baseUrl: v["base-url"] } : undefined;
        if (v["oracle-backtest"]) {
          needTty();
          process.stderr.write(`${C.dim}${de ? "Orakel-Backtest: 3 Modellaufrufe je Entscheidung …" : "Oracle backtest: 3 model calls per decision …"}${C.reset}\n`);
          const r = await A.oracleBacktest(s, { limit: v.limit ? Number(v.limit) : 5, lang, llm });
          const q = A.oracleQuality(s);
          const human = [
            `${C.bold}${de ? "Orakel-Backtest" : "Oracle backtest"} ${r.id}${C.reset} (${r.cases.length} ${de ? "Optionen" : "options"})`,
            ...r.cases.map((c) => `  ${c.decision} ${c.label.slice(0, 40)}: ${de ? "Kern" : "core"} ${c.core} · ${de ? "mit Orakel" : "with oracle"} ${c.oracle} · ${de ? "real" : "actual"} ${c.actual}`),
            `${de ? "Fehler Ø gesamt" : "mean error overall"}: ${de ? "Kern" : "core"} ${q.backtest.maeCore ?? "–"} · ${de ? "mit Orakel" : "with oracle"} ${q.backtest.maeOracle ?? "–"} · γ ${q.gamma} (${q.gammaN})`,
          ];
          return out(human.join("\n"), { run: r, quality: q });
        }
        const f = (await import("./core/forecast.js")).listForecasts(s).find((x) => x.id === v.audit);
        if (!f) throw new Error(`Unknown forecast ${v.audit}`);
        if (v.deep) {
          needTty();
          process.stderr.write(`${C.dim}${de ? "Prüf-Experte prüft die Aussagen des Orakels …" : "The auditor checks the oracle's claims …"}${C.reset}\n`);
          await A.deepAudit(s, f.id, { lang, llm });
        }
        const a = A.auditForecast(s, f, lang);
        const icon = { ok: `${C.green}✔${C.reset}`, warn: `${C.yellow}!${C.reset}`, fail: `${C.red}✘${C.reset}`, info: `${C.dim}·${C.reset}` };
        const verdict = { reliable: de ? "belastbar" : "reliable", caution: de ? "mit Vorsicht" : "with caution", unreliable: de ? "nicht belastbar" : "not reliable" }[a.verdict];
        const deep = a.deep[0];
        const human = [
          `${C.bold}${de ? "Prüf-Experte" : "Auditor"} ${f.id}: ${verdict}${C.reset}`,
          ...a.checks.map((c) => `  ${icon[c.status]} ${c.text}`),
          ...(deep ? [`${de ? "KI-Prüfung" : "AI check"} ${deep.id}${deep.verified ? "" : " (unsigned!)"}: ${deep.verdicts.filter((x) => x.verdict === "supported").length}/${deep.verdicts.length} ${de ? "Aussagen belegt" : "claims supported"}`, ...deep.verdicts.map((x) => `  ${x.verdict === "supported" ? icon.ok : x.verdict === "contradicted" ? icon.fail : icon.warn} ${x.claim}: ${x.reason}`), `  ${de ? "geprüfte Prognose" : "audited forecast"}: ${Object.entries(deep.audited).map(([k, n]) => `${k} ${n}`).join(" · ")}`] : []),
        ];
        return out(human.join("\n"), a);
      }
      if (v.benchmark) {
        const b = await P.benchmark(P.calibrationFor(s));
        const human = [
          `${C.bold}${de ? "Prüfstand (synthetische Fälle mit bekanntem Ausgang)" : "Test bench (synthetic cases with known outcome)"}${C.reset}`,
          `${de ? "klar (Option bleibt beim Ziel vs. driftet)" : "clear (option stays on goal vs drifts)"}: ${b.clear.ranking}/${b.clear.n} ${de ? "richtig gereiht" : "ranked right"}, ${b.clear.flagged}/${b.clear.n} ${de ? "Drift vorher markiert" : "drift flagged before"}`,
          `${de ? "neutral (beide auf Kurs)" : "neutral (both on track)"}: ${b.neutral.passed}/${b.neutral.n} ${de ? "bestanden" : "passed"}, ${b.neutral.falseAlarms} ${de ? "Fehlalarm(e)" : "false alarm(s)"}`,
          `${de ? "Fehler Ø" : "mean error"}: ${b.mae}`,
          ...b.results.map((r) => `  ${r.passed ? "✔" : "✘"} ${r.id} [${r.kind}${r.limit ? `: ${r.limit}` : ""}] ${de ? "Prognose" : "forecast"} ${r.predicted.on}/${r.predicted.off} · ${de ? "real" : "actual"} ${r.measured.on}/${r.measured.off}${r.falseAlarm ? (de ? " · Fehlalarm" : " · false alarm") : ""}`),
        ];
        return out(human.join("\n"), b);
      }
      if (!p[0] && !v.prompt) {
        const ev = evaluateForecasts(s);
        const c = ev.calibration;
        return out([...ev.forecasts.slice(0, 15).map((f) => `${f.id} ${f.mode.padEnd(10)} ${f.subject.kind === "decision" ? `${f.subject.node} ${f.subject.question}` : `prompt: ${f.subject.text.slice(0, 60)}`}${f.recommended ? ` → ${f.recommended.key}` : ""}${f.actual?.length ? `  ${C.dim}(actual: ${f.actual.map((a) => `${a.option} ${a.measured}% vs ${a.predicted}%`).join(", ")})${C.reset}` : ""}`), c.evaluated ? `Calibration: ${c.evaluated} evaluated, mean error ${c.meanError} points, ${c.hits} within ±15` : `${C.dim}No forecast could be checked against reality yet.${C.reset}`].join("\n") || "No forecasts yet.", ev);
      }
      if (v.quick || (!process.stdin.isTTY && !v.prompt)) {
        if (v.prompt) {
          const q = quickPrompt(s, String(v.prompt));
          return out(`Prompt keeps the context: ${q.score}%${q.explain ? `\n${P.explainText(q.explain, de ? "de" : "en")}` : ""}${q.warnings.length ? `\nLessons: ${q.warnings.join("; ")}` : ""}`, q);
        }
        const opts = quickDecision(s, p[0]);
        return out(opts.map((o) => `${C.bold}${o.key} ${o.label}: ${o.score}%${o.quick.explain ? ` ± ${o.quick.explain.band}` : ""}${C.reset}${o.quick.explored ? ` explored → ${o.quick.explored.measured}%` : ""}${o.quick.explain ? `\n   ${P.explainText(o.quick.explain, de ? "de" : "en").split("\n").join("\n   ")}` : ""}${o.quick.warnings.length ? `\n   ⚠ ${o.quick.warnings.join("\n   ⚠ ")}` : ""}`).join("\n"), opts);
      }
      // The multiverse uses the person's model settings and keys: a person at a terminal.
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The multiverse forecast needs an interactive terminal (it uses your model settings and keys). Use --quick for the forecast without a model.");
      process.stderr.write(`${C.dim}Archivist → craftsman → oracle …${C.reset}\n`);
      const f = await forecast(s, { node: p[0], prompt: v.prompt ? String(v.prompt) : undefined, variants: v.options ? String(v.options).split("|").map((x) => x.trim()).filter(Boolean) : undefined, lang: v.lang === "en" ? "en" : "de", llm: v.llm ? { provider: v.llm, model: v.model, baseUrl: v["base-url"] } : undefined });
      const adj = (name: string, a?: { proposed: number; applied: number; why: string; refs: string[]; backed: boolean }) =>
        a && a.proposed ? `\n   ${name} ${a.proposed > 0 ? "+" : ""}${a.proposed} → ${a.backed ? `${a.applied > 0 ? "+" : ""}${a.applied}` : de ? "nicht gewertet (ohne Beleg)" : "not counted (no evidence)"}: ${a.why}${a.refs.length ? ` [${a.refs.join(", ")}]` : ""}` : "";
      const lines = f.options.map((o) => {
        const u = o.universe;
        if (!u) return `${C.bold}${o.key} ${o.label}${C.reset}: ${o.score}%`;
        return `${C.bold}${o.key} ${o.label}${C.reset}: ${de ? "Kern" : "core"} ${u.core ?? o.quick.score}% → ${de ? "mit Orakel" : "with oracle"} ${o.score}%${u.capped ? ` (${de ? "gedeckelt: harter Fixpunkt" : "capped: hard fixed point"} ${u.canonRisks.join(", ")})` : ""} · ${de ? "Sicherheit" : "confidence"} ${Math.round(u.confidence * 100)}% · γ ${u.gamma ?? 1}${adj(de ? "eigene Worte" : "own words", u.own)}${adj(de ? "im Kontext" : "in context", u.ctx)}\n   ${de ? "Vergangenheit" : "past"}: ${u.past}\n   ${de ? "Gegenwart" : "present"}: ${u.trajectory.join(" → ")}${u.loses.length ? `\n   ${de ? "würde verlieren" : "would drop"}: ${u.loses.join("; ")}` : ""}\n   ${de ? "Zukunft" : "future"}: ${u.outcome}`;
      });
      const audit = (await import("./core/auditor.js")).auditForecast(s, f, de ? "de" : "en");
      const verdict = { reliable: de ? "belastbar" : "reliable", caution: de ? "mit Vorsicht" : "with caution", unreliable: de ? "nicht belastbar" : "not reliable" }[audit.verdict];
      return out([`Forecast ${f.id}`, ...lines, f.recommended ? `→ ${f.recommended.key}: ${f.recommended.why}` : "", ...f.warnings.map((w) => `${C.yellow}! ${w}${C.reset}`), `${de ? "Prüf-Experte" : "Auditor"}: ${verdict}  ${C.dim}(scenaria forecast --audit ${f.id} [--deep])${C.reset}`].filter(Boolean).join("\n"), f);
    }
    case "relay": {
      const s = Scenaria.open(v.root);
      const question = p.join(" ").trim();
      if (!question) throw new Error('Usage: scenaria relay "<question>" [--options "A|B|C"] [--decide] [--llm <provider> --model <m>]');
      // Uses the person's model settings and keys: a person at a terminal, like other person-only actions.
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("scenaria relay needs an interactive terminal (it uses your model settings and keys). Agents: use the dashboard chat, or record options with scenaria_decide.");
      const { runRelay } = await import("./core/relay.js");
      process.stderr.write(`${C.dim}Archivist → craftsman → oracle …${C.reset}\n`);
      const r = await runRelay(s, { question, options: v.options ? String(v.options).split("|").map((x) => x.trim()).filter(Boolean) : undefined, createDecision: Boolean(v.decide), lang: v.lang === "en" ? "en" : "de", llm: v.llm ? { provider: v.llm, model: v.model, baseUrl: v["base-url"] } : undefined, actor: { user: v.user, agent: "relay" } });
      const human = [
        `${C.bold}Relay ${r.id}${C.reset}: ${r.question}`,
        `${C.bold}Archivist${C.reset}`,
        ...r.archivist.constraints.map((c) => `  - ${c.hard ? "[hard] " : ""}${c.text}${c.refs.length ? C.dim + ` (${c.refs.join(", ")})` + C.reset : ""}`),
        `${C.bold}Craftsman → Oracle${C.reset}`,
        ...r.craftsman.options.map((o) => {
          const a = r.oracle.assessments.find((x) => x.option === o.label);
          const ok = r.surviving.includes(o.label);
          return `  ${ok ? C.green + "✔" : C.red + "✘"}${C.reset} ${o.label}: ${o.plan}${a?.risks.length ? `\n      ${C.dim}risks: ${a.risks.join("; ")}${C.reset}` : ""}`;
        }),
        r.oracle.recommendation ? `${C.bold}Oracle recommends${C.reset} ${r.oracle.recommendation.option} — ${r.oracle.recommendation.why}` : "",
        ...r.warnings.map((w) => `${C.yellow}! ${w}${C.reset}`),
        r.decisionId ? `Open decision ${r.decisionId} — choose: scenaria choose ${r.decisionId} <option>  (or in the dashboard)` : `${C.dim}Record as an open decision: add --decide${C.reset}`,
      ].filter(Boolean);
      return out(human.join("\n"), r);
    }
    case "analyst": {
      const s = Scenaria.open(v.root);
      const { expertAnalysis, listReports, listPersonalReports, getReport, adoptRecommendation } = await import("./core/expert.js");
      const personTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      // Reports across projects contain other projects' data: the person's, at their terminal.
      if ((p[0]?.startsWith("g") || v.scope === "all") && !personTerminal) throw new Error("Reports across all projects are yours (they contain other projects' data): run this in an interactive terminal or in the dashboard.");
      if (p[0]) {
        const r = getReport(s, p[0]);
        if (v.adopt !== undefined) {
          if (!personTerminal) throw new Error("Adopting a recommendation as a rule is the person's decision: run it in an interactive terminal or in the dashboard.");
          const rule = adoptRecommendation(s, r.id, Number(v.adopt), { by: process.env.SCENARIA_USER || userInfo().username || "person", via: "terminal" });
          return out(`${C.green}✔${C.reset} rule ${rule.id}: ${rule.text}`, rule);
        }
        if (v["out-file"]) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(v["out-file"], r.markdown);
          return out(`${C.green}✔${C.reset} ${v["out-file"]}`, { file: v["out-file"] });
        }
        return out(r.markdown, r);
      }
      if (!v.scope && !v.head && !v["no-model"] && !v.llm) {
        const rs = [...listReports(s), ...(personTerminal ? listPersonalReports(s) : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return out(rs.length ? rs.map((r) => `${r.id}  ${r.createdAt.slice(0, 16).replace("T", " ")}  ${r.scope.kind.padEnd(7)} ${(r.model ?? "rule-based").padEnd(24)} maturity ${r.maturity.score}/100 · ${r.findings.length} findings · ${r.recommendations.length} recommendations`).join("\n") + `\n${C.dim}Show: scenaria analyst <id> · new: scenaria analyst --scope project|line|all [--no-model]${C.reset}` : `No expert reports yet. Run: scenaria analyst --scope project  (or --no-model for the rule-based report)`, rs);
      }
      // With a model it spends the person's quota with their keys: a person at a terminal.
      if (!v["no-model"] && !personTerminal) throw new Error("The expert analysis with a model needs an interactive terminal (it uses your model settings and keys). Use --no-model for the rule-based report.");
      if (!v["no-model"]) process.stderr.write(`${C.dim}Analyst: facts → expert lenses → validation …${C.reset}\n`);
      const scope = v.scope === "all" || v.scope === "line" ? v.scope : v.head ? "line" : "project";
      const r = await expertAnalysis(s, { scope, head: v.head, lang: v.lang === "en" ? "en" : "de", noModel: Boolean(v["no-model"]), llm: v.llm ? { provider: v.llm, model: v.model, baseUrl: v["base-url"] } : undefined });
      return out(`${r.markdown}\n\n${C.dim}Adopt a recommendation as a rule: scenaria analyst ${r.id} --adopt <index from 0>${C.reset}`, r);
    }
    case "analyze": {
      const s = Scenaria.open(v.root);
      const lang = v.lang === "en" ? "en" : "de";
      if (v.dossier) {
        const d = dossier(s, { maxTokens: v["max-tokens"] ? Number(v["max-tokens"]) : undefined });
        const text = `${analysisPrompt(lang)}\n\n--- DOSSIER ---\n${d.text}`;
        return out(text, { ...d, prompt: analysisPrompt(lang) });
      }
      const m = projectMetrics(s);
      const { effectiveLlm } = await import("./core/settings.js");
      if (!v.llm && !effectiveLlm(s, "analysis")) {
        return out(`${renderMetrics(m, 30)}\n\n${C.dim}Pattern analysis with any LLM: scenaria analyze --llm ollama --model llama3.3   (or openai/anthropic/… with the API key in its env var)\nOr copy the dossier into any chat: scenaria analyze --dossier${C.reset}`, m);
      }
      process.stderr.write(`${C.dim}Analysing with ${v.llm ?? effectiveLlm(s, "analysis")?.provider} …${C.reset}\n`);
      const rec = await runAnalysis(s, { provider: v.llm, model: v.model, baseUrl: v["base-url"], lang, maxTokens: v["max-tokens"] ? Number(v["max-tokens"]) : undefined });
      const ins = rec.insights;
      const human = [
        `${C.bold}Analysis ${rec.id}${C.reset} · ${rec.provider}/${rec.model} · health ${rec.health}/100`,
        ins.summary ?? "",
        ins.goalAlignment ? `Goal alignment: ${ins.goalAlignment.score ?? "?"}/100 — ${ins.goalAlignment.notes ?? ""}` : "",
        ...(ins.patterns ?? []).map((x) => `${x.kind === "good" ? C.green + "+" : C.yellow + "−"}${C.reset} ${x.title}${x.evidence?.length ? C.dim + ` (${x.evidence.join(", ")})` + C.reset : ""}`),
        ...(ins.issues ?? []).map((x) => `${C.red}!${C.reset} [${x.severity ?? "?"}] ${x.title}${x.fix ? ` → ${x.fix}` : ""}`),
        ...(ins.rules ?? []).map((r, i) => `rule #${i}: ${r.text}`),
        ins.rules?.length ? `${C.dim}Accept a rule: dashboard → Analyse (approval mode), or scenaria rules add "<text>" in your own terminal${C.reset}` : "",
      ].filter(Boolean);
      return out(human.join("\n"), rec);
    }
    case "fidelity": {
      const s = Scenaria.open(v.root);
      const f = s.fidelity();
      const target = p[0] ?? s.head()?.id;
      if (!target) throw new Error("No nodes yet.");
      const path = s.path(target).map((n) => f.points[n.id]).filter(Boolean);
      const bar = (x: number) => "█".repeat(Math.round(x / 10)).padEnd(10, "·");
      const lines = path.map((pt) => `${bar(pt.score)} ${String(pt.score).padStart(3)} %  ${pt.id.padEnd(5)} ${pt.type.padEnd(10)} ${pt.title.slice(0, 60)}${pt.flags.filter((x) => !["task", "lowSignal"].includes(x)).length ? `  ${C.yellow}[${pt.flags.filter((x) => !["task", "lowSignal"].includes(x)).join(", ")}]${C.reset}` : ""}`);
      const last = path[path.length - 1];
      lines.push("", `Context fidelity at ${target}: ${last?.score ?? "?"} % · line to the main goal: ${last?.anchor === null || last?.anchor === undefined ? "no goal set" : `${Math.round(last.anchor * 100)} %`}`);
      if (f.ledgerBrokenAt) lines.push(`${C.red}Ledger broken at line ${f.ledgerBrokenAt}${C.reset}`);
      return out(lines.join("\n"), { path, ledgerBrokenAt: f.ledgerBrokenAt });
    }
    case "progress": {
      const s = Scenaria.open(v.root);
      const pr = projectProgress(s);
      if (p[0] && !pr.tasks.some((t) => t.task === p[0]) && !pr.without.some((w) => w.task === p[0])) throw new Error(`${p[0]} is not a task`);
      const data = progressForAgents(pr);
      return out(renderProgress(pr, v.lang === "de" ? "de" : "en", p[0]), p[0] ? { ...data, tasks: data.tasks.filter((t) => t.task === p[0]) } : data);
    }
    case "window": {
      const s = Scenaria.open(v.root);
      if (p[0] === "settings") return await windowSettingsCommand(s, p.slice(1), out);
      if (p[0] === "stop") return await windowStopCommand(s, p.slice(1), out, v.lang === "de" ? "de" : "en", typeof v.why === "string" ? v.why : "");
      const ws = windowStatus(s);
      if (p[0] && !ws.windows.some((w) => w.id === p[0])) throw new Error(`${p[0]} is not a window`);
      const data = windowsForAgents(ws);
      const wp = windowProgress(s);
      const progress = windowProgressForAgents(wp);
      const lang = v.lang === "de" ? "de" : "en";
      return out(`${renderWindows(ws, lang, p[0])}\n\n${renderWindowProgress(wp, lang)}`, p[0] ? { ...data, windows: data.windows.filter((w) => w.id === p[0]), progress: { ...progress, windows: progress.windows.filter((w) => w.window === p[0]) } } : { ...data, progress });
    }
    case "handover": {
      const s = Scenaria.open(v.root);
      const h = prepareHandover(s, { window: p[0] });
      return out(h.markdown, h);
    }
    case "integrity": {
      const s = Scenaria.open(v.root);
      if (v.reseal) {
        await personConfirm(
          "reseal",
          "Accept the current state of every node as the new integrity baseline? The old ledger is kept and the reseal is recorded and signed.",
          "Resealing the integrity ledger is the person's action (rule 11): run it yourself in an interactive terminal. An independent audit agent can hand in a signed request instead: scenaria auditor submit.",
        );
        const rs = s.reseal({ kind: "person", via: "terminal" }, { user: v.user, agent: "cli", source: "cli" });
        return out(`Resealed ${rs.nodes} nodes (record ${rs.record.id})${rs.archived ? `; previous ledger kept as .scenaria/${rs.archived}` : ""}.`, rs);
      }
      const r = s.integrity();
      const tampered = [...r.state.entries()].filter(([, st]) => st === "tampered").map(([id]) => id);
      const unsealed = [...r.state.entries()].filter(([, st]) => st === "unsealed").map(([id]) => id);
      const human = [
        tampered.length ? `${C.red}✘ changed outside Scenaria: ${tampered.join(", ")}${C.reset}` : `${C.green}✔ all ${r.state.size} nodes match the ledger${C.reset}`,
        r.ledgerReplaced ? `${C.red}✘ the ledger is not the one this machine accepted (deleted and recreated, or reset without the person) — review, then: scenaria integrity --reseal${C.reset}` : "",
        r.resealsUnproven.length ? `${C.red}✘ reseal without an authentic record: ${r.resealsUnproven.join(", ")}${C.reset}` : "",
        r.ledgerDiverged && !r.ledgerMissing
          ? r.ledgerDiverged.kind === "extended"
            ? `${C.yellow}! ${r.ledgerDiverged.found.lines - r.ledgerDiverged.expected.lines} ledger line(s) were written by something this computer's Scenaria did not see (an older version still running? another computer?) — review steps ${r.ledgerDiverged.since.slice(0, 8).join(", ")}, then: scenaria integrity --reseal${C.reset}`
            : `${C.red}✘ the ledger does not end where this machine last saw it (${r.ledgerDiverged.expected.lines} lines expected, ${r.ledgerDiverged.found.lines} found): shortened, rewritten or rolled back — review, then: scenaria integrity --reseal${C.reset}`
          : "",
        r.verdictsUntrusted.length ? `${C.red}✘ verdicts signed by a key this machine does not trust (do not count): ${r.verdictsUntrusted.join(", ")}${C.reset}` : "",
        r.verdictsRemoved.length ? `${C.red}✘ your (or an audit agent's) verdict was removed or changed outside Scenaria: ${r.verdictsRemoved.join(", ")}${C.reset}` : "",
        r.verdictsSuperseded.length ? `${C.yellow}! changed after they were verified (verdict no longer applies): ${r.verdictsSuperseded.join(", ")}${C.reset}` : "",
        r.verdictsRevoked.length ? `${C.dim}verdicts of an unregistered audit agent (no longer count): ${r.verdictsRevoked.join(", ")}${C.reset}` : "",
        r.restarted ? `${C.dim}a new project was started in this folder on ${r.restarted.at.slice(0, 10)}${C.reset}` : "",
        `${C.dim}verified by the person or a registered audit agent: ${r.confirmed.size} step(s)${C.reset}`,
        r.reseals.length ? `${C.dim}reseals: ${r.reseals.map((x) => `${x.id} ${x.at.slice(0, 10)} by ${x.by} (${x.kind})`).join("; ")}${C.reset}` : "",
        r.ledgerMissing ? `${C.red}✘ the ledger was deleted — review, then: scenaria integrity --reseal${C.reset}` : r.ledgerBrokenAt ? `${C.red}✘ ledger edited at line ${r.ledgerBrokenAt} — review, then: scenaria integrity --reseal${C.reset}` : `ledger chain intact (${r.entries} entries${r.torn ? `, ${r.torn} torn line(s) from interrupted writes` : ""})`,
        unsealed.length ? `${C.dim}never sealed: ${unsealed.join(", ")}${C.reset}` : "",
      ].filter(Boolean);
      return out(human.filter(Boolean).join("\n"), {
        tampered,
        unsealed,
        ledgerBrokenAt: r.ledgerBrokenAt,
        ledgerMissing: r.ledgerMissing,
        ledgerReplaced: r.ledgerReplaced,
        ledgerDiverged: r.ledgerDiverged,
        resealsUnproven: r.resealsUnproven,
        reseals: r.reseals,
        restarted: r.restarted,
        confirmed: [...r.confirmed],
        verdictsUntrusted: r.verdictsUntrusted,
        verdictsSuperseded: r.verdictsSuperseded,
        verdictsRevoked: r.verdictsRevoked,
        verdictsRemoved: r.verdictsRemoved,
        unseenWrites: r.unseenWrites,
      });
    }
    case "workspace": {
      const s = Scenaria.open(v.root);
      const sections = (v.sections ?? "").split(",").map((x) => x.trim()).filter((x) => (SECTIONS as readonly string[]).includes(x)) as Section[];
      const r = workspace(s, { sections, reader: v.reader, full: v.full });
      return out(renderWorkspace(r), r);
    }
    case "resolve": {
      const s = Scenaria.open(v.root);
      const r = resolveRefs(s, p);
      return out(JSON.stringify(r, null, 2), r);
    }
    case "expect": {
      const s = Scenaria.open(v.root);
      if (!p.length) throw new Error('Usage: scenaria expect "n12 done" "n7 = Postgres" …');
      const r = checkExpectations(s, p);
      return out(renderExpectations(r), r);
    }
    case "string": {
      const s = Scenaria.open(v.root);
      const pl = stringPayload(s, p[0]);
      const icon = pl.verdict === "valid" ? `${C.green}✔ valid` : pl.verdict === "invalid" ? `${C.red}✘ invalid` : `${C.yellow}? unproven`;
      return out(`${JSON.stringify(pl, null, 2)}\n\n${icon}${C.reset} ${pl.reasons.join("; ")}`, pl);
    }
    case "canon": {
      const s = Scenaria.open(v.root);
      const sub = p[0] ?? "list";
      // Binding decisions are a person's: they need a terminal AND typing the confirmation on it.
      // (A speed bump against agents, not a security boundary — the approval itself is signed and audited.)
      const interactive = async (confirm: string, what: string) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("This needs an interactive terminal (a person). Agents can only propose: scenaria_canon {action: \"propose\"}. Or use the dashboard → Kanon (approval link).");
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (await rl.question(`${what}\nType "${confirm}" to confirm: `)).trim();
          if (answer !== confirm) throw new Error("Not confirmed — nothing changed.");
        } finally {
          rl.close();
        }
      };
      const who = { user: v.user, via: "cli" };
      if (sub === "list") {
        const all = s.canon();
        const prop = all.filter((k) => k.status === "proposed");
        const lines = [...(renderCanon(all, 100).length ? ["Active:", ...renderCanon(all, 100)] : ["No active canon events."]), ...(prop.length ? ["Proposals (approve: scenaria canon approve <id>):", ...prop.map((k) => `- ${k.id} (${k.kind}) ${k.text}  ${C.dim}from ${k.proposedBy ?? k.source}${C.reset}`)] : [])];
        return out(lines.join("\n"), all);
      }
      if (sub === "add") {
        const kind = v.future !== undefined ? "future" : "past";
        const text = v.future ?? v.past ?? p.slice(1).join(" ");
        const weight = v.weight !== undefined ? Number(v.weight) : undefined;
        await interactive("add", `Add binding ${kind} canon event: "${text}"${v.check ? `\n  check command (runs when you start checks): ${v.check}` : ""}${v.task ? `\n  completion criterion of ${v.task}${weight !== undefined ? `, weight ${weight}` : ""}${v.artifact ? `, file ${v.artifact}` : ""}` : ""}`);
        const ev = s.addCanonAsUser({ kind, text, check: v.check, due: v.due, hard: !v.soft, task: v.task, weight, artifact: v.artifact }, who);
        return out(`${ev.id} (${ev.kind}, ${ev.hard ? "hard" : "soft"}) active: ${ev.text}`, ev);
      }
      if (sub === "approve" || sub === "reject" || sub === "retire" || sub === "reweigh") {
        if (!p[1]) throw new Error(`Usage: scenaria canon ${sub} <id>${sub === "reweigh" ? " --weight 1-100" : ""}`);
        const cur = s.canon().find((k) => k.id === p[1]);
        if (!cur) throw new Error(`Unknown canon event "${p[1]}"`);
        const weight = v.weight !== undefined ? Number(v.weight) : undefined;
        const crit = cur.task ? `\n  completion criterion of ${cur.task}, weight ${cur.weight ?? "–"}${weight !== undefined ? ` → ${weight}` : ""}${cur.artifact ? `, file ${cur.artifact}` : ""}` : "";
        await interactive(p[1], `${sub} ${cur.id} (${cur.kind}): "${cur.text}"${crit}${cur.suggestedCheck ? `\n  suggested check (NOT adopted from the CLI; set it in the dashboard if wanted): ${cur.suggestedCheck}` : ""}`);
        // Approved exactly as shown above (a change while the person reads is refused).
        const ev = s.decideCanon(p[1], sub, { ...who, reason: v.why, weight, expect: { text: cur.text, task: cur.task, weight: cur.weight, artifact: cur.artifact } });
        return out(`${ev.id} is now ${ev.status}${sub === "reweigh" ? `, weight ${ev.weight}` : ""}: ${ev.text}`, ev);
      }
      if (sub === "check") {
        const cmds = s.canon().filter((k) => k.status === "active" && k.check && (!p.slice(1).length || p.slice(1).includes(k.id)));
        await interactive("run", `Run these check commands in ${s.root}:\n${cmds.map((k) => `  ${k.id}: ${k.check}`).join("\n") || "  (none)"}`);
        const r = await s.checkCanon(p.slice(1).length ? p.slice(1) : undefined, v.user ?? "cli");
        return out(r.length ? r.map((x) => `${x.status === "passed" ? C.green + "✔" : C.red + "✘"}${C.reset} ${x.id} ${x.detail}`).join("\n") : "No approved canon event has a check command.", r);
      }
      if (sub === "gate") {
        const { gateLines, gateMatrix, runGate } = await import("./core/gate.js");
        const lines = p.slice(1).length ? p.slice(1) : gateLines(s).map((l) => l.head);
        const cmds = s.canon().filter((k) => k.status === "active" && k.check);
        if (!v.show) {
          await interactive("run", `Run ${cmds.length} check command(s) on the snapshots of ${lines.length} line(s) (${lines.join(", ")}):\n${cmds.map((k) => `  ${k.id}: ${k.check}`).join("\n") || "  (none)"}`);
          await runGate(s, { lines, by: v.user ?? "cli" });
        }
        const m = gateMatrix(s);
        const icon = (x: string) => (x === "passed" ? `${C.green}✔${C.reset}` : x === "failed" ? `${C.red}✘${C.reset}` : `${C.dim}·${C.reset}`);
        const verdict = (x: string) => (x === "valid" ? `${C.green}survives${C.reset}` : x === "invalid" ? `${C.red}invalid${C.reset}` : `${C.yellow}unproven${C.reset}`);
        const head = `${"line".padEnd(22)} ${m.events.map((e) => e.id.padEnd(4)).join(" ")}  verdict`;
        const rows = m.rows.map((r) => `${`${r.head} ${r.scenario}${r.current ? "*" : ""}`.padEnd(22)} ${r.cells.map((c) => icon(c.status) + "   ").join(" ")}  ${verdict(r.verdict)}`);
        return out([head, ...rows, m.tampered.length ? `${C.red}tampered results ignored: ${m.tampered.join(", ")}${C.reset}` : ""].filter(Boolean).join("\n"), m);
      }
      if (sub === "key") {
        const { ownApproverKey } = await import("./core/canon.js");
        const k = ownApproverKey();
        return out(`Your approver key ${k.id}\n${k.pub}\n${C.dim}Teammates trust your approvals with: scenaria canon trust ${k.pub} --name "<you>"${C.reset}`, k);
      }
      if (sub === "trust") {
        const { trustApprover, trustedApprovers } = await import("./core/canon.js");
        if (!p[1]) {
          const ks = trustedApprovers();
          return out(ks.length ? ks.map((k) => `- ${k.id} ${k.name ?? ""}  ${C.dim}since ${k.addedAt.slice(0, 10)}${C.reset}`).join("\n") : "No teammate keys trusted (your own key always counts).", ks);
        }
        await interactive("trust", `Trust approver key ${p[1].slice(0, 24)}…${v.name ? ` (${v.name})` : ""}?\nEvery canon decision signed with it will be binding on this machine. Only do this with a key you got from that person directly.`);
        const k = trustApprover(p[1], v.name);
        return out(`Trusted approver key ${k.id}${k.name ? ` (${k.name})` : ""}.`, k);
      }
      if (sub === "suggest") {
        if (v.llm) {
          const { archivistProposals } = await import("./core/canon-llm.js");
          const r = await archivistProposals(s, { provider: v.llm, model: v.model, lang: v.lang === "en" ? "en" : "de" });
          return out(`${r.proposed.length} proposal(s) by the archivist (${r.model})${r.skipped ? `, ${r.skipped} skipped` : ""}:\n${r.proposed.map((k) => `- ${k.id} (${k.kind}) ${k.text}`).join("\n")}\nApprove: scenaria canon approve <id>  (or dashboard → Kanon)`, r);
        }
        const sug = s.suggestCanon();
        return out(sug.length ? sug.map((x) => `- (${x.kind}) ${x.text}  ${C.dim}${x.why}${C.reset}`).join("\n") : "No candidates found in the history.", sug);
      }
      throw new Error("Usage: scenaria canon [list|add|approve|reject|retire|suggest|check|gate|key|trust]");
    }
    case "rules": {
      const s = Scenaria.open(v.root);
      const sub = p[0];
      if (sub === "add" || sub === "rm" || sub === "remove" || sub === "approve" || sub === "reject" || sub === "confirm") {
        // Project rules reach every agent: adding, accepting, rejecting and removing are the person's (rule 5):
        // an interactive terminal AND typing the confirmation (a speed bump against agents, like canon).
        const notPerson = 'Project rules are the person\'s decision: run this in an interactive terminal, or use the dashboard (lock → approval mode). Agents can only propose a rule, e.g. with a ```scenaria {"rule": "…"}``` block.';
        if (!isPersonTerminal()) throw new Error(notPerson);
        const decision = { by: process.env.SCENARIA_USER || userInfo().username || "person", via: "terminal" as const };
        if (sub === "add") {
          const text = p.slice(1).join(" ");
          if (!text.trim()) throw new Error('Usage: scenaria rules add "<rule>"');
          await personConfirm("add", `Add this project rule? Every agent receives it from now on:\n  ${text.replace(/\s+/g, " ").trim()}`, notPerson);
          const r = s.addRule(text, "manual", undefined, decision);
          return out(`${r.id}: ${r.text}`, r);
        }
        const iss = s.ruleIssues();
        const target = [...s.ruleProposals(), ...s.rules(), ...iss.unconfirmed, ...iss.tampered].find((r) => r.id === p[1]);
        if (!target) throw new Error(`No rule ${p[1] ?? ""}`);
        if (sub === "approve") {
          await personConfirm("approve", `Accept ${target.id}? Every agent receives it from now on:\n  ${target.text}`, notPerson);
          const r = s.approveRule(target.id, decision, target.text);
          return out(`${C.green}✔${C.reset} ${r.id} is active: ${r.text}`, r);
        }
        if (sub === "confirm") {
          await personConfirm("confirm", `Confirm ${target.id}? It is signed with your approver key, and every agent receives it from now on:\n  ${target.text}`, notPerson);
          const r = s.confirmRule(target.id, decision, target.text);
          return out(`${C.green}✔${C.reset} ${r.id} is confirmed: ${r.text}`, r);
        }
        if (sub === "reject") {
          await personConfirm("reject", `Reject ${target.id}?\n  ${target.text}`, notPerson);
          const ok = s.rejectRule(target.id, decision);
          return out(ok ? `Rejected ${target.id}` : `${target.id} is not an open proposal`, { ok });
        }
        await personConfirm("remove", `Remove ${target.id}? Agents no longer receive it:\n  ${target.text}`, notPerson);
        const ok = s.removeRule(target.id, decision);
        return out(ok ? `Removed ${target.id}` : `No rule ${target.id}`, { ok });
      }
      const rules = s.rules();
      const proposals = s.ruleProposals();
      const issues = s.ruleIssues();
      // Texts of rules that are NOT in effect are for the person: an agent's shell only learns the counts (S2-8).
      if (!isPersonTerminal()) {
        const waiting = proposals.length + issues.unconfirmed.length + issues.tampered.length + issues.missing.length;
        const lines = [
          ...(rules.length ? rules.map((r) => `${r.id}  ${r.text}  ${C.dim}(${r.source})${C.reset}`) : ["No project rules in effect."]),
          ...(waiting ? ["", `${proposals.length} proposal(s), ${issues.unconfirmed.length} rule(s) to confirm, ${issues.tampered.length} changed, ${issues.missing.length} deleted — the person decides in the dashboard or an interactive terminal.`] : []),
        ];
        return out(lines.join("\n"), { rules, counts: { proposals: proposals.length, unconfirmed: issues.unconfirmed.length, tampered: issues.tampered.length, missing: issues.missing.length } });
      }
      const lines = [
        ...(rules.length ? rules.map((r) => `${r.id}  ${r.text}  ${C.dim}(${r.source})${C.reset}`) : ['No project rules yet. Add one: scenaria rules add "<rule>"']),
        ...(proposals.length ? ["", "Proposals (accept: scenaria rules approve <id> · reject: scenaria rules reject <id>):", ...proposals.map((r) => `${r.id}  ${r.text}  ${C.dim}(proposed by ${r.proposedBy ? `"${r.proposedBy}" (stated)` : "an agent"})${C.reset}`)] : []),
        ...(issues.unconfirmed.length ? ["", "Not confirmed — agents do not receive these until you confirm them (scenaria rules confirm <id>):", ...issues.unconfirmed.map((r) => `${r.id}  ${r.text}  ${C.dim}(${r.trust === "untrusted" ? "signed by a key this machine does not trust" : "not signed yet"}; ${r.source}, ${r.createdAt.slice(0, 10)})${C.reset}`)] : []),
        ...(issues.tampered.length ? ["", `${C.red}Changed outside Scenaria — not in effect (check, then confirm or remove):${C.reset}`, ...issues.tampered.map((r) => `${r.id}  ${r.text}`)] : []),
        ...(issues.missing.length ? ["", `${C.red}Deleted outside Scenaria:${C.reset} ${issues.missing.join(", ")}`] : []),
      ];
      return out(lines.join("\n"), { rules, proposals, ...issues });
    }
    case "decide": {
      const s = Scenaria.openOrInit(v.root);
      if (!p[0] || !(v.option?.length)) throw new Error('Usage: scenaria decide "<question>" -o A -o B [--chosen A]');
      const n = s.decide({
        question: p[0],
        options: v.option,
        chosen: v.chosen,
        rationale: v.why,
        context: v.context,
        servesGoal: v.serves,
        expectedOutcome: v.expect,
        assumptions: v.assume,
        confidence: v.confidence ? Number(v.confidence) : undefined,
        ...actor,
      });
      // Open decision: the forecast per option before anyone chooses (no model).
      const { snapshotQuick, quickSummary } = await import("./core/forecast.js");
      const f = n.chosen ? null : snapshotQuick(s, n.id);
      return out(`${describe(n)}${f ? `\nForecast (context kept, before choosing): ${quickSummary(f.options)}  ${C.dim}(details: scenaria forecast ${n.id} --quick)${C.reset}` : ""}`, n);
    }
    case "choose": {
      const s = Scenaria.open(v.root);
      const n = s.choose(p[0], p[1], v.why);
      return out(describe(n), n);
    }
    case "checkpoint": {
      const s = Scenaria.openOrInit(v.root);
      const n = s.checkpoint({
        title: p[0] ?? "Checkpoint",
        outputs: v.out,
        facts: v.fact,
        openQuestions: v.open,
        irreversible: v.irreversible,
        onlyIfChanged: v["if-changed"],
        taskDone: v.done,
        summary: v.summary,
        ...actor,
      });
      return out(n ? describe(n) : "No file changes since HEAD — nothing saved.", n);
    }
    case "status": {
      const s = Scenaria.open(v.root);
      const st = s.status();
      const h = st.head;
      const human = [
        `${C.bold}Scenaria${C.reset} · ${st.projectName}  ${C.dim}${st.root}${C.reset}`,
        `goal:    ${st.project?.goal ?? `${C.yellow}not set — scenaria goal "<main goal>"${C.reset}`}`,
        `task:    ${st.task ? `${st.task.id} ${st.task.title}` : "—"}`,
        `HEAD:    ${h ? `${h.id} [${h.type}${h.scenarioId ? ` ${h.scenarioId}/v${h.version}` : ""}] ${h.title}` : "—"}${st.dirty ? `  ${C.yellow}(unsaved changes)${C.reset}` : ""}`,
        `tasks ${st.counts.tasks} · decisions ${st.counts.decisions} · checkpoints ${st.counts.checkpoints} · branches ${st.counts.branches} · verified ${st.counts.verified} · failed ${st.counts.failed} · rules ${st.rules}`,
        st.snapshots ? "" : `${C.yellow}file snapshots disabled (git not found)${C.reset}`,
      ].filter(Boolean);
      return out(human.join("\n"), st);
    }
    case "tree": {
      const s = Scenaria.open(v.root);
      return out(s.treeText(p[0], { full: v.full }), s.graph());
    }
    case "show": {
      const s = Scenaria.open(v.root);
      const n = s.node(p[0] ?? s.head()?.id ?? "");
      return out(describe(n), n);
    }
    case "context": {
      const s = Scenaria.open(v.root);
      const c = s.context(p[0], { budget: v.budget ? Number(v.budget) : undefined });
      const saved = c.historyTokens > c.tokens ? ` instead of ≈ ${c.historyTokens} tokens of conversation history` : "";
      return out(`${c.markdown}\n\n${C.dim}≈ ${c.tokens} tokens${saved}${C.reset}`, c);
    }
    case "rewind": {
      const s = Scenaria.open(v.root);
      if (!p[0]) throw new Error("Usage: scenaria rewind <id>");
      const r = s.rewind(p[0], { lesson: v.lesson, restoreFiles: !v["no-files"], ...actor });
      const human = [
        `${C.green}⟲${C.reset} HEAD is now ${r.target.id} — ${r.target.title}`,
        r.autosave ? `${C.dim}unsaved work kept as ${r.autosave.id}${C.reset}` : "",
        ...r.warnings.map((w) => `${C.yellow}! ${w}${C.reset}`),
      ].filter(Boolean);
      return out(human.join("\n"), r);
    }
    case "fork": {
      const s = Scenaria.open(v.root);
      if (!p[0] || !p[1]) throw new Error("Usage: scenaria fork <decisionId> <option>");
      const r = s.fork(p[0], p[1], { lesson: v.lesson, ...actor });
      const dec = s.node(p[0]);
      const human = [
        `${C.green}⑂${C.reset} New branch ${r.branch.id} from ${dec.id}: ${optionLabel(dec, r.branch.viaOption)}`,
        r.autosave ? `${C.dim}unsaved work kept as ${r.autosave.id}${C.reset}` : "",
        ...r.warnings.map((w) => `${C.yellow}! ${w}${C.reset}`),
      ].filter(Boolean);
      return out(human.join("\n"), r);
    }
    case "diff": {
      const s = Scenaria.open(v.root);
      const d = s.diff(p[0], p[1]);
      return out(`${C.bold}${d.from} → ${d.to}${C.reset}\n${d.stat}\n\n${d.patch}`, d);
    }
    case "verify": {
      const s = Scenaria.open(v.root);
      // A verdict counts only from the person: an interactive terminal. From an agent's shell it is a self-report.
      const person = Boolean(v.status) && isPersonTerminal();
      if (person) await personConfirm(String(v.status), `Your verdict "${v.status}" on ${p[0] ?? "HEAD"} will count as the person's and is signed with your approver key.`, "");
      // The verify command is a shell command from the project's config, which agents can edit: it runs only when
      // the person starts it at an interactive terminal after seeing its text (never from an agent's shell).
      const verifyCmd = v.run && !v["no-auto"] ? s.config().verifyCommand : undefined;
      const runByPerson = Boolean(verifyCmd) && isPersonTerminal();
      if (runByPerson) await personConfirm("run", `This runs the project's verify command in a shell, with your rights:\n\n  ${verifyCmd}\n\nIt comes from .scenaria/config.json, a file agents can edit. Run it only if this is the command you expect.`, "");
      const n = s.verify(p[0] ?? s.head()?.id ?? "", {
        status: v.status as any,
        notes: v.notes,
        by: v.by ?? (person ? v.user ?? "person" : "cli"),
        auto: !v["no-auto"],
        runCommand: v.run,
        ...(runByPerson ? { commandBy: "person" as const } : {}),
        ...(person ? { origin: "person" as const, via: "terminal" } : {}),
      });
      const note = v.status && !person ? `\n${C.yellow}Recorded as self-reported (not from an interactive terminal): it does not count as verified. The person or a registered audit agent can confirm it.${C.reset}` : "";
      return out(describe(n) + note, n);
    }
    case "auditor": {
      const sub = p[0] ?? "list";
      if (sub === "list") {
        const ks = listAuditors();
        return out(ks.length ? ks.map((k) => `${k.id}  ${k.name ?? ""}  ${C.dim}since ${k.addedAt.slice(0, 10)}${C.reset}`).join("\n") : "No audit agents registered on this machine (scenaria auditor add <public key>).", ks);
      }
      if (sub === "add") {
        const arg = p[1] ?? "";
        const pub = normalizePub(arg && existsSync(arg) ? readFileSync(arg, "utf8") : arg);
        const id = pub ? publicKeyId(pub) : "?";
        await personConfirm("trust", `Register audit agent ${id}${v.name ? ` (${v.name})` : ""}? Its signed verdicts will count as verified and it may reseal the integrity ledger of your projects on this machine.`, "Registering an audit agent is the person's action: run it in an interactive terminal.");
        const k = addAuditor(pub, v.name);
        return out(`Registered audit agent ${k.id}${k.name ? ` (${k.name})` : ""}.`, k);
      }
      if (sub === "remove") {
        await personConfirm("remove", `Unregister audit agent ${p[1]}? Its earlier verdicts stay recorded with their signature.`, "Unregistering an audit agent is the person's action: run it in an interactive terminal.");
        const ok = removeAuditor(String(p[1] ?? ""));
        return out(ok ? `Removed ${p[1]}.` : `No audit agent ${p[1]}.`, { removed: ok });
      }
      if (sub === "keygen") {
        if (!v.dir) throw new Error("Give the folder for the key: scenaria auditor keygen --dir <folder outside every project>");
        const k = auditorKeygen(v.dir);
        return out(`Audit key ${k.id} created.\n  private key: ${k.keyFile}  (keep it there or move it to the audit agent's machine — never into a project)\n  public key:  ${k.pubFile}\nRegister it (as the person): scenaria auditor add ${k.pubFile} --name "<name>"`, { id: k.id, pub: k.pub, keyFile: k.keyFile, pubFile: k.pubFile });
      }
      if (sub === "request") {
        const s = Scenaria.open(v.root);
        const action = p[1];
        const payload =
          action === "verdict" ? buildAuditorRequest(s.store, { action: "verdict", node: String(p[2] ?? ""), status: String(v.status ?? ""), notes: v.notes }) : action === "reseal" ? buildAuditorRequest(s.store, { action: "reseal" }) : null;
        if (!payload) throw new Error("scenaria auditor request verdict <id> --status passed|warning|failed [--notes ..]  |  scenaria auditor request reseal");
        if (v["out-file"]) writeFileSync(v["out-file"], payload);
        return out(payload, JSON.parse(payload));
      }
      if (sub === "sign") {
        if (!v.key) throw new Error("scenaria auditor sign --key <private key file> [payload file|-]");
        const payload = (p[1] && p[1] !== "-" ? readFileSync(p[1], "utf8") : readFileSync(0, "utf8")).trim();
        const env = signAuditorRequest(payload, readFileSync(v.key, "utf8"));
        const text = JSON.stringify(env);
        if (v["out-file"]) writeFileSync(v["out-file"], text);
        return out(text, env);
      }
      if (sub === "submit") {
        const s = Scenaria.open(v.root);
        const raw = p[1] && p[1] !== "-" ? readFileSync(p[1], "utf8") : readFileSync(0, "utf8");
        const r = s.applyAuditorRequest(raw);
        return out(r.action === "verdict" ? `${r.node.id}: ${r.node.verification?.status} (audit agent ${r.node.verification?.auditor?.name ?? r.node.verification?.auditor?.keyId})` : `Resealed ${r.nodes} nodes by the audit agent (record ${r.record.id}).`, r);
      }
      throw new Error(`Unknown: scenaria auditor ${sub} (list | add | remove | keygen | request | sign | submit)`);
    }
    case "last-good": {
      const s = Scenaria.open(v.root);
      const n = s.lastGood(p[0]);
      return out(n ? describe(n) : "No step on this path was verified by the person or a registered audit agent yet.", n);
    }
    case "audit-file": {
      // Checking a signed export needs no project and no Scenaria data: only the file (an auditor's machine).
      if (p[0] === "verify") {
        const { checkExportPath, findNewestExport } = await import("./core/auditpackage.js");
        // Without a name: the newest export in this folder (a package or a single file), named before it is checked.
        let target = p[1];
        let found = "";
        if (!target) {
          const newest = findNewestExport(process.cwd());
          if (!newest) throw new Error("No audit file in this folder. Usage: scenaria audit-file verify [<file.json> | <package folder>]");
          target = newest.path;
          found = newest.others ? ` (${newest.others} other audit file(s) here — name one to check it)` : "";
          found = `Checking the newest audit file here: ${newest.path}${found}\n`;
        }
        const { VERSION } = await import("./server.js");
        const r = checkExportPath(target, VERSION);
        // Nothing read from the file reaches the terminal unchecked (review C4a-2): values shown are computed here
        // or checked against fixed patterns by the verifier; control characters are stripped anyway.
        const safe = (x: unknown) => String(x ?? "").replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g, "?").slice(0, 300);
        const head = safe(found.replace(/\n$/, "")) + (found ? "\n" : "");
        if (!r.valid) {
          process.exitCode = 1;
          return out(`${head}${C.red}NOT VALID: ${safe(r.problem)}${C.reset}`, r);
        }
        const what = (n: string) => (n.endsWith(".txt") ? "note on checking" : "reading copy");
        const copiesSig = (r as { copiesSignature?: string }).copiesSignature;
        const changed = r.copies.filter((c) => c.state === "different").map((c) => c.name);
        // The first line states the overall result (C5, U-K5): a valid evidence in a package with a changed copy is NOT VALID as a whole.
        const whyNot = [
          ...changed.map((n) => `${what(n)} ${n} was changed`),
          ...(copiesSig === "invalid" ? ["the signature over the reading copies does not verify"] : copiesSig === "missing" ? ["the signature over the reading copies is missing"] : []),
        ];
        if (whyNot.length) process.exitCode = 1;
        const copyLine = (c: { name: string; state: string }) =>
          c.state === "same"
            ? `  ${what(c.name)} ${c.name}: ${c.name.endsWith(".txt") ? "as Scenaria wrote it (checked)" : "same content as the evidence (checked)"}`
            : c.state === "missing"
              ? `${C.yellow}  ${what(c.name)} ${c.name}: missing — not checked${C.reset}`
              : c.state === "not_comparable"
                ? `${C.yellow}  ${what(c.name)} ${c.name}: made by another Scenaria version — cannot be compared; rely on the evidence${C.reset}`
                : `${C.red}  ${what(c.name)} ${c.name}: ${c.name.endsWith(".txt") ? "WAS CHANGED — do not follow it; use the key id and fingerprint above" : "DOES NOT SHOW what the evidence holds — do not rely on it"}${C.reset}`;
        return out(
          [
            whyNot.length
              ? `${head}${C.red}NOT VALID as a package: ${safe(whyNot.join("; "))}. The evidence itself (JSON) is valid — rely only on it.${C.reset}\n  evidence: content and signature match.`
              : `${head}${C.green}Valid:${C.reset} content and signature match.`,
            `  fingerprint sha256:${safe(r.digest)}`,
            `  key ${safe(r.keyId)}${r.keyTrustedHere ? " (trusted on this machine)" : " — confirm this key id with the person over a second channel"}`,
            `  project ${safe(r.projectId)} · generated ${safe(r.generatedAt).replace("T", " ").slice(0, 16)} UTC · ${r.names === "roles-only" ? "roles only" : "with names"}`,
            ...((r as { derivations?: number }).derivations !== undefined ? [`  numbers: all ${(r as { derivations?: number }).derivations} derivations recomputed and match`] : []),
            r.integrity === "ok"
              ? "  tamper evidence: intact"
              : `${r.integrity === "alarm" ? C.red : C.yellow}  Note: the signed file itself reports ${r.integrity === "alarm" ? "a DAMAGED tamper evidence (alarm)" : "notes on the tamper evidence"} — read its integrity section.${C.reset}`,
            ...((r as { copiesSignature?: string }).copiesSignature === "invalid" ? [`${C.red}  the signature over the reading copies (audit-file.copies.json) does NOT verify${C.reset}`] : []),
            ...((r as { copiesSignature?: string }).copiesSignature === "missing" ? [`${C.red}  the signature over the reading copies (audit-file.copies.json) is MISSING — every package of this version has it; do not rely on the copies${C.reset}`] : []),
            ...(r.package ? r.copies.map(copyLine) : ["  reading copies: not checked (a single file, not a package folder)"]),
            ...((r as { extra?: string[] }).extra?.length ? [`${C.yellow}  not part of the package, not checked: ${safe((r as { extra?: string[] }).extra!.join(", "))}${C.reset}`] : []),
            "The signature means: computed by Scenaria at that time from these records and released by the key's holder — not that every fact is proven.",
          ].join("\n"),
          r,
        );
      }
      const s = Scenaria.open(v.root);
      if (p[0] === "access") {
        const cur = readAuditAccess(s.store);
        const show = (a: typeof cur) =>
          `Audit file readable by: ${a.mode === "open" ? "everyone who can reach this Scenaria (open)" : "only you, the person (approval mode or interactive terminal)"}` +
          (a.set ? `\n  set by ${a.set.by} via ${a.set.via} on ${a.set.at.slice(0, 16).replace("T", " ")} (signed)` : a.trust === "invalid" ? `\n  ${C.red}The stored setting does not verify (changed outside Scenaria or another key): "only you" applies.${C.reset}` : "\n  (default — never changed)");
        if (!p[1]) return out(show(cur), cur);
        const mode = p[1] as AuditAccessMode;
        if (!AUDIT_ACCESS_MODES.includes(mode)) throw new Error(`Usage: scenaria audit-file access [${AUDIT_ACCESS_MODES.join("|")}]`);
        const notPerson = "Who may read the audit file is the person's setting: run this in an interactive terminal, or use the dashboard (lock → approval mode).";
        await personConfirm(
          mode,
          mode === "open"
            ? "Open the audit file to everyone who can reach this Scenaria (agents too, like the other read endpoints)?"
            : "Allow only you (approval mode or interactive terminal) to read the audit file?",
          notPerson,
        );
        const a = setAuditAccess(s.store, mode, { by: process.env.SCENARIA_USER || userInfo().username || "person", via: "terminal" });
        return out(show(a), a);
      }
      if (p[0] === "evidence") return await evidenceCommand(s, p.slice(1), v, out);
      if (p[0] === "export") {
        // Signing with the person's approver key is the person's action (rule 6): interactive terminal and typed confirmation.
        const { exportAuditFile } = await import("./core/auditexport.js");
        const period = parsePeriod(v.from, v.to);
        const names = v["roles-only"] ? "roles-only" : "with-names";
        const lang = v.lang === "en" ? "en" : "de";
        // The folder is checked before anything is signed (review C4a-5).
        const dir = v["out-dir"] ? String(v["out-dir"]) : process.cwd();
        const { statSync } = await import("node:fs");
        let isDir = false;
        try {
          isDir = statSync(dir).isDirectory();
        } catch {}
        if (!isDir) throw new Error(`--out-dir: "${dir}" is not a folder.`);
        await personConfirm(
          "sign",
          `Export the audit file (${period.from || period.to ? `${period.from ?? "…"} – ${period.to ?? "…"} UTC` : "whole project"}, ${names === "roles-only" ? "roles only" : "with names"}) and sign it with your approver key?`,
          "Signing the audit file is the person's: run this in an interactive terminal, or use the dashboard (lock → approval mode).",
        );
        const { VERSION } = await import("./server.js");
        const x = exportAuditFile(s, period, { names, version: VERSION, by: process.env.SCENARIA_USER || userInfo().username || "person", via: "terminal" });
        const { writeAuditPackage } = await import("./core/auditpackage.js");
        const { signRecord } = await import("./core/canon.js");
        const folder = writeAuditPackage(dir, x, lang, (parts) => signRecord(s.store, parts));
        // Open the print-ready page, so the person can save it as PDF right away (unless --no-open).
        if (!v["no-open"] && isPersonTerminal()) {
          // An absolute path; on Windows not through explorer (it splits at commas; review C4b-7).
          const page = resolve(folder, "audit-file.html");
          // Programs by their absolute system path: never one planted in the project folder (Windows looks there first).
          const { existsSync } = await import("node:fs");
          const opener =
            process.platform === "darwin"
              ? "/usr/bin/open"
              : process.platform === "win32"
                ? join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe")
                : ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open", "/bin/xdg-open"].find((x) => existsSync(x)) ?? "";
          const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", page] : [page];
          if (opener) try {
            const { spawn } = await import("node:child_process");
            const c = spawn(opener, args, { stdio: "ignore", detached: true });
            c.on("error", () => {});
            c.unref();
          } catch {}
        }
        return out(
          [
            `Audit package written: ${folder}`,
            `  audit-file.json   the evidence (signed)`,
            `  audit-file.html   reading copy to print — PDF: in the browser "Print → Save as PDF"`,
            `  audit-file.md     reading copy as text`,
            `  audit-file.copies.json  your signature over both reading copies`,
            `  ${lang === "de" ? "PRUEFEN.txt" : "CHECK.txt"}       what is in it and how to check it`,
            `fingerprint sha256:${x.signature.digest} · key ${x.signature.keyId}`,
            `Check: scenaria audit-file verify "${folder}"`,
          ].join("\n"),
          { folder, digest: x.signature.digest, keyId: x.signature.keyId },
        );
      }
      // The person reads it at an interactive terminal (like every person-only command, rule 6); --out-file
      // writes it to a file after that check. An agent's shell reads it only when the person opened it.
      if (readAuditAccess(s.store).mode !== "open" && !isPersonTerminal()) {
        throw new Error("Only the person reads the audit file (their setting): run this in an interactive terminal (to save it: --out-file <file>), or open the dashboard in approval mode. The person can open it to everyone: scenaria audit-file access open.");
      }
      const f = buildAuditFile(s, parsePeriod(v.from, v.to));
      if (v["out-file"]) {
        writeFileSync(v["out-file"], JSON.stringify(f, null, 2) + "\n");
        return out(`Audit file written to ${v["out-file"]} (${f.summary.partly} partly evidenced, ${f.summary.not_covered} not covered, integrity: ${f.integrity.state})`, { written: v["out-file"], summary: f.summary, integrity: f.integrity.state });
      }
      const lab = (x: { de: string; en: string }) => x.en;
      const status = (c: (typeof f.controls)[number]) => {
        const [word, col] = c.status === "partly" ? ["partly", C.cyan] : c.status === "not_covered" ? ["not covered", C.yellow] : c.status === "organisational" ? ["organisation", C.dim] : [c.status, ""];
        return `${col}${word.padEnd(13)}${col ? C.reset : ""}`;
      };
      const lines = [
        `ISO/IEC 42001 audit file — ${f.project.name} · ${f.period.whole ? "whole project" : `${f.period.from?.replace("T", " ").slice(0, 16) ?? "…"} – ${f.period.to?.replace("T", " ").slice(0, 16) ?? "…"} UTC`} · ${f.period.steps} step(s)`,
        f.integrity.state === "alarm" ? `${C.red}${lab(f.integrity.headline)}${C.reset}` : lab(f.integrity.headline),
        ...f.integrity.warnings.map((w) => `  ${w.level === "alarm" ? `${C.red}!${C.reset}` : "·"} ${lab(w.title)}${w.count > 1 ? ` (${w.count})` : ""}: ${lab(w.explain)}${w.items.length ? ` [${w.items.slice(0, 8).join(", ")}${w.items.length > 8 ? ", …" : ""}]` : ""}`),
        "",
        `${f.summary.partly} partly evidenced · ${f.summary.not_covered} not covered · ${f.summary.organisational} evidence by the organisation${f.summary.withAlarm ? ` · ${C.red}${f.summary.withAlarm} with an integrity alarm${C.reset}` : ""}`,
        `The organisation's documents: ${f.summary.orgDocumented} of ${f.summary.controls} controls documented (signed by the person; they never change a status)`,
        "",
        ...f.controls.map((c) => `${c.alarm ? `${C.red}!${C.reset}` : " "} ${c.id.padEnd(8)} ${status(c)} ${c.orgEvidence.state === "documented" ? `${C.green}doc ✓${C.reset}` : c.orgEvidence.state === "unconfirmed" ? `${C.yellow}doc ?${C.reset}` : "     "} ${lab(c.title)}${c.missing.length ? `${C.dim}  — no data: ${c.missing.join(", ")}${C.reset}` : ""}`),
        "",
        `Signed approvals of rules and work in the period: ${f.sources.approvals.count}${f.sources.approvals.count ? ` (${Object.entries(f.sources.approvals.facts).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}${f.approvals.length > f.sources.approvals.count ? ` · also listed (not counted as approvals): ${[...new Set(f.approvals.filter((a) => !a.carries).map((a) => a.kind))].join(", ")}` : ""}`,
        `Independent verdicts in the period: ${f.sources.verdicts.count}${f.verdictHistory.length ? ` · ${f.verdictHistory.filter((h) => h.earlier.length).length} step(s) with earlier verdicts kept for comparison (${f.verdictHistory.reduce((n, h) => n + h.earlier.length, 0)} earlier, never counted)` : ""}`,
        `Reseals: ${f.reseals.authentic.length} authentic${f.reseals.unproven.length ? `, ${C.red}${f.reseals.unproven.length} without proof${C.reset}` : ""}`,
        `${C.dim}${lab(f.scope)}${C.reset}`,
      ];
      return out(lines.join("\n"), f);
    }
    case "protocol": {
      const s = Scenaria.open(v.root);
      const f = s.writeProtocol();
      return out(`Protocol written: ${f}`, { file: f });
    }
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch(async (err) => {
  process.stderr.write(`${C.red}✘ ${err?.message ?? err}${C.reset}\n`);
  process.exitCode = 1;
  // Started from the start icon: the terminal window would close before anyone could read this.
  if (process.argv.includes("--launcher") && process.stdin.isTTY) {
    process.stderr.write("Press Enter to close this window.\n");
    await new Promise((r) => process.stdin.once("data", r));
  }
});
