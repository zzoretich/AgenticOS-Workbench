---
description: Every Claude Code and Codex skill in one list, and share each host's own skills with the other — list, sync now, stop or resume sharing one skill, reset an edited copy
allowed-tools: Bash, Read
argument-hint: [list [--all] | sync [--dry-run] | exclude <name> | include <name> | reset <name>]
---

Run `aos skills $ARGUMENTS` in the shell (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" skills $ARGUMENTS`); with no arguments run `aos skills list`. Relay the output; every verb is a passthrough.

How sharing works: each host keeps its own skills (Claude Code under `~/.claude/skills`, Codex under `~/.agents/skills`). With both hosts enabled, AgenticOS writes a translated copy of each one into the other host's folder at the end of every session, so a skill made in one host is in the other by its next session. Plugin skills and built-ins are listed but never copied: they need their plugin's tools.

- `list [--all]`: the first line is the summary; relay it, then the table. Columns: the skill, how to run it in Claude Code and in Codex (`—` when that host lacks it), where it comes from, and its status. `--all` adds plugin skills and built-ins.
- `sync [--dry-run]`: share now instead of waiting for the session to end. `--dry-run` prints what it would write or remove and changes nothing.
- `exclude <name>` / `include <name>`: stop or resume sharing one skill (kept in `brain/config.json` under `skills.exclude`). Suggest it when the other host's skill list is crowded: Codex shortens descriptions, then drops skills, past its listing budget.
- `reset <name>`: a copy that was edited by hand is never overwritten. This deletes that copy, and the edit with it, so the next sync writes it fresh. Say that plainly and ask before running it.

Statuses worth one line each: `universal` = on both hosts; `pending` = sharing is off or only one host is enabled (the summary says which); `differs` = a different skill of the same name exists on each host and both are left alone; `edited` = a copy was edited by hand (edit the source instead, or `reset`); `excluded` = not shared on purpose; `invalid` = cannot be shared as written (the reason follows the table; usually a SKILL.md without `name`/`description` frontmatter); `listed` = a plugin skill or built-in.

The Skills tab in the Obsidian Workbench shows the same list, with buttons that start a Claude Code or Codex session running the skill.
