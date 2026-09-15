# Cost module (opt-in)

Forensic, per-skill token cost of a Claude Code session, computed from the session transcript
(`<configDir>/projects/<slug>/<session>.jsonl`). Pure python3 (3.9+, stdlib only); no network.

## Install

`aos cost enable [--budget <usd>]` checks `python3 --version`, copies `analyze_transcript.py`,
`pricing.json` and `report-template.html` into `<vault>/brain/scripts/cost/`, sets
`cost.enabled=true` in `agenticos.json`, and stores the optional monthly budget as
`cost.monthlyBudget` in `<vault>/brain/config.json`. `aos cost disable` flips the flag back;
the files stay.

## What runs

- `auto-cost.js` (SessionEnd hook) costs each session that has a transcript and patches
  `cost_usd` into `brain/_index/agent-runs/runs.jsonl` via `cost-sync.js`. Snapshots accumulate
  in `<vault>/brain/_index/cost/snapshots/` (gitignored by the vault template). With cost
  disabled the `auto-cost` pipeline stage reports `disabled`, which the HUD renders gray.
- `node brain/scripts/auto-cost.js --backfill` costs every past session that still has a transcript.
- `node brain/scripts/cost-budget.js` shows month-to-date against the budget; `--anchor <usd>`
  re-anchors to a real billed figure and recalibrates (see docs/cost.md).

## CLI

```
python3 analyze_transcript.py --transcript <jsonl> [--prev auto|none|<snapshot.json>]
    [--out <report.json>] [--html-out <report.html>] [--no-api] [--snapshots-dir <dir>] [--pricing <json>]
```
`--snapshots-dir` defaults to `data/snapshots` next to the script. `--no-api` forces the
`len-split` path; without it the script still never calls the network unless
`ANTHROPIC_API_KEY` is set and the `anthropic` package is importable (it then uses
`count_tokens` to split co-loaded skills).

## Pricing

`pricing.json` (USD per 1M tokens) carries `rates_as_of`. Verify current rates before trusting
dollar figures; unknown model ids fall back to `default_model` and are flagged in the report.

## Tests

`cd extras/cost && python3 -m unittest`
