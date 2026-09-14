---
description: Append a note to SESSION.md "Things to Remember"; tag #promote to make it permanent at /wrap
allowed-tools: Read, Edit
argument-hint: <text>
---

Remember this in working memory: **$ARGUMENTS**

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json` (also visible in the injected `<brain-context>`).

1. Read `<vault>/brain/_index/SESSION.md`.
2. Append `- $ARGUMENTS #promote` under `## Things to Remember` — or under `## Promote to Memory on Close` when the text starts with `feedback:`, `project:`, or `pattern:`.
3. Set the `updated:` frontmatter value to today's date (YYYY-MM-DD).
4. Confirm what was saved in one line. No preamble.
