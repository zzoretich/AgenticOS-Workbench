---
schema: 1
name: Daily reflect
kind: duty
schedule: "0 22 * * *"
enabled: true
guarded: true
budgetUsd: 0.5
tools: "Read,Glob,Grep,Write,Edit,Bash(date:*),Bash(ls:*),Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/reflect.js:*),Bash({{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js:*)"
timeoutSec: 900
tags: [persona]
---
The nightly reflect: runs `persona/duties/reflect-daily.md` through the persona runner (`run-duty.sh`) for at most `budgetUsd` (0.50 USD) with the allowlist in `tools` — read-only git, `reflect.js` and `ledger.js`. Before the model runs, `brain/scripts/persona/reflect.js precheck` skips the run when `persona/queue.jsonl` is empty and a daily reflect already drained today (the tick starts one early when the queue fills up — `aos routines list` shows the trigger as `early`). The duty reads `reflect.js inputs`, files at most two proposals, and the runner drains the queue once the journal entry is in. The Sunday `reflect` keeps the long form. Guarded by the persona contract — confirm before changing its schedule. `{{NODE}}` and `{{VAULT}}` are expanded by the routine runner.
