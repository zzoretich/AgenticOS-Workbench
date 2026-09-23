# Install

AgenticOS Workbench runs on macOS and Linux with Node 20+, Claude Code and/or Codex CLI (logged in), Obsidian, Ollama, and python3 3.9+. All five are checked before `aos init` writes anything. **Windows is not supported in v1** (the launcher is POSIX `sh`, scheduling uses launchd/cron).

## Ten-minute path

```
git clone https://github.com/zzoretich/AgenticOS-Workbench.git
cd AgenticOS-Workbench
npm ci --ignore-scripts
npm run setup            # = node cli/aos.js init
```

While developing from a checkout, run `npm run setup -- --from-local .` so the plugin is installed from your clone rather than from GitHub.

`aos init` asks for a vault directory (default `~/AgenticOS`; it refuses `~/.claude` and any directory holding a `settings.json`) and then, in order:

1. **Preflight** — Node ≥ 20; the hosts (see [Hosts](#hosts)): `claude` on PATH and logged in (`claude auth status`) and/or `codex` on PATH and logged in (`codex login status`), at least one; Obsidian installed (the app bundle on macOS, `obsidian` on PATH or the Flatpak on Linux); Ollama installed (`ollama` on PATH or `Ollama.app`); python3 ≥ 3.9. A missing prerequisite exits 1 with an install hint and nothing is written; `--provider none` does not waive them. Whether Ollama answers on `127.0.0.1:11434` is printed, not required.
2. **Seed** — copies `vault-template/` (existing files are kept), writes `brain/config.json` from the shipped defaults, and `.obsidian/daily-notes.json` (folder = the current year, format `YYYY-MM-DD` — Obsidian cannot express the month sub-folder of the default layout, so daily notes created from Obsidian land one level up; notes created by the scripts use the full layout). `aos init` and `aos upgrade` rewrite that file each run from `dailyNote.layout`, and its folder is the year at that moment — run `aos upgrade` after New Year, or set the folder yourself under Obsidian → Settings → Daily notes.
3. **Vendor the runtime** — `brain/scripts` (without tests or a lockfile) into `<vault>/brain/scripts`, plus `cli/*.js` (the `aos` subcommands — `aos.js`, `persona-cmd.js`, `schedule.js`, `routines.js`, `cost-cmd.js`; no tests, fixtures or rehearsal), the persona templates (`vault-template/persona/` → `brain/scripts/persona/templates/`), the schedule and cost sources (`extras/{schedule,cost}/` → `brain/scripts/extras/`, without the python tests) and the `aos` launcher; then `npm install --omit=dev` there (two dependencies, pinned by `^` ranges); symlink `~/.local/bin/aos` → `<vault>/brain/scripts/bin/aos`. `aos upgrade` refreshes the same set, and `aos doctor` checks that the persona and schedule pieces are present.
4. **`~/.claude/agenticos.json`** — vault, node path, config dir, the resolved `claude` path (`claude.bin` — hooks, the MCP server and the Obsidian plugin spawn it without a login shell; `aos upgrade` re-resolves it, and a recorded path that no longer exists is ignored), the `hosts` block (which of Claude Code and Codex are wired, their config dirs and binaries), provider (`auto`), spend caps, telemetry, cost, persona flags. Honors `CLAUDE_CONFIG_DIR` (and `AOS_CONFIG` for an explicit file path — the same rule every hook and `aos` subcommand uses).
5. **Plugin** (Claude Code host) — `claude plugin marketplace add zzoretich/AgenticOS-Workbench` then `claude plugin install agenticos@agenticos-workbench`. With `--from-local <repo-dir>` the marketplace source is your checkout. **Codex host** — `codex plugin marketplace add zzoretich/AgenticOS-Workbench` (your checkout with `--from-local`) then `codex plugin add agenticos@agenticos-workbench`, when the Codex CLI installs plugins; otherwise the direct wiring: five hook entries merged into `<codex home>/hooks.json`, `codex mcp add agenticos --env AOS_CONFIG=<agenticos.json> --env AOS_HOST=codex -- sh <vault>/brain/scripts/bin/aos mcp-server`, and the 17 commands plus 6 skills generated into `~/.agents/skills/<name>/SKILL.md` from the vendored `brain/scripts/plugin/`; see [Hosts](#hosts).
6. **Obsidian bundle** — `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/agentic-os/` from the checkout's build, else built with `npm run build -w obsidian-plugin`, else downloaded from the matching GitHub release (no GitHub release exists until the release workflow ships in a later phase, so today that fallback prints a warning; build locally instead). `--no-obsidian` skips it; `--terminal` also installs the embedded terminal's native module (`aos terminal install` later does the same).
7. **Chief of Staff interview** — names your agent and writes `<vault>/persona/` (identity, state, playbook, three duties, a proposals README); with `schedule: yes` it also installs the three duties' schedules — each duty is a routine file seeded at `brain/routines/<duty>.md`, rendered to launchd on macOS or crontab on Linux; `aos routines` manages them afterwards. `--persona-json <file>` answers it non-interactively (fields `name`, `addressAs`, `voice`, `priorities`, `dutyModel`, `dutyEffort`, `schedule`) — use it in CI and wherever stdin is not a terminal. With `--yes` (or no terminal) and no `--persona-json`, init reuses `<vault>/persona/answers.json` from an earlier run, or skips the interview with a note and continues; run `aos persona` later. Details: `docs/chief-of-staff.md`.
8. **First scan** — `scan-vault`, `build-brain-md`, `recall --warm`.
9. **Checklist** — every file written, the line to add to your `CLAUDE.md` (Claude Code), the hook entries to trust under `/hooks` (Codex), and how to open the vault.

Then add the printed line to `~/.claude/CLAUDE.md` (the installer never edits it):

```
@/path/to/AgenticOS/AGENTICOS.md
```

Under Codex there is nothing to paste: a SessionStart hook injects `AGENTICOS.md` itself. Open `codex`, run `/hooks`, and trust the agenticos entries once.

Open the vault in Obsidian ("Open folder as vault"), enable **Agentic OS** under Community plugins, and start a new `claude` or `codex` session: the first prompt receives `<brain-context>`, `/wrap` (`$agenticos:wrap` under Codex) writes memories, and the `agenticos` MCP server answers `recall`.

Flags: `--vault <dir>`, `--host auto|claude|codex|both` (default `auto`: an existing install keeps its selection, a fresh one wires every host that is installed and logged in), `--provider auto|ollama|claude|codex|none`, `--no-obsidian` (skip building or downloading the HUD bundle; Obsidian must still be installed), `--terminal`, `--cost` (installs the cost module), `--persona-json <file>`, `--from-local <repo-dir>`, `--dry-run` (prints the numbered plan, writes nothing; accepted only by `init`), `--yes` (accept defaults, no prompts). `--flag=value` works too. Any unknown or misspelled flag is a usage error (exit 2), so a typo never starts a real install. Re-running `aos init` on an existing vault keeps your files and your provider setting; only an explicit `--provider` changes it.

## After install

| Command | Does |
|---|---|
| `aos doctor` | Node, Obsidian app, Ollama installed, python3 ≥ 3.9 (all fail rows), `agenticos.json`, `AOS_VAULT`/`BRAIN_VAULT` when set (warn if the directory is missing), vault layout, MCP answering (a real stdio handshake), Obsidian bundle (warn), Ollama answering (warn, `run ollama serve`), cost analyzer (when cost is on); for the Claude host: claude login, `claude.bin` (warn when the recorded path is no longer an executable file), plugin installed, MCP declared; for the Codex host installed as a plugin: codex login, `codex plugin` (installed, its version), `codex hooks trusted` (how many of its 15 hook entries Codex trusts; a warn row until you review them under `/hooks`, because until then they do not run), `codex MCP declared` (the plugin's server, `./bin/aos` with `AOS_HOST=codex`), and a `codex direct wiring` warn row when direct entries are still present beside the plugin; with direct wiring: codex login, the five hook entries, the MCP registration (warn when it predates 0.7.0 and lacks `AOS_HOST=codex`; `aos upgrade` re-registers it), the generated skills; for either, an info row when Codex's own memories feature is on; then `persona runner` and `routines runner`, the CLI each headless job resolves to (warn when none). Exit 1 when a check fails. |
| `aos status` | the enabled hosts; resolved provider and reason; the resolved `claude` and `codex` binaries and cached login states; today's spend on four lines — hooks against `claude.perDayUsd`, persona duties (`duty:*` ledger rows) against `persona.perDayUsd`, the reasoner (`reason:*`) against `reasoner.perDayUsd`, prompt routines (`routine:*`) against `routines.perDayUsd`; the pipeline ledger |
| `aos provider <mode>` | force `ollama`, `claude`, `codex`, `none`, or back to `auto`; clears the cached probe |
| `aos upgrade` | `claude plugin marketplace update` + `plugin update`, re-vendor the runtime and bundle, refresh the Codex host when it is enabled (the plugin: the marketplace is refreshed — switched to your checkout under `--from-local` — and the plugin reinstalled, then any direct wiring removed; a Codex CLI without plugins: hooks re-merged, MCP registration checked, skills regenerated), add new config keys (your values win), rebuild indexes. Never touches memory, notes, or persona. Runs the CLI that ships with the source it upgrades from (the launcher execs the vault's previous copy), so a step that is new in that release runs the first time. |
| `aos uninstall [--keep-vault]` | plugin and marketplace removed (a failed or skipped `claude plugin …` step is reported on stderr with the command to run yourself), the Codex host unwired when it is enabled (`codex plugin remove agenticos@agenticos-workbench` and `codex plugin marketplace remove agenticos-workbench`, or the direct wiring: our hook entries, `codex mcp remove agenticos`, the generated skills; foreign hooks and skills stay), `aos uninstall --host claude|codex` unwires one host only and keeps everything else, every routine schedule removed (the `com.agenticos.<slug>` plists or tagged crontab lines, the pre-routines `com.agenticos.monitor|reflect|sitrep` labels included), `~/.local/bin/aos` and `agenticos.json` removed; the vault is deleted only if you type its path back, and never when it is your home directory or a Claude config directory. The optional Ollama supervisor (`com.agenticos.ollama`, see `extras/ollama/README.md`) is installed by hand and is left alone. |
| `aos persona on\|off\|rename <name>` | kill switch (`persona/DISABLED` only — `persona.enabled` in `agenticos.json` is left alone) and rename; plain `aos persona` re-runs the interview, prefilled from `persona/answers.json` |
| `aos cost enable [--budget <usd>]` | opt-in session costing — see `docs/cost.md`; `aos cost disable` turns it off and leaves the installed files |
| `aos terminal install` | node-pty for the Obsidian terminal tab |
| `aos workspace list\|new <name>\|adopt <path> [--name <slug>]` | the projects under `<vault>/workspaces/`: `list` shows status and per-host session counts (from the last snapshot, else a fresh scan) and every working directory sessions ran in outside `workspaces/`; `new` creates a kebab-case workspace with `README.md`, `CLAUDE.md` and an identical `AGENTS.md`; `adopt` moves an existing project directory in (refusing the vault, the config dirs, the home directory and an existing target), mirrors whichever instruction file it has into the other, and adds the missing stubs. A nested git repository stays its own repo. |

Every runtime script is also reachable as `aos <name>` (`aos scan-vault`, `aos recall "<query>"`, `aos build-brain-md`, …); the same launcher is what the plugin's hooks call as `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" <name>`.

**Orphan sweep (off by default).** `<vault>/brain/_index/scanner-config.json` ships with `"autoSweepOrphans": false`. Set it to `true` and every `scan-vault` run (the SessionEnd hook, `aos scan-vault`, `aos init` / `aos upgrade`, and the Obsidian plugin's periodic snapshot refresh) removes the per-session side-folders Claude Code leaves behind — and nothing else. The sweep looks only at UUID-named directories directly under `session-env/` and `file-history/` in the Claude config dir recorded in `agenticos.json` at install (`~/.claude` unless `CLAUDE_CONFIG_DIR` was set when you ran `aos init`); it removes one only when that UUID has no `<uuid>.jsonl` transcript under any project in that config dir's `projects/`, only once the directory is older than `orphanUuidMinAgeMinutes` (60), and only when it is empty. With `sweepTransientResidue` on, a directory holding nothing but files matching `transientResiduePatterns` is removed too; the template ships that off (`false`, no patterns), but a hand-written `scanner-config.json` that omits both keys gets the code default — on, with the built-in `-hook-<n>.sh` pattern. If `projects/` itself cannot be read, the sweep does nothing and the snapshot's `maintenance.orphanSweep` carries `reason: "projects-unreadable:<code>"`, rather than treating an unreadable allow-list as an empty one. It never touches the vault (memory, notes, persona), Claude Code's transcripts, or anything outside a UUID-named orphan directory.

**Daily-note layout.** `dailyNote.layout` in `<vault>/brain/config.json` (default `{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md`; tokens `{yyyy}` `{MM}` `{MMMM}` `{dd}`) is the one place the layout lives: the scripts, the Obsidian plugin's Memory graph and the `daily-notes.json` that `aos init` writes all read it. Every surface lists exactly the notes that match it — recall, `session_list`, `/standup`, `/reflect-week`, the session count and streak in the snapshot, and the graph's session nodes. Change the layout after notes exist and the old notes drop out of all of them (the streak resets) until you move them into the new shape; a layout with no `{dd}` anywhere in it matches nothing (the day may sit in a folder segment, e.g. `{yyyy}/{MM}-{dd}/notes.md`); symlinked year or month folders are not followed; a `{MMMM}` folder must carry the full English month name. Obsidian's own daily-notes plugin cannot express a month sub-folder, so notes created from Obsidian land one level up (see step 2 above) and are not counted until moved.

## Hosts

A *host* is the agent CLI a session runs under; a *provider* is the model that answers background questions. They are independent: a Codex-only machine can still use Ollama, and a two-CLI machine keeps one vault, one memory pipeline and one set of hooks.

**Three modes, one runtime.** Claude Code only, Codex only, or both on one vault behave the same: context on the first prompt, working memory on every stop, telemetry, costing and memory extraction at the end, the Chief of Staff and the routines in between. What differs is only how each host is wired (below) and how the runtime learns which host it is serving:

1. `AOS_HOST` in the environment — set by every Codex hook entry and by the Codex MCP server's entry, in the Codex plugin and in the direct wiring alike (the Claude Code plugin sets nothing and is the default);
2. else Claude Code's own hook environment (`CLAUDE_PROJECT_DIR`);
3. else the session transcript named in the hook payload (`rollout-*.jsonl` under the Codex home is Codex; a file under `<claude config dir>/projects/` is Claude Code);
4. else the `hosts` block when exactly one host is enabled;
5. else Claude Code.

`AOS_DEBUG=1` prints the chosen host and the rule that chose it. Related keys in `brain/config.json`: `telemetry.staleAfterMinutes` (default 30: a live run idle that long is reconciled, see below), `persona.runner` and `routines.runner` (`auto` | `claude` | `codex`, which CLI runs duties and prompt routines).

| Key | Meaning |
|---|---|
| `hosts.claude.enabled` | Claude Code is wired: the plugin is installed, doctor checks its login and plugin, `CLAUDE.md` is expected. |
| `hosts.claude.configDir` · `hosts.claude.bin` | Its config dir (mirrors `claudeConfigDir`) and the resolved CLI (mirrors `claude.bin`). |
| `hosts.codex.enabled` | Codex CLI is wired (below). Also what lets the `codex` provider join the `auto` chain. |
| `hosts.codex.home` · `hosts.codex.bin` | Its home (`CODEX_HOME`, default `~/.codex`) and the resolved CLI. |
| `hosts.codex.install` | `plugin` or `direct`: how the host is wired (below). Written by `aos init` and `aos upgrade`. |

**The Codex plugin.** When the Codex CLI installs plugins (`codex plugin list --json` answers), `aos init --host codex` installs `agenticos@agenticos-workbench` from this repository's marketplace. Codex reads `.agents/plugins/marketplace.json` before `.claude-plugin/marketplace.json`, so the one repository gives Claude Code `plugin/` and Codex `codex-plugin/`. `codex-plugin/` is generated from `plugin/` by `npm run build:codex-plugin` and committed; a test fails when it drifts. It carries:

- `hooks/hooks.json` — the same entries as the direct wiring below, each command `env AOS_HOST=codex sh "${PLUGIN_ROOT}/bin/aos" <name>`. Codex expands `${PLUGIN_ROOT}` to the installed plugin folder but checks trust against the command as written, so a trusted entry stays trusted when the plugin is upgraded.
- `.mcp.json` — the `agenticos` server as `sh ./bin/aos mcp-server` with `cwd: "."` (Codex expands no variable in MCP arguments and resolves `.` to the plugin folder), `AOS_HOST=codex`, and `AOS_CONFIG` / `CLAUDE_CONFIG_DIR` passed through when you set them.
- `bin/aos` — the launcher, a byte copy of `plugin/bin/aos`. Nothing in the plugin names a path on your machine: the launcher finds `agenticos.json` the way it always does (`AOS_CONFIG`, else `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`).
- `skills/` — the 17 commands and 6 skills of `plugin/` as Codex skills, listed as `agenticos:<name>` (`$agenticos:wrap`, `$agenticos:remember`, …), with every Claude Code idiom rewritten; the launcher is `<plugin root>/bin/aos`, two folders above each skill's folder.

Once the plugin is installed, `aos init` and `aos upgrade` remove any direct wiring (below) so the two never run side by side, and an existing direct install moves over on its next `aos upgrade`. A plugin install that fails falls back to the direct wiring, and the next upgrade tries again.

**What the direct wiring writes** (a Codex CLI without plugins). Codex has a hook system shaped like Claude Code's, so the runtime is shared and only the wiring differs:

- `<codex home>/hooks.json` — one entry per event (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd), every command `env AOS_HOST=codex AOS_CONFIG='<agenticos.json>' sh '<vault>/brain/scripts/bin/aos' <name>`. That prefix is how `aos` recognises its own entries: your own hooks in the same file are never touched, and the file is deleted on uninstall only when nothing else is left in it. SessionEnd entries carry Codex's 3 s cap (every handler hands its work to a detached process). SessionStart additionally runs `inject-conventions`, which prints `AGENTICOS.md` as session context on startup, resume, clear and after compaction — Codex's `AGENTS.md` has no include syntax.
- `codex mcp add agenticos …` — the same MCP server, registered in Codex's `config.toml`; its tools appear as `mcp__agenticos__<tool>`. Every read tool advertises the read-only annotation Codex needs to call it inside a sandbox without an approval prompt.
- `~/.agents/skills/<name>/SKILL.md` — one skill per plugin command and skill (`$wrap`, `$remember`, `$recall`, …), generated from the vendored `brain/scripts/plugin/` with every Claude Code idiom rewritten (launcher path, config path, MCP tool names, arguments). A generated file carries a marker comment; a skill directory of the same name that you wrote yourself is left alone and reported.

**Trust.** Codex quarantines hooks until you have reviewed them: open `codex`, run `/hooks`, and trust the agenticos entries once. They keep their trust across `aos upgrade` because the command text never changes (plugin entries never name a path; direct entries name the vault's launcher, so only moving the vault changes them). Moving from direct wiring to the plugin asks once more, since the entries themselves are new.

**What differs from Claude Code.** Codex reports tool payloads as JSON strings (handled); fires SessionEnd late in its TUI (thread close or archive, or 30 minutes idle) and, depending on the version, not at all when `codex exec` exits (0.144 did not, 0.155 does); and keeps its own built-in *memories* feature, which `aos` neither reads nor disables (doctor shows an info row when it is on). The late SessionEnd is covered by `reconcile-sessions`, a hook on SessionStart and Stop of both hosts: it finds every live run whose telemetry, live file and transcript have all been idle for `telemetry.staleAfterMinutes`, closes the run (ended at the transcript's last change), then costs and wraps it exactly as SessionEnd would have. A real SessionEnd that arrives later finds nothing to do. `$wrap` in-session is always immediate.

**Headless jobs on Codex.** The Chief of Staff duties and `prompt` routines run through `claude -p` when the Claude host is enabled and the CLI resolves, otherwise through `codex exec -` (prompt on stdin, `workspace-write` sandbox, our hooks off, JSON events on stdout). Codex has no per-run budget flag and no tools allowlist: the daily caps (`persona.perDayUsd`, `routines.perDayUsd`) still gate every start, the spend is *estimated* from the usage block and ledgered with `provider: "codex"`, and the sandbox is the guard. `persona.runner` / `routines.runner` (or `AOS_RUNNER` for one run) pin a CLI; `aos doctor` shows the resolved runner per kind, and `run-duty.sh <duty> --dry-run` prints the exact command. The HUD's Chat tab still runs through the `claude` CLI and stays inactive on a Codex-only machine.

## Providers

`auto` picks Ollama when it answers, else headless Claude (`claude -p --model haiku`, ≤ `claude.perCallUsd` per call and ≤ `claude.perDayUsd` per day, every call ledgered in `brain/_index/provider-spend.jsonl`), else headless Codex when Codex is an enabled host (`codex exec` with the prompt on stdin, ephemeral, read-only, hooks off; the spend is *estimated* from the usage block, since Codex reports tokens and never dollars, and ledgered the same way against `codex.perDayUsd`), else `none`. Under `none` nothing calls a model in the background: summaries are heuristic, and `/wrap` extracts memories in your own session through the `wrap_session` tool. Install Ollama and pull the two models later (`sh extras/ollama/model-pull.sh`: the `qwen3.5:9b` workhorse and the `qwen3-embedding:0.6b` embedder) and `auto` switches over with no reconfiguration.

**The reasoner role.** `/ask-brain --local`, `/reflect-week`, `/consolidate-memory` and the Obsidian Chat tab call the *reasoner*, and the reasoner is a Claude model whatever `auto` resolved for the background hooks: `claude -p --model <reasoner.model> --effort <reasoner.effort>`, ≤ `reasoner.perCallUsd` per call and ≤ `reasoner.perDayUsd` per day, ledgered as `reason:<command>` rows that never count against `claude.perDayUsd`. When Claude is not logged in or the reasoner cap is reached and Ollama is up, the call falls back to the workhorse (the command's stderr says so); with neither, `--local` exits 1 and the default in-session mode still works. `provider: none` disables the reasoner like everything else. `BRAIN_REASONER=<model>` overrides the model for one run.

| Key | Default | Meaning |
|---|---|---|
| `reasoner.model` | `claude-opus-5` | The Claude model id (or alias) the reasoner runs on. |
| `reasoner.perCallUsd` | `0.5` | `--max-budget-usd` for one reasoner call. |
| `reasoner.perDayUsd` | `5.0` | Daily cap over `reason:*` ledger rows; at the cap the reasoner resolves to `none` (`reasoner-daily-cap`) until local midnight. |
| `reasoner.effort` | `medium` | `--effort` for the call: `low`, `medium` or `high`. |

**The Codex provider.** `codex.model` (default `null`: no `-m` is passed, so Codex uses the model its own config selects), `codex.perCallUsd` (`0.05`, an estimate ceiling — Codex has no budget flag) and `codex.perDayUsd` (`0.5`, over the same hook ledger). `AOS_CODEX_MODEL` overrides the model for one run. Rates live in `brain/scripts/sdk/lib/codex-pricing.js` and are estimates to verify against the published price list.

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

`sh cli/rehearsal/first-run.sh` does the whole first run in a temporary HOME and config dir with a fake `claude`, then checks recall and `wrap_session` over MCP and uninstalls. `sh cli/rehearsal/codex-host.sh` does the same for a Codex-only machine with a fake `codex`: it installs the direct wiring on a CLI without plugins and runs its hook commands for real (the conventions injection, the Stop hook's `{}`, the first-prompt context), then upgrades to the Codex plugin, checks that the direct wiring is gone, runs the plugin's own hook commands the way Codex runs them and completes an MCP handshake from the plugin folder, then doctor and uninstall. CI runs both on Ubuntu and macOS.
