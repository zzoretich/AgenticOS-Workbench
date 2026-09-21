---
schema: 1
name: Sitrep
kind: duty
schedule: "45 7 * * 1-5"
enabled: true
guarded: true
tags: [persona]
---
The weekday-morning work-state sitrep: runs `persona/duties/sitrep.md` through the persona runner (`run-duty.sh`). Guarded by the persona contract — confirm before changing its schedule.
