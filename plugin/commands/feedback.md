---
description: Capture user feedback as a permanent rule in brain/memory/feedback/ and index it in MEMORY.md
allowed-tools: Read, Write, Edit
argument-hint: <the rule, in the user's words>
---

Save this feedback as a permanent memory: **$ARGUMENTS**

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

1. Choose a short kebab-case filename (e.g. `prefers-tables-over-bullets.md`).
2. Create `<vault>/brain/memory/feedback/<filename>.md`:
```
---
type: memory
tags: [memory/feedback, status/active]
created: <today>
updated: <today>
---

# <Short Title>

## Rule
$ARGUMENTS

## Why
*(infer from the conversation — what went wrong or what the user wants instead)*

## How to apply
*(when and where this changes behavior in future sessions)*
```
3. Append one line to `<vault>/MEMORY.md` under `## Feedback (how to work)`:
   `- [<Short Title>](brain/memory/feedback/<filename>.md) — <one-line summary>`
4. Confirm in one line. The rule is live for every future session through the `feedback_rules` tool of the `agenticos` MCP server (`mcp__plugin_agenticos_agenticos__feedback_rules`).
