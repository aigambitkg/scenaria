## Scenaria (decision checkpoints)

This project records its decision tree with Scenaria, so every decision point can be restored (files + context).

- Complex task without a mission yet → `scenaria_start_mission` (main goal + brief).
- Before acting on a choice between approaches → `scenaria_decide` with all options considered, the chosen one, rationale, assumptions and confidence (0–1).
- After each meaningful step → `scenaria_checkpoint` with 2–6 short, factual output bullets; name files in backticks. List external side effects (sent mails, pushes, API writes) under `irreversible`.
- Mistake, hallucination or dead end → `scenaria_last_good` or `scenaria_tree`, then `scenaria_rewind` with a one-line lesson. Continue only from the returned resume context, not from the abandoned attempt.
- Another option of an earlier decision → `scenaria_fork`.
{{AUTO_CAPTURE}}- Never record facts you have not verified.
- No MCP support? The same tools are available as `scenaria call <tool> '<json>'` (shell) or `POST /api/v1/tools/<tool>` (HTTP).
