# Scenaria

**Quicksave for AI agents — any LLM, any framework, one timeline for conversations, decisions and files.** Scenaria records every decision point of an agent run: the question, the options, the choice, the files and a compact fact capsule. When an agent hallucinates or takes a wrong turn, you jump back to exactly that point, or try the option it didn't take.

The model doesn't matter. Claude, GPT, Gemini, Mistral, Llama via Ollama, or your own fine-tune: they all share the same decision tree, the same verification and the same audit trail. A local dashboard draws the run as a scenario tree.

![Scenaria scenario map](docs/screenshot.png)

[Deutsche Version](README.de.md)

## Why

Long agent tasks fail in the middle. Undo tools for files already exist (git, editor checkpoints, agent-specific rewinds), but they save by **time** and live inside a single vendor's tool. Scenaria saves by **decision**, and it works across tools:

- **Decision points as first-class objects.** Each one holds the question, all options considered, the chosen one, the rationale, assumptions and confidence. Options that weren't taken stay on the map, and you can explore any of them later, even with a different model.
- **Rewind = files + context.** Rewinding restores the files. It also gives the agent a resume capsule containing *only* the path that led there. Abandoned branches are left out; at most a one-line lesson carries over. So a hallucination doesn't leak into the next attempt.
- **Nothing gets lost.** Unsaved work is autosaved before every rewind, so a rewind can be undone too. Ignored files that would be overwritten are backed up as well.
- **Verification on the same objects.** Deterministic checks catch claimed files that don't exist, undocumented changes, low-confidence decisions and irreversible side effects. A verifier records a verdict per node, and that verifier can be a different model from a different vendor.
- **Fewer tokens.** The agent resumes from a capsule of a few hundred tokens instead of re-reading a long transcript.

## Install — one line

```bash
# macOS / Linux: single binary, no Node.js needed
curl -fsSL https://raw.githubusercontent.com/ai-gambit/scenaria/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/ai-gambit/scenaria/main/install.ps1 | iex

# or with Node.js ≥ 20
npm install -g scenaria
```

Scenaria needs `git` for file snapshots (preinstalled on most dev machines; on macOS `xcode-select --install`).

## Use it — one command

```bash
cd ~/Projects/my-app
scenaria start
```

`start` does all of this:
- initializes the project;
- detects your installed agents (Claude Code, Cursor, VS Code/Copilot, Gemini CLI, Codex, Windsurf) and wires them up;
- takes a baseline version;
- opens the dashboard;
- turns on auto-save (every file change becomes a version);
- starts the **conversation proxy** for any LLM provider.

To enable Scenaria for **every** project at once, run this once:

```bash
scenaria setup --global     # user-level agent configs; projects initialize themselves on first use
```

It never initializes your home folder or folders that don't look like a project.

## One overlay for every conversation, any provider

Scenaria records **conversations, decisions and project files on one timeline**, whichever AI you talk to:

| Source | How it is captured |
|---|---|
| Claude Code | Hooks read the session transcript incrementally (prompts, answers, tool calls) |
| Any app with a configurable base URL (OpenAI, Azure, Mistral, Groq, OpenRouter, Gemini, Ollama, LM Studio, Anthropic …) | **Proxy**: set the base URL to `http://127.0.0.1:4477/proxy/<provider>` and keep your own API key |
| n8n, Make, custom code | `POST /api/v1/messages` or the Python client |
| Shell tools | `scenaria log-message --role user --text "…"` |
| ChatGPT web, Claude.ai web | `scenaria import <export.json\|.zip>` (official data exports) |
| Agents without any integration | `scenaria watch` / `start` capture every file change |

The proxy forwards requests unchanged, including streaming, and never stores API keys. It records each turn once, even though chat APIs resend the full history every time. After each answer it saves a version if files changed.

| Provider | Base URL to set in your client |
|---|---|
| OpenAI and compatible SDKs | `http://127.0.0.1:4477/proxy/openai` |
| Anthropic SDK | `http://127.0.0.1:4477/proxy/anthropic` |
| Ollama · LM Studio | `…/proxy/ollama` · `…/proxy/lmstudio` |
| Mistral · Groq · OpenRouter · Gemini (OpenAI-compatible) | `…/proxy/mistral` · `…/proxy/groq` · `…/proxy/openrouter` · `…/proxy/gemini` |
| Anything else | add it under `proxy.upstreams` in `.scenaria/config.json`, or send `x-scenaria-upstream` |

## IDs for everything

| Object | Short id | Global id |
|---|---|---|
| Decision / checkpoint / branch (node) | `n7` | `uid` (ULID, time-sortable) |
| Scenario: one line of work; a fork or new work after a rewind starts a new one | `s2` | — |
| Version: step on the path | `s2/v5` | git refs `refs/scenaria/scenarios/s2/v5` |
| Conversation | `c3` | `uid` + provider's id |
| Message | `m42` | `uid`, linked to the node it belongs to |
| File snapshot | — | commit hash |

`scenaria versions` lists them all. In the dashboard every node shows its `s/v` label, its conversation and its folder.

## Snapshot folders — every version as a real folder

```text
.scenaria/snapshots/
  index.md                                   overview with links
  n1/s1/v003-n4-form-and-webhook/            complete project files at that moment
      src/…  package.json  …
      .scenaria-version/node.json            ids, decision, capsule, model, user
      .scenaria-version/README.md            path of decisions that led here
      .scenaria-version/conversation.md      the conversation that led here
```

Unchanged files are stored only once. On macOS (APFS) they are copy-on-write clones; elsewhere they are hardlinks from a content-addressed cache. Either way, a hundred versions cost about as much disk as one plus the changes. Files are read-only, so history can't be edited by accident.

- `scenaria open n4` reveals a version in Finder or Explorer. Add `--rebuild` to regenerate a folder from the git history, and set `"link": "copy"` under `snapshotFolders` in `.scenaria/config.json` for fully independent copies.
- `scenaria open n4 --copy-to ../try-n4` gives you a writable copy.
- Teams using git can run `scenaria mirror --enable` to publish all versions as `refs/scenaria/*` in their own repository. Branches and index stay untouched. Then `git worktree add ../s2v5 refs/scenaria/scenarios/s2/v5` checks out any version.

## Works with every LLM and agent stack

| You use … | Connect via | Setup |
|---|---|---|
| **Claude Code** | MCP + hooks (automatic capture of prompts, clarifying questions, plan approvals, risky commands) | `scenaria init --for claude` |
| **Cursor · VS Code/Copilot · Gemini CLI · Codex** | MCP + `AGENTS.md` / `GEMINI.md` rules | `scenaria init --for cursor,vscode,gemini,codex` |
| **Windsurf · Cline · Zed · any MCP client** | MCP | `scenaria init --for windsurf` / `--for generic` prints the config |
| **OpenAI · Azure OpenAI · Mistral · Groq · OpenRouter · Ollama · vLLM · LM Studio** | Function calling + HTTP | `scenaria tools --format openai`, [example](examples/openai_compatible_agent.py) |
| **Anthropic API · Gemini API** | Function calling + HTTP | `scenaria tools --format anthropic` / `gemini` |
| **LangChain · LlamaIndex · CrewAI · AutoGen · custom Python** | [Python client](clients/python/scenaria_client.py) (stdlib only) | `scenaria serve` |
| **n8n · Make · Zapier · Power Automate** | HTTP API | `scenaria serve`, [examples](examples/README.md) |
| **Aider · Open Interpreter · shell agents** | CLI | `scenaria call scenaria_checkpoint '{"title":"…"}'` |
| **Agents without any tool support** | File watcher | `scenaria watch` |

All paths use **one tool registry**: the same 13 tools with the same validation behave identically over MCP, HTTP, CLI and function calling.

## For organizations

- **Local-first, no telemetry.** Everything lives in `.scenaria/` inside the project. Nothing leaves the machine unless you run a team server. This keeps it GDPR-friendly and safe for client code.
- **Mixed models, one audit trail.** Every node records `agent`, `model` and `user`. Compare vendors on the same task, or let one model build and another verify.
- **Team server.** `scenaria serve --host 0.0.0.0 --token <secret>` gives the dashboard and API to a team (Bearer token or browser cookie). Locally it only answers on 127.0.0.1 and is protected against DNS rebinding and cross-site requests.
- **Audit and governance.** `scenaria export` produces a machine-readable JSON (nodes and events) for BI or governance tools, and `scenaria protocol` writes a human-readable protocol. Decisions, verdicts, irreversible actions, who and when are all included, which supports ISO/IEC 42001 and AI Act documentation.
- **Rules for every agent.** `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` blocks tell agents when to record decisions. A ready-made [verifier prompt](templates/rules/verifier-prompt.md) works with any LLM.
- **Open source (MIT).** Self-host it, audit it and extend it.

## Tools

| Tool | Purpose |
|---|---|
| `scenaria_status` | Orientation: mission, HEAD, unsaved changes |
| `scenaria_start_mission` | Root node with main goal and brief |
| `scenaria_decide` | Record a decision point (snapshot included) |
| `scenaria_choose` | Resolve a decision recorded as open |
| `scenaria_checkpoint` | Quicksave with fact capsule |
| `scenaria_tree` / `scenaria_get_node` | Inspect the tree |
| `scenaria_context` | Resume capsule for any node |
| `scenaria_rewind` | Jump back (files + HEAD), with a lesson |
| `scenaria_fork` | Explore another option of a past decision |
| `scenaria_diff` | Diff between nodes or against the working tree |
| `scenaria_verify` | Checks + verdict (passed / warning / failed) |
| `scenaria_last_good` | Safest rewind target |

Manual MCP config for any client:

```json
{ "mcpServers": { "scenaria": { "command": "scenaria", "args": ["mcp"],
  "env": { "SCENARIA_ROOT": "/path/to/project", "SCENARIA_AGENT": "my-agent", "SCENARIA_MODEL": "my-model" } } } }
```

## What Claude Code captures automatically

With Claude Code, hooks capture events without the agent having to call anything:

| Source | Captured as |
|---|---|
| First prompt of a session | Mission with goal and brief |
| `AskUserQuestion` answers | Decision node, the user's answer = chosen option |
| Plan approval (`ExitPlanMode`) | Decision node with the plan |
| Risky Bash (`rm -rf`, `git reset --hard`, …) | Autosave right before it |
| External effects (`git push`, deploys, `curl -X POST`, …) | Flagged *irreversible* on the next node |
| End of each turn with file changes | Checkpoint with bullets from the agent's final message |

Other agents record through the tools, guided by `AGENTS.md`. `scenaria watch` adds automatic saves for any agent.

## CLI

```text
scenaria start | setup --global | init [--for <agents>]
scenaria ui | serve [--host --token] | mcp | watch
scenaria mission "<title>" --goal ..     scenaria decide "<q>" -o A -o B --chosen A --why .. --confidence 0.7
scenaria checkpoint "<title>" --out ..   scenaria status | tree | show <id> | context [id]
scenaria rewind <id> [--lesson ..]       scenaria fork <decisionId> <option>      scenaria diff <from> [to]
scenaria versions | open <id> [--copy-to dir] | mirror [--enable]
scenaria conversations | conversation <id> | import <file> | log-message --role .. --text ..
scenaria verify <id> | last-good | export [--format json|md] | protocol
scenaria tools [--format openai|anthropic|gemini|json] | call <tool> '<json>'
```

Global flags: `--root`, `--json`, `--agent`, `--model`, `--user`.

## Where things live

```text
.scenaria/
  config.json        settings (snapshot folders, proxy upstreams, mirror, verifyCommand, …)
  state.json         HEAD, active mission, counters
  nodes/n7.json      one file per node, the source of truth
  events.jsonl       append-only event log
  conversations/     sessions.json + one JSONL per conversation (git-ignored)
  snapshots/         browsable version folders (git-ignored)
  blobs/             deduplicated file cache for the folders (git-ignored)
  kb/n7.md           Obsidian-compatible note per node
  protocol.md        human-readable audit protocol
  shadow.git/        private snapshot repository (git-ignored)
```

Your own `.git`, branches, index and stash are never touched, unless you opt into `mirror`, which adds only `refs/scenaria/*`. Conversations stay local and git-ignored by default. Add `.scenaria/` to your project's `.gitignore` if you don't want the tree itself committed.

## From source

```bash
git clone https://github.com/ai-gambit/scenaria && cd scenaria
npm install          # also builds
npm link
```

## Limits

- Rewind restores **files**. It can't undo sent emails, pushes, deploys or database writes. These are flagged as irreversible, and Scenaria warns you before rewinding past them.
- The *conversation* is rewound by handing the agent the resume capsule. Agent transcripts are not edited.
- In team-server mode, file snapshots cover the project folder on the machine that runs `scenaria serve`.
- The proxy records apps whose base URL you can set. Closed web apps (ChatGPT, Claude.ai) come in via their data export (`scenaria import`); a browser extension is on the roadmap.
- If you move this repository, run `scenaria init --for …` again in your projects, because configs point to its absolute path.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md) and [examples/](examples/README.md).

## License

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
