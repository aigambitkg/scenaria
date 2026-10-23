# Handoff: developing Scenaria further

This is the working protocol for the next agent or developer who continues Scenaria. Read it first, then `docs/ARCHITECTURE.md` (how it works) and `docs/ROADMAP.md` (what is done, what is next).

- **Product owner:** Kev (Kevin Grundmann, AI-Gambit). He reads and writes German, so give your summaries to him in German. He is not a developer by trade, so explain results in plain words.
- **License:** MIT. Vendor-neutral: any LLM, any agent, any framework.
- **State at handoff:** v0.9.20 (2026-10-23: E3b — the context window in the dashboard (Simple card, a dialog in Audit and Manage with "How computed?", the handover) and the person's signed values of the rule (zone lines, P95 start value, margin, A_model, window sizes of local models; every revision kept outside the project; every number names its rule `v1.0-p<rev>`); E3b-1 core 0.9.19, E3b-2 dashboard 0.9.20), before it v0.9.18 (2026-10-22: E3a-2 — Scenaria acts on the measured fill: automatic checkpoints from orange (at the end of a turn) and from red (at once, also mid-turn), notices to the agent and from red to the person, the prepared handover `scenaria_handover`), before it v0.9.17 (2026-10-18: E3a-1 — the context window measured from the provider's token counts, with the model table, the zones and a derivation for every number), before it v0.9.16 (2026-10-18: E2 completed — all fixed-point errors in the person's language; before it v0.9.15, 2026-10-17, Batch E2: progress — completion criteria as milestones with task, weight and file, levels from evidence, gates, progress per task and project in all three views; before it 0.9.14, E1, the derivation of every number, and 0.9.13, C5, the closing review of Batch C, which Kev accepted on 2026-10-17), branch `main`. All tests pass (`npm test`). GitHub CI was green on Linux and macOS (Node 20 and 22) for 0.9.5.
- **Current phase (since 2026-10-14): feature freeze.** Work only on the batch plan in §11, one batch at a time, and start a batch only after Kev's go.
- **Now (since 2026-10-17): Batch E** (progress, context window, derivation of every number), Kev's go after accepting Batch C on 2026-10-17. **E1 built (0.9.14), E2 built (0.9.15), E3a-1 built (0.9.17, measuring the context window), E3a-2 built (0.9.18, acting on it), E3b built (0.9.19 core: the person's values; 0.9.20 dashboard)**; next E4 (progress per window and handover check) after Kev's look at E3b, one step at a time with a review each.
- **Before: Batch C** (ISO/IEC 42001 audit file), started with Kev's go on 2026-10-15, **accepted by Kev on 2026-10-17** (no separate practical test). Batch B is accepted. C1, C2/C2.1 and C3 accepted (2026-10-16); C4a accepted (2026-10-16); C4b built (0.9.10, Kev went on to C4c); C4c split with Kev on 2026-10-17: C4c-1 (0.9.11, tests green on Kev's Mac, "Alles passt"), C4c-2 built (0.9.12, the form for the organisation's evidence). **C5 (0.9.13, 2026-10-17):** reviews done and every finding fixed with a test (`test/c5.test.mjs`); done criteria checked on the demo project; **waiting for Kev's practical test (`docs/intern/batch-c/praxistest-c.md`) and his acceptance of Batch C.** Then **Batch E** after Kev's go (new, before D; Kev answered its open questions on 2026-10-17).

---

## 1. What Scenaria is (one minute)

Scenaria records the work of AI agents as a **decision tree**. Every step is a node: mission, goal, checkpoint, decision or autosave. Every node can be restored with its files and its context. Every branch is its own line of work.

On top of the tree it adds:
- **Context fidelity:** how well each step stays connected to its line and to the main goal. It is deterministic, with no model.
- **Canon:** the project's fixed points. Only a person approves them.
- **Analysis:** health checks, pattern analysis and an expert report.
- **Forecasts:** before a choice, how each option will keep context and goal.

Agents use it through MCP, HTTP, the CLI or function calling. The person uses the dashboard.

Kev tests it on his real projects. Machine-specific notes (paths, test project, model) are in `CLAUDE.local.md`, which is local and never committed.

## 2. The rules that must never be broken (security canon)

Every review so far has enforced these. Treat them as hard requirements.

1. **Never store API keys.** Keys live only in environment variables, or in the browser session as `SessionKeys`. They are sent per request and never written to disk.
2. **Session keys go only to the same provider.** Use `keyFor`; an OpenAI key never goes to Anthropic. Environment keys go only to official or trusted endpoints.
3. **Never touch the user's own `.git`.** File snapshots live in a private shadow repository, `.scenaria/shadow.git`. The only exception is opt-in mirror refs.
4. **Never initialise a project in the home folder.**
5. **Only a person approves.** "Der Archivar kann diese vorschlagen mit Freigabe durch User": agents may *propose* canon, rules and decisions, but only a person approves. Project rules follow this since 0.9.4 (S1): agents' rules are proposals; `/api/rules*` and `/api/analysis/accept` are person-only; the CLI needs a terminal and a typed confirmation. Since 0.9.5 (S2) every rule decision is signed, and only signed rules reach agents.
6. **Person-only actions need a person.**
   - Anything that spends the person's model quota or acts for them needs the **approval session** in the dashboard (the "approval mode": cookie from a single-use approval link that `scenaria start` opens in the browser, or that the lock 🔒 in the dashboard asks Scenaria to open), or an **interactive TTY** in the CLI.
   - The approval link is never printed (since 0.9.5, S2): Scenaria hands it to the browser only; `--print-approval-link` is the person's explicit choice for a machine without a browser.
   - **Agents run in a sandbox** (Kev's decision, 2026-10-16; a precondition Scenaria does not enforce): the agent, and every process it starts, has no access to the Scenaria config folder (`~/.config/scenaria`: approver key, trusted keys, anchors, project-id bindings) and never starts Scenaria under the person's account. Otherwise any Scenaria process the agent starts signs with the person's key. Scenaria adds speed bumps (link only to the browser via the system opener by absolute path without `BROWSER`; `--print-approval-link` only at a terminal with a typed confirmation), but these are not a security boundary.
   - The approval link never travels in an HTTP answer. `POST /api/approval/open` only makes the Scenaria process hand a fresh link to the operating system's browser (local mode; single use, valid 60 s, used up even by an already approved browser; once per 15 s from the dashboard, once per minute otherwise; logged with who asked). This covers check commands, approvals, the chat, the relay, the multiverse, the AI check, backtests, settings and project switching.
   - In `src/server.ts` this is enforced by the `personOnly` prefix list (for example every `POST /api/forecast*`, `POST /api/audit-file/access`, `POST /api/context-settings`). New person actions must go under such a prefix.
   - Reading the ISO/IEC 42001 audit file (`GET /api/audit-file`, `scenaria audit-file`) is the person's unless they set it to `open` (C2); the setting protects the file, not the raw records.
   - **Auditor mode (C4c-1):** the person can hand a browser to an auditor on site. That browser reads the audit file and never writes (every non-GET request from it is refused, also agent-level ones). Only cookies Scenaria issued and signed count (HMAC key `auditview.key` in the config folder). It is a protection against mistakes, not a security boundary on the person's own computer.
   - The CLI checks `process.stdin.isTTY && process.stdout.isTTY`.
7. **The chat model has agent rights only.** Person actions requested in the chat become a card, and they run only after the person clicks it.
8. **Automatic multiverse forecasts:**
   - opt-in only;
   - use only the person's *global* model, never the project config, which agents can edit;
   - share one daily budget across all projects.
9. **Signed records.** Forecasts, audits, backtests, expert reports and canon check results are signed with the approver key, bound to the project and to a content hash. Anything written or changed outside Scenaria is shown as *unverified* and never counts.
10. **Reads are open, writes that matter are not.** GET endpoints such as `/api/forecasts` or `/api/audit/overview` may be read by agents and auditors. Keep it that way only for data that is not secret.
11. **The tamper evidence belongs to the person.** Only the person, or a registered audit agent that is independent of Scenaria and of the working agent, may reseal the integrity ledger or give a verdict that counts as "verified". A working agent may never reset or certify its own work (enforced since 0.9.2, see `docs/ARCHITECTURE.md` "Who may say verified").
    - New code that counts something as verified must use `integrity().confirmed`, never `verification.status === "passed"`.
    - New writes to the ledger go through `appendLedger()` (it raises the high-water mark). A new reseal path needs a `ResealAuthority`.
    - Keys, registries and anchors live only in the global config, never in the project.
12. **Nothing confidential in the repository.** No keys, no `.env` files, no absolute paths of a machine, no private project names, no Scenaria data (`.scenaria/`). Machine notes go to `CLAUDE.local.md`, internal analyses to `docs/intern/`; both are ignored by git. Check `git status` before every commit.

## 3. Build, test, run

```bash
npm install
npm run build          # tsc (core → dist/) + vite (ui → dist/ui)
npm test               # node --test, all test/*.test.mjs, ~4–6 min
npm run typecheck:ui   # strict TS check of the dashboard
node dist/cli.js start # dashboard, approval link opened in the browser (in a project folder)
```

- **Node:** ≥ 20. Kev's Mac has Node 24.
- **On Kev's Mac:** run the tests in two halves, because each tool call there is limited to 180 s.
  - `node --test test/{auditexport,auditfile,auditpackage,auditview,c5,canon,control,derivation,engine,evidenceform,expert,forecast,handoff,help,integrity,iso42001,office}.test.mjs`
  - `node --test test/{integration,oracle,orgevidence,overlay,predict,progress,project,projects,rules,safety,universal,window,windowact}.test.mjs`
  - Kev runs `npm test` in his own terminal (no time limit there).
- Tests use a temporary `SCENARIA_HOME` (`test/helpers.mjs`), so they never touch the real `~/.config/scenaria`.
- **Known flaky test:** `watch fingerprint writes no git objects while idle`. It is timing-sensitive, failed once on the Mac and passed on rerun.
- **macOS specifics** (CI runs on macOS too; two failures there were fixed on 2026-10-15):
  - The temp folder `/var/…` is really `/private/var/…`, and a project can be opened through a symlink. Compare project folders with `realRoot()` from `src/core/projects.ts`, never as plain strings.
  - Snapshot folders use APFS clones on macOS (own inode, no extra space) and hardlinks elsewhere. Tests must not expect a shared inode on macOS.
  - To mimic macOS on Linux, run the tests with `TMPDIR` pointing to a symlinked folder. Do this before handing over any test that compares a path: Scenaria prints and opens real paths (`/private/var/…`), so a test compares with `realpathSync.native(...)`, never with the path `mkdtempSync` returned (two tests failed on Kev's Mac on 2026-10-17 for this reason).
- **Done means:** build green, `npm test` green, `typecheck:ui` clean, and the relevant browser walkthrough (§7) without console or HTTP errors.

## 4. Where things are (module map)

### Entry points (`src/`)

| File | Role |
|---|---|
| `cli.ts` | The `scenaria` command (all subcommands, `--json`). |
| `server.ts` | Dashboard and HTTP API: approval session, person-only gate, model-run jobs with progress and cancel, project switching. |
| `mcp.ts` | MCP server (stdio). The tools come from `tools.ts`. |
| `tools.ts` | **The single tool registry** for MCP, HTTP `/api/v1/tools`, the CLI `call` and function-calling exports. |
| `chat.ts` | Built-in chat: any model operates Scenaria through the same tools. Person tools become cards; `scenaria_multiverse`, `scenaria_audit_forecast` and `scenaria_relay` are chat tools. |
| `hooks.ts` | Claude Code hooks (never block the agent). Since E3a-2 the after-tool hook runs after every tool (setup matcher `*`) on a fast path: nothing new in the transcript → no lock; otherwise at most 1.5 s wait for the lock, then it gives up. |
| `setup.ts` | Agent wiring: `init --for …`, `CLAUDE.md` / `AGENTS.md` rule blocks, Claude Desktop (one entry per project with `--root`), the start icon (`writeLauncher`). |
| `proxy.ts`, `ingest.ts` | LLM proxy and conversation import (the overlay). |

### Core (`src/core/`)

| File | Role |
|---|---|
| `engine.ts` | The `Scenaria` class: missions, decide, choose, checkpoint, rewind, fork, verify, update. `remember()` keeps the field history (`meta.fieldHistory`) used for leak-free backtests. |
| `store.ts`, `types.ts`, `ledger.ts`, `snapshot.ts` | Storage, data model, integrity ledger, shadow-git snapshots. |
| **`verdict.ts`**, **`trust.ts`** | **Rule 11:** verdict origins, what counts, signature and work-hash checks (`verdict.ts` has no imports: shared with the UI). |
| **`seal.ts`** | Anchor outside the project (genesis, high-water mark, used requests), reseal records, seal findings. |
| **`auditors.ts`** | Registered audit agents: registry, signed requests (verdict / reseal), key generation. |
| `fidelity.ts` | Context fidelity. The formula is shared with the forecast. |
| `canon.ts`, `canon-llm.ts`, `gate.ts` | Fixed points, the archivist's proposals, canon gate per line. **Batch E2:** completion criteria (`task`, `weight`, `artifact`, signed `canon/v3` with `approvedAt`), approval only with `expect`, `reweigh`, retiring a missing criterion; `validateArtifact`, `artifactMatches`, `criterionAnchors`. |
| `analysis.ts` | Metrics, pattern analysis, **`callLlm`** (every model call goes through it: Anthropic / Ollama / OpenAI-compatible; `json` and `signal` options). |
| `expert.ts` | The expert analyst report. |
| `relay.ts` | Archivist, craftsman and oracle for a new high-impact question. |
| **`predict.ts`** | **Forecast core v2.** Views (`viewNow`, `viewAsOf`), `predictOption`/`predictPrompt`, `measureLine`, the backtest, `forecastQuality`, `calibrationFor`, the test bench. |
| **`oracle.ts`** | **Oracle v2** (multiverse): three roles that may only *correct* the core, with bounded and evidence-backed corrections; γ fit; `assignEntries` (safe answer-to-option matching). |
| **`forecast.ts`** | Saved forecasts (quick and multiverse), evaluation against reality, the automatic budget. |
| **`auditor.ts`** | **Prüf-Experte:** checklist and verdict, the skeptic `deepAudit`, `oracleBacktest` (also for single past decisions), `oracleQuality`/`oracleTrust`, `auditOverview` and `auditReportMarkdown`. |
| **`auditfile.ts`** | **Batch C2:** `buildAuditFile(s, period)` — status per control from the project's records, integrity warnings (`INTEGRITY_RULES`), signed approvals (`carries`, `unsigned`), reseals, `parsePeriod`. Never throws on hand-edited files (`evaluation_failed`). |
| **`orgevidence.ts`** | **Batch C3:** the organisation's documents per control (URL + SHA-256, owner role + name, date): person-only, signed per revision, anchored outside the project, catalogue-bound; `copyOrgEvidence` from another of the person's projects. Never raises a status. |
| **`auditexport.ts`** | **Batch C4a:** the signed audit file: canonical JSON, Ed25519 signature by the person, `verifyAuditExport` (no project needed), `withoutNames` (roles only), `renderAuditMarkdown` (DE/EN). |
| **`auditpackage.ts`**, **`audithtml.ts`** | **Batch C4b:** the audit package (evidence, print-ready page, Markdown, note), the newest export in a folder, checking a package incl. its reading copies; the self-contained print page (PDF via the browser). |
| **`auditaccess.ts`** | **Batch C2:** who may read the audit file (`person` default / `open`): the person's signed setting outside the project, keyed by bound id + real folder, with a high-water mark; fail-closed. |
| **`iso42001.ts`** | **Batch C:** the ISO/IEC 42001 Annex A catalogue (38 controls, own short titles DE/EN, required and supporting evidence sources, coverage, the organisation's part) and the evidence sources with their assurance, hash-chain coverage, scope and limits. No imports: shared with the UI. `test/iso42001.test.mjs` pins the reviewed mapping and checks the source facts against the engine. |
| **`derivation.ts`** | **Batch E1:** the derivation of every number — `Derivation` (value, versioned formula, inputs, sentence DE/EN), `FORMULAS` (`fidelity/1`, `health/1`, `count/1`; E2 `progress/1`, `progress-project/1`; E3a-1 `context-soft/1`, `context-fill/1`), `derive` (the value is computed from the inputs), `recompute` (never throws), the short form `compact`/`expand`. No imports: shared with the UI. A new number with a derivation gets a formula here, never a value next to it. |
| **`window.ts`**, **`models.ts`** | **Batch E3a-1:** the context window measured from provider token counts — window records with a chain hash and anchors (`recordWindowEvents`, `windowStatus`, `claudeCodeWindowEvents`, `renderWindows`, `windowsForAgents`); the model table v1 (C_max with source and date, A_model 200,000; `models.ts` has no imports). Formulas `context-fill/1`, `context-soft/1` and the zones in `derivation.ts`. |
| **`contextsettings.ts`**, **`numbers.ts`** | **Batch E3b-1:** the person's values of the context-window rule per project (zone lines, P95 start value, margin, A_model, local models), signed, every revision kept outside the project (`~/.config/scenaria/context-settings.json`, revision mark apart), fall back to the start values when not verified (with a reason), rule string `v1.0-p<rev>`; `GET/POST /api/context-settings` (POST person-only), `scenaria window settings`. `numbers.ts` (no imports, shared with the dashboard): reading typed numbers (group separators, decimal comma). |
| **`windowact.ts`** | **Batch E3a-2:** acting on the fill — `contextAdvice` (checked state of one conversation's window; `quickFill` only decides whether it is worth computing), `cutDue` (orange at a turn's end, from red at once, each zone once per window and line), `cutOnce`/`cutIfDue` (check and write under the project lock), the notices (`agentNotice`, `personNotice` from red), `prepareHandover` (read-only), `sessionStartLine`. Cuts carry `meta.contextCut` and the tag `context-cut`; quiet cuts (no file change) are passed over by progress. |
| **`progress.ts`** | **Batch E2:** progress per task and for the project from evidence (`taskProgress`, `projectProgress`): the task's current line, levels per criterion, gates, `next` for people and `nextAgent` for agents, `renderProgress`, `progressForAgents`. Formulas `progress/1`, `progress-project/1` in `derivation.ts`. |
| `llm-errors.ts` | Error codes for model calls. Shared with the UI, so it must have **no imports**. |
| `settings.ts`, `global.ts`, `projects.ts` | The person's settings (roles: chat, analysis, analyst, archivist, craftsman, oracle, auditor) and the project registry. |

### Dashboard (`ui/src/`, React + Vite)

| File | Role |
|---|---|
| `App.tsx` | Top bar with the three views (Simple / Audit / Manage, remembered per browser), dialogs, help actions, the lock 🔒 for the approval mode, the auditor-mode band (C4c-1). |
| `SimpleView.tsx` | The Simple view for office users: history in plain words by day, "Back to this state" with Undo, "What did the AI do?", open a state as a folder. |
| `Approval.tsx` | `requestApproval` and `LockedNote`: every locked notice carries the button that opens the approval mode. `ReadOnlyContext` (C4c-1): in auditor mode components hide every write action, and `LockedNote` shows only a read-only note. |
| `api.ts` | Every request. The `x-scenaria-view: dashboard` header makes requests follow a project switch; downloads must use fetch with it, never plain links. |
| `i18n.ts` | **All texts, DE and EN.** Every key must exist in both; `de` is typed as `typeof en`. |
| `helpContent.ts` | The help topics (DE/EN). `test/help.test.mjs` checks the topics, terms and actions. |
| `Forecasts.tsx` | The forecasts dialog (tabs Start / Entscheidungen / Prompt prüfen / Nachprüfen / Verlauf / Güte), the derivation and the AuditBox. |
| `ForecastStart.tsx` | Ready check, three start cards, new-decision form, run progress with stop, ErrorBox, ResultCard, PastCheck. |
| `AuditArea.tsx` | The forecast audit ("Prognose-Prüfung", Manage → Extensions). |
| `AuditFile.tsx` | **Batch C4c-1:** the ISO/IEC 42001 audit file (Audit view → "Prüfakte"): read-only view, the audit package from the dashboard, "hand over to an auditor". |
| `Why.tsx` | **Batch E1:** "ⓘ Wie berechnet?" — `Why` next to a number (hover: the sentence; tap/click/Enter: the whole derivation in place; Escape closes it while the focus is inside), `WhyList` for groups of numbers; recomputes and compares with the number shown. |
| `Progress.tsx` | **Batch E2:** progress in the dashboard — `ProgressCard` (Simple view, the current task), `ProgressDialog` (Audit and Manage header), `TaskProgressBlock`, `ProgressBar`; every number with `Why`. Changes nothing; criteria are approved in "Regeln & Meilensteine" (`Dialogs.tsx`). |
| `OrgEvidenceForm.tsx` | **Batch C4c-2:** record, remove/discard, confirm and take over the organisation's documents; SHA-256 computed in the browser; every step shows what will be signed first. |
| `Control.tsx` | Settings (your AI first, one model, the rest under "Advanced"; start icon), chat, relay. |
| `NodePanel.tsx`, `Map.tsx`, `Dialogs.tsx`, `Expert.tsx`, `Help.tsx`, `Projects.tsx` | The rest of the dashboard. |
| `styles.css` | Design tokens on `:root`, light and dark. Reuse the existing classes (`chip`, `qnote`, `x-kpi`, `log`, `btn`). |

## 5. The forecast system in short (where the recent work was)

1. **Core (`predict.ts`).**
   - It predicts the **same quantity that is measured afterwards**: the mean fidelity of the first 5 content steps on the option's line within the task.
   - Formula: `P = L + α(own − L) + β(ctx − L) − risk`.
   - α and β are learned per project by leave-one-decision-out. The band ± is the 80th percentile of the errors.
   - It is meaningful from 10 decisions; below that everything is labelled as a tendency.
   - The backtest uses `viewAsOf(t)`, so it has no knowledge of the future.
2. **Oracle (`oracle.ts`).**
   - Archivist (PAST), craftsman (CURRENT LINE) and oracle (FUTURE plus the core table).
   - The oracle may correct `own` and `ctx` by at most ±20 each. Every correction needs a reason **and** an existing, specific evidence id; the root, the task and the decision itself do not count.
   - `applied = clamp(Δ · confidence · γ, ±20)`.
   - A hard fixed point at risk caps the forecast at 40.
   - γ is learned from checked cases.
   - The cited evidence texts are stored, signed, with the forecast.
   - Without a usable oracle answer the run fails; nothing is saved.
3. **Prüf-Experte (`auditor.ts`).**
   - The checklist leads to a verdict: belastbar / mit Vorsicht / nicht belastbar.
   - "Before the choice" is decided by event order **and** the signed time.
   - Two things need the skeptic's "supported": resolving a core warning, and any correction of 10 or more points.
   - The skeptic checks only against the evidence as it was cited.
4. **Usability (0.9.1).**
   - Ready check, three paths, progress with stop.
   - Plain-language result, including "Keine klare Empfehlung" when the gap is smaller than the band.
   - Classified errors with fixes.
   - Check a past decision.
   - The auditor's area with a downloadable report (Markdown/JSON).

## 6. How work has been organised (keep this)

- **Define a main goal ("Hauptziel") first.** Then work in small batches (B1…, C1…, D1…), one commit each. Commit messages end with the co-author and session lines your environment requires.
- **Every batch is checked by an independent reviewer agent** that did not write the code. It reproduces findings with scripts and reports K1…Kn with severity, repro and fix. Fix everything HIGH and MEDIUM before you call a batch done, and add a regression test per finding.
- **Tests for every behaviour**, especially for the security rules: person-only (403 for agents), signatures (edited files become unverified), no leakage of the future.
- **Both languages for every UI text, and both help languages.** Plain words for non-technical people; technical details collapsed.
- **Honesty in the product:** never show a number as more certain than it is (band, tendency, "Keine klare Empfehlung"). Never dress up a failed model run as a result.

## 7. Browser walkthroughs (end-to-end)

There is no committed e2e suite. The walkthroughs so far used Playwright scripts outside the repo. To redo them:

1. Start a fake model server: a small HTTP server that answers OpenAI/Ollama-style requests. It switches on the system prompt (`ARCHIVIST of a multiverse`, `CRAFTSMAN of a multiverse`, `ORACLE of a multiverse`, `AUDITOR (Prüf-Experte)`) and returns the JSON the prompts in `oracle.ts` and `auditor.ts` describe.
2. Start the dashboard on a *copy* of a real project with `createApp(s, { approvalCode, approvalSecret })`. Set the approval cookie `scenaria_approval=<secret>` in the browser, and set `localStorage "scenaria.onboarded.v1" = "1"` to skip the onboarding.
3. Walk the flows: Start tab → ready check; write down a decision → "Speichern und vorhersagen" → progress → result card; Nachprüfen; Prompt prüfen; Güte; the "Prognose-Prüfung" (Manage → Extensions) with filter, details and download; a view-only browser without the cookie; EN; 390 px width.
4. Check that there is no `pageerror`, no console error and no HTTP ≥ 400 that you did not expect.
5. For the approval mode use `startServer(s, { port, quiet: true, showApprovalLink: false })` with `SCENARIA_NO_BROWSER=1`: the links Scenaria would open land in `browserLog` (exported by `server.js`); open them in the Playwright context. `SCENARIA_CLAUDE_DESKTOP_CONFIG` points the Claude Desktop wiring at a temporary file.
6. Batch B walkthrough (office user): the Simple view is the default; "Back to the state at the end of yesterday" restores the files, Undo returns; Audit and Manage render; Settings (Claude Desktop row, start icon, "Advanced"); a viewer window at 390 px clicks the lock and becomes approved; the onboarding in EN.
7. Batch C4c-1 walkthrough (audit file): set `HOME` to a temporary folder with a `Downloads` folder and `SCENARIA_NO_BROWSER=1`; Audit → "Prüfakte" (tamper protection, counts, A.2.2 with a recorded document, a period, "Ganzes Projekt"); "Prüfpaket erstellen" (the folder appears in Downloads); "An Prüfer übergeben" → "Prüfermodus starten" (band, no lock, no write buttons in the step panel, a write from the page is 403); reload (still auditor mode); "Prüfermodus beenden" (lock back); Manage → Extensions shows "Prognose-Prüfung"; a viewer without approval at 390 px (EN) sees the locked note; the person at 390 px: no horizontal scroll in the dialog. Expected HTTP errors: 403 for the viewer and for the write in auditor mode.
8. Batch C4c-2 walkthrough (the organisation's evidence): register a second project with one signed entry and put one unsigned entry into the first; Prüfakte → a control → "+ Dokument erfassen": link (an international domain), choose a file (the SHA-256 shown equals the file's), title, role, name, date → "Prüfen" (punycode shown) → "Signieren und speichern"; "Entfernen …" → "Entfernen und signieren"; the unsigned entry → "Bestätigen …" → "Bestätigen und signieren"; "Aus anderem Projekt übernehmen" → project → plan (origin name, every field) → take over; 390 px without horizontal scroll; in auditor mode no edit buttons. Expected: no HTTP errors at all.

A good next task is a committed e2e suite (`test/e2e/`, opt-in) built from this.

## 8. Working on Kev's machine

- Paths, test project, model and current state: `CLAUDE.local.md` (local only).
- **Git in a sandboxed folder:** if deleting files is not allowed there, git leaves `*.lock` and `tmp_obj_*` files behind.
  - Move stale locks aside, e.g. `mv .git/index.lock .git/stale-index-lock-<time>`; never under `.git/refs`.
  - Kev can delete the `stale-*` files himself. Prefer giving Kev the git commands to run in his own terminal.
  - Scenaria commands (even `status`) run from such a shell leave `.scenaria/lock` and `.scenaria/shadow.index.lock` behind, which can block Kev's running Scenaria. Move them aside the same way, or avoid running Scenaria there.
- **After an update:**
  1. `npm run build`, if `dist/` was not shipped.
  2. Restart `scenaria start`.
  3. Hard-reload the browser (Cmd+Shift+R).
  4. Unlock the approval mode again (the lock 🔒 in the dashboard).

## 9. Open points and good next steps

From the latest reviews (all optional and low):
- `e2e`: a chat-regression step clicks the last map node, which can be outside the viewport. Use `scrollIntoViewIfNeeded` or click HEAD.
- This repository's own Scenaria tree is in use (schema 3, since 2026-10-12): main goal set, task "Test-Projekt für alle Funktionen aufsetzen" (a separate test project outside the repository, see `CLAUDE.local.md`). Record new work there as a new task.

Resolved in S1 (0.9.4, 2026-10-16, Kev's decision): agents' project rules are only proposals (K5), and adding, accepting, rejecting and removing rules is the person's (K4). Review S1-1…S1-11: S1-3 to S1-11 fixed with tests (`test/rules.test.mjs`).

Resolved in S2 (0.9.5, 2026-10-16, Kev's decisions): S1-1 (the approval link is never printed; agents run in a sandbox, documented) and S1-2 (rule decisions are signed; only signed rules reach agents; older rules need one confirmation).

S2 review (S2-1…S2-10), fixed: S2-1 (approval link: system opener by absolute path, cleaned environment; `--print-approval-link` only at a terminal with typed confirmation; sandbox scope documented), S2-2 (removals kept as signed tombstones, so teammates see them), S2-3 (project id bound to the folder outside the project, `project-ids.json`; signatures of canon and rules are checked against it; `project_id_changed` finding), S2-4 (unsigned entries naming an agent are proposals; origin and date shown), S2-5 (ids never reused, also from the marks), S2-6 (rule trust cached by content hash and trust files), S2-8 (agents' shells see counts only), S2-9 (ISO wording), S2-10 (tests). Open, LOW: S2-7 (anchor writes have no lock across processes, like canon).

- Release notes for 0.9.4/0.9.5: in team mode without `SCENARIA_APPROVER_TOKEN`, token holders can no longer manage rules over HTTP; rules that agents added before 0.9.4 stop reaching agents until the person accepts them; since 0.9.5 every older rule reaches agents only after the person confirms it once (dashboard → Analysis → Project rules, or `scenaria rules confirm <id>`); the approval link is no longer printed in the terminal.

Batch E2 (0.9.15, 2026-10-17): three independent reviews — the core (E2a: 3 HIGH, 4 MEDIUM: removing a criterion by hand raised progress; rewinding to a verified step gave 100 %; check results ignored the line; a change during a running check; an agent could abandon a task; unsigned proposal fields; a tampered snapshot), the fixes (2 HIGH, 4 MEDIUM: rewinding to the task kept the abandoned attempt; a later task's check survived a rewind; a deleted task node; a missing criterion could not be cleared; no git; the dashboard's approve) and the dashboard (E2b: 6 MEDIUM, 6 LOW: weight field, stale dialog after a refusal, English errors, agent wording for people, words for the same action, English codes in "How computed?"). **Re-checked on 2026-10-18** (Kev: record only what exists; report `docs/intern/batch-e/e2-nachpruefung.md`): each fix was reverted in the built code to see a test fail. All 5 HIGH are fixed — E2a H2 (rewinding to a step the person verified gave 100 %) only since the re-check: gate 100 now counts the person's verdict only when it was given after the task's newest step. All 14 MEDIUM are fixed — E2b M3 (server errors in English in the dashboard) completely only in 0.9.16 (2026-10-18): every refusal of `canon.ts` and of the criterion checks in `engine.ts` is a `CanonError` with a code; the server passes the code on, the dashboard says it in German or English (`errCanon` in `ui/src/i18n.ts`); a test checks that every code has both texts. Three fixes had no test that really checked them (steps from unseen ledger lines, `progress <task> --json`, the verdict path without git); tests added in the re-check. `test/progress.test.mjs`: 30 tests. Open after E2 (LOW unless marked):
- An agent can propose criteria for any task and so keep that task's gate 20 closed (it can only lower progress).
- The verdict dialog does not show which criteria a step reports (`fulfills`).
- A criterion without a file never goes stale; a check made after the task checks the file as it was then.
- Staleness from the approval time compares clock times of one machine (step order everywhere else).
- Anchors written before 0.9.15 have no task (development machines only); a criterion signed by a key this machine does not trust has no anchor, so deleting it opens gate 20 again.
- Re-approving a criterion changed outside Scenaria shows its current values, not the earlier signed ones.
- After approving, the focus returns to the page (the row moves to the other list).
- Texts address the person ("du") also in the auditor mode.
- `POST /api/node/update` lets agents set a task's status; abandoned tasks therefore still count in the project value.

Batch E3a-1 (0.9.17, 2026-10-18): an independent review (2 HIGH: a changed window line before a break in the chain still counted; the anchoring checkpoint was not checked against the integrity ledger and projects without it had no anchor — 4 MEDIUM: an unreadable record cost the turn its checkpoint, P95 took every agent's checkpoints as step boundaries, a crash with very many answers in one window, the soft-threshold sentence did not add up — 5 LOW) and a review of the fixes (2 HIGH: deleting the outside anchor turned detection off; a reset line written by hand made checkpoint anchors be passed over — 2 MEDIUM: endless restarts with two config folders, numbers slipped in through a client-named proxy upstream — 3 LOW). Every HIGH and MEDIUM is fixed with a test in `test/window.test.mjs` except the two-config-folders case (documented below), and each fix was reverted once in the built code to see its test fail (`docs/intern/batch-e/e3a1-pruefung.md`). Open after E3a-1 (LOW unless marked, documented):
- MEDIUM: two Scenaria installations with different config folders on one project (a container next to the host), or an anchor that cannot be written, see each other's appends as foreign: every append starts the measurement again and one side warns.
- Parallel Claude Code sessions share the agent name "claude-code", so their checkpoints cut each other's steps (P95 smaller, soft threshold later); a crash between appending and raising the anchor gives a false warning and a restart; a local proxy client can join another conversation with `x-scenaria-session` (local clients are trusted, as for the conversation record).
- In a Claude Code project, after a restart the new windows count only once the next end-of-turn checkpoint (one with file changes) names the reset.
- The soft threshold of an ended window is computed with today's step sizes and capsule size (the fill and the lines 50 / 70 / 85 % are fixed).
- Two proxy conversations that start with the same system and first message share a window unless the client sends `x-scenaria-session`.
- Not detected: a changed Claude Code transcript (outside the project). Window data from another machine is never confirmed here (the measurement starts again).
- Local models (Ollama) get no number until the person enters their window size (since E3b: `scenaria window settings model <id> <tokens>` or the dashboard); the margin of 2 % of C_eff is a proposal Kev was not asked about.
- The fill is verified on this cloud session's real transcript; a transcript from Kev's Mac is still to be checked.

Batch E3a-2 (0.9.18, 2026-10-22): an independent review (2 HIGH: the after-tool hook was installed only for two tools, so "red = at once" never ran after ordinary tools; Scenaria's own cut lowered a task the person had accepted — 6 MEDIUM: parallel hooks cut several times, OpenAI Responses chains got no headers or cuts, a cut written into a node by hand or left on an abandoned branch still counted, the handover took another conversation's window, a session could be fed another transcript, the handover pointed to the save instead of the current state — 7 LOW) and a review of the fixes (4 MEDIUM: every tool call could wait up to 20 s for the project lock, a quiet cut carried the agent's words under Scenaria's name, two tests did not prove their fix — 5 LOW). Every HIGH and MEDIUM is fixed with a test in `test/windowact.test.mjs` except the fake-session case (documented below), and each fix was reverted once in the built code to see its test fail (`docs/intern/batch-e/e3a2-pruefung.md`). Open after E3a-2 (LOW unless marked, documented):
- MEDIUM: a process with the agent's rights can call `scenaria hook post-tool` with a session id and a transcript of its own. That conversation gets its own window and, from red, a cut that Scenaria writes (with the conversation's key in `meta.contextCut.key`); a real session's window cannot be fed this way (a session reads only the transcript it named first). The sandbox precondition of rule 6 limits this; Scenaria cannot tell a real transcript from a written one.
- Projects set up before 0.9.18 keep the old after-tool matcher until `scenaria start` (or `scenaria init`) runs in them again; a global setup until `scenaria setup --global` runs again. The dashboard does not yet report an outdated matcher.
- Parallel Claude Code sessions share the agent name: the handover and the session-start line take the newest window of `claude-code` (the handover lists the other windows that are yellow or fuller); a rewind in one session takes the other session's cut off the line, so a new cut becomes due there.
- The proxy computes the checked measurement before it sends the answer's headers (from yellow on), which delays the first byte by the time of that check; above yellow each hook call costs about 50 ms more (300 steps).
- The after-tool hook skips its work when the project lock stays busy for 1.5 s; the next tool or the end of the turn acts then. Opening a project now waits at most 1 s for the lock to refresh the ledger anchor (it is refreshed on the next open).
- A Stop cut with file changes stays the agent's own turn checkpoint (agent `claude-code`, marked by `meta.contextCut` and the tag); only a quiet cut is written as `scenaria`.

Batch E3b (2026-10-23): E3b-1 core (0.9.19) — an independent review (4 MEDIUM: the change history lived only in the project's event log; one now-documented model voided the whole setting; the formula texts still named the start values; a moved folder lost the values silently — 8 LOW) and a review of the fixes (2 MEDIUM: a restart after an invalid setting dropped the earlier revisions; revision numbers could repeat — 4 LOW). E3b-2 dashboard (0.9.20) — an independent review (6 MEDIUM: German thousands separators misread, a save showed no rule version, the header chip showed the zone by colour only, numbers without a time and not refreshed, English text in the German UI, Escape closed nested dialogs — 11 LOW) and a review of the fixes (2 MEDIUM: English save titles while loading, typos read as other numbers — 5 LOW). Every HIGH and MEDIUM is fixed with a test (`test/contextsettings.test.mjs`, `test/windowui.test.mjs`), the core rules were reverted once each in the built code to see a test fail; the dashboard was walked through at 1280 and 390 px, light and dark, DE and EN, with the keyboard (`docs/intern/batch-e/e3b-pruefung.md`). Open after E3b (LOW unless marked, documented):
- Hand-entered window sizes are for local models only: a name built on a documented model (also `gpt-5-mini`, `claude-opus-5.5`) is refused — such a provider model needs a row in the documented table. A name without a separator (`gpt5`) is not recognised as an alias.
- The bounds (yellow 10–90 %, red 20–95 %, emergency 30–99 %, P95 start 0–30 %, margin 0–20 %, A_model 8,000–10,000,000) are Claude's proposal (Kev not asked); looser values than the start values are named everywhere.
- Someone with write access to the config folder can still roll the setting back (delete the mark and the newest revisions) — the same limit as for every file there (rule 6's sandbox precondition).
- The dashboard refreshes the context window every 30 s (the dialog every 15 s); between two refreshes a number can be up to that old (its time is shown). The UI checks of E3b-2 are mostly static source checks plus the walkthrough; the dialog stack and the refresh have no browser test in the suite.
- The audit file (Batch C) does not yet include the windows, the cuts or the rule's history.

Batch E1 (0.9.14, 2026-10-17): two independent reviews, of the core (E1a: K1 HIGH — a wrongly typed step field broke the project check; K2–K6) and of the dashboard and exports (E1b: K1–K10), all fixed with a test each in `test/derivation.test.mjs`. Open after E1 (LOW, documented):
- Not every number has a derivation yet: decision quality in the project check, the status bar's counts and the forecast numbers (they have their own "Why this number?") follow; the help says so.
- A count's sentence names the first 12 items; the inputs (dashboard) and the footnotes (exports) list all.
- Escape closes every stacked dialog at once (older than E1); a derivation open inside keeps its own Escape only while the focus is in it.
- A word of 120 characters without a space in agent text gives the Audit view a horizontal scroll at 1280 px (older than E1).

Closing review C5 (0.9.13, 2026-10-17): two independent whole-batch reviews (security S-K1…S-K7, personas U-K1…U-K11 plus three observations) and a review of the fixes (R1–R5). All MEDIUM (S-K1–S-K3, U-K1–U-K5, R1, R2) and, by Kev's decision, the LOW ones fixed with a test each in `test/c5.test.mjs`; the C2.1 point "the audit file's own alarms are not in the project check" is fixed too. One observation did not hold: every one of the 38 controls has a part the organisation documents, so "x/38 documented by the organisation" is right. Open after C5 (LOW / design limits, documented, Kev 2026-10-17):
- The auditor can end the auditor mode in the band and then click the lock; the approval link opens in the default browser, often the auditor's own (S-K4). The auditor mode protects against mistakes, not intent; a lockout would also lock out the person. The person ends the mode themselves.
- Who may read the audit file is shown in the dashboard; changing it stays in the terminal (`scenaria audit-file access`, U-K9).
- A teammate's clone has no shadow repository: every step there shows `snapshot_missing` (project check and audit file); the text names a copy or clone as a possible cause (R4).
- A package whose note was removed and replaced by one in the other language: the missing note is said, the other one is listed as "not checked"; the package does not fail for it.
- Two processes replacing a damaged `auditview.key` at the same moment both end up using the key on disk (suspicion from R, not reproduced).

Open after C4c-1 (LOW / design limits, documented):
- The auditor mode protects against mistakes, not against intent: on the person's computer someone can open another browser, a private window or a terminal. The person stays nearby.
- While a browser in auditor mode checks in (its dashboard does every 2 minutes), nobody can open an approval link — also the person's other browser cannot unlock. The person ends the auditor mode in the auditor's browser first; a closed auditor window stops blocking after 10 minutes (or after a restart).
- Server error texts are English; the dashboard shows its own text only for the auditor-mode codes.
- In auditor mode the dashboard hides write actions in the step panel, the simple view, the goal bar, the chat, the canon dialog, "Extensions" and the settings; any other button the server refuses (403 `auditor_mode`).
- The package from the dashboard is local mode only (team mode: `scenaria audit-file export` on the project's machine).

Open after C3 (LOW / design limits, documented):
- Ids of the organisation's evidence are tracked per machine: two teammates adding entries offline can both create the same id; after a merge both copies show as changed, and only discarding (content and history in the file are lost) or restoring one side from git resolves it.
- The marks of the organisation's evidence (like the rules' and canon's) are raised outside the store lock when a teammate's newer revision is seen; two processes at the same moment can lose a mark (S2-7).
- An unreadable `org-evidence.json` raises one alarm on all 38 controls.
- Resolved in C4c-2 (0.9.12): the person records, removes, confirms and takes over entries in the dashboard.

Open after C4c-2 (LOW / design limits, documented):
- "Taken over from" records the other project's own name (its settings), which can differ from the name in the project list; the plan shows the recorded name before anything is signed.
- The browser reads a chosen file at once to compute its SHA-256 (at most 512 MB); without a secure context (team mode over plain http) the hash is pasted.
- An entry recorded with the 0.9.12 CLI whose title or note was cut right after a space shows as changed (only very long texts; fixed for new entries).

Open after C2.1 (LOW, documented):
- ~~The audit file's own alarms are not yet shown by the dashboard's project check~~ — fixed in C5 (0.9.13).
- A person's reseal accepts the step files as they are, including a hand-edited verdict history (only the person can reseal; the review accepted this).

Open after C2 (LOW, documented):
- The audit file's read setting is written like the other files in the config folder: two processes at the same moment are not locked against each other (like S2-7).
- A machine that first opens a project after an audit agent's reseal record was edited adopts the edited time (first-use trust, like every anchor).
- Old projects without `meta.goalSince` take the main goal's time from the root and the event log (not in the hash chain).
- `buildAuditFile` runs `integrity()`, the canon and gate checks more than once (about 0.5 s for 1,500 steps); computing them once is a later optimisation.

Open after Batch A (from the reviews, documented limits):
- The anchor is per machine. A project used from two computers, or from a devcontainer with another home, reports "extended" writes (medium, with the steps named). External anchoring (git remote / signed export) is on the roadmap.
- After an update, restart agents and MCP servers. An older Scenaria version that keeps running writes without raising the mark ("extended").
- On macOS, check that `realpath` gives the same folder spelling for every process; a different upper/lower case would mean a different anchor.
- A process with the person's full user rights can still read the approver key or fake a terminal (keychain / hardware keys are on the roadmap).

Product ideas already discussed or noted (see `docs/ROADMAP.md`; the batch plan in §11 has priority):
- **Test with Kev's real local model.** It has only been tested with simulated models so far. Watch for JSON robustness, duration and the readability of the error messages.
- **Commit an e2e suite** (§7).
- **Optional embedding-based fidelity** for projects in several languages. The word-based core does not see synonyms or another language; today only the oracle compensates.
- ~~Export the audit report as PDF~~ — done in Batch C (signed audit file and package with a print page, 0.9.9–0.9.11).
- Streaming chat answers; relay with parallel branches; approver keys in the OS keychain.

## 10. Version history (short)

| Version | Content |
|---|---|
| 0.1–0.3 | Core engine, rewind/fork, MCP, hooks, CLI, dashboard, vendor-neutral tools, team server, overlay/proxy |
| 0.4–0.5 | One project tree, context capsules, analysis, context integrity (ledger), handoffs |
| 0.6–0.7 | Canon (fixed points) stages 1–3, gate, relay, settings and chat in the dashboard |
| 0.8 | Forecasts and the multiverse, expert analyst, project switcher, help and onboarding |
| 0.9.0 | Forecast core v2 (same quantity as the measurement, retraceable, backtest, quality), traceable oracle v2, Prüf-Experte |
| 0.9.1 | Simple start (ready check, three paths), progress and stop, plain result, past-decision check, robust oracle for local models, auditor's area and report |
| 0.9.2 | Batch A (rule 11): verdict origins; only the person or a registered audit agent can verify or reseal; signed, work-bound verdicts; anchor with high-water mark outside the project; reseal records; audit-agent registry and signed requests; dashboard reseal; two independent review rounds (K1–K11, R1–R7) |
| 0.9.3 | Batch B (office users, two review rounds K1–K21): three views (Simple / Audit / Manage), Simple view with history in plain words, "Back to this state" + Undo, "What did the AI do?", states as folders; plain wording DE/EN incl. help and onboarding; settings with one model and "Advanced"; forecasts, relay and Prüf-Experte under "Extensions"; Claude Desktop per project; start icon; approval mode without copying a link (lock 🔒); a second start reuses the running Scenaria; macOS CI fix (real folder paths in the cross-project report, APFS clones in snapshot folders) |
| 0.9.4 | S1 (security rule 5 for project rules): agents only propose rules; adding, accepting, rejecting and removing are the person's (approval session, or terminal with typed confirmation); decisions recorded; proposals hidden from agents; ids never reused; accepting needs the text the person saw; two review rounds (K4/K5, S1-1…S1-11) |
| 0.9.5 | S2: project rules signed like canon (revision, anchor outside the project; tampered, rolled-back and deleted rules detected; older rules need one confirmation); only signed rules reach agents; the approval link is never printed (`--print-approval-link` for a machine without a browser); agents run in a sandbox (documented) |
| 0.9.6 | Batch C2 (two review rounds K1–K12, N1–N4): the ISO/IEC 42001 audit file computed from the records (status per control, whole project or a period, integrity warnings that lower no status, signed approvals and reseals); who may read it is the person's signed setting outside the project (default: only the person); steps deleted outside Scenaria are detected (`step_missing`); an audit agent's reseal time must match the anchor; the main goal's first time is kept on the root |
| 0.9.7 | Batch C2.1 (third review round K1–K8 and its review R1–R11, all fixed with a test each): a damaged verdict never breaks the integrity check or the audit file — it is `forged` and raises the alarm `verdict_forged`; a verdict counts only as a verdict, never also as an approval; replaced verdicts of the person or an audit agent are archived per step (signed, in the hash chain, not in the work hash) and shown for comparison; every audit file checks that the stored file states still exist (`snapshot_missing`); paths with spaces are scrubbed; an audit agent's reseal marks its unsigned fields; periods: an end to the minute includes that minute, stored times without a zone are UTC |
| 0.9.8 | Batch C3: the organisation's evidence per control (`.scenaria/org-evidence.json`, committed): link + SHA-256, owner role + name, date; signed by the person per revision and anchored (edited, rolled back, deleted → alarm); never raises a status (own field `orgEvidence`); bound to the catalogue (re-worded control → confirm); take over from another of the person's projects; HTTP and CLI, person-only |
| 0.9.9 | Batch C4a: the signed audit file — canonical JSON signed with the person's approver key (meaning stated in the file), `scenaria audit-file verify` for anyone without a project (also checkable with openssl), Markdown reading copy DE/EN with the fingerprint; names by default, "roles only" on request; export person-only (HTTP and CLI) |
| 0.9.10 | Batch C4b: the audit package — `export` writes a folder with the evidence, a print-ready page (opened in the browser; "Print → Save as PDF"; fingerprint in the footer of every page), Markdown and a note on checking; `verify` without a name checks the newest export here and, for a package, that the reading copies carry the same fingerprint |
| 0.9.11 | Batch C4c-1 (three review rounds K1–K11, R1–R6, S1, all fixed with a test each in `test/auditview.test.mjs`): the audit file in the dashboard (view "Prüfung" → "Prüfakte": integrity, status per control, the organisation's documents, approvals, verdict history, reseals, sources, period), the signed audit package from the dashboard (written to Downloads, print page opened), the auditor mode on site (read only, 8 h, signed cookie, the lock blocked while the auditor's browser checks in), the forecast "Prüfung" renamed "Prognose-Prüfung" |
| 0.9.20 | Batch E3b-2 (2026-10-23; an independent review — 6 MEDIUM, 11 LOW — and a review of the fixes — 2 MEDIUM, 5 LOW; every MEDIUM fixed with a test in `test/windowui.test.mjs`; walkthrough 1280/390 px, light/dark, DE/EN, keyboard): the context window in the dashboard — a card in the Simple view (the AI's memory in plain words, the zone as a word, "How computed?", when measured, what to do at red, the handover), "Context window" in Audit and Manage (newest window with fill, soft threshold, next line, saves with their rule version; all windows; the rule's values and their signed history; in Manage the person edits them under the lock, sees what is signed before signing, looser values named); Scenaria's own saves in plain words in the timeline; help topic; dialogs close one at a time with Escape; typed numbers with group separators and a decimal comma |
| 0.9.19 | Batch E3b-1 (2026-10-23; an independent review — 4 MEDIUM, 8 LOW — and a review of the fixes — 2 MEDIUM, 4 LOW; every MEDIUM fixed with a test in `test/contextsettings.test.mjs`, 25 rules reverted once each): the person's values of the context-window rule per project — zone lines, P95 start value, margin, A_model, window sizes of local models; signed, every revision kept outside the project, a restart after an invalid setting keeps the earlier revisions apart and never reuses a number; fall back to the start values with a reason; rule `v1.0-p<rev>` in every derivation (formula texts refer to the rule; `cMaxSource`); `scenaria window settings`, `GET/POST /api/context-settings` (POST person-only) |
| 0.9.18 | Batch E3a-2 (2026-10-22; an independent review — 2 HIGH, 6 MEDIUM, 7 LOW — and a review of the fixes — 4 MEDIUM, 5 LOW; every HIGH and MEDIUM fixed with a test in `test/windowact.test.mjs` except one MEDIUM documented, each fix reverted once to see its test fail; open points in §9): acting on the measured fill — orange: a checkpoint at the end of the turn (also without a file change); red and emergency: a checkpoint at once, also mid-turn (the after-tool hook now runs after every tool); each zone once per window and line of work; notices to the agent (prompt reminder, after-tool context) and from red to the person (Claude Code system message, protocol line); the proxy sends `x-scenaria-context-zone`/`-fill`/`-window` from yellow and cuts after an answer; `scenaria_handover`, `scenaria handover`, `GET /api/handover` (read-only; continues from the current state, names the last save); the new window's start names the previous window's save; quiet cuts never lower progress |
| 0.9.17 | Batch E3a-1 (2026-10-18; an independent review — 2 HIGH, 4 MEDIUM, 5 LOW — and a review of the fixes — 2 HIGH, 2 MEDIUM, 3 LOW; every HIGH and MEDIUM fixed with a test in `test/window.test.mjs` except one MEDIUM documented, each fix reverted once to see its test fail; open points in §9): the context window measured, not estimated — fill from Claude Code transcripts (`message.usage`, sub-agents skipped, compaction starts a new window) and from proxy answers (`usage`, JSON and streams); window records with a chain hash, an anchor outside the project and the chain's head in the end-of-turn checkpoint (a change outside shows; the window then shows no number; the measurement starts again after a reset line); model table v1 with sources; `C_eff = min(C_max, A_model 200,000)`; zones 50 / soft / 70 / 85 %; formulas `context-fill/1`, `context-soft/1`; `scenaria_window`, `scenaria window`, `GET /api/windows`. Measurement only |
| 0.9.16 | E2 completed (2026-10-18): every refused change to the fixed points carries a code (`CanonError`) and reaches the dashboard in the person's language (E2b M3); the test of C5's child-process output (colour codes) written back |
| 0.9.15 | Batch E2 (reviews E2a, its fixes, E2b; re-checked 2026-10-18 by reverting each fix: all HIGH and 13 of 14 MEDIUM fixed with a test in `test/progress.test.mjs`, E2b M3 partly — completed in 0.9.16, LOW points open as listed in §9): progress — completion criteria are milestones with task, weight and file (the agent proposes, the person approves exactly as shown; signed `canon/v3` with the approval time; a new weight is a signed revision; a criterion removed by hand holds its task back until the person retires it); levels from evidence (started, implemented, checked, confirmed; a failed check caps at implemented); gates 10–100 (90 and 100 % only by the person or an audit agent); only the task's current line counts; checkpoints claim with `fulfills`; `scenaria_progress`, `scenaria progress`, `GET /api/progress`; the dashboard: a card in the Simple view, "Fortschritt" in Audit and Manage, criteria in "Regeln & Meilensteine"; help topic |
| 0.9.14 | Batch E1 (reviews E1a K1–K6, E1b K1–K10; every finding fixed with a test in `test/derivation.test.mjs`): the derivation of every number — one format from the core (`core/derivation.ts`: value computed by a versioned formula from the inputs, sentence DE/EN, `recompute`), first for context fidelity (short form per step), the health score and every count of the project check (inputs list what they count), and the audit file's counts (in the signed export; `verify` recomputes them and refuses a file whose numbers contradict them); "ⓘ Wie berechnet?" in the dashboard (hover, tap, keyboard); footnotes with every counted item on the print page and in Markdown; hand-edited step fields of the wrong type never break the project check or the fidelity |
| 0.9.13 | Batch C5, closing review of Batch C (reviews S-K1…S-K7, U-K1…U-K11, R1–R5; every finding fixed with a test in `test/c5.test.mjs`): no hang on looped step links (`step_cycle`); deleting or rolling back the newest step raises the alarm (only the anchor's in-flight record excuses an interrupted write; a lock-free reader checks a flagged step once more); the person's export always verifies (lone surrogates as U+FFFD); the package's note is signed and checked (`audit-copies/v2`), files are hashed as raw bytes, extra files are named, `verify` starts with the overall result; "roles only" also hides audit agents' names; the package waits for "Show"; readers see "signed by the person"; plain labels in the approvals list; read setting shown; contrast; a discarded entry keeps its control; the audit file's own alarms in the project check |
| 0.9.12 | Batch C4c-2 (two review rounds K1–K5, R1–R2, all fixed with a test each in `test/evidenceform.test.mjs`): the organisation's evidence in the dashboard — record at the control (SHA-256 computed in the browser, the file is never uploaded; "Prüfen" shows exactly what is signed), remove/discard (outcome and entry shown, decided again under the lock), confirm (digest of the entry shown), take over from another project (plan first) |

## 11. Product decisions (2026-10-14) and the batch plan

### Decisions
1. **The core stays as it is:** decision tree, snapshots and rewind, context capsule, canon with approval by a person, signatures and ledger, one vendor-neutral tool registry.
2. **Feature freeze.** No new features outside the batches below. Each batch starts only after Kev's go.
3. **Three personas guide every decision:**
   - P1, an office user who is new to AI;
   - P2, an auditor who audits against ISO/IEC 42001;
   - P3, the AI manager of a company who optimises its systems and processes.
   The inventory per persona is internal (`docs/intern/`, local only).
4. **The forecast system becomes a later, optional extension** (Batch F). Until then its code stays as it is; do not extend it.

### Order
`0 → A → B → C → E → D`, then `F` only after Kev's go (E moved before D by Kev on 2026-10-17: the AI manager's view uses E's progress and handover numbers). Each batch follows §6: main goal first, small steps, one commit each, an independent review, a regression test per finding.

### Batch 0: publish
- **Goal:** the repository is on GitHub (private first) and contains only what is needed. No secrets, no machine paths, no Scenaria data.
- **Done:** hardened `.gitignore`, history checked for secrets, push done. Kev decides when it becomes public (recommended: after Batch A).

### Batch A: integrity only by a person or an independent audit agent — DONE in 0.9.2
- **Goal:** a working agent can neither reset the tamper evidence nor certify its own work.
- **Scope:**
  - `scenaria integrity --reseal` and `reseal()`: only by the person (interactive terminal or approval session) or by a request signed by a registered audit agent. Every reseal is a signed record. The previous ledger is kept and its chain head is anchored outside the project (global anchors).
  - **Registered audit agent:** it has its own Ed25519 key, created and kept outside Scenaria and outside the project (another machine, CI or a hardware key). The person registers its public key once (person-only, `trusted-auditors.json` in the global config). Scenaria only verifies; it never holds that private key.
  - **Verdicts get an origin:** `agent` (self-report), `person`, `auditor`, `auto` (automatic checks).
    - "Verified" and `lastGood()` count only person and auditor.
    - Agent verdicts are shown as "self-reported".
    - *Changed while building:* there is no "hard" origin. `verifyCommand` lives in the project config, which agents can edit. Check commands the person adopted keep counting through canon and gate, which are signed.
  - The health check and the audit view list reseals and self-reported verdicts.
- **Done:**
  - Tests: an agent shell (no terminal) cannot reseal through the CLI, HTTP or MCP; an unregistered or forged signature is rejected; self verdicts do not count.
  - Docs updated, independent review.
- **Honest limit (to document):** a process running with the person's full user rights can read the person's own key. For audits, the audit agent's key must live elsewhere.

### Batch B: easy to understand and use (office users) — DONE in 0.9.3, accepted by Kev 2026-10-15
- **Goal:** someone who is new to AI understands within five minutes what Scenaria does for them, and can go back to an earlier state without help.
- **Scope:**
  - **Three views on the same data:** *Simple* (P1), *Audit* (P2), *Manage* (P3).
  - The *Simple* view shows:
    - the history in plain words;
    - "Back to this state";
    - "What did the AI do?";
    - earlier versions in the file browser.
  - Plain wording in DE/EN, including the help: step, variant, fixed rule, milestone, "stays on topic", tamper protection.
  - Settings default to one model; the per-role models move under "Advanced".
  - Forecasts, relay and Prüf-Experte move out of the main bar into "Extensions". Their code is unchanged.
  - Starting without terminal knowledge (to investigate): wiring for Claude Desktop (MCP), and an approval flow that needs no link copied from a terminal while keeping rule 6.
- **Done:**
  - Browser walkthrough (§7) including 390 px width, no console errors.
  - Help updated.
  - A non-technical test person completes "go back to yesterday's state" without help. *(Kev accepted Batch B on 2026-10-15; the walkthrough did this scripted. The test with a real person stays optional: a ready kit with a moderator guide is in `docs/intern/praxistest/` (local only).)*
- **What was built (0.9.3):**
  - **Views.** `Simple` is the default for a new browser; `Audit` is the map with goal bar, rules and milestones, project check, protocol; `Manage` has chat, analysis, "Extensions" (forecasts, Prüf-Experte, relay) and "More". Same data, same API.
  - **Simple view.** Days (today, yesterday, date), newest first; one sentence per step with who did it (agent name, "you", "automatic"); "Now"; "checked by you" only from `integrity().confirmed`; "What did the AI do?" (request, results, files, changes, open as folder); "Back to this state" with an optional note for the AI, then a toast with Undo (back to the autosave, or the previous HEAD when nothing was unsaved); "Back to the state at the end of yesterday"; earlier attempts hidden by default.
  - **Claude Desktop.** `init --for claude-desktop` / Settings → Connect writes one entry per project (`scenaria-<folder>`, `--root <folder>`, `SCENARIA_AGENT=claude-desktop`) into the app's config; other entries are kept; a config with comments is left alone with a note. Not part of `all`, not wired automatically by `start` (it is a file of the app, outside the project).
  - **Start icon.** `scenaria launcher [--to dir]` / Settings → "Create start icon": `.command` (macOS), `.cmd` (Windows: `chcp 65001` first, `pushd … ||` stop), a `.desktop` entry in a terminal (Linux; `.sh` when a path holds characters its quoting makes risky) on the desktop (`XDG_DESKTOP_DIR`, OneDrive). It runs `scenaria start --launcher --root <folder>`; `--launcher` never sets up a project (moved folder → clear error). Another project with the same folder name gets "(2)". A second `start` for the same folder finds the running Scenaria (`/api/v1/health` → `rootKey`, a hash of the folder; `viewKey` = what the dashboard shows) and only reopens its dashboard with approval.
  - **Approval mode without copying.** The lock 🔒 (and every locked notice) calls `POST /api/approval/open`; the running process opens a fresh single-use link (60 s) in the default browser. The code never appears in an answer; the printed start link stays valid; no browser program → a clear "cannot open" (the server never crashes on a missing helper program). Every open dialog unlocks itself once the window shares the approval.
  - **Simple view, after review:** "checked by you" only from the engine's confirmed set (never stored fields, also not while loading); an alarm when the integrity check cannot load or a step was edited; "the state at the end of that day" is the step that was current at midnight (`GET /api/head-at`, replayed from the event log), so an evening "go back" counts — without an answer, that day's newest saved state; going back lists effects outside the files that cannot be brought back, and shows the rewind's warnings.
  - **Reviews:** two independent rounds, K1–K17 (2 high, 6 medium, 9 low) and K18–K21 (2 medium, 2 low), all fixed with a regression test each (`test/office.test.mjs`).
  - **Known limit:** any local client can send the dashboard mark (`x-scenaria-view`); the log records it as a claim ("a client marked as the dashboard") with the client's name.
- **Honest limits (documented):**
  - A program that can drive the person's browser, or read its process list at the right moment, could use an approval link that Scenaria opens. This was already true for the link `scenaria start` opens; a process with the person's full rights is outside what Scenaria can protect (§9).
  - An agent can ask for the approval window to open (it cannot receive it). The request is logged and limited.
  - Claude Desktop sends no hooks: it records only through the MCP tools (and auto-save), guided by the server instructions.

### Batch C: audit file (ISO/IEC 42001) — DONE in 0.9.6–0.9.13, accepted by Kev 2026-10-17
- **Steps (one commit each, an independent review each):**
  - **C1, catalogue (built 2026-10-15, three review rounds K1–K17, R1–R10; DONE — Kev accepted the mapping on 2026-10-16 for now; controls Scenaria does not carry yet are added later, once everything runs):** the 38 Annex A controls as a data module (`src/core/iso42001.ts`, no imports, shared with the UI): own short titles in DE/EN, the area, the evidence sources in Scenaria, the best coverage Scenaria can reach (evidenced / partly / organisational) and what the organisation must document. Kev checks the mapping (`docs/intern/batch-c/`) before C2.
  - **C2, evaluation (built 2026-10-16, 0.9.6; two review rounds K1–K12, N1–N4, all fixed with a regression test each in `test/auditfile.test.mjs`; accepted with C2.1 on 2026-10-16):** compute each control's status from the project's real data, with a period filter, the integrity status and the list of approvals and reseals. Kev's decisions (2026-10-16): the whole project unless a period is chosen; a damaged tamper evidence warns clearly at the top and at every affected control but lowers no status; who may read the audit file is set only by the person (default: only the person). Built: `core/auditfile.ts`, `core/auditaccess.ts`, `GET /api/audit-file`, `GET|POST /api/audit-file/access`, `scenaria audit-file [access]`. No dashboard view yet (C4). Review decisions: reseals and the read setting are listed but carry no control (they approve no work); fields a signature does not cover are marked `unsigned`.
  - **C2.1, corrections (built 2026-10-16, 0.9.7):** third independent review of C2 (K1–K8) and a review of the fixes (R1–R11), all fixed with a test each. Kev's decisions (2026-10-16): K1 never crash, raise an alarm; K2 the principle holds (a verdict counts once), and replaced verdicts are archived per step for comparison; K3 the file states are checked automatically on every audit file, without an approval step.
  - **C3, organisational evidence (built 2026-10-16, 0.9.8; accepted by Kev on 2026-10-16):** document reference, owner and date per control; person-only and signed; an edited file shows as unverified. Built: `core/orgevidence.ts`, `GET /api/audit-file/evidence`, `POST /api/audit-file/evidence[/remove|/confirm|/copy]`, `scenaria audit-file evidence [add|rm|confirm|copy]`, the field `orgEvidence` per control in the audit file; tests in `test/orgevidence.test.mjs`. No dashboard form yet (C4). Kev's decisions (2026-10-16): (1) stored in the project and committed, like `canon.json`; (2) it never raises the computed status — it is its own signed field next to it; (3) per project, with "take over from another project"; organisation-wide evidence comes with Batch D; (4) the document is referenced by URL **and** a hash; (5) the owner is recorded with role **and** name.
  - **C4, export and view:** signed export (PDF, Markdown, JSON) and a read-only view for auditors; the current "Prüfung" area (forecast audits) moves to the extensions. Kev's decisions (2026-10-16): the signed JSON is the evidence, Markdown and PDF are reading copies with its fingerprint; the PDF comes from a print-ready HTML page via the browser (no new dependency); an external auditor gets an audit package handed over, and a read-only auditor mode on site; a remote link waits for Batch D; exports name people by default, "roles only" on request. Steps: **C4a** signed file + `verify` + Markdown (built 0.9.9); **C4b** audit package with print-ready HTML/PDF (built 0.9.10; C4a accepted 2026-10-16); **C4c** dashboard view, form for the organisation's evidence, auditor mode, "Prüfung" area to the extensions — split with Kev on 2026-10-17 into **C4c-1** (built 0.9.11: read-only view, package from the dashboard, auditor mode; the forecast area already sat under "Extensions" since Batch B and is now called "Prognose-Prüfung" so it is not confused with the audit file) and **C4c-2** (built 0.9.12: the form for the organisation's evidence, two review rounds K1–K5, R1–R2).
  - **C5, closing Batch C (0.9.13, 2026-10-17; waiting for Kev's practical test and acceptance):** done: two independent whole-batch reviews and a review of the fixes, all MEDIUM fixed; Kev's decision on the LOW points (fix all new ones except S-K4 and the read-setting switch, which are documented; old §9 points stay documented limits, except that the audit file's own alarms now reach the project check); done criteria checked on the demo project (38 controls, signature check, an edited file is not valid). Open: Kev's practical test (`docs/intern/batch-c/praxistest-c.md`) and acceptance. The plan was: (1) an independent review of the whole batch C1–C4c (security rules and the three personas, end to end: record → audit file → package → verify → auditor mode); (2) the done criteria below, checked on the demo project; (3) Kev decides the open LOW points (§9: "Open after C2.1/C3/C4c-1/C4c-2"), fix or document; (4) Kev's practical test on a real project (a short guide in `docs/intern/`); (5) Kev's acceptance of Batch C.
- **Scope, stated honestly in the product:** Scenaria evidences how AI agents worked in projects (decisions, changes, checks, approvals, attribution). It does not evidence how AI models are developed or trained, nor the organisation's policies and impact assessments.
- **Goal:** an auditor finds every Annex A control of ISO/IEC 42001 in one place. For each one they see what Scenaria evidences automatically, what is partly covered, and what the organisation must document. They can export the whole file, signed.
- **Scope:**
  - **Control catalogue** as a data file: control IDs with short titles in our own words. The standard's text is copyrighted and is not copied. Kev checks the mapping.
  - **Per control:**
    - the evidence sources in Scenaria: ledger, signatures, approvals, decisions with rationale, irreversible effects, attribution (agent/model/person), verdicts by origin;
    - a status: evidenced / partly / organisational / not covered;
    - fields for organisational evidence (document reference, owner, date). Filling them is person-only, and each entry is signed.
  - Period filter, integrity status, and the list of reseals and approvals.
  - Export as PDF, Markdown or JSON, signed. Read-only access for an auditor.
  - The current "Prüfung" area (the audit of forecasts) moves to the extension.
- **Done:**
  - The demo project's audit file lists every control.
  - Signature checks pass, and an edited file shows as unverified.
  - Tests.

### Batch D: the AI manager's view
- **Goal:** across all projects, an AI manager sees:
  - which agents, models and processes keep context and goal;
  - where work is lost;
  - what it uses.

  They can also set rules for all projects.
- **Scope (*Manage* view):**
  - Project overview: health, context fidelity, rewinds, open decisions, last activity.
  - Per agent and model over time: decision quality, drift and breaks, rewinds, self-reported vs. independently verified work.
  - Token use per mission, agent and model, from the proxy and transcripts. Costs only when the person enters prices.
  - Rules for all projects: person-only, carried into each project's capsule.
  - Policy switches, e.g. "a task counts as done only with an independent verdict".
  - Later, as its own batch: multi-project server, SSO and roles.
- **Uses Batch E:** progress, handover loss and progress per window per agent and model; every number with its derivation (E1).
- **Done:** works with several local projects; every number is reproducible from the data; tests.

### Batch E: progress, context window and the derivation of every number (Kev's decisions 2026-10-17; after C, before D) — IN PROGRESS (Kev's go 2026-10-17); E1 built in 0.9.14, E2 in 0.9.15, E3a-1 in 0.9.17, E3a-2 in 0.9.18, E3b in 0.9.19–0.9.20
- **Goal:** every number in Scenaria is retraceable and reproducible; a model supplies evidence at most, never a number. "How far am I" and "when does the agent need a new window" follow fixed, versioned rules.
- **Concept and assessment:** `docs/intern/fortschritt-kontextfenster.md` (Kev's concept, local only). It replaces the parked course corridor (`docs/intern/pruferkreis.md`); the reviewer circle stays parked.
- **Kev's decisions (2026-10-17):** E comes before D; the percentage scale is called **"Fortschritt" / "progress"** ("Luftlinie" stays what it is: how close a step stays to the main goal's topic); the derivation of every number comes with this batch.
- **Steps (proposal; each with its own review):**
  - **E1 derivation (built 0.9.14, in two steps E1a core / E1b dashboard and exports, a review each):** one format from the core (`value, formula, version, inputs, sentence DE/EN`) and one UI piece (hover **and** tap/focus — phones and keyboards have no hover; footnotes in exports); first for the audit file, the project check, context fidelity and the counts.
  - **E2 progress (built 0.9.15, E2a core / E2b dashboard, three reviews; details and deviations in `docs/intern/batch-e/e2-fortschritt.md`, decisions n64–n66):** acceptance criteria (built on future canon events with checks), weights approved by the person, signed and frozen; levels from evidence (exists 0.25 → check ran 0.75 → independent verdict 1.0; a claim without evidence counts one level lower); gates as caps (10/20/40/60/80/90/100 %; 90 and 100 % only by an audit agent or the person, rule 11); `progress = min(criteria value, cap of the highest gate met)`.
  - **E3 context window rule (E3a-1 measuring built 0.9.17; E3a-2 acting built 0.9.18; E3b dashboard and the person's values built 0.9.19–0.9.20; Kev's decisions n75–n79 on 2026-10-18: C_max from the provider's documentation with A_model 200,000 tokens, P95 start value 5 % of C_eff, red = an immediate checkpoint, compaction = a new window; design in `docs/intern/batch-e/e3-kontextfenster.md`):** fill where Scenaria sees tokens (Claude Code transcripts, the LLM proxy); `C_eff = min(C_max, A_model)` from a versioned table; zones 50 / soft (70 % − buffer, buffer from P95 step size + handover cost + margin) / 70 % / 85 %; automatic sealed checkpoints and a prepared handover. Scenaria warns and secures; it cannot force a new window (hooks never block), and it sees no fill for Claude Desktop.
  - **E4 progress per window and handover check:** a window = an agent session; warning / stop recommendation after Kev's table; the handover loss is measured deterministically through context fidelity of the first steps in the new window (a progress computed from evidence cannot drop by switching windows).
  - **E5 closing:** walkthrough with a real project, docs, Kev's acceptance.
- **Honest limits (to state in the product):** the calculation is deterministic, not every judgement ("complete" stays a claim unless evidenced); all thresholds are start values v1.0, versioned, changes logged; the scale measures states, not effort.
- **Kev's answers (2026-10-17):**
  1. **Criteria and weights:** the agent proposes, the person approves (like fixed points); signed and frozen with the approval; a change is a new, signed revision.
  2. **Start values v1.0 as in the concept** (zones 50 / 60 / 70 / 85 %, at least 10 points of progress per window, 5 points tolerance for a handover) — **and adjustable:** only by the person (a signed setting like the audit file's read setting, versioned, every change logged); every number's derivation names the values in force.
  3. **"Stop" after two windows without progress:** enforced where the provider allows it (e.g. Claude Code hooks that can refuse a tool call or the end of a turn), otherwise a recommendation to agent and person. This is a deliberate exception to "hooks never block the agent" (`hooks.ts`), limited to this rule; the person lifts a stop (person-only, e.g. after cutting the task smaller).

### Batch F: agent modules (later, optional extension)
- **Goal:** forecasts and the other model-based helpers become an ordered, structured set of ready-made agents that need nothing but a model.
- **Scope:**
  - Each agent is a declarative definition in one catalogue: role, inputs from Scenaria, output schema, rules, evidence check.
  - Archivist, craftsman, oracle, Prüf-Experte and analyst move there.
  - Off by default; the core works without it.
  - The existing forecast code is reused, not rewritten.
