# Roadmap

## Done in 0.1 (phases 1–3)

- [x] Spike: shadow-git snapshots (snapshot, restore incl. deletions, diff, dirty check)
- [x] Core engine: missions, decisions with options, checkpoints, branches, autosaves
- [x] Rewind with automatic autosave (rewinds are undoable), fork into alternatives
- [x] Resume capsule with non-anticipativity and token estimate
- [x] Deterministic verification + verdicts, `last-good`
- [x] Local knowledge base (`kb/*.md`, Obsidian-compatible) and audit protocol
- [x] CLI (`--json` everywhere)
- [x] MCP server, 12 tools
- [x] Claude Code hooks: prompt → mission, AskUserQuestion / ExitPlanMode → decisions, risky Bash → autosave, external effects → irreversible, turn end → checkpoint, session start → capsule
- [x] `init --claude`: idempotent setup incl. verifier sub-agent and CLAUDE.md rules
- [x] Dashboard: scenario map, node details, rewind/fork/verify/diff, protocol, DE/EN, light/dark, live updates
- [x] Test suite (engine, hooks, MCP client, HTTP API)

## Phase 4: Verifier and protocol

- [ ] Run the verifier automatically after N checkpoints, or when the agent stops (opt-in hook)
- [ ] Dashboard: "suggested rewind target" banner when a node fails
- [ ] Export the audit report as Markdown/PDF (ISO/IEC 42001-friendly: decisions, verdicts, irreversible effects, who/when)
- [ ] Compare two branches side by side (capsule + diff)
- [ ] `scenaria gc` / prune: drop autosaves older than N days, `git gc` the shadow repo

## Phase 5: Desktop and multi-agent

- [ ] Tauri desktop wrapper (same UI, tray icon, project switcher)
- [ ] Multi-agent lanes: show which agent produced which node (Paperclip teams, sub-agents)
- [ ] Adapters for other agent runtimes (Codex, Cursor rules, n8n, Hermes Agent, Paperclip)
- [ ] Semantic search across the knowledge base (optional Qdrant/pgvector)
- [ ] Token metrics per mission (capsule vs. transcript over time)
- [ ] Hook into Claude Code's native checkpoints, once headless rewind is exposed
- [ ] Publish to npm (`npx scenaria init --claude`)

## Known limits

- Rewind restores files, not external effects. Those are flagged and warned about.
- The conversation is rewound by handing over the capsule; transcripts are not edited.
- Free-text summaries from the Stop hook are only as factual as the agent's final message. That's what the verifier is for.
