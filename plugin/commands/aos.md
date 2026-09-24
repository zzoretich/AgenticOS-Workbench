---
description: AgenticOS Workbench maintenance — doctor, status, provider, persona, config (runs the aos launcher)
allowed-tools: Bash
argument-hint: doctor | status | provider [auto|ollama|claude|codex|none] | persona [on|off|rename <name>] | config [list | get <key> | set <key> <value> | unset <key>]
---

Run `aos $ARGUMENTS` via Bash (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" $ARGUMENTS`); with no arguments run `aos doctor`.

- `doctor`: relay every line; for each `FAIL` line quote the fix its own detail names — every row carries the command for its host (missing config → `npm run setup` in the checkout; the Claude Code plugin missing → `claude plugin install agenticos@agenticos-workbench`; the Codex plugin missing → `aos upgrade`; MCP not answering → check `node` in `agenticos.json` and run `aos upgrade`).
- `status`: relay the provider line, every spend line against its cap — `today (hooks)` (background hook calls; the cap is `claude.perDayUsd`, or `codex.perDayUsd` when the resolved provider is codex), `today (duties)` (the persona's `duty:*` runs, `persona.perDayUsd`; they never count toward the hook cap), `today (reasoner)`, `today (routines)` and `today (graph)` — and any pipeline row whose status is `error`.
- `provider <mode>` / `persona …`: relay the confirmation line.
- `config` / `config list`: every setting by section, with its value, the file it comes from, and `*` where it differs from the default. Relay the sections the user asked about (all of them when they asked for none), plus any `note:` line. `config get <key>` prints the value alone.
- `config set <key> <value>` / `config unset <key>`: run these only for a change the user asked for in this conversation; add `--dry-run` first when they asked what a change would do. Relay the `<key>: <old> → <new>` line, every indented effect line, and every `next:` line as a step still to take. When it refuses (a read-only key names the installer command that changes it; a headless run; a config file that does not parse), relay the reason and stop: never edit `agenticos.json` or `brain/config.json` by hand to get around it. An unknown key or a bad value exits 2 with the fix in its message.
