# Developing Scenaria

For people and agents who change Scenaria itself. Read this first, then [ARCHITECTURE.md](ARCHITECTURE.md) (how it works), [ROADMAP.md](ROADMAP.md) (what is done, what is next) and [KNOWN-LIMITS.md](KNOWN-LIMITS.md) (what Scenaria does not do or protect against). How to take part: [CONTRIBUTING.md](../CONTRIBUTING.md). Security reports: [SECURITY.md](../SECURITY.md).

- **License:** MIT. Vendor-neutral: any LLM, any agent, any framework.
- **Languages:** code, comments and docs in English; every text of the dashboard in German and English.
- **Wording:** plain words, also for people who are not developers.

---

## 1. What Scenaria is (one minute)

Scenaria records the work of AI agents as a **decision tree**. Every step is a node: mission, goal, checkpoint, decision or autosave. Every node can be restored with its files and its context. Every branch is its own line of work.

On top of the tree it adds:
- **Context fidelity:** how well each step stays connected to its line and to the main goal. It is deterministic, with no model.
- **Canon:** the project's fixed points. Only a person approves them.
- **Analysis:** health checks, pattern analysis and an expert report.
- **Forecasts:** before a choice, how each option will keep context and goal.

Agents use it through MCP, HTTP, the CLI or function calling. The person uses the dashboard.

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
   - **Agents run in a sandbox** (a precondition Scenaria does not enforce): the agent, and every process it starts, has no access to the Scenaria config folder (`~/.config/scenaria`: approver key, trusted keys, anchors, project-id bindings) and never starts Scenaria under the person's account. Otherwise any Scenaria process the agent starts signs with the person's key. Scenaria adds speed bumps (link only to the browser via the system opener by absolute path without `BROWSER`; `--print-approval-link` only at a terminal with a typed confirmation), but these are not a security boundary.
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
13. **Nothing in the project folder runs with the person's rights.** The project folder, including `.scenaria/`, is writable by agents, while the dashboard, the HTTP API and the hooks often run under the person's account.
    - A shell command that comes from a project file (`verifyCommand`, a check command) runs only after the person saw its text and started it: canon checks are adopted and signed, `verifyCommand` runs only from `scenaria verify --run` at an interactive terminal.
    - Every git call on a repository in the project carries `SAFE_GIT` (`core/snapshot.ts`); never call git on project files without it.
    - Git never gets `.scenaria/shadow.git` as its `GIT_DIR`: the shadow repository's control files live outside the project (`shadowControlDir`), only the objects and the index are in it. Use `ShadowRepo.git()` or `ShadowRepo.readEnv()`; if the control folder cannot be used, snapshots are off (`snapshotIssue`), never a fallback into the project.
    - A path read from a project file is checked before it is opened, written or shown (`insideScenaria`, `showFolderCommand`).
    - Tests: `test/execguard.test.mjs`. A new way to start a program or open a path needs a test there.

## 3. Build, test, run

```bash
npm install
npm run build          # tsc (core → dist/) + vite (ui → dist/ui)
npm test               # node --test, all test/*.test.mjs, ~4–6 min
npm run typecheck:ui   # strict TS check of the dashboard
node dist/cli.js start # dashboard, approval link opened in the browser (in a project folder)
```

- **Node:** ≥ 20.
- **Windows:** CI runs the whole suite on Windows too (about 30 minutes). What keeps code and tests working there: find the home folder with `os.homedir()`, never `process.env.HOME`; in tests point "home" somewhere with `setHome()` / `homeEnv()` from `test/helpers.mjs` (both `HOME` and `USERPROFILE`); give `import()` a file URL (`importUrl()`), never a bare path; a path inside a shell script or a git config goes through `shPath()`; never start a `.cmd` file without the shell.
- Tests use a temporary `SCENARIA_HOME` (`test/helpers.mjs`), so they never touch the real `~/.config/scenaria`.
- **Known flaky test:** `watch fingerprint writes no git objects while idle`. It is timing-sensitive, failed once on macOS and passed on rerun.
- **macOS specifics** (CI runs on macOS too; two failures there were fixed on 2026-10-15):
  - The temp folder `/var/…` is really `/private/var/…`, and a project can be opened through a symlink. Compare project folders with `realRoot()` from `src/core/projects.ts`, never as plain strings.
  - Snapshot folders use APFS clones on macOS (own inode, no extra space) and hardlinks elsewhere. Tests must not expect a shared inode on macOS.
  - To mimic macOS on Linux, run the tests with `TMPDIR` pointing to a symlinked folder. Do this before handing over any test that compares a path: Scenaria prints and opens real paths (`/private/var/…`), so a test compares with `realpathSync.native(...)`, never with the path `mkdtempSync` returned (two tests once failed on macOS for this reason).
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
| `hooks.ts` | Claude Code hooks (never block the agent — the one exception is the E4 stop). Since E3a-2 the after-tool hook runs after every tool (setup matcher `*`) on a fast path: nothing new in the transcript → no lock; otherwise at most 1.5 s wait for the lock, then it gives up. Since E4 the before-tool hook runs before every tool (matcher `*`): it reads the stop without opening the project and, during a stop, refuses everything but reading and Scenaria's own MCP tools (`allowedDuringStop`); until a session's window is recorded it reads the transcript first. |
| `setup.ts` | Agent wiring: `init --for …`, `CLAUDE.md` / `AGENTS.md` rule blocks, Claude Desktop (one entry per project with `--root`), the start icon (`writeLauncher`). |
| `proxy.ts`, `ingest.ts` | LLM proxy and conversation import (the overlay). |

### Core (`src/core/`)

| File | Role |
|---|---|
| `engine.ts` | The `Scenaria` class: missions, decide, choose, checkpoint, rewind, fork, verify, update. `remember()` keeps the field history (`meta.fieldHistory`) used for leak-free backtests. |
| `store.ts`, `types.ts`, `ledger.ts`, `snapshot.ts` | Storage, data model, integrity ledger, shadow-git snapshots. `snapshot.ts` also holds `SAFE_GIT`, the control folder outside the project (`shadowControlDir`, `ShadowControlError`, `SnapshotIssue`) and `fileSystemFacts` (rule 13). |
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
| **`taskclose.ts`** | **Batch E5:** the person's close (or reopening) of a task with approved criteria, signed and kept outside the project (`task-closes.json`, `task-close/v1`): `recordTaskClose`, `taskCloseOf`, `closedByPerson` — only such a record ends an open task's hold (`engine.ts` `hasOpenCriteria`). |
| **`windowprogress.ts`** | **Batch E4:** progress per window and the handover check — lines of windows per source and agent, the progress at each change from the `progress` records (`window.ts`), `window-progress/1` (only above the best level so far), verdicts, rows per line, the stop (noted outside the project in `window-stops.json`, held until the person's signed lift: `liftStop`, `readLifts`, `stopState` reads only the note, `evaluateStop` computes it after a window's first answers), the warning, row 4 of the rule table, `handover-loss/1`; `scenaria window stop [lift --why]`, `POST /api/window-stop/lift` (person-only). |
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

## 5. The forecast system in short

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

## 6. How work is organised

- **Define a main goal ("Hauptziel") first.** Then work in small batches (B1…, C1…, D1…), one commit each.
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

## 8. After an update

1. `npm run build`, if `dist/` was not shipped.
2. Restart `scenaria start`.
3. Hard-reload the browser (Cmd/Ctrl+Shift+R).
4. Unlock the approval mode again (the lock 🔒 in the dashboard).
5. Restart agents and MCP servers: an older Scenaria version that keeps running writes without raising the integrity mark.
