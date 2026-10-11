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
