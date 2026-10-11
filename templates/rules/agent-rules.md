## Scenaria (decision checkpoints)

This project keeps ONE decision tree for the whole project with Scenaria (root `n0` = project + main goal), so every decision point can be restored (files + context) and any LLM can analyse the decisions later.

- Start of a session → `scenaria_status` (and `scenaria_context` when resuming). If the main goal is missing, ask the user and store it with `scenaria_start_mission` `{projectGoal}`.
- New piece of work → `scenaria_start_mission` `{title, goal}`: adds a task to the existing tree. Never start a second tree.
- Before acting on a real choice → `scenaria_decide` with all options considered, the chosen one, `rationale` (why), `context` (the situation), `servesGoal` (how it serves the main goal), `expectedOutcome` and `confidence` (0–1).
- After each meaningful step → `scenaria_checkpoint` with 2–6 short, factual output bullets; name files in backticks. List external side effects (sent mails, pushes, API writes) under `irreversible`. Task finished → add `taskDone: true` and a 1–2 sentence `summary`.
- Mistake, hallucination or dead end → `scenaria_last_good` or `scenaria_tree`, then `scenaria_rewind` with a one-line lesson. Continue only from the returned resume context, not from the abandoned attempt.
- Another option of an earlier decision → `scenaria_fork`.
- Older details → `scenaria_recall` instead of re-reading long histories. Follow the project rules shown in the capsule.
{{AUTO_CAPTURE}}- Never record facts you have not verified.
- No MCP support? The same tools are available as `scenaria call <tool> '<json>'` (shell) or `POST /api/v1/tools/<tool>` (HTTP). Plain chats: append ```scenaria blocks (see `scenaria prompt --kind chat`).
