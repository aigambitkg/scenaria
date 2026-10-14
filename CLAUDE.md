<!-- scenaria:start -->
## Scenaria (decision checkpoints)

This project records its decision tree with Scenaria, so every decision point can be restored (files + context).

- Complex task without a mission yet → `scenaria_start_mission` (main goal + brief).
- Before acting on a choice between approaches → `scenaria_decide` with all options considered, the chosen one, rationale, assumptions and confidence (0–1).
- After each meaningful step → `scenaria_checkpoint` with 2–6 short, factual output bullets; name files in backticks. List external side effects (sent mails, pushes, API writes) under `irreversible`.
- Mistake, hallucination or dead end → `scenaria_last_good` or `scenaria_tree`, then `scenaria_rewind` with a one-line lesson. Continue only from the returned resume context, not from the abandoned attempt.
- Another option of an earlier decision → `scenaria_fork`.
- Clarifying questions and plan approvals are captured automatically; do not record them twice.
- Never record facts you have not verified.
- No MCP support? The same tools are available as `scenaria call <tool> '<json>'` (shell) or `POST /api/v1/tools/<tool>` (HTTP).
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
- Security rules 11 and 12 in `docs/HANDOFF.md` §2 are new: only the person or a registered independent audit agent may reseal the ledger or give a verdict that counts as verified.
