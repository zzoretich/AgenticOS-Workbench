---
description: Session-end protocol — promote #promote items, extract this session's memories in-session (wrap_session), summarize into today's daily note, reset SESSION.md
allowed-tools: Bash, Read, Edit, Write, Glob, Skill, mcp__plugin_agenticos_agenticos__wrap_session, mcp__plugin_agenticos_agenticos__feedback_rules
---

Run the session wrap. Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.

1. **Mechanical wrap.** Bash: `aos wrap-session` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" wrap-session`). This promotes `#promote`-tagged items from `SESSION.md` into permanent memory, appends a "Session Wrap" block to today's daily note, clears any `## Wrap Status` banner, and resets `SESSION.md`.
2. **In-session extraction.** Use the `wrap` skill: review this conversation and call the `wrap_session` tool of the `agenticos` MCP server (`mcp__plugin_agenticos_agenticos__wrap_session`) exactly once with `facts`, `decisions`, `feedback`, `threads`, `candidates` (durable memories only), and `corrections` (quotes where the user corrected you). Report its `{written, skipped, reasons, drafts}`.
3. **Daily note summary.** The note path is `<vault>/` + `dailyNote.layout` from `<vault>/brain/config.json` (default `{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md`, `{MMMM}` = full month name) for today. Write what was built or changed, key decisions, and open threads under `## Summary` and `## What Happened`. **Append, never overwrite**: if those sections already hold an earlier session's text for today, add a new paragraph under `## Summary` and a new `### <what you did> (HH:MM–HH:MM)` subsection at the end of `## What Happened`.
4. **BRAIN.md.** Only the `## Last Session` block of `<vault>/brain/_index/BRAIN.md` is hand-editable (today's date + one line). Everything else is compiled from memory frontmatter; if a project became active or complete this session, flip its `status/…` tag in `brain/memory/projects/*.md` and run `aos build-brain-md`.
5. **Cost (optional).** Only when `cost.enabled` is true in `agenticos.json`: run `aos auto-cost --backfill` non-blocking and mention the headline. Never fail the wrap over costing.
6. Terse recap: files changed, items promoted, memories written by `wrap_session`, open threads.
