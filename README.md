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
curl -fsSL https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.ps1 | iex

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

Claude Code needs no instructions: its hooks capture prompts, questions, plans and file changes, and every prompt carries a one-line Scenaria reminder. For any other agent or chat, click **Agent prompt** in the dashboard (or run `scenaria prompt`) and paste the ready-made text. There are three versions: MCP agents, shell agents, and plain chats without tools.

## One project tree, one main goal

Each project has exactly **one** decision tree. Its root `n0` holds the project and its **main goal**. Every piece of work becomes a **task** (sub-goal) on that line, whether an agent session, a proxied conversation or a manual `scenaria task`. Finished tasks fold into a single node on the map, so even a project that runs for months stays readable. A new scenario (`s2`, `s3`, …) appears only when the line really branches: a fork, or new work after a rewind. That way you can see where the project turned, who decided and why.

A task is created only when a session actually produces something. A quick question that changes nothing leaves the map untouched. Projects from older versions, which had one tree per mission, are joined into one project tree automatically on first open. A backup is kept in `.scenaria/backups/`.

## Every decision with context, analysed by any LLM

A decision records more than question, options and choice:
- `rationale`: why this option. It is required whenever an option is chosen; set `requireRationale: false` to turn this off.
- `context`: the situation that made the decision necessary.
- `servesGoal`: how it serves the main goal.
- `expectedOutcome`: what should be observable if the choice was right.
- `trigger`: the user request that led to it. Scenaria captures this automatically.

Missing fields are flagged on the map and in the agent's tool result.

- **Health check (no LLM, no tokens):** `scenaria analyze` / dashboard → *Analysis*. It checks:
  - whether the main goal is set;
  - whether decisions carry context, rationale and a goal link;
  - work built on failed checks;
  - open or low-confidence decisions;
  - tasks that needed many restarts;
  - quality per agent and per model.
- **Pattern analysis with any model:** `scenaria analyze --llm ollama --model llama3.3` (or `openai`, `anthropic`, `gemini`, `mistral`, `openrouter`, `groq`, or any OpenAI-compatible URL).
  - Only a compact, token-budgeted dossier is sent.
  - API keys come from environment variables, or from a key entered for a single run in the dashboard. They are never stored.
  - Without any API: `scenaria analyze --dossier` copies the dossier into any chat, and you paste the result back.
- **The loop closes:** accepted recommendations become **project rules**. Every capsule and every agent prompt carries them from then on.

## Canon events: the project's fixed points

Some things must hold no matter which agent works next. Scenaria calls them **canon events**:
- **Past:** settled constraints, e.g. "Runs only in AWS eu-central-1", "TypeScript only", "No cookies without consent".
- **Future:** milestones the work must survive, e.g. "10k requests/s by 2027-01-01", optionally with a check command that proves it.

How they are governed:
- **You approve, agents propose.** Agents (`scenaria_canon {action: "propose"}`), chat blocks and the **archivist** only create proposals. A fixed point becomes binding when you approve it: in the dashboard under *Canon*, or with `scenaria canon approve` in an interactive terminal. The approval is recorded (who, via which surface).
- **The archivist** suggests candidates from the recorded history: verified or confident decisions, and obligations in facts and rules. With `scenaria canon suggest --llm …` or *Ask the archivist*, any LLM extracts proposals with evidence.
- **Checks run only on your request.** Only approved events are checked: `scenaria canon check` or *Run checks*; agents never trigger them. A suggested command only becomes the check if you tick *adopt* for exactly that command.
- **Approvals are signed.** Every binding decision carries an Ed25519 signature from your approver key (`~/.config/scenaria/approver-key.pem`, never in the project). Signatures are bound to the project and to a revision, and your machine remembers the newest revision it has seen (outside the project), so restoring an older signed `canon.json` or copying one from another project doesn't work either. An event whose signature is missing, wrong, outdated or from a key you don't trust is **not binding** and shows up as *not binding — review needed* (e.g. `canon.json` edited by hand, by an agent or by a merge). Teammates: `scenaria canon key` prints your public key; `scenaria canon trust <key> --name ..` trusts someone else's.
- **The approval link** (`scenaria start`/`ui`) opens the dashboard with approval rights in your browser. It works once and is printed only in an interactive terminal.

What this protects against, honestly: agents, chat blocks, API tokens and edits to repository files can't make anything binding. It is tamper-evident, not tamper-proof: a malicious program running with your full user rights can read your key.

How canon events are enforced:
- Every capsule and every prompt carries the active fixed points; hard ones are never trimmed by the token budget.
- Decisions state which ones they respect (`respectsCanon`).
- Breaking one needs `breaksCanon` plus a rationale. It shows up in the health check, the fidelity chart (⚑) and the board.

**The string:** `scenaria string` (and `scenaria_context {mode: "string"}`) turns one line of work into a payload:
- past constraints;
- the decisions taken;
- future checks with their status;
- a verdict: *valid*, *not yet proven* or *invalid*.

**The gate — surviving strings:** `scenaria canon gate` (or *Canon → Lines of work*) runs the adopted check commands on the snapshot of **every** line of work, each in a temporary copy (your working tree stays untouched; `node_modules` & co. are linked). The table shows which lines survive every hard fixed point. Results are signed like approvals; edited or restored results are ignored and reported.

**The relay — archivist → craftsman → oracle:** for one high-impact decision, `scenaria relay "<question>" --decide` (or *Chat → Ask the oracle*) makes three separate model calls, each with only its slice of the context: the archivist reads the past (dossier, rules, past canon), the craftsman proposes 2–4 options for the present, the oracle tests them against the future fixed points. The orchestrator — plain code, not a model — cuts options that break hard canon, and records an **open decision**; you choose. Each role can use its own model.

## Control Scenaria from one place: settings, chat, your own agent

- **Settings (⚙):** one model for chat, analysis, archivist and relay — local (Ollama, LM Studio) or any API — plus an optional model per function, a model list and a connection test. API keys are **never stored**: Scenaria uses the key from an environment variable, or one you type in for this browser session. An environment key only goes to the provider's official endpoint or to endpoints you trust there (an agent or a project file cannot redirect it). The same page connects your agents via MCP with one click and shows copy-paste snippets for any other agent (MCP JSON, HTTP tools, proxy URLs).
- **Chat (right panel):** talk to your model; it operates Scenaria with the same tools as your agents — status, context, decisions, checkpoints, tasks, canon proposals, the relay. Your own actions work from the chat too — approving/rejecting canon, running checks, the gate, the model analysis, switching the model, connecting agents: the model only *asks*, Scenaria shows a card with exactly what will happen, and it runs after your click. Rewind and fork wait for your OK as well (setting). Every chat is recorded as a conversation. Ollama is called through its native API with a 16k context window (`SCENARIA_OLLAMA_CTX`), so tools and project state are never cut off; tool calls that small models write as text are understood.
- **Your own agent:** connect it in Settings (MCP) or call the HTTP tools — it gets exactly the same capabilities and limits as the built-in chat.

Settings, chat and relay act for you and use your keys, so they need the approval session (the approval link from `scenaria start`), like canon approvals.

## Forecasts, the oracle and the auditor: see before you choose (v0.9)

Every open decision gets a **forecast before anyone chooses**: how faithful the line will stay to its context and the main goal after each option. It is the same quantity Scenaria measures afterwards, so every forecast can be checked against reality.

- **Core** (instant, no model): a small formula you can retrace by hand. "Why this number?" shows every part, the weights learned from your own past decisions and an honest uncertainty band.
- **Oracle** (multiverse, your model): archivist (past), craftsman (present) and oracle (future) may only **correct** the core, by at most ±20 points per part, each correction with a reason and existing evidence. Corrections without evidence count 0; how much the oracle is trusted (γ) is learned from how its corrections really went.
- **Auditor (Prüf-Experte)**: a checklist on every forecast (fair timing, signature, data basis, options distinguishable, track record, evidence) → reliable / with caution / not reliable. On request a skeptical model checks each oracle claim against the evidence as it was cited and removes unsupported corrections.
- **Simple to use**: the Forecasts dialog starts with a ready check (model, approval, main goal) and three paths: forecast a decision (or write one down), check a prompt, or check a past decision against what really happened. You see which role is working and get the result in plain words.
- **Audit area** (top bar → **Audit**): every forecast with a traffic light, key figures and an audit report to download (Markdown/JSON) — read-only.
- **Quality**: a backtest of every past decision as of its own time, oracle vs. core, and a test bench. Honest: meaningful from 10 decisions, shown as a tendency before.

Prompts and plans can be checked the same way, with variants side by side. Automatic forecasts are opt-in, use only your model and have a daily limit across all projects. Dashboard → **Forecasts**, CLI `scenaria forecast n12` / `--quality` / `--audit f3 [--deep]`, chat, or the `scenaria_forecast` tool for agents.

## The expert analyst: a report to optimise with (v0.8)

Analysis → **★ Expert analysis** reviews one line, the whole project or **all your projects** through four lenses: architecture & technical decisions, goal & product alignment, agent workflow & context engineering, governance & risk (in the spirit of ISO/IEC 42001). The facts are always computed and shown first. Whatever the model writes is checked against them: wrong figures and statements that contradict the facts are marked and cannot be adopted, evidence must fit the finding, and the model can move the maturity score by at most ±15. Recommendations are prioritised (P1–P3, effort, KPI to move). Rules are adopted with one click and become project rules for every agent; tasks get a direct button. Reports are signed and export as Markdown. Without a model you get the rule-based report. CLI: `scenaria analyst`.

## Several projects: switch with one click (v0.8)

Click the project name at the top to see your Scenaria projects on this computer and switch the dashboard. Your approval and your keys (memory only) stay. Agents keep working in their own project: MCP agents run in their own folder, and the server's HTTP tools, LLM proxy and auto-save stay with the project it was started in.

## Help and introduction

**?** (top right) explains every function in plain words, and every dialog has its own **?**. On the first visit a short introduction (goal → agent → model → forecasts → fixed points and analysis) gets you going. You can skip it, and restart it from **More → Introduction**.

## Context fidelity: see where context broke, changed or was manipulated

Select any node to see a line from the project root to that node, with a percentage per step. Each node's score combines:
- its **line to the main goal**: textual overlap with the main and task goal, or an explicit `servesGoal`;
- its **continuity** with the steps before it, or explicit `basedOn` references;
- **integrity**: whether the node still matches what Scenaria wrote;
- **reliability**: checks and confidence.

Markers show where context **broke off**, where the **main goal changed**, where the line **branched**, and which steps were **changed outside Scenaria**. Every node also gets a thin fidelity bar on the map, and `scenaria fidelity [id]` prints the same line in the terminal.

Manipulation becomes visible through an append-only **integrity ledger** (`.scenaria/ledger.jsonl`):
- Every write stores the node's content hash, and the ledger lines form a hash chain.
- A node file edited by hand, or an edited ledger, shows up in `scenaria integrity`, in the health check and on the map.
- Tamper-*evident*, not tamper-proof: someone who rewrites both the nodes and the entire ledger is not detected locally.

Overlap is lexical: it works offline and costs no tokens. Decisions written in another language than the goal should state `servesGoal`.

## Handoffs without re-sending everything

Agents share one structured board instead of passing chat histories around:
- **Global workspace:** `scenaria_workspace` returns the board, i.e. goals, decisions, facts, open questions, rules, lessons and risks. Each item carries a reference and its confidence. Readers pick the sections they need.
- **Context by reference:** `n12` (node), `n12.f2` (its 2nd fact), `n12.q1` (open question), `r3` (rule).
  - Pass references instead of content; `scenaria_get_node {refs}` resolves only what is needed.
  - `scenaria_context {mode: "refs"}` is a short index.
- **Theory of mind:** with a `reader` name, Scenaria remembers what that reader already knows. It then sends only new and changed items, plus items that became **invalid**, e.g. after a rewind.
- **Predictive coding:** before taking over, an agent states its assumptions (`"n12 done"`, `"n7 = Postgres"`, `"n12.f2"`, or free text) in `scenaria_expect`. It gets back only the deviations.
- **Confidence per statement:** facts can be `{text, confidence, basedOn}`. Low-confidence items are flagged "verify" in capsules and on the board.

## Few tokens, long memory

- The **resume capsule** has a token budget (default 1,500 tokens):
  - main goal, project rules and the current task in detail;
  - each earlier task as a one-line rollup: its summary, key decisions, result and lesson.
- Whatever doesn't fit stays reachable with **`scenaria_recall`**, a keyword search (BM25, offline) over decisions, rationales, lessons, checkpoints and conversations. Agents fetch details on demand instead of re-reading long histories.
- `scenaria_tree` folds finished tasks to one line each.
- The dashboard shows the capsule size next to the raw conversation history it replaces.

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

All paths use **one tool registry**: the same 18 tools with the same validation behave identically over MCP, HTTP, CLI and function calling.

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
| `scenaria_status` | Orientation: main goal, current task, HEAD, unsaved changes |
| `scenaria_start_mission` | Start a task in the project tree (or set the main goal with `projectGoal`) |
| `scenaria_decide` | Record a decision point with rationale, context, goal link (snapshot included) |
| `scenaria_choose` | Resolve a decision recorded as open |
| `scenaria_checkpoint` | Quicksave with fact capsule |
| `scenaria_tree` / `scenaria_get_node` | Inspect the tree |
| `scenaria_context` | Resume capsule for any node |
| `scenaria_rewind` | Jump back (files + HEAD), with a lesson |
| `scenaria_fork` | Explore another option of a past decision |
| `scenaria_diff` | Diff between nodes or against the working tree |
| `scenaria_verify` | Checks + verdict (passed / warning / failed) |
| `scenaria_last_good` | Safest rewind target |
| `scenaria_recall` | Keyword search over the whole project memory |
| `scenaria_health` | Deterministic quality check of the tree (incl. manipulation) |
| `scenaria_workspace` | Shared board by sections; with a reader name only the gap |
| `scenaria_expect` | Check assumptions; returns only deviations |
| `scenaria_canon` | List fixed points, archivist suggestions, propose a new one (approval stays with the user) |

Manual MCP config for any client:

```json
{ "mcpServers": { "scenaria": { "command": "scenaria", "args": ["mcp"],
  "env": { "SCENARIA_ROOT": "/path/to/project", "SCENARIA_AGENT": "my-agent", "SCENARIA_MODEL": "my-model" } } } }
```

## What Claude Code captures automatically

With Claude Code, hooks capture events without the agent having to call anything:

| Source | Captured as |
|---|---|
| Every prompt | One-line reminder: main goal, task, how to record (≈ 60–100 tokens) |
| A session's first real step | A task (sub-goal) titled after the request that led to work |
| `AskUserQuestion` answers | Decision node, the user's answer = chosen option |
| Plan approval (`ExitPlanMode`) | Decision node with the plan |
| Risky Bash (`rm -rf`, `git reset --hard`, …) | Autosave right before it |
| External effects (`git push`, deploys, `curl -X POST`, …) | Flagged *irreversible* on the next node |
| End of each turn with file changes | Checkpoint with bullets from the agent's final message |
| ` ```scenaria ` blocks in an answer | Decisions / tasks / checkpoints |

Other agents record through the tools, guided by `AGENTS.md` and the dashboard's agent prompt. Plain chats (ChatGPT, Claude.ai, local UIs) add small ` ```scenaria ` blocks that the proxy picks up, or you paste the answer into the dashboard. `scenaria watch` adds automatic saves for any agent.

## CLI

```text
scenaria start | setup --global | init [--for <agents>]
scenaria ui | serve [--host --token] | mcp | watch
scenaria goal ["<main goal>"]            scenaria task "<title>" --goal ..
scenaria decide "<q>" -o A -o B --chosen A --why .. --context .. --serves .. --confidence 0.7
scenaria checkpoint "<title>" --out .. [--done --summary ..]
scenaria status | tree [id] [--full] | show <id> | context [id] [--budget 1500] | recall "<keywords>"
scenaria prompt [--kind mcp|cli|chat] [--lang de|en] | ingest-text [file] | rules [add|rm]
scenaria analyze [--llm <provider> --model <m>] [--dossier]
scenaria fidelity [id] | integrity | workspace [--reader ..] [--sections ..] | resolve <refs> | expect "<assumption>" … | string [id]
scenaria canon [list|add --past|--future ".." [--check ..] [--due ..]|approve|reject|retire <id>|suggest [--llm ..]|check|gate [node …]|key|trust <key>]
scenaria relay "<question>" [--options "A|B"] [--decide] [--llm <provider> --model <m>]
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
  state.json         HEAD, project root, current task, counters
  memory.json        project rules (carried by every capsule and prompt)
  canon.json         canon events: fixed points, proposals, approvals, last checks (commit it)
  ledger.jsonl       integrity ledger (content hash per write, hash-chained)
  readers.json       what each reader already knows (workspace deltas)
  analyses/          stored LLM analyses
  backups/           node backups taken before schema migrations
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
git clone https://github.com/aigambitkg/scenaria && cd scenaria
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

## Developing Scenaria

Continuing the development (people or agents): start with [docs/HANDOFF.md](docs/HANDOFF.md) — rules that must never be broken, build and test, module map, working method and open points. Then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
