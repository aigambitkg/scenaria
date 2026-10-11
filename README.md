# Scenaria

**Quicksave for AI agents.** Scenaria records every decision point of an agent run: the question, the options, the choice, the files and a compact fact capsule. When an agent hallucinates or takes a wrong turn, you jump back to exactly that point, or try the option it didn't take.

Scenaria works with any MCP client and ships with Claude Code hooks for automatic capture. A local dashboard draws the run as a scenario tree.

![Scenaria scenario map](docs/screenshot.png)

[Deutsche Version](README.de.md)

## Why

Long agent tasks fail in the middle. Undo tools for files already exist (git, editor checkpoints, Claude Code's `/rewind`), but they save by **time**. Scenaria saves by **decision**:

- **Decision points as first-class objects.** Each one holds the question, all options considered, the chosen one, the rationale, assumptions and confidence. Options that weren't taken stay on the map, and you can explore any of them later.
- **Rewind = files + context.** A rewind restores the files, and it also hands the agent a resume capsule that contains *only* the path that led there. Content from abandoned branches is excluded; at most a one-line lesson is carried over. A hallucination does not leak into the next attempt.
- **Nothing gets lost.** Before every rewind, unsaved work is stored as an autosave node, so a rewind can itself be undone.
- **Verification on the same objects.** Deterministic checks catch some problems automatically: claimed files that don't exist, undocumented changes, low-confidence decisions, irreversible side effects. A verifier agent records its verdict per node, and "last good node" becomes a query.
- **Fewer tokens.** Resuming from a capsule of a few hundred tokens replaces re-reading a long transcript.

## Quick start

Requires Node.js ≥ 20 and git.

```bash
git clone <this repo> scenaria && cd scenaria
npm install
npm run build
npm link            # puts the `scenaria` command on your PATH
```

In the project your agent works on:

```bash
cd ~/Projects/my-app
scenaria init --claude   # .scenaria/, MCP server, hooks, verifier agent, CLAUDE.md rules
claude                   # restart Claude Code in this folder
scenaria ui              # open the scenario map (http://127.0.0.1:4477)
```

Just want to look first? `npm run demo` builds a demo project that contains a hallucinated step, a rewind and an explored alternative. Then run `scenaria ui --root scenaria-demo`. Use `npm run demo -- --lang en` for English content.

## What gets captured

| Source | Captured as |
|---|---|
| First prompt of a session (hook) | Mission with goal and brief |
| `AskUserQuestion` answers (hook) | Decision node, user's answer = chosen option |
| Plan approval / `ExitPlanMode` (hook) | Decision node with the plan |
| Risky Bash (`rm -rf`, `git reset --hard`, …) (hook) | Autosave right before it |
| External effects (`git push`, deploys, `curl -X POST`, …) (hook) | Flagged as *irreversible* on the next node |
| End of each turn with file changes (hook) | Checkpoint; output bullets taken from the agent's final message |
| `scenaria_decide` / `scenaria_checkpoint` (MCP) | Decisions and checkpoints the agent reports itself |

Hooks never block the agent. Errors go to `.scenaria/hook-errors.log`.

## MCP tools

| Tool | Purpose |
|---|---|
| `scenaria_status` | Orientation: mission, HEAD, unsaved changes |
| `scenaria_start_mission` | Root node with main goal and brief |
| `scenaria_decide` | Record a decision point (snapshot included) |
| `scenaria_checkpoint` | Quicksave with fact capsule |
| `scenaria_tree` / `scenaria_get_node` | Inspect the tree |
| `scenaria_context` | Resume capsule for any node |
| `scenaria_rewind` | Jump back (files + HEAD), with a lesson |
| `scenaria_fork` | Explore another option of a past decision |
| `scenaria_diff` | Diff between nodes or against the working tree |
| `scenaria_verify` | Checks + verdict (passed / warning / failed) |
| `scenaria_last_good` | Safest rewind target |

Other MCP clients (Cursor, Windsurf, custom agents):

```json
{ "mcpServers": { "scenaria": { "command": "scenaria", "args": ["mcp"], "env": { "SCENARIA_ROOT": "/path/to/project" } } } }
```

## CLI

```text
scenaria init [--claude]                 scenaria status | tree | show <id> | context [id]
scenaria mission "<title>" --goal ..     scenaria rewind <id> [--lesson ..] [--no-files]
scenaria decide "<q>" -o A -o B --chosen A --why .. --confidence 0.7
scenaria checkpoint "<title>" --out .. --fact .. [--if-changed]
scenaria fork <decisionId> <option>      scenaria diff <from> [to|working]
scenaria verify <id> [--status ..] [--run]   scenaria last-good   scenaria protocol
scenaria ui [--port 4477]                scenaria mcp
```

Add `--json` to any command for machine-readable output.

## The verifier agent

`init --claude` installs `.claude/agents/scenaria-verifier.md`. Ask Claude Code to *"use the scenaria-verifier to check this run"*. It walks the path, compares claims with diffs and files, marks every node and names the last good node to rewind to. Set `verifyCommand` in `.scenaria/config.json` (e.g. `"npm test"`) to include a test run in the checks.

## Where things live

```text
.scenaria/
  config.json      settings (exclude patterns, verifyCommand, context options)
  state.json       HEAD and active mission
  nodes/n7.json    one file per node, the source of truth
  events.jsonl     append-only event log
  kb/n7.md         Obsidian-compatible note per node (local knowledge base)
  protocol.md      human-readable audit protocol (scenaria protocol)
  shadow.git/      private snapshot repository (git-ignored)
```

Snapshots live in a private shadow repository inside `.scenaria/`. Your own `.git`, branches, index and stash are never touched. Your `.gitignore` is honored.

## Limits

- Rewind restores **files**. It cannot undo sent emails, pushes, deploys or database writes. Scenaria flags these as irreversible and warns before you rewind past them.
- Rewinding the *conversation* is done by handing the agent the resume capsule. Claude Code's internal transcript is not edited.
- Very large binary files make snapshots grow. Exclude them via `config.json → exclude`.
- If you move this repository, run `scenaria init --claude` again in your projects (hooks point to the absolute path).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
