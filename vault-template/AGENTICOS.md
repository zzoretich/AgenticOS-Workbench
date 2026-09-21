# AgenticOS — memory conventions for Claude Code and Codex CLI

> Under Claude Code this file is referenced from your CLAUDE.md as `@<vault>/AGENTICOS.md` (the installer prints the exact line); under Codex CLI a SessionStart hook injects it. This vault is both an Obsidian vault and the agent's second brain. Paths below are relative to the vault root; `aos <name>` is the launcher installed by `aos init` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" <name>` under Claude Code, `sh <vault>/brain/scripts/bin/aos <name>` anywhere).

## Memory System (3-file rule)

| File / path | Role | Shape |
|---|---|---|
| `MEMORY.md` (vault root) | **Index** — flat pointer list, one line per memory file | no frontmatter |
| `brain/memory/<type>/` | **Canonical content** — `user/`, `feedback/`, `projects/`, `reference/` | frontmatter + body |
| `brain/_index/BRAIN.md` | **Session bootstrap** — auto-injected on the first turn (≤850 tokens), compiled by `aos build-brain-md` | curated pointers |

Working memory: `brain/_index/SESSION.md` (≤400 tokens; reset by `/wrap`). Patterns: `brain/patterns/`. Reflections: `brain/reflections/`. Daily notes: `dailyNote.layout` in `brain/config.json` (default `<year>/<year>-<month>-<Month>/<date>.md`). Dashboard caches: `brain/_index/` — written only by scripts.

How it runs (automatic, via the `agenticos` Claude Code plugin, or the hook entries `aos init --host codex` writes for Codex):
- **First prompt** — the `UserPromptSubmit` hook injects `BRAIN.md` + `SESSION.md` as `<brain-context>` (plus a `<persona>` block when `persona/IDENTITY.md` exists and `persona/DISABLED` does not). The `agenticos` MCP server exposes `recall`, `memory_search`, `memory_read`, `memory_list`, `pattern_list`, `session_list`, `session_recall`, `feedback_rules`, `snapshot_read`, `brief_read`, `routine_list`, and the one write tool `wrap_session`.
- **During** — a `Stop` hook writes the last-active marker and, every ~5 turns, a working-memory summary into `BRAIN.md` `## Last Session` (model-written when a provider is available, heuristic otherwise).
- **Session end** — telemetry finalizes under `brain/_index/agent-runs/`; `auto-wrap` extracts memories when a provider is available (otherwise `SESSION.md` shows "not wrapped — run /wrap"); `scan-vault` refreshes the dashboard caches and the recall index.

## Capture vocabulary

Under Codex CLI every `/name` below is the skill `$name` (`$wrap`, `$remember`, …) and the MCP tools are `mcp__agenticos__<tool>`.

- `/remember <text>` — add to `SESSION.md`; tag `#promote` to make it permanent at wrap
- `/feedback` · `/pattern` · `/project` — write a memory of that type
- `/wrap` — promote `#promote` items, extract this session's memories in-session (`wrap_session`), summarize into today's daily note, reset `SESSION.md`
- `/brain` — show current state · `/scan` — refresh the dashboard
- `/ask-brain <q>` · `/standup` · `/reflect-week` · `/consolidate-memory` · `/compress <file>` — a script assembles the context, you answer or write it in-session (pass `--local` to let the local provider do it)
- `/cost` — session costing (only after `aos cost enable`)
- `/aos doctor|status|provider|persona` — maintenance
- `/routines [list|sync|run <slug>|enable <slug>|disable <slug>|next]` — the recurring actions (see Routines)

## Conventions

- New memory → file in `brain/memory/<type>/` → one line in `MEMORY.md` → (only if session-relevant) a pointer in `BRAIN.md`. **Never duplicate** across the three.
- `MEMORY.md` bullets are `- [Title](brain/memory/<type>/<slug>.md) — description` under the H2 for that type; the H2 names are fixed.
- `[[wiki-links]]` in Obsidian-facing files (daily notes, memory, MOCs); markdown `[text](path)` in Claude-facing files (this file, `MEMORY.md`, skills).
- `brain/_index/` is written only by scripts. In `BRAIN.md` the `## Last Session` block is the one hand-editable part; everything else is compiled from memory frontmatter (`pin: true`, `status/active`).
- After any correction from the user: capture it with `/feedback` (include **Why** and **How to apply**). Rules surface through the `feedback_rules` tool; auto-drafted rules wait in `brain/memory/feedback/_drafts/` for the `feedback-review` skill.

## Providers

`provider` in `agenticos.json` (`aos provider <mode>`): `auto` (default) picks `ollama` when `127.0.0.1:11434` answers, else `claude` (headless `claude -p --model haiku`, capped per call and per day, ledgered in `brain/_index/provider-spend.jsonl`), else `codex` when Codex is a wired host (headless `codex exec`, spend estimated from its token counts, same caps and ledger), else `none`. Under `none`, background summaries are heuristic, session-end extraction is skipped, and `/wrap` does the extraction in-session. The Obsidian plugin never calls a model. `aos status` shows the resolved provider, today's spend (hook calls against `claude.perDayUsd`, persona duties against `persona.perDayUsd`), and the pipeline ledger.

## Routines

A recurring action is a file: `brain/routines/<slug>.md` — frontmatter (`schedule:` a five-field cron expression, `kind: duty | prompt | command`, `enabled:`, caps) plus a body (the prompt for `prompt`, a note otherwise). The three Chief of Staff duties ship as `kind: duty` routines with `guarded: true` (the persona contract covers them: confirm before changing their schedule or prompt). `aos routines list | sync | run <slug> | enable <slug> | disable <slug> | next [<slug>]` — also `/routines <verb>` inside Claude Code (`$routines` under Codex) and the HUD's Routines tab, which edits the same files. `sync` renders one launchd plist (macOS) or crontab line (Linux) per enabled routine, every one running through `brain/scripts/routines/run-routine.js`; last runs, exit codes, cost and failure streaks live in `brain/_index/routines.json`. Prompt routines are capped by `routines.perRunUsd` and `routines.perDayUsd` (ledgered as `routine:<slug>`); duties keep the persona caps.
