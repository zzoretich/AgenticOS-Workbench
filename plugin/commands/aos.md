---
description: AgenticOS Workbench maintenance — doctor, status, provider, persona (runs the aos launcher)
allowed-tools: Bash
argument-hint: doctor | status | provider [auto|ollama|claude|codex|none] | persona [on|off|rename <name>]
---

Run `aos $ARGUMENTS` via Bash (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" $ARGUMENTS`); with no arguments run `aos doctor`.

- `doctor`: relay every line; for each `FAIL` line quote the fix its own detail names — every row carries the command for its host (missing config → `npm run setup` in the checkout; the Claude Code plugin missing → `claude plugin install agenticos@agenticos-workbench`; the Codex plugin missing → `aos upgrade`; MCP not answering → check `node` in `agenticos.json` and run `aos upgrade`).
- `status`: relay the provider line, every spend line against its cap — `today (hooks)` (background hook calls; the cap is `claude.perDayUsd`, or `codex.perDayUsd` when the resolved provider is codex), `today (duties)` (the persona's `duty:*` runs, `persona.perDayUsd`; they never count toward the hook cap), `today (reasoner)`, `today (routines)` and `today (graph)` — and any pipeline row whose status is `error`.
- `provider <mode>` / `persona …`: relay the confirmation line.
