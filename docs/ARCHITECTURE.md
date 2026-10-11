# Architecture

## Main goal

Every decision point of an agent run leaves a **restorable, verifiable state**. If something goes wrong, you get back to that point in seconds: the files return to how they were, and the agent receives a compact capsule of facts so it can continue cleanly or try the alternative.

## Components

```text
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 agents ──▶ │  MCP server  │   │ Claude hooks │   │     CLI      │ ◀── humans, scripts
            └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                   └────────────┬─────┴──────────────────┘
                                ▼
                     ┌─────────────────────┐        ┌──────────────────┐
                     │   core / engine     │ ◀────▶ │ dashboard server │ ◀── browser (React Flow)
                     │ decide · checkpoint │        │  REST + SSE      │
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
| Types | `src/core/types.ts` | Data model (nodes, options, snapshots, verification) |
| Store | `src/core/store.ts` | JSON files, append-only event log, cross-process lock |
| Snapshots | `src/core/snapshot.ts` | Private shadow git repository |
| Engine | `src/core/engine.ts` | All operations; the only writer |
| Context | `src/core/context.ts` | Resume capsule, token estimate |
| Verify | `src/core/verify.ts` | Deterministic checks |
| Protocol | `src/core/protocol.ts` | Knowledge-base notes, audit protocol |
| MCP | `src/mcp.ts` | 12 tools over stdio |
| Hooks | `src/hooks.ts` | Claude Code capture, never blocking |
| Setup | `src/setup.ts` | Idempotent wiring of `.mcp.json`, `.claude/settings.json`, `CLAUDE.md` |
| Server | `src/server.ts` | Localhost API + live events for the dashboard |
| UI | `ui/` | Vite + React + React Flow, prebuilt into `dist/ui` |

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
- The dashboard binds to `127.0.0.1` only, answers only to loopback `Host` headers (DNS-rebinding protection), rejects POSTs from foreign origins and requires the header `X-Scenaria: 1` on every POST.
- Hooks always exit 0 and print nothing, except the SessionStart context. They act only in initialized projects.

## Design of the dashboard

The visual language comes from the scenario-tree diagrams of operations research:

- **Nodes:** boxed, with LaTeX-style italic ids (*n*7).
- **Time axis:** *t*₁…*t*ₙ, with straight edges.
- **Light mode:** graph paper. **Dark mode:** blueprint.
- **Active timeline:** traced like a highlighter on a printout. This is the one loud element.

Typefaces: Instrument Sans for the UI and STIX Two Text italic for ids and the axis. Both are bundled, so the dashboard works offline.
