# Known limits

What Scenaria does not do, does not detect or does not protect against — written down on purpose, so nobody has to find out the hard way. Security-relevant limits are also summarised in [SECURITY.md](../SECURITY.md). Each list comes from an independent review of that part; everything rated high or medium in those reviews was fixed with a test unless it is listed here.

## The basics

- **Tamper-evident, not tamper-proof.** A program running with the person's full user rights can read the person's signing key, fake a terminal or drive the person's browser. Scenaria cannot protect against that.
- **Agents belong in a sandbox.** Scenaria's guarantees ("only a person approves", signed records) assume that the agent, and every process it starts, has no access to the Scenaria config folder (`~/.config/scenaria`) and does not start Scenaria under the person's account. Scenaria does not set up that sandbox; `scenaria start` wires agents under the account it runs in.
- **The saved file states live in the project folder** (`.scenaria/shadow.git/objects`), so they move with it and an agent in a sandbox and the person's dashboard both reach them. An agent can delete or damage them there; Scenaria reports such a state as missing (`snapshot_missing`) and cannot restore it. The repository's settings (config, exclude list, refs) are outside the project since 0.9.25, see the section below.
- **Not audited by a third party.** The reviews named here were done by independent AI reviewer agents, not by an external security firm.
- **The ISO/IEC 42001 mapping is the project's own.** It was not reviewed by an accredited certification body and is no certificate. Scenaria evidences how AI agents worked in a project; it does not evidence how models are developed or trained, nor an organisation's policies.
- **Team mode is simple:** one shared token for agents and one for approvers, no user accounts or roles, no TLS of its own (put it behind a reverse proxy with HTTPS).
- **Data at rest is not encrypted.** Recorded conversations, snapshots and the tree are plain files in `.scenaria/` inside the project. Use disk encryption and keep `.scenaria/` out of shared or public repositories (the default `.gitignore` does).
- **Chat, forecasts, the forecast audit and “Ask the oracle” are experimental.** They ask a language model the person sets up, and how good the answers are depends on that model; they were checked with a stand-in model for the mechanics only, not yet systematically with real models. The dashboard shows them only once a model is set up. Saving, looking, going back, approving, rules and the audit file need no model.
- **Windows is experimental.** Scenaria builds there, but in CI (November 2026) 12 of the automated tests failed on Windows and the run did not finish within 25 minutes (audit package paths, setup of agent configs, a few dashboard checks). macOS and Linux are the tested systems.

## Snapshot repository: control files outside the project (0.9.25)

- If Scenaria cannot use its own folder (`~/.config/scenaria/shadow`: missing rights, a file in its place, a read-only home), **nothing is saved** until the person fixed it. The dashboard, `scenaria status`, `scenaria start` and the agents' status say so and name what to check on that system. Scenaria does not fall back to control files in the project.
- The refs (`refs/scenaria/*`) are kept per machine and account. They are written anew from the steps when needed (the mirror does it); a tool that reads `.scenaria/shadow.git` directly sees only the refs from before 0.9.25.
- Do not run `git gc` or `git prune` by hand inside `.scenaria/shadow.git`: seen from there, states saved since 0.9.25 have no ref and would be removed. Scenaria itself never runs them.
- An older Scenaria version working on the same project still reads and writes (it uses the old control files in the project), but without this protection. Update every installation, also the one an agent uses.
- File-system facts (upper/lower case, execute bit, symlinks) are taken as four yes/no values from `.scenaria/shadow.git/config`, read by Scenaria, not by git. An agent that changes them can make a save record wrong file modes or names; it cannot make git run anything.
- Checked on Linux with git 2.43. macOS and Windows run the same tests in CI; a project path with a line break in its name cannot be mirrored.

## Integrity and verdicts (0.9.2)

- The anchor is per machine. A project used from two computers, or from a devcontainer with another home, reports "extended" writes (medium, with the steps named). External anchoring (git remote / signed export) is on the roadmap.
- After an update, restart agents and MCP servers. An older Scenaria version that keeps running writes without raising the mark ("extended").
- On macOS, check that `realpath` gives the same folder spelling for every process; a different upper/lower case would mean a different anchor.
- A process with the person's full user rights can still read the approver key or fake a terminal (keychain / hardware keys are on the roadmap).

## Audit file: evaluation (0.9.6)

- The audit file's read setting is written like the other files in the config folder: two processes at the same moment are not locked against each other.
- A machine that first opens a project after an audit agent's reseal record was edited adopts the edited time (first-use trust, like every anchor).
- Old projects without `meta.goalSince` take the main goal's time from the root and the event log (not in the hash chain).
- `buildAuditFile` runs `integrity()`, the canon and gate checks more than once (about 0.5 s for 1,500 steps); computing them once is a later optimisation.

## Audit file: corrections (0.9.7)

- A person's reseal accepts the step files as they are, including a hand-edited verdict history (only the person can reseal; the review accepted this).

## The organisation's evidence (0.9.8)

- Ids of the organisation's evidence are tracked per machine: two teammates adding entries offline can both create the same id; after a merge both copies show as changed, and only discarding (content and history in the file are lost) or restoring one side from git resolves it.
- The marks of the organisation's evidence (like the rules' and canon's) are raised outside the store lock when a teammate's newer revision is seen; two processes at the same moment can lose a mark.
- An unreadable `org-evidence.json` raises one alarm on all 38 controls.

## Audit file in the dashboard, auditor mode (0.9.11)

- The auditor mode protects against mistakes, not against intent: on the person's computer someone can open another browser, a private window or a terminal. The person stays nearby.
- While a browser in auditor mode checks in (its dashboard does every 2 minutes), nobody can open an approval link — also the person's other browser cannot unlock. The person ends the auditor mode in the auditor's browser first; a closed auditor window stops blocking after 10 minutes (or after a restart).
- Server error texts are English; the dashboard shows its own text only for the auditor-mode codes.
- In auditor mode the dashboard hides write actions in the step panel, the simple view, the goal bar, the chat, the canon dialog, "Extensions" and the settings; any other button the server refuses (403 `auditor_mode`).
- The package from the dashboard is local mode only (team mode: `scenaria audit-file export` on the project's machine).

## The organisation's evidence in the dashboard (0.9.12)

- "Taken over from" records the other project's own name (its settings), which can differ from the name in the project list; the plan shows the recorded name before anything is signed.
- The browser reads a chosen file at once to compute its SHA-256 (at most 512 MB); without a secure context (team mode over plain http) the hash is pasted.
- An entry recorded with the 0.9.12 CLI whose title or note was cut right after a space shows as changed (only very long texts; fixed for new entries).

## Audit file: closing review (0.9.13)

- The auditor can end the auditor mode in the band and then click the lock; the approval link opens in the default browser, often the auditor's own. The auditor mode protects against mistakes, not intent; a lockout would also lock out the person. The person ends the mode themselves.
- Who may read the audit file is shown in the dashboard; changing it stays in the terminal (`scenaria audit-file access`).
- A teammate's clone has no shadow repository: every step there shows `snapshot_missing` (project check and audit file); the text names a copy or clone as a possible cause.
- A package whose note was removed and replaced by one in the other language: the missing note is said, the other one is listed as "not checked"; the package does not fail for it.
- Two processes replacing a damaged `auditview.key` at the same moment both end up using the key on disk (suspected, not reproduced).

## Derivation of every number (0.9.14)

- Not every number has a derivation yet: decision quality in the project check, the status bar's counts and the forecast numbers (they have their own "Why this number?") follow; the help says so.
- A count's sentence names the first 12 items; the inputs (dashboard) and the footnotes (exports) list all.
- Escape closes every stacked dialog at once (older than E1); a derivation open inside keeps its own Escape only while the focus is in it.
- A word of 120 characters without a space in agent text gives the Audit view a horizontal scroll at 1280 px (older than E1).

## Progress (0.9.15)

- An agent can propose criteria for any task and so keep that task's gate 20 closed (it can only lower progress).
- The verdict dialog does not show which criteria a step reports (`fulfills`).
- A criterion without a file never goes stale; a check made after the task checks the file as it was then.
- Staleness from the approval time compares clock times of one machine (step order everywhere else).
- Anchors written before 0.9.15 have no task (development machines only); a criterion signed by a key this machine does not trust has no anchor, so deleting it opens gate 20 again.
- Re-approving a criterion changed outside Scenaria shows its current values, not the earlier signed ones.
- After approving, the focus returns to the page (the row moves to the other list).
- Texts address the person ("du") also in the auditor mode.
- `POST /api/node/update` lets agents set a task's status; abandoned tasks therefore still count in the project value.

## Context window: measuring (0.9.17)

- MEDIUM: two Scenaria installations with different config folders on one project (a container next to the host), or an anchor that cannot be written, see each other's appends as foreign: every append starts the measurement again and one side warns.
- Parallel Claude Code sessions share the agent name "claude-code", so their checkpoints cut each other's steps (P95 smaller, soft threshold later); a crash between appending and raising the anchor gives a false warning and a restart; a local proxy client can join another conversation with `x-scenaria-session` (local clients are trusted, as for the conversation record).
- In a Claude Code project, after a restart the new windows count only once the next end-of-turn checkpoint (one with file changes) names the reset.
- The soft threshold of an ended window is computed with today's step sizes and capsule size (the fill and the lines 50 / 70 / 85 % are fixed).
- Two proxy conversations that start with the same system and first message share a window unless the client sends `x-scenaria-session`.
- Not detected: a changed Claude Code transcript (outside the project). Window data from another machine is never confirmed here (the measurement starts again).
- Local models (Ollama) get no number until the person enters their window size (since E3b: `scenaria window settings model <id> <tokens>` or the dashboard); the margin of 2 % of C_eff is a start value.
- The fill was verified on a real Claude Code transcript from Linux; one from macOS is still to be checked.

## Context window: acting on it (0.9.18)

- MEDIUM: a process with the agent's rights can call `scenaria hook post-tool` with a session id and a transcript of its own. That conversation gets its own window and, from red, a cut that Scenaria writes (with the conversation's key in `meta.contextCut.key`); a real session's window cannot be fed this way (a session reads only the transcript it named first). The sandbox precondition of rule 6 limits this; Scenaria cannot tell a real transcript from a written one.
- Projects set up before 0.9.18 keep the old after-tool matcher until `scenaria start` (or `scenaria init`) runs in them again; a global setup until `scenaria setup --global` runs again. The dashboard does not yet report an outdated matcher.
- Parallel Claude Code sessions share the agent name: the handover and the session-start line take the newest window of `claude-code` (the handover lists the other windows that are yellow or fuller); a rewind in one session takes the other session's cut off the line, so a new cut becomes due there.
- The proxy computes the checked measurement before it sends the answer's headers (from yellow on), which delays the first byte by the time of that check; above yellow each hook call costs about 50 ms more (300 steps).
- The after-tool hook skips its work when the project lock stays busy for 1.5 s; the next tool or the end of the turn acts then. Opening a project now waits at most 1 s for the lock to refresh the ledger anchor (it is refreshed on the next open).
- A Stop cut with file changes stays the agent's own turn checkpoint (agent `claude-code`, marked by `meta.contextCut` and the tag); only a quiet cut is written as `scenaria`.

## Context window: the person's values (0.9.19–0.9.20)

- Hand-entered window sizes are for local models only: a name built on a documented model (also `gpt-5-mini`, `claude-opus-5.5`) is refused — such a provider model needs a row in the documented table. A name without a separator (`gpt5`) is not recognised as an alias.
- The bounds (yellow 10–90 %, red 20–95 %, emergency 30–99 %, P95 start 0–30 %, margin 0–20 %, A_model 8,000–10,000,000) are start values, not yet tuned on real projects; looser values than the start values are named everywhere.
- Someone with write access to the config folder can still roll the setting back (delete the mark and the newest revisions) — the same limit as for every file there (rule 6's sandbox precondition).
- The dashboard refreshes the context window every 30 s (the dialog every 15 s); between two refreshes a number can be up to that old (its time is shown). The UI checks of E3b-2 are mostly static source checks plus the walkthrough; the dialog stack and the refresh have no browser test in the suite.
- The audit file (Batch C) does not yet include the windows, the cuts or the rule's history.

## Progress per window and the stop (0.9.21)

- **MEDIUM, kept on purpose (nothing that was is erased, so it can be compared):** an agent that rewinds on its own (as Scenaria advises at a dead end) and redoes the work gets no credit for the redo up to the old best level, so two such windows stop it (the defence against do-rewind-redo loops). Only the person's lift starts the bar again; a rewind with a lesson does not.
- **MEDIUM, documented:** two Claude Code sessions at once in one project can be read as a window change; a resulting stop is marked "most likely two sessions at once" and the person lifts it.
- **MEDIUM, mitigated:** a rewind (allowed during a stop) can restore an older `.claude/settings.json` with a weaker hook; the session start then warns that the stop is not enforced (Scenaria does not rewrite the person's settings).
- The stop blocks the whole project (Scenaria has one HEAD per project, so the stopped task is every session's work). Progress is the project's: a window is credited with what others did meanwhile. Through the proxy progress per window is measured within one conversation only, and the stop is a header.
- The stop holds up an agent that is stuck, not one that changes Scenaria's configuration folder or hooks outside its tools (the same limit as every file there).
- The escalation's fill is shown without its own "How computed?" (the window's fill above it has one); Escape closes the whole dialog, not only the lift confirmation.

## Open tasks across sessions (0.9.22)

- A task with criteria the person never accepts stays the work for every later session; the way out is the person's close in the dashboard (unlocked) — the stop texts say so. A task's node deleted by hand ends its hold (the tree's integrity check shows the damage).
- Through the proxy every tool call counts as a work step (the tool names are the client's own).
- A task without criteria left for a new one is still marked done automatically (old behaviour).
