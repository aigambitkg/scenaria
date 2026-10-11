#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Scenaria } from "./core/engine.js";
import { Store, resolveRoot } from "./core/store.js";
import { optionLabel } from "./core/context.js";
import { agentPrompt, type PromptKind } from "./core/prompts.js";
import { recall, renderRecall } from "./core/recall.js";
import { applyBlocks } from "./core/blocks.js";
import { SECTIONS, checkExpectations, renderExpectations, renderWorkspace, resolveRefs, workspace, type Section } from "./core/workspace.js";
import { dossier, analysisPrompt, projectMetrics, renderMetrics, runAnalysis } from "./core/analysis.js";
import type { ScenariaNode } from "./core/types.js";

const HELP = `Scenaria — quicksave & checkpoints for AI agents (any LLM, any framework)

Usage: scenaria <command> [options]

Quick start
  start [--for <targets>] [--no-open] [--no-watch] [--port 4477]
                                        One command: init, auto-detect & wire your agents, dashboard + proxy + auto-save
  setup --global [--for <targets>]      Register Scenaria once for ALL projects (user-level agent configs)

Setup
  init [--for <targets>] [--no-rules]   Initialize .scenaria/ and wire agents:
                                        claude, cursor, vscode, gemini, codex, windsurf, generic, all
  ui [--port 4477] [--no-open]          Dashboard / scenario map (local only)
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
  integrity [--reseal]                  Ledger check: nodes changed outside Scenaria (--reseal: accept current state, keep old ledger)
  workspace [--sections facts,decisions] [--reader <name>] [--full]
                                        Shared board; with --reader only what that reader does not know yet
  resolve <ref> [<ref> …]               Resolve references (n12, n12.f2, n9.q1, r3)
  expect "<assumption>" […]             Check assumptions; prints only deviations
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
  analyze [--llm <provider> --model <m> [--base-url ..] [--api-key-env ..]] [--lang de|en] [--dossier]
                                        Health check; with --llm: pattern analysis by ANY LLM (Ollama, OpenAI, Anthropic, …)
  rules [add "<rule>" | rm <id>]        Project rules every capsule and prompt carries

Verify & document
  verify <id> [--status passed|warning|failed] [--notes ..] [--by ..] [--run] [--no-auto]
  last-good [id]
  protocol                              Write .scenaria/protocol.md
  export [--format json|md] [--out-file f]  Full export for audits / BI / governance tools

Universal tool layer (same tools as MCP)
  tools [--format openai|openai-responses|anthropic|gemini|json|mcp]
                                        Function-calling schemas for any LLM API
  call <tool> ['<json args>'] [--args-file f]
                                        Run a tool from any shell-capable agent

Global: --root <dir>  --json  --agent <name>  --model <model>  --user <name>
`;

const opts = {
  root: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  claude: { type: "boolean" },
  "no-claude-md": { type: "boolean" },
  "no-rules": { type: "boolean" },
  for: { type: "string" },
  model: { type: "string" },
  user: { type: "string" },
  host: { type: "string" },
  token: { type: "string" },
  format: { type: "string" },
  "out-file": { type: "string" },
  "args-file": { type: "string" },
  interval: { type: "string" },
  quiet: { type: "string" },
  global: { type: "boolean" },
  force: { type: "boolean" },
  rebuild: { type: "boolean" },
  "no-watch": { type: "boolean" },
  "copy-to": { type: "string" },
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
  "base-url": { type: "string" },
  "api-key-env": { type: "string" },
  "max-tokens": { type: "string" },
  dossier: { type: "boolean" },
  limit: { type: "string" },
  sections: { type: "string" },
  reader: { type: "string" },
  reseal: { type: "boolean" },
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
    lines.push(`  verification: ${col}${n.verification.status}${C.reset}${n.verification.notes ? " — " + n.verification.notes : ""}`);
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
      const s = Scenaria.init(v.root, { projectName: v.name, force: v.force });
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
      await startServer(s, { port: v.port ? Number(v.port) : 4477, open: cmd === "ui" && !v["no-open"], host, token: tok, showToken: tok !== token });
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
    case "start": {
      const { setupAgents, parseTargets, detectAgents } = await import("./setup.js");
      const { startServer } = await import("./server.js");
      const startRoot = v.root ?? process.cwd();
      const s = new Store(resolveRoot(startRoot)).exists ? Scenaria.open(startRoot) : Scenaria.init(startRoot, { force: v.force });
      const targets = v.for ? parseTargets(v.for) : detectAgents();
      const r = setupAgents(s.root, [...targets, "generic"].filter((t, i, a) => a.indexOf(t) === i) as any, { rulesFiles: !v["no-rules"] });
      // Baseline AFTER wiring, so agent config files are part of the starting state.
      if (!v["no-watch"]) s.ensureBaseline({ agent: "scenaria", user: v.user, source: "cli" });
      const port = v.port ? Number(v.port) : 4477;
      const srv = await startServer(s, { port, open: !v["no-open"], host: "127.0.0.1", quiet: true });
      const base = srv.url;
      const lines = [
        "",
        `${C.bold}Scenaria is running${C.reset} for ${s.root}`,
        "",
        `  Dashboard      ${C.cyan}${base}${C.reset}`,
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
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        const { spawn } = await import("node:child_process");
        try {
          spawn(cmd, [folder], { stdio: "ignore", detached: true }).unref();
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
    case "analyze": {
      const s = Scenaria.open(v.root);
      const lang = v.lang === "en" ? "en" : "de";
      if (v.dossier) {
        const d = dossier(s, { maxTokens: v["max-tokens"] ? Number(v["max-tokens"]) : undefined });
        const text = `${analysisPrompt(lang)}\n\n--- DOSSIER ---\n${d.text}`;
        return out(text, { ...d, prompt: analysisPrompt(lang) });
      }
      const m = projectMetrics(s);
      if (!v.llm && !s.config().analysis) {
        return out(`${renderMetrics(m, 30)}\n\n${C.dim}Pattern analysis with any LLM: scenaria analyze --llm ollama --model llama3.3   (or openai/anthropic/… with the API key in its env var)\nOr copy the dossier into any chat: scenaria analyze --dossier${C.reset}`, m);
      }
      process.stderr.write(`${C.dim}Analysing with ${v.llm ?? s.config().analysis?.provider} …${C.reset}\n`);
      const rec = await runAnalysis(s, { provider: v.llm, model: v.model, baseUrl: v["base-url"], apiKeyEnv: v["api-key-env"], lang, maxTokens: v["max-tokens"] ? Number(v["max-tokens"]) : undefined });
      const ins = rec.insights;
      const human = [
        `${C.bold}Analysis ${rec.id}${C.reset} · ${rec.provider}/${rec.model} · health ${rec.health}/100`,
        ins.summary ?? "",
        ins.goalAlignment ? `Goal alignment: ${ins.goalAlignment.score ?? "?"}/100 — ${ins.goalAlignment.notes ?? ""}` : "",
        ...(ins.patterns ?? []).map((x) => `${x.kind === "good" ? C.green + "+" : C.yellow + "−"}${C.reset} ${x.title}${x.evidence?.length ? C.dim + ` (${x.evidence.join(", ")})` + C.reset : ""}`),
        ...(ins.issues ?? []).map((x) => `${C.red}!${C.reset} [${x.severity ?? "?"}] ${x.title}${x.fix ? ` → ${x.fix}` : ""}`),
        ...(ins.rules ?? []).map((r, i) => `rule #${i}: ${r.text}`),
        ins.rules?.length ? `${C.dim}Accept a rule: scenaria rules add "<text>"  (or in the dashboard → Analyse)${C.reset}` : "",
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
    case "integrity": {
      const s = Scenaria.open(v.root);
      if (v.reseal) {
        const rs = s.reseal({ user: v.user, agent: "cli", source: "cli" });
        return out(`Resealed ${rs.nodes} nodes${rs.archived ? `; previous ledger kept as .scenaria/${rs.archived}` : ""}.`, rs);
      }
      const r = s.integrity();
      const tampered = [...r.state.entries()].filter(([, st]) => st === "tampered").map(([id]) => id);
      const unsealed = [...r.state.entries()].filter(([, st]) => st === "unsealed").map(([id]) => id);
      const human = [
        tampered.length ? `${C.red}✘ changed outside Scenaria: ${tampered.join(", ")}${C.reset}` : `${C.green}✔ all ${r.state.size} nodes match the ledger${C.reset}`,
        r.ledgerMissing ? `${C.red}✘ the ledger was deleted — review, then: scenaria integrity --reseal${C.reset}` : r.ledgerBrokenAt ? `${C.red}✘ ledger edited at line ${r.ledgerBrokenAt} — review, then: scenaria integrity --reseal${C.reset}` : `ledger chain intact (${r.entries} entries${r.torn ? `, ${r.torn} torn line(s) from interrupted writes` : ""})`,
        unsealed.length ? `${C.dim}never sealed: ${unsealed.join(", ")}${C.reset}` : "",
      ].filter(Boolean);
      return out(human.join("\n"), { tampered, unsealed, ledgerBrokenAt: r.ledgerBrokenAt });
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
    case "rules": {
      const s = Scenaria.open(v.root);
      if (p[0] === "add") {
        const r = s.addRule(p.slice(1).join(" "), "manual");
        return out(`${r.id}: ${r.text}`, r);
      }
      if (p[0] === "rm" || p[0] === "remove") {
        const ok = s.removeRule(p[1] ?? "");
        return out(ok ? `Removed ${p[1]}` : `No rule ${p[1]}`, { ok });
      }
      const rules = s.rules();
      return out(rules.length ? rules.map((r) => `${r.id}  ${r.text}  ${C.dim}(${r.source})${C.reset}`).join("\n") : 'No project rules yet. Add one: scenaria rules add "<rule>"', rules);
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
      return out(describe(n), n);
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
      const n = s.verify(p[0] ?? s.head()?.id ?? "", {
        status: v.status as any,
        notes: v.notes,
        by: v.by ?? "cli",
        auto: !v["no-auto"],
        runCommand: v.run,
      });
      return out(describe(n), n);
    }
    case "last-good": {
      const s = Scenaria.open(v.root);
      const n = s.lastGood(p[0]);
      return out(n ? describe(n) : "No verified-good node on this path yet.", n);
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

main().catch((err) => {
  process.stderr.write(`${C.red}✘ ${err?.message ?? err}${C.reset}\n`);
  process.exitCode = 1;
});
