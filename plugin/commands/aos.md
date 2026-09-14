---
description: AgenticOS Workbench maintenance — doctor, status, provider, persona (runs the aos launcher)
allowed-tools: Bash
argument-hint: doctor | status | provider [auto|ollama|claude|none] | persona [on|off|rename <name>]
---

Run `aos $ARGUMENTS` via Bash (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" $ARGUMENTS`); with no arguments run `aos doctor`.

- `doctor`: relay every line; for each `FAIL` line quote the fix from its detail (missing config → `npm run setup` in the checkout; plugin missing → `claude plugin install agenticos@agenticos-workbench`; MCP not answering → check `node` in `agenticos.json` and run `aos upgrade`).
- `status`: relay the provider line, both spend lines — `today (hooks)` against `claude.perDayUsd` (background hook calls) and `today (duties)` against `persona.perDayUsd` (the persona's `duty:*` runs; they never count toward the hook cap) — and any pipeline row whose status is `error`.
- `provider <mode>` / `persona …`: relay the confirmation line.
