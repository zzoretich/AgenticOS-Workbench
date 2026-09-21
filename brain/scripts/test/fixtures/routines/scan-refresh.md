---
schema: 1
name: Scan refresh
kind: command
schedule: "*/30 * * * *"
enabled: false
argv: [node, "brain/scripts/scan-vault.js", --quiet]
---
