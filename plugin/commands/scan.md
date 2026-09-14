---
description: Refresh the dashboard caches — full vault scan, BRAIN.md compile, recall index
allowed-tools: Bash, Read
---

Refresh the vault scan:

1. Bash: `aos scan-vault` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" scan-vault`). It writes `brain/_index/snapshot.json`, `snapshot.md`, `health.md`, the recall index, and prints a one-line summary (scan time, capability counts, health severity counts, total size).
2. Report that summary line as-is.
3. If the summary's `health:` field reports errors (`NE` with N > 0), read `<vault>/brain/_index/health.md` and quote only the `## ERROR` section. Otherwise the summary line is enough.
