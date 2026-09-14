---
name: cost
description: Session and month-to-date cost from transcripts — cost completed sessions, read the anchored budget, explain where the money went. Only active when the cost module is enabled (cost.enabled in agenticos.json after `aos cost enable`); otherwise explain how to enable it. Use when the user asks "how much did this cost", "cost the last session", "what's my spend this month", "/cost", or "backfill costs".
---

# Cost

The cost module is opt-in. **First** read `cost.enabled` in
`${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

- **Disabled or absent** → answer: the cost module is off; enabling it needs python3 ≥ 3.9 and one command, `aos cost enable [--budget <usd>]` (it copies the transcript analyzer into `<vault>/brain/scripts/cost/`, flips the flag, and records the monthly budget in `brain/config.json`). Then stop. Do not estimate costs by hand.
- **Enabled** → continue.

## What exists

- `auto-cost` runs at every session end: it finds the session's transcript under `<claudeConfigDir>/projects/*/<session>.jsonl`, runs the analyzer, and patches `cost_usd` (with `cost_source`) into `brain/_index/agent-runs/runs.jsonl`. The pipeline ledger (`brain/_index/pipelines.json`, `auto-cost`) shows `ok`, `skipped` (no transcript), or `error` (analyzer failed).
- `aos auto-cost --backfill` costs every completed session that still has `cost_usd: null`; `aos auto-cost --cost-one <session-uuid>` costs one.
- `aos cost-budget` prints the anchored month-to-date: a real billed figure anchored at a point in time plus calibrated transcript costs for sessions that ended since. `aos cost-budget --anchor <usd>` re-anchors to a fresh billed number; `--budget <usd>` changes the monthly budget.
- Headless provider spend (the `claude` provider's own calls) is separate: `aos status` shows today's hook spend against `claude.perDayUsd` and the persona's duty spend (`duty:*` ledger rows) against `persona.perDayUsd`, one line each.

## Answering

1. For "what did session X cost": Bash `aos auto-cost --cost-one <uuid>` (fallback `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" …`), then read that run's row in `runs.jsonl` and report `cost_usd`.
2. For "how much this month": `aos cost-budget`; report month-to-date, the budget, and the anchor date.
3. For "where did it go": the analyzer's per-turn breakdown is in its `--out` JSON (path printed by `auto-cost`); the largest entries are usually large tool results and big file writes, not named skills — say so rather than blaming a skill bucket.
4. Transcript-derived costs exclude the platform's hidden baseline: a slight, consistent underestimate. Say so once when reporting a total.
