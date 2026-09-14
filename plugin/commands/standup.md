---
description: Did / Doing / Blockers standup from recent daily notes, git and telemetry, appended to today's daily note
allowed-tools: Bash, Read, Write
argument-hint: [--local]
---

Generate today's standup:

1. Bash: `aos standup $ARGUMENTS` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" standup $ARGUMENTS`). Without `--local` it prints a `<<<AOS_CONTEXT feature=standup>>> … <<<END>>>` block: yesterday's and today's notes, recent commits, recent runs, and the Did/Doing/Blockers format.
2. Write the standup in that format to a temp file and persist it with `aos standup --write <file>` (appends to today's daily note under `## Standup`).
3. With `--local` the provider writes it; relay verbatim.
4. Show the standup. This is the quick manual take; scheduled state reviews belong to the persona's sitrep duty.
