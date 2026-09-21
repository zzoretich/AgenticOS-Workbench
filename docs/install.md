# Install

AgenticOS Workbench runs on macOS and Linux with Node 20+, Claude Code (logged in), and optionally Obsidian and Ollama. **Windows is not supported in v1** (the launcher is POSIX `sh`, scheduling uses launchd/cron).

## Ten-minute path

```
git clone https://github.com/zzoretich/AgenticOS-Workbench.git
cd AgenticOS-Workbench
npm ci --ignore-scripts
npm run setup            # = node cli/aos.js init
```

While developing from a checkout, run `npm run setup -- --from-local .` so the plugin is installed from your clone rather than from GitHub.

`aos init` asks for a vault directory (default `~/AgenticOS`; it refuses `~/.claude` and any directory holding a `settings.json`) and then, in order:

1. **Preflight** — Node ≥ 20; `claude` on PATH and logged in (`claude auth status`); Obsidian detected (optional); python3 ≥ 3.9 (checked only with `--cost`); Ollama on `127.0.0.1:11434` (informational).
2. **Seed** — copies `vault-template/` (existing files are kept), writes `brain/config.json` from the shipped defaults, and `.obsidian/daily-notes.json` (folder = the current year, format `YYYY-MM-DD` — Obsidian cannot express the month sub-folder of the default layout, so daily notes created from Obsidian land one level up; notes created by the scripts use the full layout). `aos init` and `aos upgrade` rewrite that file each run from `dailyNote.layout`, and its folder is the year at that moment — run `aos upgrade` after New Year, or set the folder yourself under Obsidian → Settings → Daily notes.
3. **Vendor the runtime** — `brain/scripts` (without tests or a lockfile) into `<vault>/brain/scripts`, plus `cli/*.js` (the `aos` subcommands — `aos.js`, `persona-cmd.js`, `schedule.js`, `routines.js`, `cost-cmd.js`; no tests, fixtures or rehearsal), the persona templates (`vault-template/persona/` → `brain/scripts/persona/templates/`), the schedule and cost sources (`extras/{schedule,cost}/` → `brain/scripts/extras/`, without the python tests) and the `aos` launcher; then `npm install --omit=dev` there (two dependencies, pinned by `^` ranges); symlink `~/.local/bin/aos` → `<vault>/brain/scripts/bin/aos`. `aos upgrade` refreshes the same set, and `aos doctor` checks that the persona and schedule pieces are present.
4. **`~/.claude/agenticos.json`** — vault, node path, config dir, the resolved `claude` path (`claude.bin` — hooks, the MCP server and the Obsidian plugin spawn it without a login shell; `aos upgrade` re-resolves it, and a recorded path that no longer exists is ignored), provider (`auto`), spend caps, telemetry, cost, persona flags. Honors `CLAUDE_CONFIG_DIR` (and `AOS_CONFIG` for an explicit file path — the same rule every hook and `aos` subcommand uses).
5. **Plugin** — `claude plugin marketplace add zzoretich/AgenticOS-Workbench` then `claude plugin install agenticos@agenticos-workbench`. With `--from-local <repo-dir>` the marketplace source is your checkout.
6. **Obsidian bundle** — `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/agentic-os/` from the checkout's build, else built with `npm run build -w obsidian-plugin`, else downloaded from the matching GitHub release (no GitHub release exists until the release workflow ships in a later phase, so today that fallback prints a warning; build locally instead). `--no-obsidian` skips it; `--terminal` also installs the embedded terminal's native module (`aos terminal install` later does the same).
7. **Chief of Staff interview** — names your agent and writes `<vault>/persona/` (identity, state, playbook, three duties, a proposals README); with `schedule: yes` it also installs the three duties' schedules — each duty is a routine file seeded at `brain/routines/<duty>.md`, rendered to launchd on macOS or crontab on Linux; `aos routines` manages them afterwards. `--persona-json <file>` answers it non-interactively (fields `name`, `addressAs`, `voice`, `priorities`, `dutyModel`, `dutyEffort`, `schedule`) — use it in CI and wherever stdin is not a terminal. With `--yes` (or no terminal) and no `--persona-json`, init reuses `<vault>/persona/answers.json` from an earlier run, or skips the interview with a note and continues; run `aos persona` later. Details: `docs/chief-of-staff.md`.
8. **First scan** — `scan-vault`, `build-brain-md`, `recall --warm`.
9. **Checklist** — every file written, the line to add to your `CLAUDE.md`, and how to open the vault.

Then add the printed line to `~/.claude/CLAUDE.md` (the installer never edits it):

```
@/path/to/AgenticOS/AGENTICOS.md
```

Open the vault in Obsidian ("Open folder as vault"), enable **Agentic OS** under Community plugins, and start a new `claude` session: the first prompt receives `<brain-context>`, `/wrap` writes memories, and the `agenticos` MCP server answers `recall`.

Flags: `--vault <dir>`, `--provider auto|ollama|claude|none`, `--no-obsidian`, `--terminal`, `--cost` (installs the cost module; needs python3 ≥ 3.9), `--persona-json <file>`, `--from-local <repo-dir>`, `--dry-run` (prints the numbered plan, writes nothing; accepted only by `init`), `--yes` (accept defaults, no prompts). `--flag=value` works too. Any unknown or misspelled flag is a usage error (exit 2), so a typo never starts a real install. Re-running `aos init` on an existing vault keeps your files and your provider setting; only an explicit `--provider` changes it.

## After install

| Command | Does |
|---|---|
| `aos doctor` | Node, claude login, `agenticos.json`, `AOS_VAULT`/`BRAIN_VAULT` when set (warn if the directory is missing), `claude.bin` (warn when the recorded path is no longer an executable file), vault layout, plugin installed, MCP declared and answering (a real stdio handshake), Obsidian bundle (warn), Ollama (info), python3 (when cost is on). Exit 1 when a check fails. |
| `aos status` | resolved provider and reason; the resolved `claude` binary and cached login state; today's spend on four lines — hooks against `claude.perDayUsd`, persona duties (`duty:*` ledger rows) against `persona.perDayUsd`, the reasoner (`reason:*`) against `reasoner.perDayUsd`, prompt routines (`routine:*`) against `routines.perDayUsd`; the pipeline ledger |
| `aos provider <mode>` | force `ollama`, `claude`, `none`, or back to `auto`; clears the cached probe |
| `aos upgrade` | `claude plugin marketplace update` + `plugin update`, re-vendor the runtime and bundle, add new config keys (your values win), rebuild indexes. Never touches memory, notes, or persona. |
| `aos uninstall [--keep-vault]` | plugin and marketplace removed (a failed or skipped `claude plugin …` step is reported on stderr with the command to run yourself), every routine schedule removed (the `com.agenticos.<slug>` plists or tagged crontab lines, the pre-routines `com.agenticos.monitor|reflect|sitrep` labels included), `~/.local/bin/aos` and `agenticos.json` removed; the vault is deleted only if you type its path back, and never when it is your home directory or a Claude config directory. The optional Ollama supervisor (`com.agenticos.ollama`, see `extras/ollama/README.md`) is installed by hand and is left alone. |
| `aos persona on\|off\|rename <name>` | kill switch (`persona/DISABLED` only — `persona.enabled` in `agenticos.json` is left alone) and rename; plain `aos persona` re-runs the interview, prefilled from `persona/answers.json` |
| `aos cost enable [--budget <usd>]` | opt-in session costing (python3 ≥ 3.9) — see `docs/cost.md`; `aos cost disable` turns it off and leaves the installed files |
| `aos terminal install` | node-pty for the Obsidian terminal tab |

Every runtime script is also reachable as `aos <name>` (`aos scan-vault`, `aos recall "<query>"`, `aos build-brain-md`, …); the same launcher is what the plugin's hooks call as `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" <name>`.

**Orphan sweep (off by default).** `<vault>/brain/_index/scanner-config.json` ships with `"autoSweepOrphans": false`. Set it to `true` and every `scan-vault` run (the SessionEnd hook, `aos scan-vault`, `aos init` / `aos upgrade`, and the Obsidian plugin's periodic snapshot refresh) removes the per-session side-folders Claude Code leaves behind — and nothing else. The sweep looks only at UUID-named directories directly under `session-env/` and `file-history/` in the Claude config dir recorded in `agenticos.json` at install (`~/.claude` unless `CLAUDE_CONFIG_DIR` was set when you ran `aos init`); it removes one only when that UUID has no `<uuid>.jsonl` transcript under any project in that config dir's `projects/`, only once the directory is older than `orphanUuidMinAgeMinutes` (60), and only when it is empty. With `sweepTransientResidue` on, a directory holding nothing but files matching `transientResiduePatterns` is removed too; the template ships that off (`false`, no patterns), but a hand-written `scanner-config.json` that omits both keys gets the code default — on, with the built-in `-hook-<n>.sh` pattern. If `projects/` itself cannot be read, the sweep does nothing and the snapshot's `maintenance.orphanSweep` carries `reason: "projects-unreadable:<code>"`, rather than treating an unreadable allow-list as an empty one. It never touches the vault (memory, notes, persona), Claude Code's transcripts, or anything outside a UUID-named orphan directory.

**Daily-note layout.** `dailyNote.layout` in `<vault>/brain/config.json` (default `{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md`; tokens `{yyyy}` `{MM}` `{MMMM}` `{dd}`) is the one place the layout lives: the scripts, the Obsidian plugin's Memory graph and the `daily-notes.json` that `aos init` writes all read it. Every surface lists exactly the notes that match it — recall, `session_list`, `/standup`, `/reflect-week`, the session count and streak in the snapshot, and the graph's session nodes. Change the layout after notes exist and the old notes drop out of all of them (the streak resets) until you move them into the new shape; a layout with no `{dd}` anywhere in it matches nothing (the day may sit in a folder segment, e.g. `{yyyy}/{MM}-{dd}/notes.md`); symlinked year or month folders are not followed; a `{MMMM}` folder must carry the full English month name. Obsidian's own daily-notes plugin cannot express a month sub-folder, so notes created from Obsidian land one level up (see step 2 above) and are not counted until moved.

## Providers

`auto` picks Ollama when it answers, else headless Claude (`claude -p --model haiku`, ≤ `claude.perCallUsd` per call and ≤ `claude.perDayUsd` per day, every call ledgered in `brain/_index/provider-spend.jsonl`), else `none`. Under `none` nothing calls a model in the background: summaries are heuristic, and `/wrap` extracts memories in your own session through the `wrap_session` tool. Install Ollama and pull the two models later (`sh extras/ollama/model-pull.sh`: the `qwen3.5:9b` workhorse and the `qwen3-embedding:0.6b` embedder) and `auto` switches over with no reconfiguration.

**The reasoner role.** `/ask-brain --local`, `/reflect-week`, `/consolidate-memory` and the Obsidian Chat tab call the *reasoner*, and the reasoner is a Claude model whatever `auto` resolved for the background hooks: `claude -p --model <reasoner.model> --effort <reasoner.effort>`, ≤ `reasoner.perCallUsd` per call and ≤ `reasoner.perDayUsd` per day, ledgered as `reason:<command>` rows that never count against `claude.perDayUsd`. When Claude is not logged in or the reasoner cap is reached and Ollama is up, the call falls back to the workhorse (the command's stderr says so); with neither, `--local` exits 1 and the default in-session mode still works. `provider: none` disables the reasoner like everything else. `BRAIN_REASONER=<model>` overrides the model for one run.

| Key | Default | Meaning |
|---|---|---|
| `reasoner.model` | `claude-opus-5` | The Claude model id (or alias) the reasoner runs on. |
| `reasoner.perCallUsd` | `0.5` | `--max-budget-usd` for one reasoner call. |
| `reasoner.perDayUsd` | `5.0` | Daily cap over `reason:*` ledger rows; at the cap the reasoner resolves to `none` (`reasoner-daily-cap`) until local midnight. |
| `reasoner.effort` | `medium` | `--effort` for the call: `low`, `medium` or `high`. |

**Ollama endpoint.** `ollama.host` / `ollama.port` in `agenticos.json` (or `brain/config.json`) outrank the `OLLAMA_HOST` / `OLLAMA_PORT` environment variables for every provider-routed call and for the `aos doctor` / `aos init` probe; the environment variables apply only when those keys are absent.

**What the Claude provider spends.** Under `claude`, a session end costs two to four Haiku calls (working-memory summary, memory extraction, correction check, scan insights when enabled) plus one call every ~5 turns for the summary — roughly a cent or two per session at the measured ~$0.0034 per call. When the day's hook spend reaches `claude.perDayUsd` (default 0.50) the provider resolves to `none` with reason `daily-cap` until local midnight: summaries fall back to heuristics and the pipeline ledger shows those stages gray (`skipped` / `disabled`), never red. `aos status` shows the running totals (hooks, duties, reasoner), each cap, the reasoner model, the resolved `claude` binary and the cached login state; `aos provider <mode>` clears that cache. Chat rows from the Obsidian plugin's Chat tab are reasoner calls (feature `reason:chat`) and count toward `reasoner.perDayUsd`; each cap is enforced the next time its provider resolves — the next hook run (a Stop or SessionEnd hook, or `aos scan-vault --quiet`) for the hook cap, the next reasoner command for the reasoner cap.

**In-session commands.** `/ask-brain`, `/standup`, `/reflect-week`, `/consolidate-memory` and `/compress` print an assembled context block by default and let Claude answer in your own session; that step persists nothing model-generated. The one write it may perform is recall's self-heal: a missing `brain/_index/recall-index.json` is rebuilt in pure Node, with no model call.

**Routines.** A `kind: prompt` routine (`brain/routines/<slug>.md`) runs headless Claude under its own caps: `routines.perRunUsd` per run (`budgetUsd:` in the file overrides it) and `routines.perDayUsd` per day, summed over the `routine:*` ledger rows; a capped day skips the run and records why in `brain/_index/routines.json`. `routines.tools` is the `--allowedTools` list those runs get (default `Read,Glob,Grep`). Duties keep the `persona.*` caps and `command` routines spend nothing. `routines.externalLabels` lists launchd labels the HUD's Routines tab shows read-only under "Outside the runtime". `aos upgrade` seeds `brain/routines/` once on a vault that predates routines and re-renders any installed schedule from the routine files.

## Update checks

### `updates`

| Key | Default | Meaning |
|---|---|---|
| `updates.check` | `true` | Whether to check GitHub Releases for a newer version. |
| `updates.intervalHours` | `24` | Minimum hours between checks. Doubles on consecutive failures, capped at four doublings. |

Set in `brain/config.json`, or in `~/.claude/agenticos.json` to override it (`agenticos.json` wins).
`aos update-status --off` writes `updates.check = false` to `agenticos.json`. The check is
unauthenticated and sends nothing but an HTTP GET to `api.github.com`.

## Uninstall

`aos uninstall --keep-vault` leaves `~/.claude` as it was and keeps the vault. `aos uninstall` additionally deletes the vault after you type its path (or with `AOS_CONFIRM_DELETE=<vault>` for scripts). `--yes` skips the prompt and always keeps the vault; deletion needs the typed path or `AOS_CONFIRM_DELETE=<vault>`.

## Rehearsing an install without touching your machine

`sh cli/rehearsal/first-run.sh` does the whole first run in a temporary HOME and config dir with a fake `claude`, then checks recall and `wrap_session` over MCP and uninstalls. CI runs it on Ubuntu and macOS.
