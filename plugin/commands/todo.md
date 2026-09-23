---
description: Add a todo to TODO.md in Obsidian Tasks syntax (due date, priority, #tags); the Workbench To-Do tab shows it
allowed-tools: Read, Edit, Write
argument-hint: <text> [by <date>] [urgent] [#tag]
---

Add this todo: **$ARGUMENTS**

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json` (also visible in the injected `<brain-context>`). The list is `<vault>/TODO.md`.

1. Turn the text into ONE Obsidian Tasks line body, in this order: the task text, a priority emoji, `📅 YYYY-MM-DD`, then the `#tags`.
   - A date or deadline ("by Oct 1", "tomorrow", "next Friday", "on 2026-10-01") becomes `📅 YYYY-MM-DD`, resolved against today's local date, and the phrase leaves the text. No date mentioned → no 📅.
   - "urgent", "asap", "important" or a `!` → `⏫`; "medium" → `🔼`; "low priority", "someday", "whenever" → `🔽`. Otherwise no priority emoji.
   - Keep `#tags` and any Tasks emoji the user typed (`📅`, `⏫`, `🔼`, `🔽`) exactly as written. Keep the wording; add nothing the user did not say.
2. Read `<vault>/TODO.md`. If it does not exist, create it with exactly this content:

```markdown
# To-Do

Written by the Workbench To-Do tab and `/todo`. Tasks-plugin syntax: 📅 due date, ⏫ 🔼 🔽 priority, #tags.
Ticking an item moves it to Done with its completion date (✅).

## Open

## Done
```

3. Insert `- [ ] <body>` as the last item under `## Open` — after that item and its indented lines, before the blank line and the next `##` heading. Change nothing else in the file.
4. Confirm the saved line in one sentence. No preamble.
