# AgenticOS Workbench

A second brain for Claude Code: persistent memory, recall, session capture, and an Obsidian HUD that renders it all. Works with Claude Code alone; uses a local Ollama stack when one is present.

Status: foundation phase. Install instructions land with the installer (Plan 3).

## Development

- `npm test` runs every suite.
- `npm run gate` runs the privacy gate (fails on any forbidden term).
- `npm run export -- --source <vault> --diff` previews an export from a vault.
- Node 20 or newer. `npm ci --ignore-scripts` is enough for tests; `npm install` additionally builds the terminal's native module for the Obsidian plugin.
- `brain/scripts/test/live/` needs a running Ollama and is excluded from `npm test`.
- Layout: `brain/scripts` (runtime), `obsidian-plugin` (HUD), `tools` (export + privacy gate). The Claude Code plugin shim, installer, and vault template arrive in the next phases.
