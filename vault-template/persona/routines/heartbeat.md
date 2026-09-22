---
schema: 1
name: Heartbeat
kind: command
schedule: "*/30 * * * *"
enabled: true
guarded: false
argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/persona/watchdog.js"]
timeoutSec: 60
tags: [persona]
---
The persona watchdog (`brain/scripts/persona/watchdog.js`): model-free, every 30 minutes. It checks that every enabled duty fired on schedule, flags a MISSED duty under `## Flags` in `persona/STATE.md`, sends one OS notification per miss, and once a day re-runs the recheck recipes of approved proposals (`ledger.js verify`). `{{NODE}}` and `{{VAULT}}` are expanded by the routine runner. Disable it with `aos routines disable heartbeat`; do not delete the file.
