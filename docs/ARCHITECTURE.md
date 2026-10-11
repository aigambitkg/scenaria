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
             │  tools.ts — ONE vendor-neutral tool registry (18 tools, zod schemas, validation)      │
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
| Context | `src/core/context.ts` | Budgeted resume capsule, task rollups, token estimate |
| Recall | `src/core/recall.ts` | BM25 search over nodes and conversations |
| Analysis | `src/core/analysis.ts` | Health check, dossier, provider-neutral LLM analysis, stored insights |
| Blocks | `src/core/blocks.ts` | ` ```scenaria ` decision blocks from plain chats |
| Prompts | `src/core/prompts.ts` | Ready-made agent prompts and the per-prompt reminder |
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

Each project has exactly **one tree**. Its root `n0` (type `mission`) holds the project name and the **main goal**. Each node has a `type`:

- `mission`: the project root `n0`, holding the main goal (`goal`) and its history (`meta.goalHistory`).
- `goal`: a task (sub-goal) on the project line: title, task goal, `status` (active/done/abandoned), `summary`.
- `decision`: question, `options[]` (ids `a`, `b`, …), `chosen`, rationale, `context`, `servesGoal`, `expectedOutcome`, `trigger` (auto), assumptions, confidence.
- `checkpoint`: a progress save holding outputs, facts, open questions, irreversible effects and changed files.
- `branch`: the start of an alternative explored via `fork`. Its `viaOption` names the option.
- `autosave`: an automatic save, made before a rewind or a risky command.

Children of a decision carry `viaOption`, which records the option they continue. Options that no child has taken are drawn as dashed "ghost" nodes, and you can start any of them at any time.

`state.json` holds `head`. New nodes attach under HEAD, and rewind and fork move it.

### One project tree (schema 3)

- **Tasks are created lazily.** A hook, the proxy or an API call registers a session's request with `noteTask(key, title)`. The goal node is created right before the session's first real node, keyed per session or conversation. Questions without any work therefore leave the map untouched.
  - A lazily created task shares the previous snapshot, i.e. the state at task start.
  - Its `meta.since` lets the opening conversation be linked to the task.
- **Explicit tasks.** `scenaria_start_mission` / `scenaria task` start a task right away with a fresh snapshot. Calling it twice without any work in between refines the task instead of stacking a second one.
- **Leaving a task finishes it** (`status: done`). `checkpoint {taskDone, summary}` sets the summary that later capsules carry.
- **Scenarios** still mean "a linear line of work". A straight project is `s1` from `n0` to HEAD. A new scenario starts only for a fork, a non-chosen option, or new work after a rewind.
- **Migration from schema 2 (one tree per mission)** is idempotent and runs under the lock:
  - The node files and `state.json` are backed up to `.scenaria/backups/schema2-*`.
  - `n0` is created; every former root becomes a `goal`.
  - Each former root is attached to the node that was HEAD when it was started, found by replaying `events.jsonl`. Fallback: the newest earlier node.
  - Scenario ids are recomputed, and version refs are rewritten.

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

This idea comes from stochastic scenario trees: at node *n*, you may only know what happened on the path to *n*. Sibling branches are never included. The only things that cross branches are explicit lessons and project rules.

The capsule is assembled from prioritised items within a **token budget** (`contextBudget`, default 1,500):

| Priority | Content |
|---|---|
| always | Project and main goal; current task and its goal; state of the target node; latest user request; last-good node |
| 1 | Project rules (`memory.json`); irreversible effects on the path |
| 2 | Decisions of the current task, with rationale, context, goal link and expected outcome |
| 3 | Lessons on the path |
| 4 | One line per earlier task on the path (stored `summary`, or a deterministic rollup of the path segment with the option actually taken); older tasks drop first |
| 5–7 | Checkpoints of the current task, changed files, established facts, steps before the first task |

Items are kept by priority and rendered in reading order. What is left out is counted, and the capsule points to `scenaria_recall` (BM25 over nodes and messages, offline) and `scenaria_get_node`.

On a 30-task project a 600-token capsule still holds the goal, the rules, the current task and the newest rollups. `context()` also reports `historyTokens`, the raw conversation on the same path, so the dashboard can show the saving.

## Decision context and analysis

- **Recording.** `scenaria_decide` requires `rationale` when an option is chosen (`requireRationale`). It accepts `context`, `servesGoal` and `expectedOutcome`, and stores the latest user request of the current task as `trigger`. The tool result names missing fields. The map flags them (`!` rationale, `?` context or goal link).
- **Health check (`metrics`)** is deterministic and costs no tokens.
  - Decision quality is the share of six fields present: chosen, rationale, context, servesGoal, ≥2 alternatives, confidence.
  - Each decision gets an outcome: kept, passed, revised, abandoned, failed or open.
  - Findings: goal missing, no rationale, no context or goal link, single option, open decision, low confidence never verified, work built on a failed check, tasks with ≥3 branches, done tasks without a result.
  - Statistics per agent and per model, plus a health score from 0 to 100.
- **Dossier.** The same history as compact lines (`D n12 task=n9 by=agent/model conf=… outcome=… | Q | chosen | alts | why | ctx | goal | expected`), plus tasks, lessons and failed checks. The newest decisions are kept when `maxTokens` is tight.
- **LLM run.** There are two code paths. The OpenAI-compatible one (`/chat/completions`) covers OpenAI, Ollama, LM Studio, Gemini, Mistral, OpenRouter, Groq, Azure-style and custom URLs; the other is Anthropic `/v1/messages`.
  - Keys come from env vars (`OPENAI_API_KEY`, …, or `apiKeyEnv`), or from a per-request key. They are never written to disk.
  - Team mode forbids custom base URLs, against request forgery.
  - The answer is parsed tolerantly as JSON (summary, goal alignment, patterns, issues, rules, token tips) and stored in `.scenaria/analyses/`.
- **Rules.** Accepted rules go to `memory.json` and are carried by every capsule, every agent prompt and the per-prompt reminder.

## Context fidelity and integrity

- **Ledger.** `save()` appends `{ts, id, hash, op, c}` to `ledger.jsonl`, where `hash` is sha256 over the node without its volatile fields (verification, snapshotFolder, meta) and `c` is the chain hash over the previous line.
  - `integrity()` compares each node with its last ledger hash: ok, tampered or unsealed. It also reports the first broken chain line.
  - Projects from before the ledger are sealed once on upgrade.
  - A migration appends `migrate` entries.
- **Fidelity** (`core/fidelity.ts`) is one DFS over the tree; each node only sees its own path.
  - Score = 0.35·anchor + 0.35·continuity + 0.15·integrity + 0.15·reliability. Without a goal, the anchor weight is redistributed.
  - **Anchor:** Ochiai overlap of 6-char stems (compounds split at `-_./`) with the main goal and the task goal, normalised at 0.18. `servesGoal` lifts it to at least 0.8.
  - **Continuity:** overlap with the last 6 ancestors plus the task goal, normalised at 0.15. A `basedOn` reference to an ancestor lifts it to at least 0.95.
  - **Low-signal nodes** (watcher autosaves, very short text) carry the previous values with 2 % decay instead of counting as a break.
  - **Flags:**
    - `break`: continuity < 0.12 and anchor < 0.4, or a drop of ≥ 30 points;
    - `drift`: decision anchor < 0.25, or task anchor < 0.2;
    - `goalChanged`: an entry of `goalHistory.until` falls between parent and node;
    - `branch`: the node has `forkedFrom`;
    - `tampered` / `builtOnTampered`.
  - A tampered node is capped at 25.

## Canon events (fixed points)

- **Storage.** `canon.json` (committed) holds `k1…` events of kind `past` or `future`.
  - Fields: `hard`, optional `check` command, `due`, `evidence`.
  - Status flow: `proposed → active → retired`, or `proposed → rejected`.
  - Audit: `proposedBy`, `decidedBy`, `decidedVia`, plus `canon` events in the log.
- **Governance.** Only `addCanonAsUser` and `decideCanon` can make an event binding.
  - They are reached from the dashboard (local: loopback + X-Scenaria; team: token) and from the CLI, where the CLI refuses without an interactive TTY. That keeps agent shells out.
  - The MCP/HTTP tool `scenaria_canon` can only list, suggest and propose. Engine-level `respectsCanon`/`breaksCanon` only keep approved ids.
  - Dashboard decisions need the approval session (HttpOnly, SameSite=Strict cookie) set by the approval link. Local mode: a random code per start that works **once** and is printed only to a TTY. Team mode: `SCENARIA_APPROVER_TOKEN`.
  - **Signatures.** Binding decisions and check results are signed with the person's Ed25519 key (`approver-key.pem` in the global config dir, mode 600). `canonState` computes trust per event: `verified` (valid signature from the own key or a key in `trusted-approvers.json`, also global), `untrusted` (valid signature, unknown key), `tampered`/`unsigned`. Only `verified` events can be `active`; the others get the computed status `tampered`/`untrusted` and are not binding. `keyId` is always derived from the embedded public key. A `lastCheck` counts only with a valid signature from a trusted key.
  - **Replay/rollback.** Payloads carry `canon/v2`, the project id (`config.json → projectId`) and a per-event revision `rev` that grows with every signed change (checks included). A high-water mark per event (`rev`, status, signature) lives outside the project in `anchors/<projectId>.json` in the global config dir. An older revision, a different record with the same revision, or a proposal reusing an id of a signed event is `tampered`; an approved event missing from the file is reported (`missing`, `canon_missing`). Newer verified revisions (a teammate's, pulled from git) raise the mark; a machine without a mark trusts the first verified revision it sees. Re-approving an unverifiable event never revives one the mark (or the stored status) says was retired/rejected.
  - **Commands.** Approving never keeps a command implicitly: `adoptCheck` must be `true` (one unambiguous candidate) or the exact command text the person saw.
  - Limits: tamper-evident, not tamper-proof. A malicious local process with full user rights can read the private key (or the cookie) and forge decisions. The audit trail shows `decidedVia`.
- **Unreadable `canon.json`** (merge conflict): writers refuse; the capsule says the fixed points are UNKNOWN, `stringPayload` returns `unproven`, health reports `canon_unreadable`.
- **Archivist.** The deterministic suggestions (nothing stored) come from:
  - decisions on the HEAD path that are verified, or have ≥ 0.8 confidence plus a rationale;
  - rules and facts phrased as obligations;
  - measurable expected outcomes.

  The LLM variant (`canon-llm.ts`) sends the dossier plus the existing canon and stores the returned items as `proposed` (source `archivist`).
- **Enforcement.**
  - In the capsule, hard events have priority 0 and are never trimmed.
  - The reminder and the agent prompt list them.
  - `scenaria_decide` validates the cited ids; `breaksCanon` needs a rationale on every path (engine-level, so also for chat blocks and the API).
  - Metrics: `canon_broken`, `canon_check_failed`, `canon_overdue`, `canon_proposed`, `no_canon`, `canon_tampered`, `canon_untrusted`, `canon_unreadable`.
  - Fidelity: `canonBroken` (score ≤ 40); `respectsCanon` anchors to at least 0.7.
  - Board: section `canon`, risks for breaks. Expectations: `kN`.
- **Checks** run `check` with a shell in the project root, only for active events and only on a person's request. The result (`lastCheck`) records HEAD and whether the tree was clean.
- **String payload** (`stringPayload`):
  - past canon + rules;
  - the decisions on the path, with the option taken;
  - future canon with its check status.

  Verdict: `invalid` if a hard event is broken on the path or its check failed; `unproven` if hard future events are not passed yet; otherwise `valid`.

## Workspace, references and handoffs

- **Board** (`core/workspace.ts`): items on the HEAD path, in sections goals, decisions, facts, questions (current task only), rules, lessons and risks (irreversible effects, failed checks).
  - Item references: `n12`, `n12.f2`, `.q`, `.o`, `.l`, `.i`, `r3`.
  - `resolveRefs` returns only the requested content.
- **Readers** (`readers.json`) hold `ref → hash of text|confidence|status` per reader. A read with a reader returns new and changed items, plus known refs of the requested sections that disappeared (invalidated). Knowledge of other sections is kept. Up to 100 readers and 4,000 refs each.
- **Expectations:**
  - Precise forms are checked exactly: `nX done`, `nX verified|failed`, `nX = option`, `nX.fK`, `rK`.
  - Free text is first matched against decision options on the path; naming a non-taken option counts as contradicted. Otherwise it needs ≥ 60 % stem coverage by a fact or decision; low-confidence support yields "unknown".
- **Confidence per fact:** `factInfo[i] = {confidence, basedOn}`, aligned with `facts`.

## Capture paths and prompts

- **Claude Code hooks.** Each prompt returns a short `additionalContext` reminder: main goal, task, how to record, top rules.
- **Agent prompts** (`scenaria prompt`, dashboard → *Agent prompt*) come in three kinds, in German or English, optionally with the capsule attached:
  - `mcp`: tool calls;
  - `cli`: `scenaria call …` / HTTP;
  - `chat`: plain chats without tools.
- **Decision blocks.** Models without tools append ` ```scenaria ` JSON blocks: decision, task, checkpoint, lesson, projectGoal or rule.
  - They are read from proxy answers, from Claude Code's final message and from text pasted into the dashboard (`/api/v1/ingest-text`).
  - Each block is applied once (sha1 of the item, claimed under the lock).

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
