---
schema: 1
name: Briefing
kind: command
schedule: "*/30 7-22 * * *"
enabled: true
guarded: false
argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/persona/briefing.js"]
timeoutSec: 90
tags: [persona]
---
The Chief of Staff's paragraph at the top of the Workbench's Pulse tab (`brain/scripts/persona/briefing.js`). Every 30 minutes from 7:00 to 22:00 it reads the facts Pulse shows (what needs you, health, decisions, to-dos, notifications, routines, spend) and makes one model call only when they changed since the last paragraph, as a `duty:briefing` call against the daily duty cap (`persona.perDayUsd`). It writes `brain/_index/briefing.json`; Pulse composes the paragraph from the same facts whenever there is none or it is out of date. Nothing runs while the persona is off; `persona.briefing.enabled: false` turns this one off. Disable it with `aos routines disable briefing`.
