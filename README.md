# AgenticOS Workbench

A second brain for Claude Code: persistent memory, recall, session capture, and an Obsidian HUD that renders it all. Works with Claude Code alone; uses a local Ollama stack when one is present.

Install: `git clone … && npm ci --ignore-scripts && npm run setup` — see [docs/install.md](docs/install.md). After install, `aos doctor` checks everything and `/wrap` in Claude Code writes your first memories.

## Development

- `npm test` runs every suite.
- `npm run gate` runs the privacy gate (fails on any forbidden term).
- `npm run export -- --source <vault> --diff` previews an export from a vault.
- Node 20 or newer. `npm ci --ignore-scripts` is enough for tests; `npm install` additionally builds the terminal's native module for the Obsidian plugin.
- `brain/scripts/test/live/` needs a running Ollama and is excluded from `npm test`.
- Layout: `brain/scripts` (runtime), `obsidian-plugin` (HUD), `tools` (export + privacy gate). The Claude Code plugin shim, installer, and vault template arrive in the next phases.
- `npm test` also runs `cli/` (launcher, installer, manifests, template). `sh cli/rehearsal/first-run.sh` rehearses a complete install in a temp HOME (what CI's `first-run` job runs).
- Layout additions: `plugin/` (Claude Code plugin: manifests, `bin/aos`, commands, skills), `cli/` (installer), `vault-template/` (seed vault).
