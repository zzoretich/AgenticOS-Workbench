# Chief of Staff layer

Installed by default. Your vault gets a named agent — an identity that is injected into every
Claude Code session, a small state file that bridges sessions, a playbook of your own commands,
skills and agents, three scheduled duties, and a proposals protocol for changes that need your
sign-off. The machinery ships; the content is generated for you and never leaves your machine.

## The interview

The `aos init` Chief of Staff interview (item 7 in `docs/install.md`), and `aos persona` at any time, ask in order:

1. Agent name (required; the prompt shows "Proton" as an example — pick your own).
2. How the agent addresses you (a name or a title).
3. Voice in one line.
4. What it should watch most (comma-separated → `## Priorities` in STATE.md).
5. Model for background duties (default: your configured Claude model).
6. Effort for background duties (`low|medium|high`, default `medium`).
7. Schedule daily duties? (default yes → launchd on macOS, crontab on Linux).

Non-interactive: `aos init --persona-json answers.json` or `aos persona --yes` (reuses the last
answers). The answers file shape is
`{ "name", "addressAs", "voice", "priorities", "dutyModel", "dutyEffort", "schedule" }`.
Re-running the interview regenerates `IDENTITY.md` and `duties/*.md`; it keeps `STATE.md`,
`PLAYBOOK.md`, `proposals/README.md` and `autoapply.json`.

## Layout: `<vault>/persona/`

| File | Written by | Purpose |
|---|---|---|
| `IDENTITY.md` | interview | persona + directives; guarded |
| `STATE.md` | duties, you | `## Sitrep`, `## Flags` (`- [ ]` items), `## Priorities`, `## Pending Proposals`, `## Last Duty Runs` |
| `PLAYBOOK.md` | `build-playbook.js` once | intent → route table over your `<configDir>/{skills,agents,commands}` |
| `duties/{monitor,reflect,sitrep}.md` | interview | duty prompts (guarded) |
| `proposals/` | agent | guarded changes awaiting approval (see its README) |
| `journal/` | duties | one file per day; `journal/logs/` holds duty logs |
| `answers.json` | interview | the interview answers (for prefilled re-runs and rename) |
| `autoapply.json` | interview | `{ "classes": [] }` — the dormant auto-apply whitelist |
| `repos.json` | you (optional) | `{ "stall_threshold_days": 4, "repos": [{ "name", "path" }] }` for the sitrep |
| `DISABLED` | `aos persona off` | kill switch: no injection, no duties |

## Every session

The `UserPromptSubmit` hook injects `<persona>IDENTITY.md --- STATE.md</persona>` before the brain
context, unless the merged `persona.enabled` is `false` or `persona/DISABLED` exists. The config
merge reads `brain/config.json` first and `agenticos.json` last, and `aos init` pins
`"persona": { "enabled": true }` into `agenticos.json` — so on an installed vault the switch lives
there, not in `brain/config.json`. To turn the agent off without editing config, use
`aos persona off`: it only writes `persona/DISABLED` and leaves `persona.enabled` alone. A fresh
`brain/_index/sitrep.md` (under 18 hours old) is injected too.

## Duties

| Duty | When | Does |
|---|---|---|
| monitor | daily 13:00 | duty health, vault drift, unfinished work, pending review counts; prepares one safe fix |
| reflect | Sunday 18:00 | curates the playbook from `scan-arsenal.js`, promotes repeated corrections to feedback memories, files proposals, writes a weekly reflection |
| sitrep | weekdays 07:45 | `sitrep-state.js diff` → one page with ONE recommended action → `brain/_index/sitrep.md` + daily note |

Runner: `sh <vault>/brain/scripts/persona/run-duty.sh <duty> [--dry-run]`. It runs
`claude -p` with the duty prompt, appends `IDENTITY.md` + `STATE.md` as system prompt,
`AOS_HEADLESS=1` (your hooks do not fire), a scoped tool allowlist, `--max-budget-usd`
(`PERSONA_MAX_USD`, else `persona.perDutyUsd` from config, default 2.0), and
`--output-format json`. The cost of every run is appended to `brain/_index/provider-spend.jsonl`
as `feature: "duty:<name>"`. A duty is skipped for the rest of the day — journal entry
`- status: SKIPPED daily-cap`, exit 0 — once today's `duty:*` rows add up to
`persona.perDayUsd` (default 6.0). Both caps live in `<vault>/brain/config.json` (the `enabled` switch
does not — `agenticos.json` is merged last and `aos init` writes it there; see above):

```json
{ "persona": { "perDutyUsd": 2.0, "perDayUsd": 6.0 } }
```

Raise `perDayUsd` if you schedule more duties or a bigger `perDutyUsd`; with the defaults three
$2 runs fit in one day. `claude.perDayUsd` (0.5) is a separate cap for the background hook
calls (session summary, wrap) and the Obsidian chat (its rows carry feature `chat`), and never
blocks a duty. A duty must append a `## HH:MM — duty: <name>` entry to the journal; otherwise the
runner records FAILED and adds a flag to `STATE.md`. A duty that runs past `PERSONA_TIMEOUT`
(default 1800 s) is killed and journaled FAILED too; `claude -p` prints its cost only at the end,
so such a run ledgers $0 and only `--max-budget-usd` (`persona.perDutyUsd`) bounds what it
spent. A duty never runs `git commit`: `STATE.md`
and `journal/` are ignored by the vault's `.gitignore`, and anything else it edits stays in the
working tree for you to review. Env: `PERSONA_MODEL`, `PERSONA_EFFORT`, `PERSONA_LOG_DIR`,
`PERSONA_TOOLS`, `PERSONA_MAX_USD`, `PERSONA_TIMEOUT`, `PERSONA_CLAUDE_BIN`, `AOS_NODE`.
`PERSONA_NAME` is set by the schedules (plists and cron lines) so that `aos persona rename` has
something to re-render; the runner takes the name from `IDENTITY.md` and never reads it.

Schedules are rendered from `extras/schedule/` into `~/Library/LaunchAgents/com.agenticos.<duty>.plist`
(macOS) or crontab lines ending in `# com.agenticos.<duty>` (Linux). `aos uninstall` removes the
three duty schedules (the `com.agenticos.monitor|reflect|sitrep` plists / the crontab lines tagged
`# com.agenticos.<duty>`); the optional `com.agenticos.ollama` supervisor from `extras/ollama` is
left alone. A failed `launchctl load` is reported as a warning and never aborts `aos init` or
`aos persona`. Limits: the plist renderer XML-escapes the values it substitutes, but cron lines
carry them unquoted — on Linux the vault path and the agent name may contain no spaces and no
shell-special characters (`& ; $ ' " %` — `%` is cron's command terminator); launchd escapes them, cron does not. On both platforms
`PERSONA_TOOLS` interpolates the vault path into permission rules, so a vault path with spaces
cannot be used by duties at all. Windows: not supported; run duties by hand.

## Commands and skills

- `aos persona` — re-run the interview (prefilled). `aos persona rename <name>` re-renders
  IDENTITY.md and the three duties from the templates with the new name, rewrites the PLAYBOOK's
  H1 and the name on STATE.md's non-heading lines, and re-renders installed schedules; the
  playbook's body is yours, so hand-written annotations that mention the old name survive a rename.
  `aos persona off` / `on` create / remove `persona/DISABLED` — the kill switch only; neither
  touches `persona.enabled`.
- "sitrep" (skill `persona-sitrep`, also reachable as `/agenticos:persona-sitrep`) — present the
  fresh sitrep or rebuild it interactively.
- "review persona flags" (skill `persona-flag-closer`) — batch-review proposals, flags and new
  duty failures with deterministic recheck recipes, one decision pass, one commit per decision.

## Proposals

Guarded files (IDENTITY.md, duties, persona scripts, schedules, anything outside `persona/`)
change only through `persona/proposals/YYYY-MM-DD-<slug>.md` with a `recheck` recipe and a
premise table; approval applies the change exactly as written and re-runs the recipe expecting
the finding to be gone. See `persona/proposals/README.md` in your vault.

## Privacy

The product ships templates and scripts only. Your identity, state, playbook, journal and
proposals are generated in your vault; `agenticos.json` records no agent name.
