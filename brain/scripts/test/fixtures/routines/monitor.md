---
schema: 1
name: Monitor
kind: duty
schedule: "0 13 * * *"
enabled: true
guarded: true
tags: [persona]
---
Runs the `monitor` duty prompt at `persona/duties/monitor.md` through `run-duty.sh`.
