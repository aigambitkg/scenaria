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

You are working on Scenaria itself. Before changing anything, read `docs/HANDOFF.md`, then `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`. The handoff file covers:
- the security rules that must never be broken (no stored keys, only a person approves, person-only actions, signed records);
- build and test, and when a change counts as done;
- the module map, the working method (main goal, small batches, independent review, tests per finding) and the open points.

Talk to Kev in German and in plain words.

### Current phase (since 2026-10-14)
- **Feature freeze.** Work only on the batch plan in `docs/HANDOFF.md` §11 (order 0 → A → B → C → D, then E and F after Kev's go). Start a batch only after Kev says go; one batch at a time.
- Every decision is checked against three personas: an office user new to AI, an ISO/IEC 42001 auditor, and a company's AI manager.
- **Never commit anything confidential:** no keys or `.env` files, no absolute paths of a machine, no private project names, no `.scenaria/` data. Machine notes live in `CLAUDE.local.md`, internal analyses in `docs/intern/`; both are ignored by git. Run `git status` before every commit.
- Security rules 11 and 12 in `docs/HANDOFF.md` §2: only the person or a registered independent audit agent may reseal the ledger or give a verdict that counts as verified (enforced since 0.9.2, Batch A). Anything that counts "verified" uses `integrity().confirmed`.
- Batch 0, A and B are done (B accepted by Kev on 2026-10-15). Batch C (ISO/IEC 42001 audit file) is in progress since Kev's go on 2026-10-15; work through it in small steps C1–C4 (`docs/HANDOFF.md` §11). C1 is accepted; C2 is built (0.9.6) and corrected in C2.1 (0.9.7); C3 (0.9.8) is accepted (2026-10-16). C4 runs with Kev's go and decisions (`docs/HANDOFF.md` §11) in steps: C4a signed file (0.9.9, accepted), C4b audit package with HTML/PDF (0.9.10), C4c-1 dashboard view, package from the dashboard and auditor mode (0.9.11), then C4c-2 the form for the organisation's evidence (Kev agreed to the split on 2026-10-17).
