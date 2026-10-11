#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Scenaria } from "./core/engine.js";
import { optionLabel } from "./core/context.js";
import type { ScenariaNode } from "./core/types.js";

const HELP = `Scenaria — quicksave & checkpoints for AI agents

Usage: scenaria <command> [options]

Setup
  init [--claude] [--name <n>]      Initialize .scenaria/ (with --claude: MCP, hooks, verifier agent, CLAUDE.md)
  ui [--port 4477] [--no-open]      Open the dashboard / scenario map
  mcp                               Start the MCP server (stdio)

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
  protocol                          Write .scenaria/protocol.md

Global: --root <dir>  --json
`;

const opts = {
  root: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  claude: { type: "boolean" },
  "no-claude-md": { type: "boolean" },
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
  const actor = { agent: v.agent ?? "cli", source: "cli" as const };

  switch (cmd) {
    case "init": {
      const s = Scenaria.init(v.root, { projectName: v.name });
      let msg = `${C.green}✔${C.reset} Scenaria initialized in ${s.store.dir}${s.repo ? "" : `\n${C.yellow}! git not found — file snapshots disabled${C.reset}`}`;
      if (v.claude) {
        const { setupClaude } = await import("./setup.js");
        const changes = setupClaude(s.root, { claudeMd: !v["no-claude-md"] });
        msg += "\n" + changes.map((c) => `${C.green}✔${C.reset} ${c}`).join("\n");
        msg += `\n\nRestart Claude Code in this folder. Then: ${C.cyan}scenaria ui${C.reset}`;
      }
      return out(msg, { root: s.root });
    }
    case "ui": {
      const { startServer } = await import("./server.js");
      const s = Scenaria.open(v.root);
      await startServer(s, { port: v.port ? Number(v.port) : 4477, open: !v["no-open"] });
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
