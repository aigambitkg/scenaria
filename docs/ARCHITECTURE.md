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
             │  tools.ts — ONE vendor-neutral tool registry (22 tools, zod schemas, validation)      │
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
| Verdicts | `src/core/verdict.ts`, `src/core/trust.ts` | Verdict origins, what counts (rule 11), signature/content checks |
| Seal | `src/core/seal.ts` | Anchor outside the project, high-water mark, reseal records |
| Audit agents | `src/core/auditors.ts` | Registry, signed requests, key generation |
| ISO/IEC 42001 | `src/core/iso42001.ts`, `src/core/auditfile.ts`, `src/core/auditaccess.ts` | Annex A catalogue (C1), the audit file computed from the records (C2), who may read it (C2) |
| Protocol | `src/core/protocol.ts` | Knowledge-base notes, audit protocol |
| **Tools** | `src/tools.ts` | Vendor-neutral tool registry + schema export (OpenAI, Anthropic, Gemini, JSON, MCP) |
| MCP | `src/mcp.ts` | Registers the registry over stdio |
| Hooks | `src/hooks.ts` | Claude Code automatic capture, never blocking |
| Setup | `src/setup.ts` | Idempotent wiring for Claude Code, Claude Desktop, Cursor, VS Code, Gemini CLI, Codex, Windsurf, AGENTS.md; start icon |
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
  - Keys come from the provider's env var (`OPENAI_API_KEY`, …) or from a per-request key. They are never written to disk.
  - Team mode forbids custom base URLs, against request forgery.
  - The answer is parsed tolerantly as JSON (summary, goal alignment, patterns, issues, rules, token tips) and stored in `.scenaria/analyses/`.
- **Rules** (`memory.json`, since 0.9.4 with a status, since 0.9.5 signed). Only **active** rules are carried by every capsule, every agent prompt, the per-prompt reminder, the board, the dossier and the relay.
  - **Only the person makes a rule active** (security rule 5): `POST /api/rules*` and `/api/analysis/accept` are person-only (approval session); the CLI `scenaria rules add|approve|reject|rm` needs an interactive terminal and a typed confirmation. Each decision is stored with the rule (`decidedBy`, `decidedVia`, `decidedAt`) and in the event log.
  - **Agents only propose:** a ```scenaria {"rule": …}``` block becomes a proposal (`status: "proposed"`, `proposedBy` = the name the agent stated). Proposals never reach agents; agents only see how many are waiting. At most 50 open proposals.
  - **Accepting needs the text the person saw** (`/api/rules/approve {id, text}`), so a changed proposal is never accepted unseen. Ids only go up (`nextId`); a rejected proposal stays on file as `rejected`, so its text is not proposed again.
  - **Older projects:** rules without a status count as active, except those agents added (`source: "agent"`): they become proposals.
  - **Signed (0.9.5, like canon):** every decision of the person (add, accept, reject, confirm, remove) is signed with the approver key over `[projectId, "rule/v1", rev, id, text, status, decidedBy, decidedVia, decidedAt]`. The newest revision per rule is anchored outside the project (`anchors/<projectId>.json`, key `rule:<id>`), so an older signed version or a removed rule copied back counts as `tampered`.
  - **What reaches agents:** only active rules with a valid signature by a trusted key (own, or a teammate in `trusted-approvers.json`). Unsigned or untrusted active rules wait for the person's one-time confirmation (`/api/rules/confirm {id, text}`, `scenaria rules confirm <id>`); changed rules are shown as tampered; approved rules deleted from the file are reported as missing. The health check reports `rules_unconfirmed`, `rule_tampered`, `rule_missing` and `rules_proposed`.
  - **Limits:** the approver key is on the person's machine; agents must run in a sandbox (or under their own account) without access to it. Rules are not in the hash chain (they are signed instead).

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

## Who may say "verified", and who may reset the tamper evidence (0.9.2, security rule 11)

Only the person, or a registered audit agent that is independent of Scenaria and of the working agent, can make a step count as verified or reset the integrity ledger. A working agent can report, never certify or reset.

- **Verdict origins** (`verification.origin`, `core/verdict.ts`): `person` (approval session, or an interactive terminal with a typed confirmation), `auditor` (signed request), `agent` (self-report through tools/CLI without a terminal), `auto` (deterministic checks). Verdicts from before 0.9.2 are `legacy`.
  - A "passed" counts only from the person or an audit agent. Agent, automatic and legacy passes are shown as such ("Reported by the agent", "Automatic checks only", "Earlier check — please confirm") and never count.
  - A "failed" or "warning" counts from anyone, and it stays until the person or an audit agent gives a new verdict. A self-report may lower trust, never raise it.
  - An agent's or the automatic checks' later report never replaces a person's or an audit agent's verdict. It is kept next to it as `verification.report`, and only a negative report lowers the outcome.
- **Authenticity** (`core/trust.ts`), checked on every `integrity()`:
  - The person's verdict is signed with the approver key (`verdict/v2`: project, node, status, time, by, via, notes and the **work hash**).
  - An audit agent's verdict keeps its signed request, which must name this project, this node, this status and the work hash, with a key registered on this machine.
  - Results:
    - `forged`: the node counts as tampered;
    - `untrusted`: a valid signature by a key this machine does not trust (high finding);
    - `revoked`: an audit agent the person unregistered;
    - `superseded`: the work changed after the verdict.
  - The work hash (`ledger.workHash`) covers the node without `verification`, `meta`, `snapshotFolder` and `lessons`, so a lesson attached by a rewind does not supersede a verdict.
  - Only `integrity().confirmed` counts: `lastGood()`, status counts, the health check, fidelity reliability, expectations, the analyst's facts, the archivist, the board and the knowledge-base notes all use it.
- **No laundering:** when Scenaria writes over a node file that was changed outside it, the ledger line gets `op: "write-over-tampered"`, and the node stays tampered until the person reseals.
- **The anchor outside the project** (`core/seal.ts`, `~/.config/scenaria/anchors/ledger-<folder hash>.json`, trust on first use).
  - It remembers the ledger's first chain hash (genesis), every authorised reseal, the hashes of applied audit-agent requests (no replay), and a **high-water mark**.
  - The mark is the line count and last chain hash. It is raised before every append with `pending` and the node in flight, and confirmed after the node file is written.
  - Findings:
    - `ledgerMissing`: deleted, also when `ledger.sealed` was deleted too;
    - `ledgerReplaced`: a different ledger;
    - `ledgerDiverged`, kind `rewritten`: shortened, rewritten or rolled back (high);
    - `ledgerDiverged`, kind `extended`: lines this machine's Scenaria did not write, e.g. an older version still running, another computer, or a hand-made line (medium; the steps are named);
    - `resealsUnproven`: a reseal without an authentic record.
  - A divergence found during a write is kept until the person reseals.
- **Reseal** (`Scenaria.reseal(authority)`): `{kind: "person", via: "terminal" | "dashboard"}` or `{kind: "auditor", request}`. Without an authority it throws.
  - The CLI asks for a typed confirmation in an interactive terminal. The dashboard uses `POST /api/integrity/reseal`, which needs the approval session.
  - An audit agent's reseal request is bound to the ledger state and to a digest of every node's content (it also lists the tampered nodes). It is valid 24 h and can be used once.
  - Every reseal writes a record (`.scenaria/reseals/rsN.json`): the person's is signed; an audit agent's carries its request. The old ledger is kept, and the anchor is updated.
- **Starting over in a folder** whose earlier project this machine anchored: only the person, confirmed in a terminal (`scenaria init` / `start` ask), archives the old anchor. An agent's auto-init keeps it, so the new ledger shows as replaced until the person reviews and reseals.
- **Audit agents** (`core/auditors.ts`):
  - **Keys.** The registry is `~/.config/scenaria/trusted-auditors.json`, with keys and removed keys; adding and removing are person-only (CLI with a typed confirmation, or `/api/auditors/*` with the approval session). `scenaria auditor keygen` refuses folders inside a project or Scenaria's config. The person's own approver key cannot be registered as an audit agent.
  - **Wire format.** `{payload, pub, sig}`: Ed25519 over the exact payload bytes, which plain `openssl pkeyutl -sign -rawin` can produce. Tools: `scenaria_auditor_request` (read-only) and `scenaria_auditor_submit` (the signature is the authority).
- **Config folder:** `SCENARIA_HOME` / `XDG_CONFIG_HOME` that point inside a Scenaria project are ignored. Keys, registries and anchors never come from the project.
- **Limits (documented, not hidden):**
  - A process with the person's full user rights can read the approver key, edit the anchor and the registries, or fake a terminal.
  - The anchor is per machine. A project used from two computers, or from a container with another home, shows "extended" writes.
  - After updating Scenaria, restart agents and MCP servers so no older version keeps writing.

## The derivation of every number (Batch E1, 0.9.14)

Kev's goal for Batch E (2026-10-17): every number in Scenaria is retraceable and reproducible; a model supplies evidence at most, never a number.

- **One format (`core/derivation.ts`, no imports, shared with the UI).** A `Derivation` is `{key, value, formula, expression DE/EN, inputs [{name, label DE/EN, value}], sentence DE/EN}`. The value is never stored next to a formula: `derive(key, formula, inputs)` COMPUTES it with the formula, so `recompute(d)` gives the same value from the inputs alone — for the person, an auditor with the signed file, a test. `recompute` never throws (unknown formula, a crafted input, `null` → `null`) and only reads the formula's own input names.
- **Versioned formulas** (`FORMULAS`): `fidelity/1` (context fidelity: 35/35/15/15 of goal line, connection, integrity, reliability; without a goal 35/15/15 rescaled; caps 25 when changed outside, 40 when it breaks a fixed point; the project start 100, or 25 when changed outside), `health/1` (the project check's 100 − deductions, kept within 0–100), `count/1` (the number of listed items). A changed formula is a new version; derivations keep naming theirs.
- **Where:** each fidelity point carries `why` in the short form (`compact`: value, formula, input values; `expand` adds the texts from the same formula — about 0.3 kB instead of 1.7 kB per step); `metrics().why.health` and `why.counts` (inputs are the lists of what is counted, e.g. `"tampered: n3"`, so they can be recounted); the audit file's `derivations` for every summary count (control ids). `score`, `health`, `counts` and `summary` ARE these values.
- **The signed export** carries the audit file's derivations. `verify` recomputes each one and compares it with the number in the file; a file whose numbers contradict their own derivation is not valid (Scenaria never writes one). Files from before E1 (no derivations) verify as before.
- **Dashboard (`ui/src/Why.tsx`):** "ⓘ Wie berechnet?" next to the fidelity of the selected step, the health score, and as a list for the project check's and the audit file's counts. Hover shows the sentence (title); a click, a tap, Enter or Space opens the derivation in place (sentence, formula, every input with every item; long lists scroll; finding codes in plain words); Escape closes it while the focus is inside it, and only it. The panel recomputes the number from the inputs as they came and compares it with that value and with the number shown.
- **Exports:** the print page and the Markdown copy have a footnote per summary number (marker after the label) with the sentence, the formula and every counted item.
- **Robust inputs:** hand-edited step fields of the wrong type (a text or number where a list belongs) never break the project check or the fidelity (`nodeText`, the irreversible count).

## Progress (Batch E2, 0.9.15)

"How far along am I?" in percent, per task and for the project, computed only from evidence by versioned rules (`core/progress.ts`, formulas `progress/1` and `progress-project/1` in `core/derivation.ts`). Kev's decisions n64–n66 (2026-10-17); the design and every deviation found in the reviews: `docs/intern/batch-e/e2-fortschritt.md`.

- **Completion criteria** are future canon events with `task` (a goal node), `weight` (1–100) and an optional `artifact` (a path or pattern `*`, `**`, `?` inside the project; never absolute, never `..`, never `.scenaria/` or `.git/`). Agents propose them (`scenaria_canon` propose, chat blocks); the person approves them — **exactly as shown**: approval carries `expect` (text, task, weight, file) and is refused if the stored proposal differs; the person may set the weight on approval; a new weight later is a signed revision ("reweigh", the check result is cleared). Chat cards approve with their own view; an approval without `expect` is refused for criteria.
- **Signed as `canon/v3`:** the decision payload adds `approvedAt` (set at approval; evidence counts from then), task, weight and file. Stripping all of them gives a v2 payload and adding them to a v2 record gives v3 — either way the signature fails. The anchor outside the project keeps each criterion's task and words, so a criterion removed, moved or renamed by hand still holds its task back ("missing"); the person can retire a missing criterion (`canon-forget/v1`, signed record, the anchor moves to "retired"; an old copy cannot come back).
- **Claims:** a checkpoint's `fulfills: ["k3"]` (only approved future fixed points) is the agent's claim, never proof.
- **Only the task's current line counts:** from the task to its newest step (HEAD's line when HEAD is in or past the task; the task alone when HEAD is on the task or before it; its newest step when HEAD is on another branch, shown as `offLine`). Steps changed outside Scenaria or written in ledger lines this machine did not write are never positive evidence; any step counts against a check (staleness).
- **Levels per criterion:** 0 open · 0.25 started (its file exists in the newest trustworthy snapshot, or a step names it) · 0.5 implemented (a claim with evidence: the file changed on the line since the approval; without a file, the claiming step changed files) · 0.75 checked (its check command passed on saved files) · 1 confirmed (the person confirmed it, or the person / a registered audit agent verified the claiming step — `integrity().confirmed`, rule 11). A failed check caps the criterion at 0.5. A check result or confirmation counts only on the line it was made on (`lastCheck.node`, signed) or after the task on HEAD's line, and is stale when a later step on the line changed the file (by step order, not clock time). Without git the person's word and passed checks count (with a note).
- **Gates (caps, cumulative):** 10 goal and an approved criterion · 20 every criterion weighted and settled (no proposal, nothing changed outside or missing) and a chosen decision on the line · 40 first results (a criterion's file changed since its approval, or a criterion ≥ 0.5) · 60 all ≥ 0.5 · 80 all ≥ 0.75 · 90 all 1 · 100 the person's own verdict on the newest step of the line, given after every step of the task on any line (automatic saves aside) — a verdict on an earlier step the agent rewinds to is not the acceptance of the task. `progress = round(min(100 × Σ w·s / Σ w, cap))`; a criterion without a weight counts 1 and keeps gate 20 open.
- **Project:** the mean over every task with criteria (abandoned tasks too — an agent can mark a task abandoned; the person retires its criteria), each counting the same; a task node deleted or changed by hand counts as 0 % for its criteria. Tasks without criteria are listed, not counted.
- **Where:** `scenaria_progress` (agents: short derivations and `nextAgent`), `scenaria progress [task]`, `GET /api/progress` (full derivations), the dashboard: a card for the current task in the Simple view, a header button and dialog in Audit and Manage, criteria with task, weight and file in "Rules & milestones" (approve with weight, set weight, retire a missing one). `next` names, for people, who acts next ("you" / "the AI").
- **Limits (documented):** a criterion without a file never goes stale; a check made after the task checks the file as it was then; staleness from approval time compares clock times of one machine.

## The context window, measured (Batch E3a-1, 0.9.17)

How full an agent's context window is, measured from the provider's token counts and never estimated (`core/window.ts`; model table `core/models.ts`; formulas `context-fill/1` and `context-soft/1` in `core/derivation.ts`). Kev's decisions n75–n79 (2026-10-18); design and deviations: `docs/intern/batch-e/e3-kontextfenster.md`. E3a-1 only measures; acting on it is E3a-2 (next section), the dashboard E3b.

- **Where the numbers come from.** Claude Code transcripts (read by the hooks with the conversation): each main-line answer's `message.usage`; fill = input + cache write + cache read of the newest answer. One answer is written as several lines with the same message id and counts once; sub-agents (`isSidechain`) and `<synthetic>` lines are skipped. The LLM proxy: each answer's `usage` (Anthropic JSON and streams; OpenAI chat `prompt_tokens`, in streams only with `stream_options.include_usage`; OpenAI Responses `input_tokens`). MCP alone (Claude Desktop) gives no tokens: no window, no number, a plain "not measurable here".
- **Windows.** A window is one conversation from its start until the next window of that conversation: a Claude Code session (start reason from SessionStart: new session, `/clear`, resumed), a `compact_boundary` in the transcript (start reason "compaction", with Claude Code's trigger and size before), a proxy conversation (`x-scenaria-session` or the first messages; `previous_response_id` joins the earlier answer's conversation), or a proxy fill below half of the last one ("fill fell sharply", most likely compacted). Re-reading a transcript adds nothing (each answer and boundary is recorded once).
- **The rule (v1.0, start values):** `C_eff = min(C_max, A_model)`; C_max from the model table (documented by the provider, with source and date: the Claude 5 family 1M, `gpt-5` 400k, `gemini-4-argon` 1M); A_model 200,000 tokens (a setting, Kev n79). A model not in the table gets no number ("the rule does not apply"); local models (Ollama) need the person's entry (E3b). Fill in % of C_eff, rounded down to 0.1 (69.96 % shows 69.9 % and is still below the red line). Soft threshold = max(50 %, 70 % − buffer), buffer = P95(step size) + handover cost + margin, rounded up to 0.1; P95 by nearest rank over the newest 200 steps once 20 are measured, before that 5 % of C_eff; a step is the growth of the fill between two checkpoints or decisions of the window's own agent inside one window (checkpoints without a new answer between them are one cut); handover cost = the size of the current resume capsule; margin 2 % of C_eff (proposal, Kev was not asked). Zones: green < 50 %, yellow 50 % – soft, orange soft – 70 %, red 70 – 85 %, emergency ≥ 85 %.
- **Records and what shows a change.** `.scenaria/windows.jsonl`: append-only lines with a chain hash. A window with a line that is not confirmed shows no number ("changed outside"): (1) a break in the chain distrusts every line up to it, including the line before it; (2) an anchor outside the project (`anchors/<project>.windows.json`, raised after every append) shows a rewritten or deleted file and lines someone else added, and records without an anchor on this machine (the anchor deleted, the file brought in) are not confirmed; (3) the Claude Code end-of-turn checkpoint stores the chain's length, head and newest reset in `meta.windows` — that checkpoint is in the integrity ledger, so a rewrite shows even with the outside anchor rewritten too, and editing the checkpoint to match makes the checkpoint itself "changed". When Scenaria next appends after (1) or (2), it writes a "reset" line first: older windows stay without a number, the measurement starts again ("measurement started again"); in a Claude Code project the new windows count once the next end-of-turn checkpoint names that reset (a reset line written by hand hides nothing). Usage from a proxy upstream the client names itself (`x-scenaria-upstream`) is not recorded; `previous_response_id` joins a conversation only for the same agent. Not detected: a changed Claude Code transcript (outside the project).
- **Where:** `scenaria_window` (agents: short derivations; read-only — no tool can set a fill), `scenaria window [wN] [--json]`, `GET /api/windows` (full derivations). `current` is the window with the newest answer, or the window of a given conversation (`windowStatus(s, { key })`, used by the hooks in E3a-2).
- **Limits (documented):** two Scenaria installations with different config folders on one project (a container next to the host) see each other's appends as foreign: every append starts the measurement again; parallel Claude Code sessions share the agent name, so their checkpoints cut each other's steps; a crash between appending and raising the anchor leaves a false warning and a restart; the soft threshold of an ended window is computed with today's step sizes and capsule size; two proxy conversations that start with the same system and first message share a window unless the client sends `x-scenaria-session`; an OpenAI chat stream without `include_usage` has no number.

## Acting on the context window (Batch E3a-2, 0.9.18)

`core/windowact.ts`, wired into `hooks.ts`, `proxy.ts`, `tools.ts`, `cli.ts` and `server.ts`. Kev's decisions n75–n79 (2026-10-18); design, deviations and the review: `docs/intern/batch-e/e3-kontextfenster.md`, `e3a2-pruefung.md`.

- **Only the checked number acts.** `contextAdvice(s, key)` takes the window of one conversation from `windowStatus(s, { key })` — measurable, unchanged, the model in the table. `quickFill` (cached, unchecked) only rules out everything below the yellow line so the hooks stay cheap; nothing is shown or done from it.
- **What happens per zone.** Yellow: a notice to the agent. Orange: a notice; at the end of the turn (Stop, the next prompt when a turn ended without Stop, a proxy answer) an automatic checkpoint, also without a file change. Red and emergency: a checkpoint at once — after any tool (PostToolUse, matcher `*`), else at the end of the turn — and a notice to the agent and the person. Each zone is cut at most once per window and line of work (`cutDue`); a cut of a higher zone counts for the lower ones; a cut left on an abandoned branch after a rewind does not count (`WindowCut.onLine`). The agent's notice repeats on every prompt from yellow on.
- **The cut.** `meta.contextCut` {window, key, startedAt, zone, fill, tokens, rule, moment} and the tag `context-cut`; only Scenaria writes both (the tools' schemas have no `meta` or `tags`). A cut counts only when it is unchanged since written (integrity). Check and write happen under the project lock (`cutOnce`), so parallel tool calls cut once. A cut at a moment of its own is written as agent `scenaria`; the Stop cut is the turn's own checkpoint when files changed, and Scenaria's (outputs: only the cut bullet; the agent's words in `meta.agentSummary`) when nothing changed. Cuts give no verdict and claim no criterion; a quiet cut (a snapshot without file change, nothing irreversible, no verdict on it, trusted) is passed over by progress as the task's last step, so an accepted task stays accepted.
- **Notices.** The agent: the prompt reminder (also when the reminder is switched off, then alone) and `additionalContext` after a tool. The person: from red a Claude Code `systemMessage` in the person's language (German or English from the global setting), and one protocol line per cut (`update` event with `data.context`). The proxy: `x-scenaria-context-zone`, `-fill`, `-window` on the response from yellow on — the state after the conversation's previous answer, because the headers go out before the answer is complete; an upstream's own `x-scenaria-*` headers are dropped; nothing for a client-named upstream. OpenAI Responses chains (`previous_response_id`) use the same window key as the measurement (`windowKeyFor`).
- **The handover.** `prepareHandover` (read-only, computed when asked): whose window and how full (with the derivation sentence), the last automatic save on the current line, other windows that are yellow or fuller, the task's progress, the resume capsule of HEAD, and how to continue. The new window continues from the current state, never from the save. The tool uses the asking agent's newest window. At SessionStart the capsule names the agent's previous window and its save.
- **Never.** Open a new window, change progress, give a verdict; block the agent only for the E4 stop below. Hooks exit 0; after a tool they skip without a new answer in the transcript, and give up after 1.5 s of a busy lock.

## The person's values of the rule and the dashboard (Batch E3b, 0.9.19–0.9.20)

- **Values (`core/contextsettings.ts`).** Per project: yellow, red and emergency lines, P95 start value and margin (in % of C_eff), A_model (tokens), and window sizes of local models the documented table does not cover. Set only by the person (dashboard approval session, or `scenaria window settings` at an interactive terminal with a typed confirmation; checked before asking). Stored outside the project (`context-settings.json` in the config folder), bound to the project id and its real folder, every revision signed and kept (`revisions`, oldest first); a revision mark apart (`rev`, `first`). Read: all signatures valid, revisions contiguous from `first`, newest ≥ mark, values within the bounds of this version — else the start values apply with a reason (`signature`, `history`, `older`, `values`, `missing`, `unreadable`). A model the documented table covers now is dropped from the entries (`dropped`) and the provider's size applies. After an invalid setting the next change starts a new history above every number seen and keeps the earlier revisions apart (`earlier`, unverified); the new revision signs that it restarts (`restart`). A moved folder shows `elsewhere`. `looser` names values looser than the start values.
- **The rule string.** `v1.0 …` for the start values, `v1.0-p<rev> yellow=… red=… emergency=… floor=<yellow> p95start=… margin=… minSteps=20` for the person's revision; `window.ts`, `quickFill`, `windowact.ts` and the cuts use the values in force; every derivation carries the rule and `cMaxSource` (the provider's page with its date, or "entered by the person"); the formula texts refer to the rule's lines.
- **Dashboard (`ui/src/Window.tsx`).** Simple view: one card (the AI's memory in plain words, the zone as a word, "How computed?", when measured, what to do at red, the handover). Audit and Manage: a header button with fill and zone, a dialog with the newest window, all windows, the saves with their rule version, the rule's values and their history (key id, local time); in Manage the person edits the values under the lock and sees exactly what is signed before signing (no browser dialog). The Simple timeline shows Scenaria's own saves in plain words, only for saves the server counts. Numbers typed with group separators or a decimal comma are read by `core/numbers.ts`; a typo is refused, never read as another value. The page refreshes the context window every 30 s (the dialog every 15 s) while visible.

## Progress per window, the handover check and the stop (Batch E4, 0.9.21)

Kev's table C (2026-10-17) and his answers of 2026-10-24: ≥ 10 points of progress per full window is a normal handover; < 10 in one window a warning with a problem note; < 10 in two windows in a row a stop (rewind, or the person decides); the first window of a task at red with gate 20 open an escalation (split the task). Only full windows are assessed, only tasks with criteria; during a stop the agent may read and use Scenaria; the handover check compares the first 3 steps.

- **Records (`core/window.ts`).** `progress` lines in `windows.jsonl` (in the chain, under the outside anchor): at a Claude Code session start (`recordProgressSnapshot`, with the session's key, before the new window's first answer) and when a window is opened (tagged with the window; skipped when nothing was answered since the last record). A line keeps only the inputs of each task's `progress/1` (criteria, gates, `waiting`), only tasks with approved criteria, and HEAD's task (`focus`); the values are computed again on reading (`snapInfo`). Lines whose fields are not what Scenaria writes are no records.
- **The assessment (`core/windowprogress.ts`).** Windows of one source and agent form a line; a window's successor is the first window of the line that starts after its last answer (through the proxy only within the same conversation). The progress at a change: the new window's own session-start record, else the newest record between the old window's last answer and the new one's first (without a predecessor: at most 15 minutes before), else the record written at the opening if the window answered after it. `window-progress/1` = Σ over the tasks with criteria at the end of (end − max(start, best so far with the same criteria since the newest lift)). Verdicts: progress (≥ min, always), none (a full window — highest fill ≥ the yellow line, or compacted — on a task with criteria whose next step is not the person's), else not assessed (`not-full`, `no-fill`, `no-criteria`, `waiting`, `no-measure`, `changed-outside`), which does not break a row. Each ended window is judged by the person's values in force when it ended (`valuesAt`, from the signed history). Rows, warnings and stops are per line; the two windows of a stop worked on the same task. Row 4 and the hint without criteria come from the running windows at red or fuller (live progress).
- **The stop.** Found when progress per window is computed — after a window's first answers (`evaluateStop` from `ingest.ts` and `proxy.ts`, when `windowJustStarted`), and whenever it is shown — and noted outside the project (`window-stops.json` in the config folder, `stops`). A noted stop holds until the person lifts it, whatever the records show later (Scenaria never takes one back); a stop whose window went on answering after the next one began is marked `likelyParallel` (a hint to lift it). The stand-in view at a session start (`pending`) only gives text. The person lifts it (`liftStop`: approval session `POST /api/window-stop/lift`, or `scenaria window stop lift --why` at an interactive terminal with a typed confirmation), with a reason, signed, kept outside the project, logged; windows that ended before the newest lift no longer count.
- **Enforcement (`hooks.ts`).** The PreToolUse hook runs for every tool (setup matcher `*`). It reads the stop first, without opening the project (`new Store(root)`, the id registry and the note), so a project made unreadable cannot switch it off; during a stop it refuses everything but reading tools, the task list, `AskUserQuestion`, plan mode and Scenaria's own MCP tools (exact server and tool names) — the shell completely. Until a session's window is recorded, the hook reads the transcript first, so the very first tool of a new window is refused. The session start says a stop and warns when the hook before every tool is not wired. The proxy cannot hold a client up: `x-scenaria-stop`.
- **Notices (`core/windowact.ts` `windowNotices`, at a new prompt).** During a stop the agent hears it every time, the person once; the problem note, the escalation, the hint without criteria and a lossy handover (`handover-loss/1` over the tolerance: the full handover again) once each (tracked in the session scratch). `prepareHandover` carries the problem note; `sessionStartNote` the stand-in view.
- **`handover-loss/1`.** T = round(100 × (line to the goal + connection) / 2) from context fidelity (without a goal the connection alone); the old window's last step against the mean of the new window's first k steps in the same task (no tasks, automatic saves, Scenaria's own steps, steps too short to judge, or changed ones).
- **The person's values.** `minProgress` (1–50) and `tolerance` (0–50 points) in the same signed revision as the zone values (`context-settings/v2`; a revision signed before stays valid with the start values); rule string `v1.0[-p<rev>] min=… tolerance=… k=3`.
- **Dashboard (`ui/src/Window.tsx`).** A stop first in the context-window dialog (all views; lifting under the lock, never as an auditor, a reason chosen by the person, what is signed shown first), the Simple card and a header chip; per window the points with "How computed?" and the verdict; the handover checks; the two values in the settings form.
- **Limits.** The stop holds up an agent that is stuck, not one that changes the configuration folder or the hooks outside its tools. Two Claude Code sessions at once in one project can look like a window change. Progress is the project's: a window is credited with what others did meanwhile. Through the proxy only within one conversation, and only a notice.

## The ISO/IEC 42001 audit file (Batch C: C2 0.9.6, corrections C2.1 0.9.7, organisational evidence C3 0.9.8, signed export C4a 0.9.9, audit package C4b 0.9.10, dashboard and auditor mode C4c-1 0.9.11, evidence form C4c-2 0.9.12, closing review C5 0.9.13)

The audit file shows, for each of the 38 Annex A controls, what this project's records evidence. The catalogue (`core/iso42001.ts`, C1) names per control the best coverage Scenaria can reach and the evidence sources it needs (`required`) or that support it (`supporting`). `buildAuditFile(s, period)` (`core/auditfile.ts`, C2) computes the status from the real records:

- **Status.** `organisational` when the catalogue says so; `partly` when every required source holds data in the period; otherwise `not_covered`, with the missing sources named. Never higher than the catalogue's coverage. No control reaches `evidenced`.
- **What counts (rule 11).**
  - Verdicts carry a control only when they are independent and authentic: the person's or a registered audit agent's, signature valid, on an untampered step whose work did not change, not an unseen write, not removed. Self-reported, automatic and legacy verdicts are counted under "all" and never carry.
  - **A verdict counts once (C2.1, Kev 2026-10-16):** only for the "verdicts" source. The "approvals" source counts signed approvals of rules and work only: canon decisions and checks, line checks (gate), project-rule decisions. Verdicts, reseals and the audit file's read setting are listed with `carries: false`.
  - **Verdict history (C2.1, Kev 2026-10-16):** when a verdict of the person or an audit agent (or an older one without origin, but not an automatic result) is replaced, `verify()` archives it unchanged in `node.verificationHistory` (with `replacedAt`). The node file is in the hash chain, so removing or editing an entry shows as tampering; the field is not part of the work hash, so archiving never supersedes the current verdict. The audit file lists `verdictHistory` per step (current verdict and earlier ones, each with its signature state `signed` / `forged` / `untrusted` / `revoked` / `unsigned`, and `stepChanged` when the step was changed outside Scenaria). Earlier verdicts never count; an entry that no longer verifies raises the note `verdict_archive_invalid`.
  - **Damaged verdicts never break anything (C2.1):** a verdict field of the wrong type (a number as key, a request without key) makes the verdict `forged` (tampering) instead of throwing; `integrity().verdictsForged` lists them and the audit file raises the alarm `verdict_forged`. Key ids of anything that is not text are empty; signature checks accept text only.
  - **File states (C2.1, Kev 2026-10-16):** every audit file checks, with one `git cat-file --batch-check`, that each recorded file state still exists in the shadow repository. Missing ones do not count and raise the alarm `snapshot_missing`. A check that cannot run (no git) claims nothing missing; the source shows nothing and `evaluation_failed` says why.
  - Each approval names the fields its signature does not cover (`unsigned`, e.g. a canon decision's channel).
  - Canon and project rules count when signed by a trusted key and in force before the period ended; the main goal when it was recorded before the period ended (`meta.goalSince` on the root, in the hash chain; older projects: the root's time or the later "goal set" event).
  - Reseals count only when the record is authentic AND matches what this machine anchored (time included).
- **Period.** The whole project by default (Kev, 2026-10-16). `YYYY-MM-DD` is a whole day in UTC (in Germany a UTC day starts at 01:00, in summer at 02:00); a date-time needs a time zone; an end given to the minute includes that minute. Anything else is refused. Stored times without a time zone (imports, hand edits) are read as UTC, never in the server's local time. Rules count from their latest decision.
- **Integrity (Kev, 2026-10-16).** A damaged tamper evidence lowers no status. It shows a headline and a warning at every control that uses an affected source. The warnings come from the project check's codes (`INTEGRITY_RULES`: alarm or note, affected sources, plain words DE/EN); counts and items come from the engine's own lists, so they stay complete even when the project check fails. They concern the whole record, not only the period. A source that cannot be evaluated (a destroyed file) shows nothing and raises `evaluation_failed`; the file is always produced. Error details never carry machine paths.
- **Steps that vanished.** `integrity().stepsMissing` lists steps that are in the ledger but whose file was deleted or cannot be read (Scenaria never deletes step files). The project check reports them as `step_missing` (high).
  - **The newest step too (C5, review S-K2):** with an anchor on this machine, only the anchor's in-flight record excuses a step file that is older than its last ledger line, or missing (an interrupted write). The last ledger line no longer does, so deleting or rolling back the newest step raises the alarm at once. Without an anchor (a project first opened here) the last line still stands in for an interrupted write.
  - **Reading without the lock (C5, review R1):** `integrity()` holds no lock, so it can catch a write half-way. A step that looks changed or missing is read once more — the in-flight record first, then the file — and only what still fails counts. A regression test runs a writer and a reader side by side.
  - **Loops (C5, review S-K1):** a step whose parent links lead back to itself (a hand edit or a bad merge; Scenaria never writes one) never makes anything hang: every walk along parent links stops, and `parentCycles()` raises `step_cycle` (high, an alarm in the audit file).
- **Who may read it (`core/auditaccess.ts`).** Only the person sets it: `person` (default: approval session or interactive terminal) or `open` (everyone who can reach this Scenaria). Kept outside the project in `~/.config/scenaria/audit-access.json`, keyed by the bound project id and the real folder, signed with the approver key (`audit-access/v2`, bound to project and folder), with a separate high-water mark (`audit-access.marks.json`) against older settings put back. Anything that does not verify means `person` (fail-closed). Every change is logged.
  - **Limit:** this protects the audit file (view and export). The raw records (steps, export, canon, analysis) stay readable as before (rule 10).
- **Routes.** `GET /api/audit-file?from&to` (403 `approval_required` unless the setting is `open` or the request has the approval session), `GET /api/audit-file/access` (open), `POST /api/audit-file/access {mode}` (person-only gate). CLI: `scenaria audit-file [--from] [--to] [--json] [--out-file f]` (reading at an interactive terminal unless opened), `scenaria audit-file access [person|open]` (interactive terminal and typed confirmation).
- **Codes the audit file computes itself** (`AUDIT_FILE_OWN_CODES`): `evaluation_failed` and the `org_evidence_*` codes. Since 0.9.13 (C5, Kev 2026-10-17) `verdict_forged`, `snapshot_missing` and `verdict_archive_invalid` are also in the project check (`projectMetrics`), so the dashboard shows them too, and they lower the health score. A teammate's clone has no shadow repository, so every step there shows `snapshot_missing`; the text names a copy or clone as a possible cause.
- **The organisation's evidence per control (C3, 0.9.8, `core/orgevidence.ts`).** 25 of the 38 controls are the organisation's to evidence. The person records, per control, a document: link (`http`/`https` only, no credentials), SHA-256 of the document (`--doc-file` only computes it; the path is never stored), owner with role **and** name, the document's date, optional title and note. Kev's decisions (2026-10-16):
  - **Stored in the project and meant to be committed**, like `canon.json`: `.scenaria/org-evidence.json` (`{v, standard, entries, nextId}`).
  - **It never raises a status.** Each control gets its own field `orgEvidence: {state: documented | unconfirmed | none, entries}` next to the computed `status`; `summary.orgDocumented` counts documented controls. In the approvals list the decisions appear as kind `evidence` with `carries: false`.
  - **Signed like project rules:** every decision (record, remove, confirm) is signed with the approver key over every shown field (`orgevidence/v1`, unsigned: none), bound to the project and a revision; the newest revision per entry is anchored outside the project (`anchors/<projectId>.evidence.json`, key `ev:<id>`). Trust: `verified` / `untrusted` / `unsigned` / `tampered`. Once an entry is anchored, anything but a newer (or the same) revision validly signed by a trusted key is `tampered` (an edit, a rollback, another key, a re-activated removal); a duplicate id is `tampered`. Only `verified` counts. Control and direction characters are dropped on read and refused on input; links are stored normalised (an international domain as punycode). The file must be a plain file of at most 2 MB. An entry's content never changes: a new document is a new entry, the old one is removed (kept as a signed tombstone with `removedAt`; who recorded it and when stays in `recordedBy/Via/At`). Ids are never reused: a new id was never signed (not anchored) and is not in the file; a planted huge id cannot block new ones.
  - **The person never signs content they did not enter or compare (review C3-1, C3-2, N1, N3).** Every decision is judged and signed on ONE reading of the file, and nothing is written when the file changed meanwhile. Removing the person's own entry keeps its content; copies added under the same id are dropped. An entry that was never the person's (unsigned, a teammate's untrusted key) is *discarded*: replaced by a signed tombstone without content (`discarded: true`), which never counts. Since 0.9.13 the tombstone keeps the control it concerned, when every copy names the same real Annex A control (C5), so the approvals list still says which control. The person's entry changed outside Scenaria is not discarded silently: restore the file from git, or discard it explicitly (`--discard`). Confirming needs the digest of exactly the stored entry (`entryDigest`, listed by `GET …/evidence`); a teammate's or unsigned entry is in force from the confirmation on and loses any "copied from" claim.
  - **Bound to the catalogue:** each entry carries the control's fingerprint (id, coverage, titles, the organisation's part); when the catalogue's wording changes, the entry still counts but raises the note `org_evidence_catalogue_changed` until the person confirms it. The audit file names the catalogue it was computed with (`catalogue: {standard, controls, hash}`).
  - **Per project, with "take over from another project":** `planCopy` shows what would be taken over: the active entries of another of the person's projects that this machine can vouch for (verified for THAT project, catalogue unchanged, not here yet), and how many other existing folders claim the same project id (a second checkout or a copy: shown, never a refusal that a throwaway folder could force). `copyOrgEvidence` then takes exactly the ids the person saw (`expect`); each is recorded and signed anew here, in force from now, with `copiedFrom` = the other project's name (never a path). Organisation-wide evidence comes with Batch D.
  - **Period:** the whole project shows the current state; a period shows what was in force at some point of it (`activeFrom` ≤ end, not removed before the start).
  - **Warnings** (computed by the audit file, `controls` names the affected controls): `org_evidence_tampered`, `org_evidence_missing` (recorded, then deleted from the file), `org_evidence_unreadable` (alarms); `org_evidence_unconfirmed`, `org_evidence_catalogue_changed` (notes).
  - **Who:** reading follows the audit file's setting (`GET /api/audit-file/evidence`, `scenaria audit-file evidence`). Every change is the person's: `POST /api/audit-file/evidence` (`{control, url, hash, role, name, date, title?, note?}`), `…/remove` (`{id, discard?}`), `…/confirm` (`{id, digest}`), `…/copy` (`{from, dryRun: true}` for the plan, then `{from, expect}`) — approval session, under the `personOnly` prefix; CLI `scenaria audit-file evidence add|rm|confirm|copy` (interactive terminal and typed confirmation; the CLI shows the full entry or plan first). Copying takes only a project from the person's project list, never any folder. A tampered entry cannot be confirmed.
  - **Limits:** the file is committed, so role and name are visible to everyone who can read the repository. Scenaria does not fetch the link; an auditor checks the document against the hash. Since C4c-2 (0.9.12) the person also records, removes, confirms and takes over entries in the dashboard (see below).
- **The signed audit file (C4a, 0.9.9, `core/auditexport.ts`).** Kev's decisions (2026-10-16): the signed JSON is the evidence; Markdown (and PDF from C4b) are reading copies that carry its fingerprint; people are named by default, "roles only" on request.
  - **Body:** `{kind: "scenaria/iso42001-audit-export", version, names, context: {scenariaVersion, generatedAt, projectId, ledger {lines, head, genesis}, anchor {genesis, lines, head} (no folder path), catalogue, period, meaning DE/EN}, file: <the audit file>}`.
  - **Signature:** SHA-256 over the canonical body (`canonicalJson`: keys sorted, `undefined` dropped, no whitespace — RFC 8785/JCS for JSON data) → `digest`; the person's approver key signs the UTF-8 bytes of `["<projectId>","audit-export/v1","<digest>"]` (Ed25519, the same as `signRecord`; the tag keeps it apart from every other signed record). `signature` carries `alg, digest, projectId, keyId, pub, sig` and the `signed` text for other tools — a checker rebuilds that text from `projectId` and `digest` and never takes it from the file (review C4a-1).
  - **Well-formed text (C5, review S-K3/R5):** records may hold a lone surrogate (an agent can send one); the export writes and hashes it as U+FFFD, so the person's export always passes `verify`. Checking refuses lone surrogates in text and in objects alike.
  - **Strict checking:** `verify` reads the file with a strict JSON parser (no duplicate keys, no `__proto__`/`constructor`/`prototype` keys, only finite and exact numbers, nesting ≤ 64, ≤ 64 MB), checks algorithm, digest and project-id formats, the rebuilt signed text, the key id, and that the integrity state and names mode are ones Scenaria writes. The terminal output shows only values computed or checked by `verify` (control characters stripped) and says loudly when the signed file itself reports a damaged tamper evidence.
  - **Meaning, stated in the file:** computed by Scenaria at that time on that machine from these records and released by the key's holder — not proof of every fact; the integrity section says how far the records are reliable. The auditor confirms the key id with the person over a second channel.
  - **Roles only (`withoutNames`):** owners keep their role (name empty); who decided becomes "person" or "audit agent"; OS accounts and registered audit agents (since 0.9.13) are only counted. Recorded in the signed `names` field.
  - **Who:** signing is the person's: `POST /api/audit-file/export {from?, to?, names?, lang?}` (approval session; returns `{export, markdown}`), CLI `scenaria audit-file export [--from] [--to] [--roles-only] [--lang de|en] [--out-dir]` (interactive terminal, typed "sign"; the folder is checked before signing; writes `.json` and `.md` named with the time to the second, the names mode and a short fingerprint, created exclusively so nothing existing or a planted link is written over). Checking is anyone's and needs no project: `scenaria audit-file verify <file.json>` (`verifyAuditExport`, never throws; exit code 1 when not valid; says whether the key is trusted on this machine).
  - **Markdown (`renderAuditMarkdown`, DE/EN):** header with fingerprint and key id, period, hash-chain head, names mode, meaning and scope; tamper evidence; summary; one row per control (status from the records, the organisation's document, notes); the organisation's documents with hash, owner, date and in-force period; signed approvals and decisions (unsigned fields marked); verdict history; reseals; how to check. Recorded text is escaped (every Markdown metacharacter, HTML, line breaks, control and direction characters), so it can never become a link, an image, emphasis or a new cell. Roles only also leaves out the project check's technical messages; titles and texts stay as recorded.
- **The audit package (C4b, 0.9.10, `core/auditpackage.ts`, `core/audithtml.ts`).** Kev's decisions (2026-10-16): the PDF is made by the browser from a print-ready page (no PDF library); `verify` without a name finds the newest audit file in the folder.
  - **`scenaria audit-file export`** now writes a package folder `audit-package-<project>-<time>-<names>-<fingerprint>/` with `audit-file.json` (the evidence), `audit-file.html` (print-ready reading copy, opened in the browser at an interactive terminal unless `--no-open`: "Print → Save as PDF"), `audit-file.md`, `audit-file.copies.json` (the person's signature over both reading copies) and `PRUEFEN.txt`/`CHECK.txt` (contents, fingerprint, key id to confirm, how to check). Folder and files are created exclusively. `POST /api/audit-file/export` also returns `html`.
  - **The page:** self-contained (no scripts, no links, nothing loaded; a Content-Security-Policy `default-src 'none'`), every recorded text HTML-escaped and without control or direction characters; A4, fixed width (long words wrap, nothing is cut off at the right); the controls grouped by area with status, the organisation's document and notes; step titles shown apart from verdicts; one `<meta name="scenaria-fingerprint">`; the fingerprint line (project, "reading copy", short fingerprint, key id) is the footer row of the table the page sits in, so every browser repeats it on every printed page.
  - **`scenaria audit-file verify [<file.json> | <package folder>]`:** without a name it checks the newest export in the current folder and names it — inside a package folder only its own `audit-file.json`; elsewhere packages and single `audit-file*.json` files by modification time, saying how many others there are (times can be set by anyone, so name the file when in doubt). For a package the reading copies are checked against the person's signature over their SHA-256 hashes (`audit-file.copies.json`: `[projectId, "audit-copies/v1", digest, lang, sha256(html), sha256(md)]`, the same key as the evidence; written by `export`), which works with any Scenaria version; without it they are rendered again from the verified evidence (DE and EN) and compared byte for byte. **Since 0.9.13 (C5, review S-K5/S-K6/R2):** the copies signature is `audit-copies/v2` and covers the note too (`[…, sha256(note)]`, the note named by the signed language); v1 packages still verify. Files are hashed as raw bytes and the evidence is read as strict UTF-8 (an invalid byte is refused, never turned into U+FFFD). Files Scenaria did not write — a PDF saved there, the note of the other language — are named as "not part of the package, not checked". The first line of the output states the overall result: "NOT VALID as a package: …" when a copy or the note changed or the copies signature fails, even though the evidence itself is valid. Results: "same content", "does not show what the evidence holds" (exit 1), "made by another Scenaria version — cannot be compared" (only without the copies signature) or "missing"; a copies signature that does not verify, is not a plain small file, or is missing from a package exported by 0.9.10 or later (which always writes it) fails (exit 1); for a single file it says the reading copies were not checked.
  - **Opening the page:** by the system's own program at its absolute path (`/usr/bin/open`, `%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler`, `/usr/bin/xdg-open`), with an absolute file path — never a program found in the project folder.
- **In the dashboard (C4c-1, 0.9.11, `ui/src/AuditFile.tsx`).** View "Prüfung" → "Prüfakte" (help topic `audit-file`): the scope, a period (UTC days), the tamper protection with every warning (also the audit file's own codes), the counts as filters, the 38 controls by area (status, the organisation's documents, details per control: what Scenaria shows, the sources with data and what is missing, the documents with hash, owner, trust and whether they count), the signed approvals (unsigned fields named), the verdict history, the reseals and all sources. Times are shown with their time zone. "partly evidenced" never uses the green of "verified" (since 0.9.13 also not on the print page or in the terminal). Since 0.9.13 (C5): the package button waits while typed dates differ from the period shown, and the done message names the period; readers other than the person see "signed by the person"; the approvals list and verdict history use plain labels instead of codes; the read setting is shown (changing it stays in the terminal). The forecast audit (Batch B: under "Extensions") is called "Prognose-Prüfung" / "Forecast audit".
- **The audit package from the dashboard (C4c-1).** `POST /api/audit-file/package {from?, to?, names, lang, open?}` (person-only, local mode only; team mode: `team_mode`): exactly the period shown; the target folder is checked BEFORE signing — an absolute home, `~/Downloads` (else the home folder) as a real folder (`realpathSync.native`), never inside the project or the viewed project (compared without case on macOS and Windows), writable. Then the same writer as the CLI (`writeAuditPackage`, copies signature included); the print page is opened by the system's opener with an absolute path. The answer carries the folder's name, where (`downloads` | `home`), fingerprint, key id and names mode — never a machine path; a write error answers `package_failed` without a path.
- **The auditor mode on site (C4c-1, Kev 2026-10-16/17).** The person hands a browser to an auditor: `POST /api/audit-file/auditor-mode` (person-only, local mode only, at most once per 10 s) sets the HttpOnly, SameSite=Strict cookie `scenaria_auditview` (8 h) and clears the approval cookie.
  - **Signed cookie (review R1):** the value is `<48 hex random>.<valid until, base36 ms>.<HMAC-SHA256, 32 hex>`; the HMAC key is 32 random bytes in the person's config folder (`auditview.key`, mode 600, created exclusively on first use, kept across restarts; a damaged, too short key is replaced on disk, never kept only in memory — C5). Only cookies with a valid HMAC count; anything else (a cookie planted by another page on 127.0.0.1 — cookies do not separate ports) is ignored entirely. Team mode ignores the cookie.
  - **Reading:** the server keeps at most 5 auditor-mode browsers (keyed by sha256 of the cookie, oldest dropped), shared by every app of one server (a project switch keeps the mode); a restart forgets them. A listed cookie reads `GET /api/audit-file` and `/api/audit-file/evidence` whatever the read setting; `GET /api/approval` answers `auditView: true | "stale" | false` ("stale": a cookie Scenaria issued that the server no longer lists).
  - **Never writing (fail closed):** every request other than GET/HEAD that carries a cookie Scenaria issued — listed, expired or from before a restart — is refused (403 `auditor_mode`) at the top of the handler, before the LLM proxy, except `POST /api/audit-file/auditor-mode/end` (anyone may call it; it clears the cookie and logs only when a listed one ended).
  - **No approval for the auditor's browser (review K1, S1):** an approval link redeemed in a browser carrying such a cookie grants nothing: the link is used up, the auditor mode ends there, the browser lands on `/?approval=auditor`. While an auditor-mode browser checked in during the last 10 minutes (its dashboard asks `GET /api/approval` every 2 minutes), `POST /api/approval/open` is refused for everyone (409 `auditor_mode_active`; the dashboard mark is only a claim), so no link can land in the auditor's browser; a closed auditor window stops blocking after 10 minutes.
  - **The dashboard in auditor mode:** a band ("only reads", "Prüfakte", "End auditor mode"); a `ReadOnlyContext` hides the write actions (step panel, simple view, goal, chat, canon dialog, extensions, settings) and the lock; locked notes show a read-only note.
  - **Honest limit:** this protects against mistakes. On the person's own computer someone can open another browser, a private window or a terminal. Also, the auditor can end the mode in the band and then click the lock: the fresh approval link opens in the default browser, often the auditor's own (review C5 S-K4; Kev 2026-10-17: documented, no lockout, which would also lock out the person). The person stays nearby and ends the mode themselves.
- **The organisation's evidence in the dashboard (C4c-2, 0.9.12, `ui/src/OrgEvidenceForm.tsx`).** Only for the approved person, never in auditor mode. The rule from C3 holds: the person signs only what they saw.
  - **Record** (at the control: "Dokument erfassen"): link, the document's SHA-256 — computed in the browser from a chosen file (`crypto.subtle`, at most 512 MB; the file is never uploaded) or pasted —, title, owner role and name, the document's date, note. "Prüfen" sends `POST /api/audit-file/evidence {…, dryRun: true}`: the values checked and normalised by `validateInput` (an international domain as punycode), nothing written. The person sees exactly them, and "Signieren und speichern" sends those values; normalising is idempotent, so the signed entry is the one shown.
  - **Remove / discard:** `POST …/remove {id, discard?, dryRun: true}` returns `planRemove` (outcome `remove` / `drop_copies` / `discard` / `restore_first` / `already_removed`, the entry, the digest of the entry concerned); the person sees the outcome in plain words and the entry, and the call sends `expect: {outcome, digest}` — **required** over HTTP (400 `plan_first`) and passed by the CLI (review K3). `removeOrgEvidence` decides again under the lock on one reading of the file and refuses anything else (`changed`). `restore_first` offers "discard anyway" (plans again with `discard: true`).
  - **Confirm** (a teammate's or unsigned entry, or one whose control wording changed): the entry is shown, the dashboard sends its `digest` (C3). An entry whose stored values are not in their checked normal form (e.g. a look-alike link that would be signed as punycode, an upper-case hash) is refused (`not_normal`): signing would change it (review K2). `GET …/evidence` marks such entries (`normal: false`); the dashboard offers only "discard" and shows the punycode next to any link not stored in normal form (R1).
  - **Take over from another project:** the person's other projects on this computer (`/api/projects`), then the plan (`dryRun`: what would be taken over with every signed field incl. the note, the project name recorded as the origin, what not and why, other folders claiming the same project), then `expect: {name, entries: [{id, digest}]}` — `takeDigest` covers every signed value; required by the core, HTTP and the CLI; a changed name or entry is refused (review K1, R2).
  - **Normalising is idempotent** (`clean` trims after cutting, review K4), so a preview sent back is signed unchanged. Scenaria's own error codes (`not_normal`, `changed`, `plan_first`, auditor mode) are shown in the person's language.
  - **Privacy note in the form:** the entry is committed with the project; role and name are visible to everyone who can read the repository.

## Canon events (fixed points)

- **Storage.** `canon.json` (committed) holds `k1…` events of kind `past` or `future`.
  - Fields: `hard`, optional `check` command, `due`, `evidence`.
  - Status flow: `proposed → active → retired`, or `proposed → rejected`.
  - Audit: `proposedBy`, `decidedBy`, `decidedVia`, plus `canon` events in the log.
- **Governance.** Only `addCanonAsUser` and `decideCanon` can make an event binding.
  - They are reached from the dashboard (local: loopback + X-Scenaria; team: token) and from the CLI, where the CLI refuses without an interactive TTY. That keeps agent shells out.
  - The MCP/HTTP tool `scenaria_canon` can only list, suggest and propose. Engine-level `respectsCanon`/`breaksCanon` only keep approved ids.
  - Dashboard decisions need the approval session (HttpOnly, SameSite=Strict cookie) set by the approval link. Local mode: a random code per start that works **once** and is handed to the browser only, never printed (since 0.9.5; `--print-approval-link` for a machine without a browser). Team mode: `SCENARIA_APPROVER_TOKEN`.
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
- **Gate per line (`gate.ts`, stage 2).** Lines = each scenario's newest node with a snapshot. `runGate` exports the snapshot with `ShadowRepo.exportTo` (read-tree + checkout-index into a temp dir with its own index — project and shadow index untouched), links dependency folders (`node_modules`, `.venv`, `venv`, `vendor`, plain excluded dirs), runs every adopted check there, and stores the newest result per (node, event) in `gate.json`. Results are signed (`gate/v1`, project id, sequence number, event text and command) and anchored like canon events; a result whose event text/command changed is no longer evidence. `stringPayload` takes the deepest evidence on the line from `lastCheck` and the gate. Only a person starts the gate (approval session or interactive CLI). Linked dependency folders are a fixed list and shared with the project (a check that installs packages writes into the real `node_modules`).
- **Relay (`relay.ts`, stage 3).** Three LLM calls with disjoint context: archivist (question, past canon, rules, dossier), craftsman (question, constraints, active canon, capsule), oracle (options, future canon, hard past constraints, today). Each role resolves its model via `effectiveLlm(role)`. The orchestrator is deterministic: unknown canon ids are dropped, options that break hard canon or fail a hard future event are cut, and with `createDecision` an open decision (no `chosen`, tag `relay`, oracle verdict in each option's description) is recorded. Reports: `.scenaria/relays/rlN.json`.

## Settings, chat and key handling (v0.7)

- **Settings** (`settings.ts`) live in the global config (`~/.config/scenaria/config.json`): `llm.default`, `llm.roles` (chat, analysis, analyst, archivist, craftsman, oracle, auditor), `trustedEndpoints`, `chat` (`confirmDestructive`, `maxSteps`). Resolution: request override → role → default → project `analysis` config. Never a key.
- **Env keys** (`envKeyAllowed`): a key from an environment variable is sent only to the provider's official base URL or to a trusted endpoint from the global config. A base URL from a request or from the project's `config.json` gets no env key (otherwise an agent could point `openai` at itself and receive `OPENAI_API_KEY`). Only the provider's own variable is used (`apiKeyEnv` from config files is ignored — an agent could otherwise pick another provider's key); local servers (Ollama, LM Studio) never get an env key. Any other key is entered per session.
- **Chat** (`src/chat.ts`): provider-neutral tool loop (OpenAI-compatible `tools`/`tool_calls`, Anthropic `tool_use`/`tool_result`). Tools = the 18 Scenaria tools + `scenaria_relay`. Calls of tools with `destructiveHint` (rewind, fork) stop the loop as `pending` until the person answers (`decisions: {id: approve|deny}`); the client resends the history (tool data stays in the browser). Max steps per message from the settings. Each turn is logged with `logMessages(…, "history")` under `chat:<session>` and becomes a task like proxy conversations. The chat model has agent rights only: canon proposals, never approvals or check commands.
- **Person actions in the chat:** chat-only tools `scenaria_canon_decide`, `scenaria_canon_check`, `scenaria_gate`, `scenaria_analyze`, `scenaria_set_model`, `scenaria_connect_agents` always stop as `pending` (regardless of `confirmDestructive`); Scenaria writes the card text (`summary`) from the real data, and they run only with the person's `decisions[id] = approve`. Canon approval via chat never adopts a check command.
- **Providers:** Ollama goes through native `/api/chat` (`options.num_ctx`, default 16384) because its OpenAI-compatible endpoint truncates silently at the model's default context. Tool calls written as text (`<tool_call>…</tool_call>`, or a JSON block that is the whole answer) are parsed; `<think>` blocks are stripped. Local models get a 600 s timeout.
- **UI robustness:** `translate="no"` (browser page translation rewrites React's text nodes and crashed the app into a blank page) and error boundaries around the app, side panel and dialogs. A used/invalid approval link redirects to `/?approval=invalid` (dashboard read-only with a note) instead of a dead page.
- **Chat confirmations:** tool-call ids are assigned by Scenaria (never the provider's), and the person's `decisions` apply only to the calls that were waiting when they answered; calls the person skipped by writing a new message are closed as "not executed".
- **Endpoints** `POST /api/settings*`, `/api/agents/connect`, `/api/chat`, `/api/relay`, `/api/canon/*` (incl. archivist and gate), `/api/analysis/run|config` require the approval session (they act for the person or spend the person's quota); `GET /api/settings` shows effective models, which providers have env keys (names only), agent status (`agentStatus`) and connection snippets.

## Forecasts, the multiverse and the auditor (v0.8–v0.9)

- **Core / quick forecast** (`predict.ts`, model v2, deterministic, no model): predicts the SAME quantity that is measured afterwards — the mean context fidelity of the first 5 content steps on the option's line within the task (`measureLine`, at least 2 steps). Two parts with the fidelity formula (`stepComponents`, shared with `fidelity.ts`): `own` = the option's own words, `ctx` = question + option as the next step in context, both on the line before the choice. `P = L + α(own−L) + β(ctx−L) − risk`, L = mean of the last 5 content steps; risk = lessons (−6 each, max 18) and hard dated canon (−6 each, max 12). α, β by constrained least squares on this project's past decisions (shrunk to 0.25/0.25); band = 80th percentile of leave-one-decision-out errors (≥ 8 decisions, else ±20). Every number is in `explain` and the shown formula reproduces it exactly.
- **Backtest without the future** (`viewAsOf`): only nodes created by t, field values restored from `meta.fieldHistory`, lessons/verifications/canon/main goal as of t. `forecastQuality`: leave-one-decision-out MAE vs. naive persistence (skill), bias, coverage of the band, breaks, ranking; meaningful from 10 decisions; tampered cases excluded. Test bench (`benchmark`, worker thread): synthetic clear/neutral/limit cases.
- **Oracle v2** (`oracle.ts`, three model calls, disjoint context built from a View): archivist (`--- PAST ---`: earlier decisions, lessons, past canon), craftsman (`--- CURRENT LINE ---`: next steps, keeps/loses), oracle (main goal, future canon, hard past constraints, the two findings and the CORE table). The oracle may only correct `own`/`ctx`: Δ ∈ [−20, 20] each, with a reason AND evidence ids that exist in its material; generic ids (root, task, the decision itself) are ignored, invented ids dropped; without both it counts 0 ("unbacked"). `applied = clamp(Δ·confidence·γ, ±20)`, confidence rounded to 2 decimals; the final number uses the core formula with the corrected parts; a hard fixed point at risk caps at 40. γ (trust) is fitted by least squares on [0, 1.5] from checked cases with corrections, shrunk towards 1 (weight 5). The texts behind all cited ids are stored with the forecast (`evidence`, signed).
- **Prüf-Experte** (`auditor.ts`): `auditForecast` — deterministic checklist (timing vs. the choose event, signature, model, goal, line, signal, options distinguishable vs. band, core skill on this project, warning flags, backed/dropped/generic evidence, word-relevance hint, recommendation vs. numbers, canon cap, γ, deep audit) → reliable / caution / unreliable. A core warning counts as resolved and a correction ≥ 10 counts as checked only with the skeptic's "supported". `deepAudit` (role `auditor`, person-only): each claim judged only against the evidence as it was cited; unsupported corrections removed in the audited forecast; signed records in `.scenaria/audits/aN.json` (the newest signed one is used). `oracleBacktest` (person-only): past decisions re-forecast as of their own time, core vs. core + oracle; signed records in `.scenaria/forecast-backtests/bN.json`; feeds γ and `oracleQuality` (compared only on cases the oracle changed, a tendency below 10 decisions). Endpoints: `GET /api/forecast/audit`, `GET /api/forecast/oracle` (open), `POST /api/forecast/audit`, `POST /api/forecast/oracle-backtest` (approval session). CLI `scenaria forecast --audit fN [--deep]`, `--oracle-backtest [--limit n]` (model paths need a terminal); chat tool `scenaria_audit_forecast`.
- **Ease of use and audit (0.9.1):** `runMultiverse` asks a role again once when its answer is not JSON (Ollama with `format: "json"`), then continues without that role (warning); keys, labels, order, "75" confidence and "+8" deltas are understood. `GET /api/forecast/progress` shows the running job (role by role); `POST /api/forecast/decision` lets the person write down a decision; `oracleBacktest({decisions})` re-forecasts any decided decision as of its time (shown even when not yet measurable; only measured options teach γ). `auditOverview` / `auditReportMarkdown` (`GET /api/audit/overview`, `GET /api/audit/report?format=md|json`, read-only) feed the auditor's area (since 0.9.11 called "Prognose-Prüfung" / "Forecast audit", Manage → Extensions, so it is not confused with the ISO/IEC 42001 audit file).
- **Automatic (opt-in):** only when the person switched it on (Settings, `forecast.auto`, default off) and only with the model the person chose in their global settings (never the project's `config.json`, which agents can edit): open decisions on the HEAD line (≥ 2 options, not chosen, no verified multiverse yet) get a multiverse forecast in the background, one at a time, at most `forecast.dailyLimit` per day (default 20), at most two attempts per decision (then reported as failed). Starting one by hand needs the approval session (`POST /api/forecast`, chat tool `scenaria_multiverse`, CLI `scenaria forecast` in a terminal); reading is open (`GET /api/forecasts`, `/api/forecast/quick`). Session keys are only handed to role models of the same provider (`keyFor`).
- **Integrity:** forecast files are signed (approver key, project-bound, content hash). Unsigned or edited files are shown as unverified and never count (they cannot suppress or replace a real forecast). The quick forecast of every new open decision is saved as a snapshot (no model) so it can be evaluated later. The craftsman (and the relay's craftsman) gets the capsule without future canon lines.
- **Evaluation:** for options really taken after the forecast (chosen or explored), the measured fidelity of the branch (`measureLine`, the same quantity as the forecast; model-v1 forecasts are kept but not scored) is compared with the predicted score → per-forecast error and overall calibration (mean error, hits within ±15). Prompt forecasts: the line after the forecast is measured; once the person marks which variant they used, it is compared with that variant's forecast.
- **Quick layer details:** options with too little text (“yes”/“no”) are marked `signal: low`; nearly equal scores are reported as “not distinguishable without a model — multiverse recommended”. Fixed points touched by wording are listed (`canonHints`); hard and dated ones lower the score a little and must be judged by the oracle.

## The analyst — expert report to optimise with (v0.8)

`src/core/expert.ts`. A specialised agent that reviews one line of work, the whole project or **all**
Scenaria projects of the person (registry in the global config, `src/core/projects.ts`; projects are
remembered when the dashboard, the MCP server or `scenaria init` opens them).

1. **Facts, deterministic.** `factSheet()` computes KPIs (steps, decisions, rationale rate, decision
   quality, context fidelity and breaks, drifts, verification, canon active/broken/proposed, valid/invalid
   lines from the gate, forecast hit rate, rules, lessons), every line with its verdict and fidelity,
   agents/models and issues — plus the list of ids that may serve as evidence.
2. **Rule-based findings** need no model, so a baseline report is always possible (also the agents'
   read-only `scenaria_expert` tool when no report exists — nothing is stored then).
3. **Expert layer** (role `analyst`, any model): reads only the fact sheet (+ the dossier for one
   project) and answers through four lenses — architecture & technical decisions, goal & product
   alignment, agent workflow & context engineering, governance & risk in the spirit of ISO/IEC 42001 —
   with maturity, findings, root causes, prioritised recommendations (P1–P3, effort, KPI to move).
4. **Validation**: evidence ids that do not exist are removed; a quoted KPI value that differs from the
   facts is corrected (and noted); unknown KPIs are dropped; findings without valid evidence are marked
   "unverified" and sorted last.

Single-project reports live in `.scenaria/reports/x<n>.json`; reports across projects in the person's config folder (`~/.config/scenaria/reports/g<n>.json`, readable only with the approval session; other projects' folders are not written). Every report is signed (Ed25519, like forecasts); a file written around Scenaria is shown as unconfirmed and nothing can be adopted from it. "Adopted" is derived from the real project rules. The summary is always the facts; the model's text is shown separately, its maturity can move the rule-based score by at most ±15, a quoted KPI the facts contradict marks the finding (and recommendations on that KPI) as contradicted, evidence must be about the finding, and numbers in the model's text that are not in the facts are flagged. Recommendations are "rule" (can be adopted) or "task" (do once). The project registry is its own file (`projects.json`). Reports across projects are the person's in the CLI too (interactive terminal only).

Known limits of the check (stated in the report): a statement with the right value can still be wrong; a simple heuristic flags obvious mismatches ("missing" at ≥ 90 %, a count of problems that is 0). Numbers in free text are matched against all fact numbers ±1, which is coarse for 0–100. That is why the computed facts always come first and the model's words are labelled.
Running (`POST /api/expert`) and adopting a recommendation as a project rule (`POST /api/expert/adopt`)
are the person's (approval session / interactive terminal / chat card); reading is open.
CLI: `scenaria analyst [--scope project|line|all] [--head n12] [--no-model]`, `scenaria analyst x3
[--adopt 0] [--out-file report.md]`.

## Switching projects (v0.8)

The person's projects are remembered in `~/.config/scenaria/projects.json` (dashboard, MCP server and
`scenaria init` register them). The dashboard's project name is a switcher: one click shows the list
(name, folder, last use; missing folders greyed out, removable without touching files) and switches.

- One server, one approval session: `startServer` keeps one approval secret and the single-use link
  state for its lifetime; switching creates a fresh app for the new project and closes the old one
  (its open dashboards get an SSE `project` event and remount; requests already running finish in the
  project they started in, and the old automatic-forecast timer stops).
- The list and the switch are the person's (approval session) and only in local mode; agents only see
  the current project's name, never folders. Agents keep working in their own project: MCP/CLI agents
  run in their own process, and the server's agent endpoints (`/api/v1/*` tool calls, pasted answers,
  conversation logging, every other `/api/` call that is not from the dashboard, and the LLM proxy
  `/proxy/*`) stay bound to the project the server was started
  in (where auto-save runs too). Only requests the dashboard marks (`x-scenaria-view: dashboard`) follow
  a switch; the switcher says so when the two differ.
- The UI keeps the session API keys (memory only) across switches; everything else is reloaded.
- The daily limit of automatic forecasts is one budget for all projects together.

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

(Who may give a verdict that counts: see "Who may say verified" above.)

`verify(id)` runs these checks:

- the snapshot exists,
- paths claimed in outputs/facts (in backticks or path-like) exist in the snapshot,
- a decision has a chosen option and a rationale, and confidence ≥ 0.5,
- changed files are documented,
- irreversible effects are flagged,
- optionally `verifyCommand`, run only if the node is HEAD and the tree is clean.

A verdict of the person or a registered audit agent overrides the automatic result; a verifier agent's verdict is a self-report. `lastGood()` is the nearest node on the path whose `passed` is confirmed (`integrity().confirmed`).

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

### Three views on the same data (0.9.3)

- **Simple** (default for a new browser, `localStorage "scenaria.view.v1"`): the history as a time axis by day, newest first, one plain sentence per step (`SimpleView.tsx`). The highlighter marks "Now". "Back to this state" calls the same `rewind` (files restored, autosave first) and offers Undo; "What did the AI do?" shows the leading user request (`/api/node/:id/messages`), outputs, files and the diff; "open as folder" materialises the snapshot folder. "Checked by you" uses `integrity().confirmed` only (also the node panel and the map: nothing counts while the check loads or fails, and the Simple view then warns). "Back to the state at the end of yesterday" asks `GET /api/head-at?until=<local midnight>`, which replays the event log, so an evening "go back" is respected.
- **Audit**: the scenario map with goal bar, rules and milestones, project check, protocol and conversations.
- **Manage**: the map with chat, analysis, "Extensions" (forecasts, Prüf-Experte, relay; code unchanged) and "More".

### The approval mode without copying a link (0.9.3)

`scenaria start` opens the first single-use link itself. Later, the lock 🔒 in the top bar (and the button in every locked notice) sends `POST /api/approval/open` (needs `X-Scenaria: 1`, local mode only). The server process creates a fresh single-use code (valid 60 s, at most three outstanding; the start link stays valid) and hands `/?approve=<code>` to the operating system's browser (`open` / `xdg-open` / `start`). A code is used up before anything else is checked, also when the browser is already approved, so it never stays valid in a browser history. The answer only says "opened", "already", "busy" (15 s between openings from the dashboard, 60 s for anything else) or "no browser", and the request is logged with who asked. Every window of that browser shares the cookie, so the window that asked becomes approved too. Team mode keeps the approver token.

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

  If a Scenaria already serves the same folder on ports 4477–4486 (`/api/v1/health` → `rootKey`, a hash of the real path), `start` does not start a second server: it asks the running one to open its dashboard with approval and exits.
- **Start icon** (`scenaria launcher`, Settings → "Create start icon"): a `.command` (macOS), `.cmd` (Windows, UTF-8 code page first) or `.desktop` (Linux) file on the desktop (or in the project) that runs `scenaria start --launcher --root <folder>`. With `--launcher`, `start` refuses to set up a project, so a moved folder or an icon run elsewhere never turns the desktop into a project.
- **Claude Desktop** has no project folder, so `--for claude-desktop` writes one entry per project into the app's `claude_desktop_config.json` (`scenaria-<folder>`, args `… mcp --root <real path>`, `SCENARIA_AGENT=claude-desktop`). An existing entry for the same folder is updated, other entries and settings are kept; a file with comments is left alone. It is never part of `all` or of the automatic wiring in `start`.
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
