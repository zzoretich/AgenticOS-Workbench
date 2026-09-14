---
description: Show current brain state — BRAIN.md, SESSION.md, and the most recent daily notes
allowed-tools: Read, Glob, Bash
---

Display the current brain state. Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

1. Read and show `<vault>/brain/_index/BRAIN.md`.
2. Read and show `<vault>/brain/_index/SESSION.md`.
3. List the 5 most recent daily notes: glob the folders described by `dailyNote.layout` in `<vault>/brain/config.json` (default `<vault>/<year>/**/<date>.md`), sorted by date descending, with each note's first `## ` heading line when present.
4. Format as one digest the user can scan in under 20 seconds. No preamble.
