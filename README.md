# Scenaria

**Quicksave for AI agents — any LLM, any framework.** Scenaria records every decision point of an agent run: the question, the options, the choice, the files and a short summary of the facts. When an agent takes a wrong turn, you go back to exactly that point, or try the option it did not take.

![Scenaria scenario map](docs/screenshot.png)

[Deutsche Version](README.de.md) · [Full guide](docs/GUIDE.md) · [Changelog](CHANGELOG.md)

> **Status: public preview (0.9.x).** Scenaria is usable and well tested (more than 560 automated tests, run on Linux and macOS), but it has not been audited by an external security firm. Read [Known limits](docs/KNOWN-LIMITS.md) and [SECURITY.md](SECURITY.md) before you use it with confidential company data.

## What it does

- **Go back to a decision, not to a time.** Each decision point holds the question, all options, the chosen one and the reason. Going back restores the files *and* gives the agent a short summary of only the path that led there, so a mistake does not leak into the next attempt.
- **Nothing gets lost.** Unsaved work is saved before every step back, so a step back can be undone too.
- **One tree for every model.** Claude, GPT, Gemini, Mistral, local models via Ollama: they share one decision tree and one record of who did what.
- **Only you can say "verified".** An agent's own "passed" is shown as self-reported and never counts. Your approvals and verdicts are signed with a key that stays outside the project.
- **A dashboard in plain words.** Three views on the same data: *Simple* for everyday use, *Audit* for checking, *Manage* for settings and analysis. German and English.
- **Evidence for audits.** An audit file ordered by the Annex A controls of ISO/IEC 42001, signed and exportable. The mapping is the project's own work, not a certificate.
- **Local first, no telemetry.** Everything lives in `.scenaria/` inside your project. Nothing leaves your machine unless you run a team server.

## Install

Scenaria needs `git` (on macOS: `xcode-select --install`).

```bash
# macOS / Linux: one file, no Node.js needed
curl -fsSL https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.sh | sh

# Windows (PowerShell) — experimental: 12 of the automated tests still fail on Windows
irm https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.ps1 | iex

# or with Node.js 20 or newer
npm install -g scenaria
```

The install scripts download the file for your system from the [releases page](https://github.com/aigambitkg/scenaria/releases) and check it against the published `SHA256SUMS` before installing. To check a download yourself:

```bash
sha256sum -c SHA256SUMS --ignore-missing      # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
```

From source:

```bash
git clone https://github.com/aigambitkg/scenaria && cd scenaria
npm install && npm run build && npm link
```

## Use it

```bash
cd ~/Projects/my-app
scenaria start
```

`start` sets up the project, connects the agents it finds (Claude Code, Cursor, VS Code/Copilot, Gemini CLI, Codex, Windsurf), takes a first snapshot, opens the dashboard and saves automatically from then on.

- No terminal wanted? `scenaria launcher` puts a start icon on your desktop.
- Claude Desktop: `scenaria init --for claude-desktop`, then restart the app.
- Any other agent or chat: click **Agent prompt** in the dashboard (or run `scenaria prompt`) and paste the text.
- Agents reach Scenaria through MCP, HTTP, the command line or function calling; all use the same tools.

Everything else — fixed points, forecasts, the audit file, progress, the context window, the team server, every command — is in the [full guide](docs/GUIDE.md).

## Security in short

- The dashboard answers only on your own machine (`127.0.0.1`) unless you start a team server with a token.
- Agents can only *propose* rules, fixed points and verdicts. Making them binding needs you: the approval mode in the dashboard (the lock 🔒) or a typed confirmation at a terminal.
- Your signing key lives in `~/.config/scenaria`, never in the project. API keys are never stored.
- Nothing in the project folder is run with your rights: no git hooks, no command from a project file unless you start it yourself.
- **Run agents in a sandbox** (or under their own account) without access to `~/.config/scenaria`. Scenaria is tamper-evident, not tamper-proof: a program with your full user rights can read your key.

Found a security problem? Please report it privately: [SECURITY.md](SECURITY.md).

## Limits

- Going back restores **files**. It cannot undo sent e-mails, pushes, deploys or database writes; these are marked, and Scenaria warns you first.
- Recorded conversations and snapshots are plain files in `.scenaria/`. Use disk encryption for confidential work.
- The team server has one shared token and no user accounts; put it behind HTTPS.
- More, in detail: [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md).

## Documentation

| | |
|---|---|
| [docs/GUIDE.md](docs/GUIDE.md) | The full guide: every feature and command |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works inside |
| [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) | What it does not do or protect against |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is done, what is next |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) | Changing Scenaria and taking part |
| [examples/](examples/README.md) | Using Scenaria from your own agent |

## License

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
