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

## The ISO/IEC 42001 audit file (Batch C, 0.9.6)

The audit file shows, for each of the 38 Annex A controls, what this project's records evidence. The catalogue (`core/iso42001.ts`, C1) names per control the best coverage Scenaria can reach and the evidence sources it needs (`required`) or that support it (`supporting`). `buildAuditFile(s, period)` (`core/auditfile.ts`, C2) computes the status from the real records:

- **Status.** `organisational` when the catalogue says so; `partly` when every required source holds data in the period; otherwise `not_covered`, with the missing sources named. Never higher than the catalogue's coverage. No control reaches `evidenced`.
- **What counts (rule 11).**
  - Verdicts carry a control only when they are independent and authentic: the person's or a registered audit agent's, signature valid, on an untampered step whose work did not change, not an unseen write, not removed. Self-reported, automatic and legacy verdicts are counted under "all" and never carry.
  - The "approvals" source counts signed approvals of rules and work: canon decisions and checks, line checks (gate), project-rule decisions, independent verdicts. Reseals and the audit file's read setting are listed with `carries: false`: they approve no work.
  - Each approval names the fields its signature does not cover (`unsigned`, e.g. a canon decision's channel).
  - Canon and project rules count when signed by a trusted key and in force before the period ended; the main goal when it was recorded before the period ended (`meta.goalSince` on the root, in the hash chain; older projects: the root's time or the later "goal set" event).
  - Reseals count only when the record is authentic AND matches what this machine anchored (time included).
- **Period.** The whole project by default (Kev, 2026-10-16). `YYYY-MM-DD` is a whole day in UTC; a date-time needs a time zone. Anything else is refused.
- **Integrity (Kev, 2026-10-16).** A damaged tamper evidence lowers no status. It shows a headline and a warning at every control that uses an affected source. The warnings come from the project check's codes (`INTEGRITY_RULES`: alarm or note, affected sources, plain words DE/EN); counts and items come from the engine's own lists, so they stay complete even when the project check fails. They concern the whole record, not only the period. A source that cannot be evaluated (a destroyed file) shows nothing and raises `evaluation_failed`; the file is always produced. Error details never carry machine paths.
- **Steps that vanished.** `integrity().stepsMissing` lists steps that are in the ledger but whose file was deleted or cannot be read (Scenaria never deletes step files). The project check reports them as `step_missing` (high).
- **Who may read it (`core/auditaccess.ts`).** Only the person sets it: `person` (default: approval session or interactive terminal) or `open` (everyone who can reach this Scenaria). Kept outside the project in `~/.config/scenaria/audit-access.json`, keyed by the bound project id and the real folder, signed with the approver key (`audit-access/v2`, bound to project and folder), with a separate high-water mark (`audit-access.marks.json`) against older settings put back. Anything that does not verify means `person` (fail-closed). Every change is logged.
  - **Limit:** this protects the audit file (view and export). The raw records (steps, export, canon, analysis) stay readable as before (rule 10).
- **Routes.** `GET /api/audit-file?from&to` (403 `approval_required` unless the setting is `open` or the request has the approval session), `GET /api/audit-file/access` (open), `POST /api/audit-file/access {mode}` (person-only gate). CLI: `scenaria audit-file [--from] [--to] [--json] [--out-file f]` (reading at an interactive terminal unless opened), `scenaria audit-file access [person|open]` (interactive terminal and typed confirmation).
- **Next (C3, C4).** Organisational evidence per control (person-only, signed), a signed export (PDF, Markdown, JSON) and a read-only view for auditors.

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
- **Ease of use and audit (0.9.1):** `runMultiverse` asks a role again once when its answer is not JSON (Ollama with `format: "json"`), then continues without that role (warning); keys, labels, order, "75" confidence and "+8" deltas are understood. `GET /api/forecast/progress` shows the running job (role by role); `POST /api/forecast/decision` lets the person write down a decision; `oracleBacktest({decisions})` re-forecasts any decided decision as of its time (shown even when not yet measurable; only measured options teach γ). `auditOverview` / `auditReportMarkdown` (`GET /api/audit/overview`, `GET /api/audit/report?format=md|json`, read-only) feed the auditor's area.
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
