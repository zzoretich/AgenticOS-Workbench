---
description: Capture project context as a memory in brain/memory/projects/ (active projects are compiled into BRAIN.md)
allowed-tools: Read, Write, Edit, Bash
argument-hint: <project-name> <context>
---

Save this project context: **$ARGUMENTS**

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

1. Parse `$ARGUMENTS`: the first token is the project name (kebab-case); the rest is the context.
2. **Workspace.** Run `aos workspace which --json` in the shell from the folder this session runs in, without changing directory first (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" workspace which --json`). It prints `{"name": "<name>", "slug": "<slug>", "via": "<how it matched>"}` when the folder belongs to a workspace (the workspace itself, a worktree of it, or a code folder linked to it), or `{"name": null}` when it does not. Only when `name` is set, the note carries `workspace: <name>` in its frontmatter (step 3), which links it to that workspace in the Workbench Spaces tab. When `name` is null, or the command fails or prints anything else, write no `workspace:` line.
3. If `<vault>/brain/memory/projects/<project-name>.md` exists: add a dated bullet under `## Updates` and bump `updated:`; when step 2 printed a `name` and the frontmatter has no `workspace:` line yet, add `workspace: <name>` after `updated:` (never change an existing one). Otherwise create it, with the `workspace:` line only when step 2 printed a `name`:
```
---
type: memory
tags: [memory/projects, status/active]
created: <today>
updated: <today>
workspace: <name>
---

# <Project Name>

## Summary
*(one line)*

## Context
<the text from $ARGUMENTS>

## Updates
- <today>: <text>
```
4. If new, add `- [<Project Name>](brain/memory/projects/<project-name>.md) — <one line>` under `## Project` in `<vault>/MEMORY.md`.
5. Do not hand-edit `brain/_index/BRAIN.md`; it is compiled. `status/active` in the frontmatter is what puts the project into `## Active context`. To surface it immediately run `aos build-brain-md` in the shell (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" build-brain-md`).
6. Confirm in one line, naming the workspace when the note was linked to one.
