---
description: Weekly reflection from the last 7 daily notes and git history, written to brain/reflections/
allowed-tools: Bash, Read, Write
argument-hint: [--weeks=N] [--local]
---

Generate the weekly reflection:

1. Bash: `aos reflect-week $ARGUMENTS` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" reflect-week $ARGUMENTS`). Without `--local` it prints a `<<<AOS_CONTEXT feature=reflect-week>>> … <<<END>>>` block: the notes and commits for the window plus the exact section layout the reflection must use.
2. Write the reflection in that layout to a temp file (e.g. `/tmp/reflect-week.md`), then persist it with `aos reflect-week --write /tmp/reflect-week.md`. The script prints the saved path (`brain/reflections/<YYYY-WW>.md`).
3. With `--local` the provider writes it; relay the output and the saved path.
4. Show the reflection to the user.
