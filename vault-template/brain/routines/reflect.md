---
schema: 1
name: Reflect
kind: duty
schedule: "0 18 * * 0"
enabled: true
guarded: true
tags: [persona]
---
The weekly reflection: runs `persona/duties/reflect.md` through the persona runner (`run-duty.sh`). Guarded by the persona contract — confirm before changing its schedule.
