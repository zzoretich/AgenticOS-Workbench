---
schema: 1
name: Monitor
kind: duty
schedule: "0 13 * * *"
enabled: true
guarded: true
tags: [persona]
---
The daily health sweep: runs `persona/duties/monitor.md` through the persona runner (`run-duty.sh`). Guarded by the persona contract — confirm before changing its schedule.
