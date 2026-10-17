# Handoff: developing Scenaria further

This is the working protocol for the next agent or developer who continues Scenaria. Read it first, then `docs/ARCHITECTURE.md` (how it works) and `docs/ROADMAP.md` (what is done, what is next).

- **Product owner:** Kev (Kevin Grundmann, AI-Gambit). He reads and writes German, so give your summaries to him in German. He is not a developer by trade, so explain results in plain words.
- **License:** MIT. Vendor-neutral: any LLM, any agent, any framework.
- **State at handoff:** v0.9.12 (2026-10-17, Batch C4c-2: the form for the organisation's evidence in the dashboard; before it C4c-1 in 0.9.11 — audit file in the dashboard, audit package from the dashboard, auditor mode —, C4b in 0.9.10, C4a in 0.9.9, C3 in 0.9.8, C2.1 in 0.9.7), branch `main`. All tests pass (`npm test`). GitHub CI was green on Linux and macOS (Node 20 and 22) for 0.9.5.
- **Current phase (since 2026-10-14): feature freeze.** Work only on the batch plan in §11, one batch at a time, and start a batch only after Kev's go.
- **Now (since 2026-10-15): Batch C** (ISO/IEC 42001 audit file), started with Kev's go. Batch B is accepted. C1 accepted; C2 built (0.9.6) and corrected in C2.1 (0.9.7); C3 (0.9.8) accepted by Kev on 2026-10-16; C4 started with Kev's go and decisions (2026-10-16, §11): C4a (0.9.9) accepted by Kev on 2026-10-16; C4b built (0.9.10); C4c split with Kev on 2026-10-17: C4c-1 (0.9.11, tests green on Kev's Mac), C4c-2 built (0.9.12, the form for the organisation's evidence); then closing Batch C, then Batch E (new, before D).

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
   - In `src/server.ts` this is enforced by the `personOnly` prefix list (for example every `POST /api/forecast*`, `POST /api/audit-file/access`). New person actions must go under such a prefix.
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
  - `node --test test/{auditexport,auditfile,auditpackage,auditview,canon,control,engine,expert,forecast,handoff,help,integrity,iso42001,office}.test.mjs`
  - `node --test test/{integration,oracle,orgevidence,overlay,predict,project,projects,rules,safety,universal}.test.mjs`
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
| `hooks.ts` | Claude Code hooks (never block the agent). |
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
| `canon.ts`, `canon-llm.ts`, `gate.ts` | Fixed points, the archivist's proposals, canon gate per line. |
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

Open after C2.1 (LOW, documented):
- The audit file's own alarms (`verdict_forged`, `snapshot_missing`, `verdict_archive_invalid`) are not yet shown by the dashboard's project check.
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

### Batch C: audit file (ISO/IEC 42001) — IN PROGRESS (Kev's go 2026-10-15)
- **Steps (one commit each, an independent review each):**
  - **C1, catalogue (built 2026-10-15, three review rounds K1–K17, R1–R10; DONE — Kev accepted the mapping on 2026-10-16 for now; controls Scenaria does not carry yet are added later, once everything runs):** the 38 Annex A controls as a data module (`src/core/iso42001.ts`, no imports, shared with the UI): own short titles in DE/EN, the area, the evidence sources in Scenaria, the best coverage Scenaria can reach (evidenced / partly / organisational) and what the organisation must document. Kev checks the mapping (`docs/intern/batch-c/`) before C2.
  - **C2, evaluation (built 2026-10-16, 0.9.6; two review rounds K1–K12, N1–N4, all fixed with a regression test each in `test/auditfile.test.mjs`; waiting for Kev's acceptance):** compute each control's status from the project's real data, with a period filter, the integrity status and the list of approvals and reseals. Kev's decisions (2026-10-16): the whole project unless a period is chosen; a damaged tamper evidence warns clearly at the top and at every affected control but lowers no status; who may read the audit file is set only by the person (default: only the person). Built: `core/auditfile.ts`, `core/auditaccess.ts`, `GET /api/audit-file`, `GET|POST /api/audit-file/access`, `scenaria audit-file [access]`. No dashboard view yet (C4). Review decisions: reseals and the read setting are listed but carry no control (they approve no work); fields a signature does not cover are marked `unsigned`.
  - **C2.1, corrections (built 2026-10-16, 0.9.7):** third independent review of C2 (K1–K8) and a review of the fixes (R1–R11), all fixed with a test each. Kev's decisions (2026-10-16): K1 never crash, raise an alarm; K2 the principle holds (a verdict counts once), and replaced verdicts are archived per step for comparison; K3 the file states are checked automatically on every audit file, without an approval step.
  - **C3, organisational evidence (built 2026-10-16, 0.9.8; waiting for Kev's acceptance):** document reference, owner and date per control; person-only and signed; an edited file shows as unverified. Built: `core/orgevidence.ts`, `GET /api/audit-file/evidence`, `POST /api/audit-file/evidence[/remove|/confirm|/copy]`, `scenaria audit-file evidence [add|rm|confirm|copy]`, the field `orgEvidence` per control in the audit file; tests in `test/orgevidence.test.mjs`. No dashboard form yet (C4). Kev's decisions (2026-10-16): (1) stored in the project and committed, like `canon.json`; (2) it never raises the computed status — it is its own signed field next to it; (3) per project, with "take over from another project"; organisation-wide evidence comes with Batch D; (4) the document is referenced by URL **and** a hash; (5) the owner is recorded with role **and** name.
  - **C4, export and view:** signed export (PDF, Markdown, JSON) and a read-only view for auditors; the current "Prüfung" area (forecast audits) moves to the extensions. Kev's decisions (2026-10-16): the signed JSON is the evidence, Markdown and PDF are reading copies with its fingerprint; the PDF comes from a print-ready HTML page via the browser (no new dependency); an external auditor gets an audit package handed over, and a read-only auditor mode on site; a remote link waits for Batch D; exports name people by default, "roles only" on request. Steps: **C4a** signed file + `verify` + Markdown (built 0.9.9); **C4b** audit package with print-ready HTML/PDF (built 0.9.10; C4a accepted 2026-10-16); **C4c** dashboard view, form for the organisation's evidence, auditor mode, "Prüfung" area to the extensions — split with Kev on 2026-10-17 into **C4c-1** (built 0.9.11: read-only view, package from the dashboard, auditor mode; the forecast area already sat under "Extensions" since Batch B and is now called "Prognose-Prüfung" so it is not confused with the audit file) and **C4c-2** (the form for the organisation's evidence, with its own review).
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

### Batch E: progress, context window and the derivation of every number (Kev's decisions 2026-10-17; after C, before D)
- **Goal:** every number in Scenaria is retraceable and reproducible; a model supplies evidence at most, never a number. "How far am I" and "when does the agent need a new window" follow fixed, versioned rules.
- **Concept and assessment:** `docs/intern/fortschritt-kontextfenster.md` (Kev's concept, local only). It replaces the parked course corridor (`docs/intern/pruferkreis.md`); the reviewer circle stays parked.
- **Kev's decisions (2026-10-17):** E comes before D; the percentage scale is called **"Fortschritt" / "progress"** ("Luftlinie" stays what it is: how close a step stays to the main goal's topic); the derivation of every number comes with this batch.
- **Steps (proposal; each with its own review):**
  - **E1 derivation:** one format from the core (`value, formula, version, inputs, sentence DE/EN`) and one UI piece (hover **and** tap/focus — phones and keyboards have no hover; footnotes in exports); first for the audit file, the project check, context fidelity and the counts.
  - **E2 progress:** acceptance criteria (built on future canon events with checks), weights approved by the person, signed and frozen; levels from evidence (exists 0.25 → check ran 0.75 → independent verdict 1.0; a claim without evidence counts one level lower); gates as caps (10/20/40/60/80/90/100 %; 90 and 100 % only by an audit agent or the person, rule 11); `progress = min(criteria value, cap of the highest gate met)`.
  - **E3 context window rule:** fill where Scenaria sees tokens (Claude Code transcripts, the LLM proxy); `C_eff = min(C_max, A_model)` from a versioned table; zones 50 / soft (70 % − buffer, buffer from P95 step size + handover cost + margin) / 70 % / 85 %; automatic sealed checkpoints and a prepared handover. Scenaria warns and secures; it cannot force a new window (hooks never block), and it sees no fill for Claude Desktop.
  - **E4 progress per window and handover check:** a window = an agent session; warning / stop recommendation after Kev's table; the handover loss is measured deterministically through context fidelity of the first steps in the new window (a progress computed from evidence cannot drop by switching windows).
  - **E5 closing:** walkthrough with a real project, docs, Kev's acceptance.
- **Honest limits (to state in the product):** the calculation is deterministic, not every judgement ("complete" stays a claim unless evidenced); all thresholds are start values v1.0, versioned, changes logged; the scale measures states, not effort.
- **Open questions for Kev (before E2/E3):** who sets criteria and weights (proposal: the agent proposes, the person approves, like fixed points); start values as in the concept; a "stop" after two windows without progress only recommended, or enforced where a provider allows it.

### Batch F: agent modules (later, optional extension)
- **Goal:** forecasts and the other model-based helpers become an ordered, structured set of ready-made agents that need nothing but a model.
- **Scope:**
  - Each agent is a declarative definition in one catalogue: role, inputs from Scenaria, output schema, rules, evidence check.
  - Archivist, craftsman, oracle, Prüf-Experte and analyst move there.
  - Off by default; the core works without it.
  - The existing forecast code is reused, not rewritten.
