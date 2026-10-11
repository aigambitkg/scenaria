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

## Next: capture everywhere

- [ ] Browser extension for ChatGPT / Claude.ai / Gemini web (live capture without exports)
- [ ] Homebrew tap and winget package
- [ ] Gemini native API (`generateContent`) and Bedrock/Vertex shapes in the proxy
- [ ] Map ChatGPT conversation branches (edited messages) to Scenaria scenarios on import

## Phase 4: Verifier and protocol

- [ ] Run the verifier automatically after N checkpoints, or when the agent stops (opt-in hook)
- [ ] Dashboard: "suggested rewind target" banner when a node fails
- [ ] Export the audit report as Markdown/PDF (ISO/IEC 42001-friendly: decisions, verdicts, irreversible effects, who/when)
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
