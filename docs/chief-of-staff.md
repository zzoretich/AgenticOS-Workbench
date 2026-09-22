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
| `ledger.jsonl` | `ledger.js` (tracked) | append-only proposal outcomes: `filed`, `approved`, `rejected`, `stale-dropped`, `verified`, `regressed` |
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
| tick | hourly | the cheap beat (0.10 USD cap, about 0.06 per working run, read-only): `tick.js signals` → queues new corrections, duty failures, stalled repos, regressions and aged flags into `persona/queue.jsonl` for reflect; skipped by the runner when nothing changed |

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

Each duty is a routine file, `brain/routines/<duty>.md` (`kind: duty`, `guarded: true`, a five-field
cron `schedule:`). Its schedule is rendered from that file through `extras/schedule/launchd/routine.plist.tmpl`
into `~/Library/LaunchAgents/com.agenticos.<duty>.plist` (macOS) or a crontab line ending in
`# com.agenticos.<duty>` (Linux); every schedule runs `brain/scripts/routines/run-routine.js`, which
hands a duty to `run-duty.sh` unchanged. Change a cadence by editing the file — the HUD's Routines
tab asks for confirmation on a guarded duty — and running `aos routines sync`; `aos routines list`
shows the next fire time and the last result. `aos uninstall` removes every routine schedule (the
pre-routines `com.agenticos.monitor|reflect|sitrep` plists included); the optional
`com.agenticos.ollama` supervisor from `extras/ollama` is left alone. A failed `launchctl load` is reported as a warning and never aborts `aos init` or
`aos persona`. Limits: the plist renderer XML-escapes the values it substitutes, but cron lines
carry them unquoted — on Linux the vault path and the agent name may contain no spaces and no
shell-special characters (`& ; $ ' " %` — `%` is cron's command terminator); launchd escapes them, cron does not. On both platforms
`PERSONA_TOOLS` interpolates the vault path into permission rules, so a vault path with spaces
cannot be used by duties at all. Windows: not supported; run duties by hand.

## Heartbeat

Duties are only as reliable as the scheduler that starts them, and `run-duty.sh` can only record a
FAILED run it was started for. The watchdog, `brain/scripts/persona/watchdog.js`, closes that gap from
outside and never calls a model. It runs two ways: as the `heartbeat` routine
(`brain/routines/heartbeat.md`, `kind: command`, every 30 minutes; `aos persona` seeds the file when it
is missing, and `{{NODE}}` / `{{VAULT}}` in its `argv` are expanded by the routine runner, so the file
is the same on every machine) and from the `SessionStart` hook (`aos persona-watchdog`, throttled to
once per 30 minutes, silent), so a dead launchd still gets noticed the next time you open a session.

Each check takes every enabled duty's last run from `brain/_index/routines.json` (merged with the duty
log, as `aos routines list` does) and projects its schedule forward: a fire time more than
`persona.watchdog.graceMinutes` (default 45, longer than `PERSONA_TIMEOUT`, so a duty still running is
never a miss) in the past with no run since is a MISSED duty; a duty that never ran counts from the
moment `aos routines sync` installed its schedule. On a miss the watchdog writes one
`- [ ] <date> duty '<slug>' MISSED — … (watchdog)` line directly under `## Flags` in `STATE.md` (the
next session sees it in the `<persona>` block), sends one OS notification (`osascript` on macOS,
`notify-send` on Linux; `persona.watchdog.notify: false` turns that off), and records every beat in
`brain/_index/persona-heartbeat.json` (`schema: 1`; per routine `status`:
`ok | missed | failed | never | disabled | unwatched | invalid | stale`, `lastRunAt`, `due`, `next`).
It removes its own MISSED line once the duty runs again and never touches any other flag; a line you
close by hand stays closed until a new miss. Once a day it also runs `ledger.js verify` (see
Proposals). `aos routines run heartbeat` checks now; `aos routines disable heartbeat` turns the schedule
off without deleting the file.

The second layer is the **tick**, `brain/routines/tick.md` (`kind: duty`, hourly, seeded by `aos persona`
next to the heartbeat; `aos persona --yes` adds it to an existing vault). It is the only duty with a
runner-side helper, `brain/scripts/persona/tick.js`: before the model runs, `tick.js precheck` compares a
signature of the vault's inputs — the journal, feedback memories and drafts, `STATE.md`, proposals, the
ledger, each repo in `persona/repos.json` (its `.git/HEAD`, index, reflog and `.planning/STATE.md`) and
the watchdog's beats — with the one recorded at the last beat, and `run-duty.sh` skips the model call when
nothing changed (one `skipped: unchanged` line in `duty-tick.log`, no journal entry, exit 0, so the
watchdog still counts the hour as a run). When something did change, the duty runs `tick.js signals`,
which lists the candidates since the last beat with a source pointer each — `correction` (a feedback
file or draft), `duty-failure` (a failed or missed beat), `repo-stall` (`.planning/STATE.md` idle past
`stall_threshold_days`), `regressed` (a ledger event) and `flag-aged` (a `- [ ] <date>` flag older than
`persona.tick.flagAgeDays`, default 7) — and queues the ones worth reflect's time with `tick.js queue
<type> --source <pointer> --note <why>`, which validates the type and never queues the same (type, source)
twice. The queue is `persona/queue.jsonl`, append-only, one JSON line per signal; the daily reflect that
drains it is the next slice. The tick's budget and allowlist live in the routine file (`budgetUsd: 0.1` — a working haiku run costs about 0.06 USD, most of it the cached system prompt across its tool turns, so 0.05 cut every run off mid-flight —
`tools:` Read, Glob, Grep, Write, Edit, `date`, `tick.js` and `ledger.js summary` — no git), and the
routine runner passes them to `run-duty.sh` as `PERSONA_MAX_USD` and `PERSONA_TOOLS`; `tick.js beat`
records the beat after the contract check passes. The tick touches `STATE.md` in two places only: its
`tick:` line under `## Last Duty Runs`, and the `## Sitrep` block when it queued something. `tick.js
status` prints its state (`brain/_index/persona-tick.json`: last beat, skips, the pending signature).

In the Obsidian HUD the sidebar shows a heartbeat pill next to the update pill, read from
`persona-heartbeat.json`: green while the last check is under an hour old and no duty is missed or
failed, amber under three hours (or while a duty has never run, is stale or invalid), rose otherwise or on
any miss; the tooltip lists each duty with its status, last run and next fire.

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

Guarded files (IDENTITY.md, duties and their routine files — `guarded: true`, which the Routines tab confirms before changing — persona scripts, schedules, anything outside `persona/`)
change only through `persona/proposals/YYYY-MM-DD-<slug>.md` with a `recheck` recipe and a
premise table; approval applies the change exactly as written and re-runs the recipe expecting
the finding to be gone. See `persona/proposals/README.md` in your vault.

Every outcome lands in `persona/ledger.jsonl` (tracked, unlike `STATE.md`) through
`brain/scripts/persona/ledger.js`: `filed` by reflect, `approved` / `rejected` / `stale-dropped` by the
review (an approval keeps the proposal's `recheck` recipe), and `verified` or `regressed` by the
watchdog, which re-runs each approval's recipe daily from day 1 to day 14: exit 0 again means the
finding is back (`regressed`, plus a `STATE.md` flag and a notification); a clean week means
`verified`. A proposal carries an optional `kind: self | vault | workflow | product` (default `self`;
the last two are ideas for you rather than changes the agent applies). `ledger.js summary [--days N]`
prints counts per event and kind, the approval rate, open proposals and unverified approvals; reflect
reads it before proposing, so a rejected idea is not filed twice and a regression counts as evidence
against the earlier fix. Under the hood a duty may run `ledger.js` (it is on the runner's tool
allowlist), and the runner's system prompt now opens with today's date and the journal path, so a duty
that runs just after midnight no longer journals into yesterday's file.

## Privacy

The product ships templates and scripts only. Your identity, state, playbook, journal and
proposals are generated in your vault; `agenticos.json` records no agent name.
