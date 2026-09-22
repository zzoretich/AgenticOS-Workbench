---
schema: 1
name: Tick
kind: duty
schedule: "0 * * * *"
enabled: true
guarded: true
budgetUsd: 0.05
tools: "Read,Glob,Grep,Write,Edit,Bash(date:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/tick.js:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js summary:*)"
timeoutSec: 600
tags: [persona]
---
The hourly beat: runs `persona/duties/tick.md` through the persona runner (`run-duty.sh`) for at most `budgetUsd` (0.05 USD, about 1 USD a day) with the allowlist in `tools` — no git, no shell beyond `tick.js` and `ledger.js summary`. Before the model runs, `brain/scripts/persona/tick.js precheck` compares the vault's inputs (journal, feedback and drafts, STATE.md, proposals, ledger, tracked repos, the watchdog's beats) with the last beat and skips the run when nothing changed. The duty queues new signals into `persona/queue.jsonl` for reflect. Guarded by the persona contract — confirm before changing its schedule. `{{NODE}}` and `{{VAULT}}` are expanded by the routine runner.
