---
description: Create or extend a decision-heuristic note in brain/patterns/
allowed-tools: Read, Write, Edit, Glob
argument-hint: <area>: <pattern>   (area = debugging | architecture | code-quality | testing | other)
---

Capture this pattern: **$ARGUMENTS**

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

1. Parse `$ARGUMENTS`: the words before the first `:` or ` - ` are the area (debugging / architecture / code-quality / testing / other); the rest is the pattern.
2. If `<vault>/brain/patterns/<area>.md` exists: append the pattern as a new `### <short title>` subsection and bump `updated:`. Otherwise create it:
```
---
type: pattern
tags: [pattern/<area>, status/active]
created: <today>
updated: <today>
---

# <Area> Patterns

### <short pattern title>
<the pattern>
```
3. If the file is new, add `- [<Area> Patterns](brain/patterns/<area>.md) — <one line>` under `## Patterns` in `<vault>/MEMORY.md`.
4. Confirm in one line. The MOC `brain/_index/MOC-patterns.md` picks the file up on the next scan.
