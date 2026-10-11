# Architecture

## Main goal

Every decision point of an agent run leaves a **restorable, verifiable state**. If something goes wrong, you get back to that point in seconds: the files return to how they were, and the agent receives a compact capsule of facts so it can continue cleanly or try the alternative.

## Components

```text
 any MCP client ─┐   Claude hooks ─┐   shell agents ─┐   any LLM API / n8n / Python ─┐   watcher ─┐
   (Claude Code,  │   (auto capture) │   scenaria call  │   HTTP /api/v1/tools/<name>   │  scenaria  │
   Cursor, VS Code,│                  │                  │   + schemas (?format=openai…) │   watch    │
   Gemini, Codex…) │                  │                  │                                │            │
                   ▼                  ▼                  ▼                                ▼            ▼
             ┌──────────────────────────────────────────────────────────────────────────────────────┐
             │  tools.ts — ONE vendor-neutral tool registry (13 tools, zod schemas, validation)      │
             └───────────────────────────────────────────┬──────────────────────────────────────────┘
                                                         ▼
                     ┌─────────────────────┐        ┌──────────────────┐
                     │   core / engine     │ ◀────▶ │ server (ui/serve)│ ◀── browser (React Flow)
                     │ decide · checkpoint │        │ REST + SSE, token│
                     │ rewind · fork ·     │        └──────────────────┘
                     │ verify · context    │
                     └───┬─────────────┬───┘
                         ▼             ▼
                 .scenaria/nodes   .scenaria/shadow.git
                 events.jsonl      (file snapshots)
                 kb/*.md
```

| Module | File | Role |
|---|---|---|
| Types | `src/core/types.ts` | Data model (nodes, options, snapshots, verification, attribution) |
| Store | `src/core/store.ts` | JSON files, append-only event log, cross-process lock |
| Snapshots | `src/core/snapshot.ts` | Private shadow git repository |
| Engine | `src/core/engine.ts` | All operations; the only writer |
| Context | `src/core/context.ts` | Resume capsule, token estimate |
| Verify | `src/core/verify.ts` | Deterministic checks |
| Protocol | `src/core/protocol.ts` | Knowledge-base notes, audit protocol |
| **Tools** | `src/tools.ts` | Vendor-neutral tool registry + schema export (OpenAI, Anthropic, Gemini, JSON, MCP) |
| MCP | `src/mcp.ts` | Registers the registry over stdio |
| Hooks | `src/hooks.ts` | Claude Code automatic capture, never blocking |
| Setup | `src/setup.ts` | Idempotent wiring for Claude, Cursor, VS Code, Gemini CLI, Codex, Windsurf, AGENTS.md |
| Server | `src/server.ts` | Dashboard API, `/api/v1` tool API, local or token-protected team mode |
| Python client | `clients/python/scenaria_client.py` | stdlib-only client for any Python agent stack |
| UI | `ui/` | Vite + React + React Flow, prebuilt into `dist/ui` |

## Vendor neutrality

- **One registry, many transports.** Each tool is defined once with a zod input schema and a handler that returns `{text, data}`, where `text` is meant for an LLM and `data` for programs. MCP, HTTP (`POST /api/v1/tools/<name>`), the CLI (`scenaria call`) and custom code all validate and run through `callTool()`.
- **Schema export** (`scenaria tools --format …`, `GET /api/v1/tools?format=…`):
  - `openai` (Chat Completions), `openai-responses`, `anthropic` (`input_schema`), `mcp` and `json`.
  - `gemini`: converted to the OpenAPI subset Gemini accepts (no type arrays, `anyOf` or `additionalProperties`; argument-less tools have no parameters).
- **OpenAI-style arguments.** The HTTP API accepts `{"arguments": "<json string>"}`, so tool calls can be forwarded unchanged.
- **Attribution.** `agent`, `model` and `user` are stored on every node. They come from `SCENARIA_AGENT` / `SCENARIA_MODEL` / `SCENARIA_USER` (MCP), the `x-scenaria-agent|model|user` headers (HTTP) or `--agent/--model/--user` (CLI). `user` defaults to the OS account.
- **Capture without tools.** `scenaria watch` polls the shadow index (incremental `git add`, cheap). After a quiet period it writes an auto-checkpoint titled with the changed files. This works for any agent that writes files.
- **Rules files.** `AGENTS.md` is the cross-vendor convention; `CLAUDE.md` and `GEMINI.md` get the same block. The Claude block additionally mentions hook-based auto capture.

## Data model

A **mission** is the root of a tree. Each node has a `type`:

- `mission`: goal and brief.
- `decision`: question, `options[]` (ids `a`, `b`, …), `chosen`, rationale, assumptions, confidence.
- `checkpoint`: a progress save holding outputs, facts, open questions, irreversible effects and changed files.
- `branch`: the start of an alternative explored via `fork`. Its `viaOption` names the option.
- `autosave`: an automatic save, made before a rewind or a risky command.

Children of a decision carry `viaOption`, which records the option they continue. Options that no child has taken are drawn as dashed "ghost" nodes, and you can start any of them at any time.

`state.json` holds `head`. New nodes attach under HEAD, and rewind and fork move it.

## Snapshots

`git` runs with `GIT_DIR=.scenaria/shadow.git`, `GIT_WORK_TREE=<project>` and `GIT_INDEX_FILE=.scenaria/shadow.index`:

- Snapshot: `add -A` → `write-tree` → `commit-tree` → `update-ref refs/scenaria/<id>`. The ref pins it against garbage collection.
- Restore: `add -A` (the index learns about new files), then `read-tree -u --reset <commit>`. This restores modified and deleted files and removes files that were created after the snapshot. Ignored files stay untouched.
- The project's `.gitignore` is honored. `.scenaria/` is excluded by an explicit pathspec (`:(top,literal,exclude).scenaria`) on every `add`, so even allowlist-style ignores (`*`, `!*/`) cannot pull it in; a restore refuses any tree that contains it. Extra patterns (`node_modules/`, …) go to `info/exclude`. The project's own `.git` is never read or written, and `GIT_*` variables from a surrounding git process are stripped.
- **Ignored files are never overwritten silently.** Before a restore, Scenaria lists files on disk that the target would overwrite but that are not part of the current snapshot (ignored files at the same path, or a file where the target has a folder). They are force-added to the autosave first, so they can be recovered.
- Nested repositories without commits are excluded with a warning on the node; nested repos with commits are stored as a commit pointer (also flagged).

## Rewind semantics

1. If the working tree differs from HEAD's snapshot, it is saved as an `autosave` node first, so nothing is lost and the rewind can be undone.
2. Irreversible effects recorded on the abandoned path are returned as warnings.
3. Files are restored to the target's snapshot. With `restoreFiles: false`, only HEAD moves.
4. An optional lesson is attached to the target, and HEAD moves there.
5. The resume capsule for the target is returned.

`fork(decision, option)` = rewind to the decision, then a new `branch` node whose `viaOption` is set to the option.

## Resume capsule (non-anticipativity)

This idea comes from stochastic scenario trees: at node *n*, you may only know what happened on the path to *n*. The capsule therefore contains:

- the mission goal and brief,
- every decision on the path with the option taken *on this path*, its rationale and the alternatives,
- the last N checkpoints in full, older ones as single lines,
- facts established on the path, the target's own capsule and its changed files,
- lessons, irreversible effects, verification verdicts, and the last node that passed verification.

Sibling branches are never included. The only things that cross branches are explicit lessons. A typical capsule is 150–600 tokens. The Stop hook also records `transcriptTokens` (≈ transcript size / 4), so the dashboard can show the saving.

## Verification

`verify(id)` runs these checks:

- the snapshot exists,
- paths claimed in outputs/facts (in backticks or path-like) exist in the snapshot,
- a decision has a chosen option and a rationale, and confidence ≥ 0.5,
- changed files are documented,
- irreversible effects are flagged,
- optionally `verifyCommand`, run only if the node is HEAD and the tree is clean.

A human or a verifier agent can then set a verdict, which overrides the automatic result. `lastGood()` is the nearest node on the path with the verdict `passed`.

## Concurrency and safety

- Every write runs under `.scenaria/lock` (O_EXCL file holding `pid:token`). A lock is only reclaimed if its process is gone (or after 10 minutes), and only its owner removes it. The slow `verifyCommand` runs outside the lock. An orphaned git index lock (hook killed mid-operation) is cleared after 2 minutes.
- Hook session state (`session.json`) is read-modify-written under the same lock, so parallel hooks don't lose entries.
- Node and state files are written atomically (tmp + rename).
- **Local mode** (`scenaria ui`, `scenaria serve` without a token): binds to `127.0.0.1` and answers only to loopback `Host` headers (DNS-rebinding protection). It rejects POSTs from foreign origins and requires `X-Scenaria: 1` on every POST.
- **Team mode** (`scenaria serve --host 0.0.0.0 --token …`): every request needs the token, either as `Authorization: Bearer` (API clients) or as an HttpOnly, SameSite=Lax cookie set by opening `/?token=…` (browser). Cookie-authenticated POSTs still need `X-Scenaria: 1`, and tokens are compared in constant time. A non-loopback host without a token is refused, and the CLI generates a token if none is given.
- Hooks always exit 0 and print nothing, except the SessionStart context. They act only in initialized projects.

## Design of the dashboard

The visual language comes from the scenario-tree diagrams of operations research:

- **Nodes:** boxed, with LaTeX-style italic ids (*n*7).
- **Time axis:** *t*₁…*t*ₙ, with straight edges.
- **Light mode:** graph paper. **Dark mode:** blueprint.
- **Active timeline:** traced like a highlighter on a printout. This is the one loud element.

Typefaces: Instrument Sans for the UI and STIX Two Text italic for ids and the axis. Both are bundled, so the dashboard works offline.

## Identity and versions (v0.3)

Every node carries:
- **`uid`**: a ULID, globally unique and time-sortable. It is stable across exports and merges.
- **`scenarioId`**: one linear line of work. A node opens a **new scenario** when its parent already continues in its own scenario, which covers forks and new work after a rewind. It also opens one when it explores a non-chosen option of a decision. `forkedFrom` names the branch point.
- **`version`**: the step number on the path from the mission root. `(scenarioId, version)` is unique and is shown as `s2/v5`.

Snapshot commits are pinned under several refs:
- `refs/scenaria/<nodeId>`
- `refs/scenaria/scenarios/<s>/v<n>`
- `refs/scenaria/heads/<s>`

`scenaria mirror` fetches `refs/scenaria/*` into the project's own repository. This is opt-in and touches nothing else. Projects from older versions are migrated on open (schema 2).

## Conversation overlay

`src/core/conversations.ts` stores **sessions** (`c1`, `uid`, provider, model, agent, source) in `conversations/sessions.json`. **Messages** go into one JSONL file per session (`m1`, `uid`, role, text, tool calls, model, timestamp, hash). Each message stores **`headAt`**, the decision-tree node that was HEAD when it was said. This one field turns separate chats into an overlay on the tree:
- "led here" = messages at the parent node, said before this node was created;
- "after this point" = messages at this node;
- the resume capsule includes the latest user request on the path;
- snapshot folders contain the conversation along the path.

Deduplication uses a **chain hash** per message (hash of the whole conversation up to and including it; tool-call arguments normalized). Two append modes:
- **history**: the full chat history is resent, as chat APIs and imports do. Only the part after the longest matching prefix is stored, and a diverged tail (an edited or regenerated message) is stored as new turns.
- **append**: new messages only. Exact repeats of the last few messages are skipped.

Sources:
- Claude Code transcripts (incremental by byte offset, from hooks);
- the proxy;
- `POST /api/v1/messages`;
- `scenaria log-message`;
- `scenaria import`: ChatGPT export (current branch of the conversation tree), Claude.ai export, OpenAI message lists, generic JSONL, Claude Code JSONL; `.zip` is read via `unzip`.

## LLM proxy

`src/proxy.ts` serves `/proxy/<provider>/<path>` and forwards to `proxy.upstreams[provider]` (or to `x-scenaria-upstream`):
- **Forwarding:** headers go through unchanged, except hop-by-hop headers, cookies, origin/referer and `x-scenaria-*`. The response streams through chunk by chunk.
- **Recognized shapes:** OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, as JSON or as server-sent events. Text and tool calls are reassembled from the stream.
- **Conversation identity:** taken from `x-scenaria-session`, otherwise a hash of the system prompt plus the first user message. That hash stays the same across the turns of one conversation.
- **Order of operations:**
  1. If there is no mission yet, the first request names it, or renames an auto-baseline.
  2. The request history is recorded before forwarding.
  3. The answer is recorded after the stream ends.
  4. `autoCheckpoint` runs with the user's request as title.
- **Security:** In local mode the proxy is loopback-only, rejects foreign `Origin`, and accepts JSON bodies only (HTML forms cannot send JSON cross-site without CORS). In team mode it needs `x-scenaria-token`, because `Authorization` carries the provider key, and `x-scenaria-upstream` is ignored, so only configured upstreams can be reached. Provider `set-cookie` and `access-control-*` headers are stripped. API keys are never stored.
- **Robustness:** Backpressure: the proxy waits for the client to drain. A client disconnect cancels the provider request, so a model doesn't keep generating and billing. There is an idle timeout of 10 minutes.

## Snapshot folders

`src/core/folders.ts` materializes each new node into `.scenaria/snapshots/<mission>/<scenario>/v<NNN>-<id>-<slug>/`:
1. List the tree with `git ls-tree -r -z`.
2. Read missing blobs in one `git cat-file --batch`.
3. Store them content-addressed in `.scenaria/blobs/` (read-only, 0444 or 0555).
4. Hardlink them into the folder, with a copy as fallback on a different filesystem. Symlinks stay symlinks; nested repos become empty directories.
5. Write `.scenaria-version/` with `node.json`, `README.md` (decision path) and `conversation.md`, then regenerate `index.md`.

The folders must live inside `.scenaria/`, so they are never snapshotted themselves. Trees with more than `maxFiles` entries are skipped with a warning. `scenaria open` materializes older nodes on demand.

## One-command start and distribution

- `scenaria start`:
  1. init;
  2. `detectAgents()` (binaries on PATH, `~/.claude`, `~/.cursor`, apps in /Applications …);
  3. wire them;
  4. baseline mission, taken after wiring, so agent configs belong to the baseline;
  5. dashboard, API and proxy in one process;
  6. auto-save loop (stat fingerprint per tick, a version after 10 s of quiet).
- `scenaria setup --global` writes user-level configs and sets `~/.config/scenaria/config.json` → `autoInit: true` (deliberately not `~/.scenaria/`, which would mark the home folder as a project):
  - Claude Code: `claude mcp add --scope user`, plus hooks and rules in `~/.claude`;
  - Cursor and VS Code: user `mcp.json` with `--root ${workspaceFolder}`;
  - Gemini CLI, Codex, Windsurf: their user configs.

  Hooks and the MCP server then initialize a project on first use, but only if `isPlausibleProject()` passes: never the home folder, a filesystem root, a dot-folder in home such as `~/.codex` (compared by real path) or an unresolved `${…}`, and only where a project marker such as `.git`, `package.json`, `pyproject.toml` or `AGENTS.md` exists. `Scenaria.init` itself refuses forbidden roots unless `--force` is given, and `findRoot` never treats home as a project.
- **Distribution:**
  - npm package (`dist/` prebuilt, `prepare` builds clones automatically);
  - **single-file binaries** built with Bun (`scripts/build-binaries.mjs`). Dashboard and templates are embedded via `globalThis.__SCENARIA_EMBEDDED__`, and `selfInvocation()` makes hooks and MCP configs call the binary itself;
  - `install.sh` / `install.ps1` download the right binary. On macOS they remove quarantine and ad-hoc sign;
  - GitHub Actions: CI on Ubuntu and macOS (Node 20/22), and a release on tag that runs tests, npm publish, binaries for darwin/linux/windows, macOS signing and compression.
