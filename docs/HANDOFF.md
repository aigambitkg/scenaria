# Handoff: developing Scenaria further

This is the working protocol for the next agent or developer who continues Scenaria. Read it first, then `docs/ARCHITECTURE.md` (how it works) and `docs/ROADMAP.md` (what is done, what is next).

- **Product owner:** Kev (Kevin Grundmann, AI-Gambit). He reads and writes German, so give your summaries to him in German. He is not a developer by trade, so explain results in plain words.
- **License:** MIT. Vendor-neutral: any LLM, any agent, any framework.
- **State at handoff:** v0.9.2 (2026-10-14, Batch A), branch `main`. 213/213 tests pass.
- **Current phase (since 2026-10-14): feature freeze.** Work only on the batch plan in §11, one batch at a time, and start a batch only after Kev's go.

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
5. **Only a person approves.** "Der Archivar kann diese vorschlagen mit Freigabe durch User": agents may *propose* canon, rules and decisions, but only a person approves.
6. **Person-only actions need a person.**
   - Anything that spends the person's model quota or acts for them needs the **approval session** in the dashboard (cookie from the approval link printed by `scenaria start`), or an **interactive TTY** in the CLI. This covers check commands, approvals, the chat, the relay, the multiverse, the AI check, backtests, settings and project switching.
   - In `src/server.ts` this is enforced by the `personOnly` prefix list (for example every `POST /api/forecast*`). New person actions must go under such a prefix.
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
node dist/cli.js start # dashboard + approval link (in a project folder)
```

- **Node:** ≥ 20. Kev's Mac has Node 24.
- **On Kev's Mac:** run the tests in two halves, because each tool call there is limited to 180 s.
  - `node --test test/{canon,control,engine,expert,forecast,handoff,help,integrity}.test.mjs`
  - `node --test test/{integration,oracle,overlay,predict,project,projects,safety,universal}.test.mjs`
- Tests use a temporary `SCENARIA_HOME` (`test/helpers.mjs`), so they never touch the real `~/.config/scenaria`.
- **Known flaky test:** `watch fingerprint writes no git objects while idle`. It is timing-sensitive, failed once on the Mac and passed on rerun.
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
| `setup.ts` | Agent wiring: `init --for …`, `CLAUDE.md` / `AGENTS.md` rule blocks. |
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
| `llm-errors.ts` | Error codes for model calls. Shared with the UI, so it must have **no imports**. |
| `settings.ts`, `global.ts`, `projects.ts` | The person's settings (roles: chat, analysis, analyst, archivist, craftsman, oracle, auditor) and the project registry. |

### Dashboard (`ui/src/`, React + Vite)

| File | Role |
|---|---|
| `App.tsx` | Top bar, dialogs, help actions. |
| `api.ts` | Every request. The `x-scenaria-view: dashboard` header makes requests follow a project switch; downloads must use fetch with it, never plain links. |
| `i18n.ts` | **All texts, DE and EN.** Every key must exist in both; `de` is typed as `typeof en`. |
| `helpContent.ts` | The help topics (DE/EN). `test/help.test.mjs` checks the topics, terms and actions. |
| `Forecasts.tsx` | The forecasts dialog (tabs Start / Entscheidungen / Prompt prüfen / Nachprüfen / Verlauf / Güte), the derivation and the AuditBox. |
| `ForecastStart.tsx` | Ready check, three start cards, new-decision form, run progress with stop, ErrorBox, ResultCard, PastCheck. |
| `AuditArea.tsx` | The auditor's area (top bar "Prüfung"). |
| `Control.tsx` | Settings, chat, relay. |
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
3. Walk the flows: Start tab → ready check; write down a decision → "Speichern und vorhersagen" → progress → result card; Nachprüfen; Prompt prüfen; Güte; the "Prüfung" area with filter, details and download; a view-only browser without the cookie; EN; 390 px width.
4. Check that there is no `pageerror`, no console error and no HTTP ≥ 400 that you did not expect.

A good next task is a committed e2e suite (`test/e2e/`, opt-in) built from this.

## 8. Working on Kev's machine

- Paths, test project, model and current state: `CLAUDE.local.md` (local only).
- **Git in a sandboxed folder:** if deleting files is not allowed there, git leaves `*.lock` and `tmp_obj_*` files behind.
  - Move stale locks aside, e.g. `mv .git/index.lock .git/stale-index-lock-<time>`; never under `.git/refs`.
  - Kev can delete the `stale-*` files himself. Prefer giving Kev the git commands to run in his own terminal.
- **After an update:**
  1. `npm run build`, if `dist/` was not shipped.
  2. Restart `scenaria start`.
  3. Hard-reload the browser (Cmd+Shift+R).
  4. Open the approval link again.

## 9. Open points and good next steps

From the latest reviews (all optional and low):
- `e2e`: a chat-regression step clicks the last map node, which can be outside the viewport. Use `scrollIntoViewIfNeeded` or click HEAD.
- This repository's own Scenaria tree is empty (old schema 2). If Kev wants the development itself recorded, start a mission there (`scenaria_start_mission`), with Kev's approval.

Open after Batch A (from the reviews, documented limits):
- The anchor is per machine. A project used from two computers, or from a devcontainer with another home, reports "extended" writes (medium, with the steps named). External anchoring (git remote / signed export) is on the roadmap.
- After an update, restart agents and MCP servers. An older Scenaria version that keeps running writes without raising the mark ("extended").
- On macOS, check that `realpath` gives the same folder spelling for every process; a different upper/lower case would mean a different anchor.
- A process with the person's full user rights can still read the approver key or fake a terminal (keychain / hardware keys are on the roadmap).

Product ideas already discussed or noted (see `docs/ROADMAP.md`; the batch plan in §11 has priority):
- **Test with Kev's real local model.** It has only been tested with simulated models so far. Watch for JSON robustness, duration and the readability of the error messages.
- **Commit an e2e suite** (§7).
- **Optional embedding-based fidelity** for projects in several languages. The word-based core does not see synonyms or another language; today only the oracle compensates.
- **Export the audit report as PDF** (ISO/IEC 42001-friendly). Markdown/JSON exist now.
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
`0 → A → B → C → D`, then `E` and `F` only after Kev's go. Each batch follows §6: main goal first, small steps, one commit each, an independent review, a regression test per finding.

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

### Batch B: easy to understand and use (office users)
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
  - A non-technical test person completes "go back to yesterday's state" without help.

### Batch C: audit file (ISO/IEC 42001)
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
- **Done:** works with several local projects; every number is reproducible from the data; tests.

### Batch E: course corridor and drift guard (parked)
- Plan: `docs/intern/pruferkreis.md`, stage 1 only. It merges with the canon as "Goal & rules". It starts only after A–D and Kev's go.

### Batch F: agent modules (later, optional extension)
- **Goal:** forecasts and the other model-based helpers become an ordered, structured set of ready-made agents that need nothing but a model.
- **Scope:**
  - Each agent is a declarative definition in one catalogue: role, inputs from Scenaria, output schema, rules, evidence check.
  - Archivist, craftsman, oracle, Prüf-Experte and analyst move there.
  - Off by default; the core works without it.
  - The existing forecast code is reused, not rewritten.
