# Security

Scenaria records what AI agents do and lets a person approve, check and go back. That only works if agents cannot quietly change the record or act as the person. This page says how to report a problem, what Scenaria protects, and what it does not.

## Reporting a problem

**Please do not open a public issue for a security problem.**

- Use **GitHub → Security → Report a vulnerability** on this repository (private), or
- write to **kevin.grundmann@ai-gambit.com** with "Scenaria security" in the subject.

Please include the version (shown in the dashboard's settings and by `GET /api/v1/health`), your operating system, what you did and what happened. A small script that shows the problem helps most.

What you can expect: an answer within 5 working days, an assessment within 14 days, and a fix or a documented limit for confirmed problems, with credit to you in the changelog if you wish. Scenaria is maintained by a small team; there is no bug bounty.

## Supported versions

Only the newest release gets security fixes. Before 1.0, please update to the newest 0.9.x.

## What Scenaria is built to protect

Assume an AI agent that can read and write the project folder, call Scenaria's tools (MCP, HTTP, command line) and run a shell **inside a sandbox or under its own account**. Such an agent must not be able to:

1. approve a rule, a fixed point or its own work, or give a verdict that counts as "verified";
2. reset or rewrite the tamper evidence without it showing;
3. spend the person's model quota, read the person's keys or use the person's settings;
4. make Scenaria run a program with the person's rights (a command from a project file, a git hook, a git driver, an application in the project folder);
5. reach the dashboard or the API from a web page the person happens to visit.

How this is done, in short:

- **Only a person approves.** Binding actions need the approval mode of the dashboard (a cookie set only by a single-use link that Scenaria hands directly to the browser) or a typed confirmation at an interactive terminal.
- **Signed records.** Approvals, verdicts, rules and the audit file are signed with an Ed25519 key in `~/.config/scenaria` (never in the project), bound to the project and to a revision. Anything changed outside Scenaria shows as unverified.
- **Keys are never stored.** API keys come from environment variables or the browser session and go only to the provider they belong to.
- **Local only by default.** The server listens on `127.0.0.1`, answers only to local host names (against DNS rebinding), refuses requests from other origins and requires a custom header on every write.
- **Nothing in the project folder runs with the person's rights.** Git is always called with hooks, `core.fsmonitor`, signing programs and the `ext::` transport switched off; the snapshot repository's config is reduced to what `git init` writes; the project's `verifyCommand` runs only when the person starts it at a terminal after seeing its text; opening a folder only shows it.

The rules developers must keep are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §2; the tests for them are in `test/` (for point 4: `test/execguard.test.mjs`).

## What Scenaria does not protect against

Please read this before you rely on Scenaria for confidential work. The full list is in [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md).

- **A program with your full user rights.** If an agent runs unsandboxed under your own account, it can read your signing key, start Scenaria as you, or drive your browser. Scenaria is tamper-evident, not tamper-proof. **Scenaria does not set up the sandbox for you**; `scenaria start` connects agents under the account it runs in.
- **A race on the snapshot repository's config.** `.scenaria/shadow.git` lives in the project folder. Scenaria cleans its config right before every git call, but a program that rewrites the file at exactly that moment could have a git filter driver run with the rights of the Scenaria process. Hooks, `core.fsmonitor` and the other programs named above are switched off regardless. Moving this file out of the project folder is planned.
- **Team mode is basic.** One shared token for agents, one for approvers, no user accounts, no roles and no TLS of its own. Run it only inside a trusted network and behind a reverse proxy with HTTPS.
- **Data at rest.** Recorded conversations, snapshots (which follow your `.gitignore`, so check that secrets are ignored there) and the tree are plain, unencrypted files in `.scenaria/`.
- **Downloads.** Release files come with `SHA256SUMS`, and the install scripts check them. This catches a damaged or swapped file; it does not help if the release itself was compromised. The binaries are not signed with an Apple or Microsoft developer certificate yet, so your system may warn.
- **Windows is experimental.** The test suite, including the security tests, does not pass there yet.
- **No external audit yet.** The code was reviewed part by part by independent AI reviewer agents and is covered by tests, but no external security firm has audited it.
- **No certificate.** The ISO/IEC 42001 audit file orders evidence by the standard's controls. The mapping is the project's own work and was not reviewed by an accredited body.

## Using Scenaria safely

- Run agents in a sandbox, a container or under their own user account, without access to `~/.config/scenaria`.
- Keep `.scenaria/` out of shared and public repositories (the default `.gitignore` entries do this) and use disk encryption.
- For audits that must hold against the person's own machine, keep the audit agent's key on another machine or in CI.
- Update when a release notes a security fix ([CHANGELOG.md](CHANGELOG.md)).
