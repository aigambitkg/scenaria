# Roadmap

## Done in 0.1 (phases 1–3)

- [x] Spike: shadow-git snapshots (snapshot, restore incl. deletions, diff, dirty check)
- [x] Core engine: missions, decisions with options, checkpoints, branches, autosaves
- [x] Rewind with automatic autosave (rewinds are undoable), fork into alternatives
- [x] Resume capsule with non-anticipativity and token estimate
- [x] Deterministic verification + verdicts, `last-good`
- [x] Local knowledge base (`kb/*.md`, Obsidian-compatible) and audit protocol
- [x] CLI (`--json` everywhere)
- [x] MCP server
- [x] Claude Code hooks: prompt → mission, AskUserQuestion / ExitPlanMode → decisions, risky Bash → autosave, external effects → irreversible, turn end → checkpoint, session start → capsule
- [x] `init --claude`: idempotent setup incl. verifier sub-agent and CLAUDE.md rules
- [x] Dashboard: scenario map, node details, rewind/fork/verify/diff, protocol, DE/EN, light/dark, live updates
- [x] Test suite (engine, hooks, MCP client, HTTP API)

## Done in 0.2 (vendor-neutral and ready for organizations)

- [x] One tool registry for MCP, HTTP, CLI and function calling (13 tools)
- [x] Schema export for OpenAI (Chat + Responses), Anthropic, Gemini, MCP and JSON Schema
- [x] HTTP API `/api/v1` (health, tools, tool calls, export); OpenAI-style string arguments
- [x] `scenaria call` for shell agents, `scenaria watch` for agents without tools
- [x] `init --for claude,cursor,vscode,gemini,codex,windsurf,generic,all` and `AGENTS.md` / `GEMINI.md` rules
- [x] Attribution per node: agent, model, user
- [x] Team server with token (Bearer + cookie), local mode protected against DNS rebinding
- [x] JSON/Markdown export for audits
- [x] Python client (stdlib only) and an OpenAI-compatible agent example (OpenAI, Azure, Mistral, Ollama, vLLM, …)
- [x] Vendor-neutral verifier prompt

## Done in 0.3 (one install, one overlay)

- [x] `scenaria start`: init, auto-detect and wire agents, baseline, dashboard, proxy and auto-save in one command
- [x] `scenaria setup --global`: every project, with auto-init only in real projects
- [x] Single-file binaries (Bun) with embedded dashboard, `install.sh` / `install.ps1`, release pipeline, npm-ready package
- [x] IDs everywhere: node `uid` (ULID), scenarios `s1…`, versions `s2/v5`, conversations `c1…`, messages `m1…`
- [x] Conversation overlay linked to the tree (`headAt`), visible per node in the dashboard and in snapshot folders
- [x] Universal LLM proxy (OpenAI-compatible and Anthropic, streaming) for any provider
- [x] Claude Code transcript capture, HTTP and CLI logging, imports (ChatGPT, Claude.ai, OpenAI lists, JSONL)
- [x] Snapshot folders per version (hardlinked, read-only, `index.md`), `scenaria open`, `--copy-to`
- [x] `scenaria mirror`: versions as `refs/scenaria/*` in the project repo

## Done in 0.4 (one project tree, context, analysis)

- [x] One tree per project: root `n0` with the main goal, tasks as sub-goals, lazy task creation per session, automatic migration of multi-root projects
- [x] Decisions with `context`, `servesGoal`, `expectedOutcome`, auto `trigger`; rationale required when an option is chosen; quality flags on the map
- [x] Deterministic health check (per agent / model), dossier, LLM analysis with any provider (OpenAI-compatible or Anthropic, local or API), stored insights
- [x] Project rules (`memory.json`) carried by every capsule, prompt and reminder; accept rules from an analysis
- [x] Token-budgeted capsule with task rollups, `scenaria_recall` (BM25), folded tree view
- [x] Ready-made agent prompts (MCP / shell / chat, DE/EN) in the dashboard and CLI; per-prompt reminder for Claude Code
- [x] ```scenaria decision blocks from plain chats (proxy, transcript, paste)

## Done in 0.5 (context integrity and handoffs)

- [x] Context fidelity per node (goal line, continuity, integrity, reliability) as a chart along the path, with breaks / goal changes / branches / manipulation; fidelity bars on the map
- [x] Integrity ledger (hash-chained), `scenaria integrity`, manipulation findings in the health check
- [x] Global workspace by sections, item references (`n12.f2`), reader deltas (theory of mind) with invalidation after rewinds
- [x] Expectations / predictive coding (`scenaria_expect`), confidence per fact, `basedOn` references, reference capsule

## Done in 0.6 (canon events, stage 1)

- [x] Canon events (past constraints, future milestones) with proposal → approval by a person, audit trail
- [x] Archivist suggestions (deterministic + any LLM), checks run on request, string payload with verdict
- [x] Canon in capsule, prompts, reminder, board, expectations, health check and fidelity chart; dashboard dialog
- [x] Signed approvals (Ed25519, trusted approver keys outside the project), one-time approval link, explicit adoption of check commands

## Done in 0.7 (control from one place, canon stages 2–3)

- [x] Settings page: one model for everything or one per function, model list, connection test, trusted endpoints, agents via MCP with one click
- [x] Built-in chat that operates Scenaria with all tools (any provider, tool calling), confirmation for rewind/fork, recorded as a conversation
- [x] Canon gate per line of work ("surviving strings"), signed and anchored results
- [x] Relay archivist → craftsman → oracle with isolated contexts and deterministic orchestrator, open decision for the person
- [x] Env API keys only to official or trusted endpoints

## Done in 0.8 (forecasts and the multiverse)

- [x] A forecast for every open decision before the choice; prompt check with variants
- [x] Multiverse (archivist, craftsman, oracle), automatic mode opt-in with a daily budget across projects
- [x] Expert analyst, project switcher, help and onboarding

## Done in 0.9 (a traceable oracle and the auditor)

- [x] Forecast core v2: the same quantity as the measurement, retraceable formula, learned weights, uncertainty band
- [x] Backtest without knowledge of the future (field history), quality vs. naive persistence, test bench
- [x] Oracle v2: bounded, evidence-backed corrections of the core; learned trust γ; evidence kept as cited
- [x] Prüf-Experte: checklist and verdict per forecast, skeptic model, oracle backtest, oracle vs. core
- [x] 0.9.1: simple start (ready check, three paths, write down a decision), visible progress, plain-language result, check a past decision, robust oracle with local models, auditor's area with report download

## Plan from 0.9.1 (decided 2026-10-14): feature freeze, then batches

The core stays as it is. New features come only through these batches, in this order and one at a time. Details: `docs/HANDOFF.md` §11.

- [x] **0, publish:** repository on GitHub (private first), only what is needed, no secrets or machine data
- [x] **A, integrity by a person or an independent audit agent (0.9.2):** reseal only by the person or a registered audit agent (own key outside Scenaria); verdicts carry their origin; self-reported work no longer counts as verified
- [x] **B, easy to use for office users (0.9.3):** three views (Simple / Audit / Manage), plain wording, one model by default, forecasts and relay moved to "Extensions", Claude Desktop per project, start icon, approval mode without copying a link
- [x] **S1, project rules only by the person (0.9.4):** agents only propose rules; the person adds, accepts, rejects and removes them (approval mode or terminal with confirmation)
- [x] **S2, signed project rules (0.9.5):** rules signed like canon; only signed rules reach agents; the approval link is never printed; agents run in a sandbox
- [x] **C, audit file for ISO/IEC 42001 (0.9.6–0.9.13, accepted by Kev 2026-10-17):** every Annex A control with evidence from Scenaria, status and fields for organisational evidence; period filter; signed PDF/Markdown/JSON export; read-only access for auditors
  - [x] C1 catalogue (accepted 2026-10-16)
  - [x] C2 evaluation from the project's records (0.9.6): status per control, period, integrity warnings, approvals and reseals, read setting only by the person
  - [x] C2.1 corrections (0.9.7): no crash on damaged verdicts, a verdict counts once, verdict history per step, file states checked on every audit file
  - [x] C3 organisational evidence per control (0.9.8): link + hash, owner role + name, date; signed by the person; never raises a status; take over from another project
  - [x] C4a signed audit file (0.9.9): canonical JSON signed by the person, `verify` without a project, Markdown reading copy, names or roles only
  - [x] C4b audit package (0.9.10): evidence, print-ready page (PDF via the browser), Markdown, note; `verify` finds the newest export
  - [x] C4c-1 audit file in the dashboard (0.9.11): read-only view, audit package from the dashboard (Downloads), auditor mode on site (read only), "Prüfung" for forecasts renamed "Prognose-Prüfung"
  - [x] C4c-2 form for the organisation's evidence in the dashboard (0.9.12): record (SHA-256 in the browser), remove/discard, confirm, take over from another project — each step shows what will be signed
  - [x] C5 closing review (0.9.13): two independent whole-batch reviews and a review of the fixes, every finding fixed with a test; done criteria checked on the demo project; Kev decided the LOW points
  - [x] C5 acceptance of Batch C by Kev (2026-10-17)
- [ ] **E, progress, context window and the derivation of every number** (Kev 2026-10-17, after C and before D; in progress since Kev's go on 2026-10-17):
  - [x] E1 derivation of every number (0.9.14): one format from the core, versioned formulas, recompute; context fidelity, health score, counts, audit file; "How computed?" in the dashboard (hover, tap, keyboard); footnotes in the exports; `verify` recomputes them
  - [x] E2 progress (0.9.15): completion criteria as milestones with task, weight and file (agent proposes, the person approves exactly as shown, signed `canon/v3`); levels from evidence, gates as caps (90/100 % only by the person or an audit agent); only the current line counts; `scenaria_progress`, `scenaria progress`, progress in all three views with "How computed?"
  - [x] E3a-1 measuring the context window (0.9.17): fill from Claude Code transcripts and proxy answers, windows with compaction, model table v1 with sources, `C_eff = min(C_max, A_model)`, zones, `context-fill/1` / `context-soft/1`, records whose changes outside show; `scenaria_window`, `scenaria window`, `GET /api/windows`
  - [x] E3a-2 acting on it (0.9.18): orange → a checkpoint at the end of the turn, red and emergency → a checkpoint at once (also mid-turn), each zone once per window; notices to the agent and from red to the person; proxy headers `x-scenaria-context-*`; the prepared handover `scenaria_handover`, `scenaria handover`, `GET /api/handover`
  - [ ] E3b dashboard and the person's thresholds · [ ] E4 progress per window and handover check · [ ] E5 closing every number with its derivation on hover and tap; progress from evidence-bound criteria levels capped by gates; a fixed, versioned context-window rule with sealed checkpoints; progress per window and a deterministic handover check. Kev's answers (2026-10-17): criteria and weights proposed by the agent, approved by the person; start values v1.0 from the concept, adjustable only by the person (signed, logged); a stop after two windows without progress is enforced where the provider allows it
- [ ] **D, the AI manager's view:** cross-project overview, agents and models over time (with E's progress and handover numbers), token use, rules and policies for all projects
- [ ] **F, agent modules** (later, optional): forecasts and other model-based helpers as ready-made agents that only need a model

## Next (after the batch plan)

- [ ] Streaming chat answers; chat history browser
- [ ] Relay with parallel branches (craftsman options explored as forks, gate on each)
- [ ] Approver keys in the OS keychain / hardware keys (passkey, YubiKey) so a local process cannot read them (until then: agents in a sandbox)

## Next: capture everywhere

- [ ] Optional embedding-based fidelity (any OpenAI-compatible `/embeddings`, e.g. Ollama) for cross-language projects
- [ ] Anchor ledger heads in an external system (git remote / signed export) for tamper-proof audits

- [ ] Browser extension for ChatGPT / Claude.ai / Gemini web (live capture without exports)
- [ ] Homebrew tap and winget package
- [ ] Gemini native API (`generateContent`) and Bedrock/Vertex shapes in the proxy
- [ ] Map ChatGPT conversation branches (edited messages) to Scenaria scenarios on import

## Phase 4: Verifier and protocol

- [ ] Run the verifier automatically after N checkpoints, or when the agent stops (opt-in hook)
- [ ] Dashboard: "suggested rewind target" banner when a node fails
- [x] Export the audit report as Markdown/PDF (ISO/IEC 42001-friendly: decisions, verdicts, irreversible effects, who/when) — done in Batch C: the signed audit file and the audit package (0.9.9–0.9.11)
- [ ] Compare two branches side by side (capsule + diff)
- [ ] `scenaria gc` / prune: drop autosaves older than N days, prune snapshot folders/blobs, `git gc` the shadow repo

## Phase 4b: Organizations

- [ ] SSO/OIDC for the team server, role-based access (viewer / reviewer / operator)
- [ ] Multi-project server (one dashboard for many repositories)
- [ ] Native auto-capture hooks for further agents (Cursor hooks, Gemini CLI hooks, Codex notify) on top of MCP
- [ ] Remote snapshots: agents on other machines push file snapshots to a team server
- [ ] TypeScript/JS client package and OpenAPI document for the HTTP API
- [ ] Policy settings, e.g. require verification before merge, or block rewinds past irreversible nodes

## Phase 5: Desktop and multi-agent

- [ ] Tauri desktop wrapper (same UI, tray icon, project switcher)
- [ ] Multi-agent lanes: show which agent produced which node (Paperclip teams, sub-agents)
- [ ] Deeper adapters for orchestrators (Paperclip teams, Hermes Agent, LangGraph checkpointer bridge)
- [ ] Semantic search across the knowledge base (optional Qdrant/pgvector)
- [ ] Token metrics per mission (capsule vs. transcript over time)
- [ ] Hook into Claude Code's native checkpoints, once headless rewind is exposed

## Known limits

- Rewind restores files, not external effects. Those are flagged and warned about.
- The conversation is rewound by handing over the capsule; transcripts are not edited.
- Free-text summaries from the Stop hook are only as factual as the agent's final message. That's what the verifier is for.
