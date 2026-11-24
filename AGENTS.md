<!-- scenaria:start -->
## Scenaria (decision checkpoints)

This project keeps ONE decision tree for the whole project with Scenaria (root `n0` = project + main goal), so every decision point can be restored (files + context) and any LLM can analyse the decisions later.

- Start of a session → `scenaria_status` (and `scenaria_context` when resuming). If the main goal is missing, ask the user and store it with `scenaria_start_mission` `{projectGoal}`.
- New piece of work → `scenaria_start_mission` `{title, goal}`: adds a task to the existing tree. Never start a second tree.
- Before acting on a real choice → `scenaria_decide` with all options considered, the chosen one, `rationale` (why), `context` (the situation), `servesGoal` (how it serves the main goal), `expectedOutcome` and `confidence` (0–1).
- After each meaningful step → `scenaria_checkpoint` with 2–6 short, factual output bullets; name files in backticks. List external side effects (sent mails, pushes, API writes) under `irreversible`. Task finished → add `taskDone: true` and a 1–2 sentence `summary`.
- Mistake, hallucination or dead end → `scenaria_last_good` or `scenaria_tree`, then `scenaria_rewind` with a one-line lesson. Continue only from the returned resume context, not from the abandoned attempt.
- Another option of an earlier decision → `scenaria_fork`.
- Older details → `scenaria_recall` instead of re-reading long histories. Follow the project rules shown in the capsule.
- Never record facts you have not verified.
- No MCP support? The same tools are available as `scenaria call <tool> '<json>'` (shell) or `POST /api/v1/tools/<tool>` (HTTP). Plain chats: append ```scenaria blocks (see `scenaria prompt --kind chat`).
<!-- scenaria:end -->

## Developing Scenaria (this repository)

You are working on Scenaria itself. Before changing anything, read `docs/DEVELOPMENT.md`, then `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` and `docs/KNOWN-LIMITS.md`. The development guide covers:
- the security rules that must never be broken (no stored keys, only a person approves, person-only actions, signed records, nothing in the project folder runs with the person's rights);
- build and test, and when a change counts as done (build green, `npm test` green, `npm run typecheck:ui` clean);
- the module map and the working method (main goal first, small steps, an independent review, a test per finding).

Rules for every change:
- **Never commit anything confidential:** no keys or `.env` files, no absolute paths of a machine, no private project names, no `.scenaria/` data. Machine notes live in `CLAUDE.local.md` / `AGENTS.local.md`, internal analyses in `docs/intern/`; all are ignored by git. Run `git status` before every commit.
- Every text of the dashboard exists in German and English, in plain words.
- A new number shown to people gets a versioned formula in `src/core/derivation.ts` and a derivation, never a bare value.
- Anything that counts as "verified" uses `integrity().confirmed`.
- A security problem is reported privately (see `SECURITY.md`), not in a public issue.
