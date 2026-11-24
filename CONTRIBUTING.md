# Contributing to Scenaria

Thank you for wanting to help. Scenaria is in public preview; the core is stable, and new features come in small, reviewed steps.

## Before you start

- **A bug or an idea:** open an issue first, so nobody does work that does not fit. For a bug, say the version, the operating system, what you did, what you expected and what happened.
- **A security problem:** never in a public issue. See [SECURITY.md](SECURITY.md).
- **A new feature:** please ask in an issue before writing code. The order of work is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Set up

```bash
git clone https://github.com/aigambitkg/scenaria && cd scenaria
npm install            # needs Node.js 20 or newer and git
npm run build          # core → dist/, dashboard → dist/ui
npm test               # all tests, about 5 minutes
npm run typecheck:ui   # strict type check of the dashboard
```

Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) first: it has the security rules that must never be broken, the module map and how work is organised.

## What a change needs

1. **One purpose per pull request**, with a short description of what changes for the person using Scenaria.
2. **A test for every behaviour you add or fix**, especially for the security rules (an agent's call is refused, an edited file shows as unverified, nothing from the project folder is run).
3. **Build, `npm test` and `npm run typecheck:ui` are green.**
4. **Both languages:** every text of the dashboard and the help exists in German and English, in plain words.
5. **Honest numbers:** a number shown to people gets a versioned formula and a derivation (`src/core/derivation.ts`), never a bare value.
6. **Docs:** update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) when behaviour changes, [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) when a limit appears or goes, and add a line to [CHANGELOG.md](CHANGELOG.md).
7. **Nothing confidential:** no keys, no `.env` files, no absolute paths of your machine, no `.scenaria/` data. Run `git status` before you commit.

Changes that touch approvals, signatures, the server's access checks, git calls or anything that starts a program are reviewed with extra care and may take longer.

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) of this project.
