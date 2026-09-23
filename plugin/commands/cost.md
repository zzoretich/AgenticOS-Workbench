---
description: Cost completed sessions from their transcripts and patch runs.jsonl (only when the cost module is enabled)
allowed-tools: Bash, Read
argument-hint: "[session-uuid]  (default: every completed session that has no cost yet)"
---

Cost sessions. First read `cost.enabled` in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

- If it is `false` or absent: tell the user the cost module is off and how to turn it on — `aos cost enable` (needs python3 ≥ 3.9) — and stop.
- If a session UUID was given: Bash `aos auto-cost --cost-one <uuid>` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" auto-cost --cost-one <uuid>`). The script finds the session by its host — a Claude Code transcript under `<claudeConfigDir>/projects/*/<uuid>.jsonl` (priced by the analyzer) or a Codex rollout under `<codex home>/sessions/` (priced from its token count) — and patches `cost_usd` in `brain/_index/agent-runs/runs.jsonl`. Do not target the live session; it is not finalized yet.
- Otherwise: `aos auto-cost --backfill` costs every completed session that still has `cost_usd: null` and a transcript on disk.

Report the sessions costed and the headline USD. Costs are transcript-derived and exclude the platform baseline, so they are a slight, consistent underestimate (Codex figures are token-count estimates); `aos cost-budget` shows the anchored month-to-date figure and `aos cost-budget --anchor <usd>` recalibrates it to a billed number.
