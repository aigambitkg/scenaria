#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Scenaria } from "./core/engine.js";
import { optionLabel } from "./core/context.js";
import type { ScenariaNode } from "./core/types.js";

const HELP = `Scenaria — quicksave & checkpoints for AI agents (any LLM, any framework)

Usage: scenaria <command> [options]

Setup
  init [--for <targets>] [--no-rules]   Initialize .scenaria/ and wire agents:
                                        claude, cursor, vscode, gemini, codex, windsurf, generic, all
  ui [--port 4477] [--no-open]          Dashboard / scenario map (local only)
  serve [--host 0.0.0.0] [--port 4477] [--token ..]
                                        Dashboard + HTTP API for teams (token required off-localhost)
  mcp                                   MCP server (stdio) for any MCP client
  watch [--interval 3] [--quiet 15]     Auto-save whenever files change (agents without MCP/hooks)

Record
  mission "<title>" [--goal ..] [--brief ..]
  decide "<question>" -o A -o B [--chosen A] [--why ..] [--assume ..] [--confidence 0.8]
  choose <decisionId> <option> [--why ..]
  checkpoint "<title>" [--out ..] [--fact ..] [--open ..] [--irreversible ..] [--if-changed]

Navigate
  status | tree [missionId] | show <id> | context [id]
  rewind <id> [--lesson ..] [--no-files]
  fork <decisionId> <option> [--lesson ..]
  diff <fromId> [toId|working]

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
      const s = Scenaria.init(v.root, { projectName: v.name });
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
      const interval = Math.max(1, Number(v.interval ?? 3)) * 1000;
      const quiet = Math.max(0, Number(v.quiet ?? 15)) * 1000;
      let lastPrint = "";
      let changedAt = 0;
      let saves = 0;
      process.stdout.write(`Watching ${s.root} — auto-save after ${quiet / 1000}s without changes. Ctrl+C to stop.\n`);
      const tick = () => {
        try {
          // Cheap change detection (paths + size + mtime) — no git objects are written per tick.
          const fp = s.repo!.fingerprint();
          if (fp !== lastPrint) {
            const first = lastPrint === "";
            lastPrint = fp;
            if (!first || s.isDirty()) changedAt = Date.now();
            return;
          }
          if (changedAt && Date.now() - changedAt >= quiet) {
            changedAt = 0;
            const n = s.autoCheckpoint({ agent: v.agent ?? process.env.SCENARIA_AGENT ?? "watch", model: v.model, user: v.user });
            if (n) {
              process.stdout.write(`${C.green}◆${C.reset} ${n.id} ${n.title}\n`);
              if (++saves % 20 === 0) s.repo!.git(["gc", "--auto", "-q"], { allowFail: true });
            }
          }
        } catch (err: any) {
          process.stderr.write(`${C.yellow}! ${err?.message ?? err}${C.reset}\n`);
        }
      };
      tick();
      setInterval(tick, interval);
      return;
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
    case "mission": {
      const s = Scenaria.openOrInit(v.root);
      if (!p[0]) throw new Error('Usage: scenaria mission "<title>" [--goal ..]');
      const n = s.startMission({ title: p[0], goal: v.goal, brief: v.brief, ...actor });
      return out(describe(n), n);
    }
    case "decide": {
      const s = Scenaria.openOrInit(v.root);
      if (!p[0] || !(v.option?.length)) throw new Error('Usage: scenaria decide "<question>" -o A -o B [--chosen A]');
      const n = s.decide({
        question: p[0],
        options: v.option,
        chosen: v.chosen,
        rationale: v.why,
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
        `mission: ${st.mission ? `${st.mission.id} ${st.mission.title}` : "—"}`,
        `HEAD:    ${h ? `${h.id} [${h.type}] ${h.title}` : "—"}${st.dirty ? `  ${C.yellow}(unsaved changes)${C.reset}` : ""}`,
        `nodes ${st.counts.nodes} · decisions ${st.counts.decisions} · checkpoints ${st.counts.checkpoints} · branches ${st.counts.branches} · verified ${st.counts.verified} · failed ${st.counts.failed}`,
        st.snapshots ? "" : `${C.yellow}file snapshots disabled (git not found)${C.reset}`,
      ].filter(Boolean);
      return out(human.join("\n"), st);
    }
    case "tree": {
      const s = Scenaria.open(v.root);
      return out(s.treeText(p[0]), s.graph());
    }
    case "show": {
      const s = Scenaria.open(v.root);
      const n = s.node(p[0] ?? s.head()?.id ?? "");
      return out(describe(n), n);
    }
    case "context": {
      const s = Scenaria.open(v.root);
      const c = s.context(p[0]);
      return out(`${c.markdown}\n\n${C.dim}≈ ${c.tokens} tokens${C.reset}`, c);
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
