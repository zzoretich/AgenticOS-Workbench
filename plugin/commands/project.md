---
description: Capture project context as a memory in brain/memory/projects/ (active projects are compiled into BRAIN.md)
allowed-tools: Read, Write, Edit, Bash
argument-hint: <project-name> <context>
---

Save this project context: **$ARGUMENTS**

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

1. Parse `$ARGUMENTS`: the first token is the project name (kebab-case); the rest is the context.
2. If `<vault>/brain/memory/projects/<project-name>.md` exists: add a dated bullet under `## Updates` and bump `updated:`. Otherwise create it:
```
---
type: memory
tags: [memory/projects, status/active]
created: <today>
updated: <today>
---

# <Project Name>

## Summary
*(one line)*

## Context
<the text from $ARGUMENTS>

## Updates
- <today>: <text>
```
3. If new, add `- [<Project Name>](brain/memory/projects/<project-name>.md) — <one line>` under `## Project` in `<vault>/MEMORY.md`.
4. Do not hand-edit `brain/_index/BRAIN.md`; it is compiled. `status/active` in the frontmatter is what puts the project into `## Active context`. To surface it immediately run `aos build-brain-md` via Bash (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" build-brain-md`).
5. Confirm in one line.
