# Changelog

All notable changes to AgenticOS Workbench. Versions follow the tags. From the next release on, each version's section is also its GitHub release notes, and an **Upgrading** subsection lists anything you need to do after `aos upgrade`.

## [Unreleased]

### Fixed
- On a machine without Codex, the Routines tab no longer asks the runtime for Codex's automations every minute while it is open (each ask raised a notice). It asks only where Codex is a session host.
- The nightly and weekly reflect duties can promote a repeated correction into a feedback memory again. Since the duty write scope (0.14.0) they were refused `brain/memory/feedback/` and `MEMORY.md`, journaled the block and raised a flag in `persona/STATE.md` on every run that tried. Both duties now get those two paths, and nothing else in `brain/memory/`. Codex cannot grant a single file at the vault root, so after a clean reflect run the runner adds the `MEMORY.md` line of each new feedback memory the duty did not index, on both hosts.

## [0.21.0] — 2026-09-28

### Added
- **The status line** (`aos statusline install`, opt-in). Claude Code gets three lines: model and effort, the task in progress (else the GSD phase), branch and PR; context, rate limits, cost, prompt cache and lines changed; and, only when something needs you, the gates waiting on you, unread breaking news and alerts, open flags, a live agent-team run, the spend nearest its daily cap, an update, a provider that fell to none or an unwrapped session, each a link to the Workbench tab that handles it. The status line you had is recorded and chained (it still runs, with the same input) and `aos statusline uninstall` puts it back, byte for byte when nothing else in the file changed. Subagents get their own rows. Codex runs no status line command, so install writes a preset of its built-in items into `config.toml`, never over one you set without `--force`, and what needs you is printed at session start. `aos doctor` and the next session start say when another installer took the slot; `aos upgrade` keeps an installed line pointed at the current runtime and never takes a lost slot back. Settings: `statusline.segments`, `statusline.links`, `statusline.subagents`, `statusline.refreshSeconds`, `statusline.codexItems`.
- `obsidian://agenticos?tab=<tab>` opens the Workbench on a tab.

### Changed
- The Obsidian status bar shows what needs you (gates, alerts, flags, a live run, spend near its cap, health), each opening where it is handled, instead of inventory counts; a vault whose runtime predates the status line keeps the counts.

### Fixed
- Opening a Workbench tab from a command or link right after Obsidian starts (a deferred leaf) now lands on that tab.
- `idle` in the Obsidian status bar is dimmed.

## [0.20.3] — 2026-09-28

### Changed
- The Agent Teams tab hands the next step to the team's lead. After you approve a gate, or raise the budget of a paused item, the tab opens the lead in the terminal with a prompt saying what you decided, that it is already recorded, and how to run `aos team` for this vault: its agent on the lead's own provider when that host is enabled and has it, else another enabled host. The Approve dialog says where it opens; where no enabled host has the lead's agent, a plain session opens, told which lead to act as and where the team's rules are. If no terminal can start, the command is copied to the clipboard and shown in a notice that stays until you dismiss it. The lead still picks the next seat; the tab never dispatches one. Before, the item waited with the lead as its owner until someone started the lead.

## [0.20.2] — 2026-09-28

### Changed
- Update notices count the Workbench. The installed version was the lower of the Claude Code or Codex plugin and the vault's runtime, so a Workbench an upgrade could not replace looked current. It now also counts the Obsidian plugin's own `manifest.json` in the vault, read at every check and session start: the notice names it ("plugin 0.20.1, vault 0.20.1, Workbench 0.20.0"), and the statusline and the Workbench's update badge stay on until it is replaced. A Workbench whose `manifest.json` is missing or invalid counts as an incomplete install ("Workbench incomplete"), and `aos upgrade` refreshes the update check before rescanning, so the badge is right as soon as it finishes. A vault without the Workbench (`aos init --no-obsidian`) is judged as before.

## [0.20.1] — 2026-09-28

### Fixed
- `aos upgrade --from-local` no longer installs an old Workbench. The Obsidian bundle's `main.js` is a build output kept out of git, and the upgrade built it only when it was missing, so a checkout holding one from an earlier build installed that old code beside the new `manifest.json` and `styles.css` (0.20.0 showed no Agent Teams tab). A checkout with its dependencies installed now always rebuilds; a `main.js` older than the plugin's sources is never installed, and the upgrade says why and tries the release bundle instead.

## [0.20.0] — 2026-09-28

### Upgrading
- Add `persona/teams/*/running/` to your vault's `.gitignore` (new vaults get it): a live agent-team run's marker exists only while the run is going.
- Add `*.lock` and `*.tmp` to your vault's `.gitignore` (new vaults get them): a writer's lock and temp files exist only for the moment of a write, but an auto-backup at that moment would commit them.

### Added
- **Agent teams** (`aos team`, `/team` · `$agenticos:team`): named teams in `persona/teams/<team>/` with a roster (`TEAM.md`), a work board, a team thread and a run log. A lead moves items through stages and gates and dispatches headless seats, each in its own git worktree, on the provider its `TEAM.md` row names; a reviewer marked `opposite` runs on the provider that did not build the work. Gates, budgets, pausing and roster changes are the user's decisions and are refused under `AOS_HEADLESS=1`, and every board write can be a compare-and-set with `--expect`. A killed run still leaves a trace (a live-run marker, signal traps, a sweep), `dispatch --detach` hands a run to launchd or a systemd user unit, and `aos team wait` tells a lead's caller when a run ended. Spend is recorded as `team:<team>:<member>` (Codex priced from tokens), shown by `aos status` and kept out of the hook cap; each item's phase budget caps its Claude spend. A team's lead joins the Runs tab's orchestrator roster, so its seats roll up under it. `aos team init` seeds an example team. Only a clean, successful seat run merges into the item's trunk; the lead takes held work with `aos team merge`, and parallel seats split an item's budget with `--max-usd`.
- **The Agent Teams tab** in the Workbench (⁂, after Agents): the gates waiting on you across every team come first, each with the lead's case, the spend, budget presets and − / +, **Approve** and **Redirect** (which opens the lead in the terminal to take your note). Then one team at a time: its work board by stage, with each item's detail, posts, runs and budget; its roster, with what each member is doing and a button to talk to it on each host; its channel, with a message box to the lead; and Manage, where provider, model and effort are pickers, pausing is a switch, and members are added from your agents. The tab reads `persona/teams/` itself and writes only through `aos team`, sending the state it showed so a stale card is refused, and the rail badge counts pending gates.
- `summary.everyPrompts` (default 10) and `summary.minMinutes` (default 15): how often the working-memory summary refreshes BRAIN.md's Last Session, as pickers in ⚙ Settings → Memory & scanning.

### Changed
- `aos team list` lists a team whose `TEAM.md` cannot be read as a row with its error instead of failing, and `aos team list --json` names the presets `aos team set` accepts.
- The `feedback_rules` MCP tool returns an index of the active rules (path, title, one-line description, updated), newest first; `full: true` adds each rule's text and `limit` keeps the newest. On a vault with 70 rules one call went from about 20k tokens to about 5k. `feedback-review` asks for the text; `cross-review` reads the index and then only the rules it needs.
- `memory_list` returns the same kind of index grouped by type, with `type` and `limit` filters, instead of every memory's frontmatter; `session_recall` cuts a daily note at `maxChars` (default 24,000) and says how to read the rest. Every MCP tool's JSON is compact.

### Fixed
- A row appended to a log whose last line has no newline (a crash mid-append, a hand edit) is no longer joined to that fragment and lost with it: every JSONL writer now starts the row on a line of its own. On a team board this was a gate approval that reported success while the gate stayed pending.
- Files the runtime changes from several processes at once no longer lose a write. `routines.json` (a routine's run against `aos routines sync`, which wrote back a state it read before installing the schedules), `MEMORY.md`, `SESSION.md`, BRAIN.md's Last Session (against the BRAIN.md compile) and the daily note are now changed under a lock, as they are at that moment; every writer that used a shared `<file>.tmp` has a temp name of its own.
- A session's cost is counted once. The cost sync used to rewrite `runs.jsonl` to patch the whole session's cost into every row of the session, so a session with two runs counted twice ($213 on one vault), and a run that ended while it rewrote the file could be lost. Costs now go to their own log, `brain/_index/agent-runs/costs.jsonl`, and `runs.jsonl` is only ever appended to (retention prunes both under a lock the writers wait on). The Workbench's Runs tab, Cost panel, Fix Queue and the monthly budget read the two together: the session's cost on its latest run, its earlier runs at $0 pointing to it. Rows costed before this release are read the same way; nothing is rewritten.
- One session no longer turns into several runs, each wrapped as if it were the whole session. The Workbench's load-time sweep read the telemetry hook's own process id, which is always gone, so it marked every session idle for 5 minutes "crashed", and the session's next tool call started a new run. The plugin now runs the runtime's own reconcile instead (idle past `telemetry.staleAfterMinutes`, or a Codex process that exited). A session that goes on after its run was closed is recorded as a second segment with its own run id and timeline instead of overwriting the first, and auto-wrap keeps a per-session offset, so a later wrap of the same session extracts only what is new and skips when nothing is.
- The working-memory summary ran every few minutes in a busy session and not at all in the next one. It counted every user-role entry, and Claude Code writes each tool result and slash command as one (43 for 2 prompts in one transcript), against a single marker per day shared by every session. It now counts only the prompts you type, keeps one marker per session on both hosts, and runs every 10 prompts at most every 15 minutes.
- `feedback_rules` and `memory_list` no longer return the correction detector's unreviewed drafts (`brain/memory/feedback/_drafts/`) as rules and memories.
- The terminal no longer leaks listeners. Every visit to Pulse or Term left three terminal-pool listeners behind for as long as Obsidian ran, and a closed panel kept redrawing its tabs; each panel now removes its own when it closes.
- The Pulse command deck's `/reflect` only printed a prompt meant for a session and wrote nothing. It is now `/reflect-week` and writes this week's reflection to `brain/reflections/` in one click through the model provider (the reasoner model, within `reasoner.perCallUsd` and `reasoner.perDayUsd`); the notice shows the saved path, or why no model was available.
- The deck's `/remember` and `/pattern` filed a feedback memory. `/remember` now adds the note to `SESSION.md` with `#promote`, under "Things to Remember" (or "Promote to Memory on Close" for a `feedback:`, `project:` or `pattern:` note), and `/pattern` adds a pattern to `brain/patterns/<area>.md`, listing a new area file in `MEMORY.md`, the same as the in-session `/remember` and `/pattern`.
- A deck command that reports on stderr (as the runtime scripts do) shows that line in its success notice instead of "ok".

## [0.19.2] — 2026-09-24

### Fixed
- BRAIN.md no longer stops updating when active projects outgrow its 850-token budget. Session-end extraction files every new project as active, and the compiler used to fail once they crowded out the "Last Session" block, so every session started with the old BRAIN.md. It now lists active projects newest first (by `updated`), keeps as many as fit, and ends the list with "…and N older active projects" pointing at `brain/_index/MOC-projects.md`. Only pinned rules that overflow on their own still fail the build. The pipeline ledger records the count as `activeProjectsOmitted`.
- ⚙ Settings' Codex model pickers now list the models your Codex offers (GPT-6 and GPT-5.6 included), read from Codex's own `models_cache.json`, which Codex keeps current; without a Codex cache they fall back to the pricing table's list.

## [0.19.1] — 2026-09-24

### Fixed
- ⚙ Settings said "no `aos config`, run `aos upgrade`" on 0.19.0: `aos` exited before a pipe had taken all its output, so the Workbench read `aos config list --json` cut off at 64 KB. Every `aos` command now exits only after its output is flushed, and the tab names the real reason when the output does not parse.

### Added
- Duty model and effort are settings: `aos config set persona.model <model>` and `aos config set persona.effort low|medium|high`, then `aos routines sync`. They win over the interview's answers, which stay the fallback; the Codex duty model stays `persona.codexModel`.
- One duty can run on its own model: `model:` and `effort:` in `brain/routines/<duty>.md` override the schedule's for that duty (for example the hourly tick on `haiku`, the weekly reflect on a bigger model). The Workbench Routines tab accepts them too.

### Upgrading
- Nothing to do. To move the duties to another model, set `persona.model` and run `aos routines sync`; raise a duty's `budgetUsd` in its routine file if the new model costs more per run (the hourly tick's is 0.10 USD).

## [0.19.0] — 2026-09-24

### Added
- ⚙ Settings has no text boxes: every setting is a toggle, a preset picker, chips or a button. Numbers also step with − / + to the next preset; model pickers list each host's models (Codex's from its pricing table); lists are chips; `quickLinks`, the roster and external labels open `brain/config.json`, and skill and agent exclusions open their tabs. A value set outside the presets is shown as "(custom)" and never changed by opening the tab; set any value with `aos config set`. Obsidian's own settings pane gets the same pickers.
- `aos config list --json` rows carry `choices`, `unit`, `pick` and `editIn`.
- **Notifications.** Agents, routines and duties on either host post with `aos notify post`. Each post is a Markdown note under `brain/notifications/`, with a level (`breaking`, `alert`, `edition`, `info`), optional tags and allow-listed actions.
  - A new Workbench **Notifications** tab lists the items with an unread badge (rose while a breaking item is unread), filters by view, level and sender, and read, archive and open-note controls.
  - Actions: **ask** runs a named skill in a new Claude Code or Codex session, and **react** records a +1/−1 the sender can read back.
  - `breaking` and `alert` items raise a desktop notification.
  - `/notifications` (Claude Code) and `$agenticos:notifications` (Codex) do the same from a session.
  - New settings: `notifications.osAlert`, `notifications.retentionDays` and `notifications.maxPerSenderPerHour`.
  - `recallRoots` now includes `brain/notifications`, so past items are searchable.

## [0.18.0] — 2026-09-24

### Added
- ⚙ Settings, pinned to the bottom-left of the Workbench rail: every setting of the whole system in one tab, built from `aos config`. Master switches head it; each row shows where its value comes from (this machine, this vault or the default), when a change applies, and a ↺ to go back to the default; spend limits show today's spend against the cap. A change runs `aos config set`, so a refused value is explained under its field; raising spend or widening an agent's autonomy asks first; a step a change leaves (`aos routines sync`) waits as a button, counted on the ⚙ badge. Also "Open Workbench: Settings" in the command palette and a button in Obsidian's settings pane.
- `aos config list --json` rows carry `host` (a Claude- or Codex-only setting) and `spentToday` (on each daily cap).

### Changed
- The HUD's Cost and Telemetry toggles are now the system's own switches, `cost.enabled` and `telemetry.enabled`: turning Telemetry off stops the hooks recording, not just the HUD's view. The old HUD-only values are dropped from the plugin's `data.json`.
- The Workbench rail scrolls its tab buttons when the pane is short, so none is cut off.

### Upgrading
- If you turned the HUD's Cost or Telemetry toggle off without changing the system setting, check ⚙ Settings once after upgrading: the HUD now shows what the system does.

## [0.17.0] — 2026-09-24

### Added
- `aos config list | get | set | unset`: every setting in one place, with the file each value comes from. `set` validates the value, writes it atomically to the file that actually wins the merge, and runs the side effects the change needs. It works from a terminal, from `/aos config` in Claude Code and from `$agenticos:aos config` in Codex. First step toward the Workbench Settings tab.
- `aos doctor` has a `config` row that flags unknown keys (typos) and invalid values in `agenticos.json` and `brain/config.json`.

### Changed
- `persona.enabled` set through `aos config` is the whole Chief of Staff switch: `false` also pauses scheduled duties (`persona/DISABLED`). `aos persona on|off` still pauses duties alone.
- `scan.autoSweepOrphans` in the vault config now turns the orphan sweep on; a boolean in `brain/_index/scanner-config.json` still wins.
- Every writer of `agenticos.json` and `brain/config.json` (`aos provider`, `aos cost`, `aos graph`, `aos persona`, init and upgrade) writes atomically, so a hook never reads a half-written file.

### Fixed
- A daily cap of `0` now means no spend for `codex.perDayUsd`, `reasoner.perDayUsd`, `graph.semantic.perDayUsd` and `crossReview.perDayUsd`, as it already did for the Claude, persona and routine caps; it used to fall back to the default.

### Upgrading
- Run `aos upgrade`; until then the launcher answers `aos config` with `unknown script config`.

## [0.16.0] — 2026-09-23

### Changed
- Release notes come from this CHANGELOG; a release builds in a read-only job and publishes from a separate one, and every GitHub Action is pinned to a commit (#41).
- CI type-checks the HUD, lints the JavaScript (eslint) and the shell scripts (shellcheck), and runs every suite in two extreme time zones with host variables exported (#41).

### Fixed
- Codex sessions now close in telemetry as soon as the Codex process exits, instead of waiting out the stale-session timeout (#40).
- The MCP server reports the release version instead of 0.1.0: the runtime's own `package.json` is now bumped with every release (#41).
- An accepted proposal's own sub-headings now nest under its What and Why in `persona/backlog.md` (#41).

## [0.15.0] — 2026-09-23

### Added
- Universal agents: an Agents tab and one agent set for both hosts (#39).

## [0.14.0] — 2026-09-23

### Added
- Universal skills: a Skills tab and one skill set shared between Claude Code and Codex, synced automatically each session (#38).

### Security
- Private terms used by the privacy gate (names, paths, and other sensitive identifiers) now load from a local, gitignored file instead of shipping in the repository (#35).
- Chief of Staff duties can now write only inside their own scope — journal, state, proposals, and similar files — on both hosts, closing a path for a prompt-injected duty to edit scripts or trust files (#36).

### Upgrading
- The privacy fix above required rewriting and force-pushing this repository's history to purge terms that had already been committed. If you cloned before this release, discard that clone and clone again — a pull will conflict.

## [0.13.0] — 2026-09-23

### Added
- Cross-review and handoff: Claude Code and Codex can review each other's plans, or hand off a task to the other model, on both hosts (#34).

## [0.12.0] — 2026-09-23

### Added
- The vault graph's daily semantic pass now also runs under Codex (#32).

### Fixed
- Skills, `aos upgrade`, `aos status`, and on-screen text now name the host you're actually using under Codex instead of assuming Claude (#30).
- The reasoner role and structured tool-call requests now work correctly under Codex (#31).
- Cost tracking and the file/session inventory now follow whichever host you're on (#33).

## [0.11.3] — 2026-09-23

### Fixed
- `aos upgrade` now follows a marketplace that was added from a local checkout (#29).

## [0.11.2] — 2026-09-23

### Fixed
- The vault graph's semantic-pass timestamp now survives a structural-pass rebuild (#28).

## [0.11.1] — 2026-09-23

### Fixed
- The vault graph's lock is no longer broken while its owner process is still alive (#27).

## [0.11.0] — 2026-09-23

### Added
- `aos init` installs a pinned graphify and builds a structural vault graph on every scan (#24).
- `graph_*` MCP tools and a graph skill for querying the vault's structure (#25).
- A daily semantic pass enriches the vault graph, metered on its own spend budget (#26).

### Upgrading
- Install [uv](https://docs.astral.sh/uv) if you don't already have it. `aos init` now requires it, and `aos upgrade` will warn — without failing — that graphify can't install until it's present.

## [0.10.0] — 2026-09-23

### Added
- AgenticOS ships as a Codex plugin as well as a Claude Code plugin (#23).

### Upgrading
- An existing Codex install that used the old direct hook wiring moves over to the Codex plugin automatically on your next `aos upgrade`. Review and trust the new hook entries once under `/hooks` in Codex; that trust then survives future upgrades.

## [0.9.2] — 2026-09-23

### Security
- Recipe guard: proposal recipes now run only inside a read-only grammar, limiting what an auto-applied proposal can do (#22).

## [0.9.1] — 2026-09-23

### Added
- Every proposal now gets its own page in the Proposals tab, in one format, with an HTML page (#21).

### Fixed
- Duty date placeholders now fill with the local day (#20).

## [0.9.0] — 2026-09-22

### Added
- Proposals tab in the HUD, with rail count badges (#18).
- To-do tab and `/todo` command (#19).

## [0.8.0] — 2026-09-22

### Changed
- Obsidian, Ollama, and python3 (3.9+) are now mandatory prerequisites of `aos init`; `--provider none` no longer waives them (#15).

### Upgrading
- Obsidian, Ollama, and python3 (3.9+) are now required. `aos upgrade` itself won't fail if they're missing, but `aos doctor` will start reporting them as failures, and running `aos init` fresh will refuse to proceed without them.

## [0.7.0] — 2026-09-22

### Added
- Host routines: Codex Automations and Claude Code cloud routines now appear in the Routines tab (#7).
- Persona heartbeat watchdog and a proposal outcome ledger (#8).
- Hourly "tick" duty with a heartbeat pill in the HUD (#9).
- Nightly reflection, an idea backlog, and an early-reflect trigger (#11).
- Earned autonomy for the persona: recheck confirmations, class stats, and auto-applied proposals once trust is earned (#13).
- Codex parity: one vault now works from either host, auto-detected, with session reconciliation for Codex's late `SessionEnd` (#14).

### Fixed
- Raised the tick duty's daily budget to $0.10 (#10).
- Reflect and ledger scripts now also accept vault-relative paths (#12).

## [0.6.0] — 2026-09-21

### Added
- `workspaces/` becomes the tracked home for Claude Code and Codex projects, with an `aos workspace` command to create or adopt one and per-workspace session counts in the HUD (#6).

## [0.5.0] — 2026-09-21

### Added
- Codex CLI can now be used as a session host, alongside or instead of Claude Code (`aos init --host codex|both|auto`) (#5).

## [0.4.0] — 2026-09-21

### Added
- Routines tab: recurring actions defined as files, run by one scheduler, surfaced in the Workbench (#3).

### Fixed
- `aos upgrade` now runs the checkout's own CLI instead of a stale copy already in the vault (#4).

## [0.3.0] — 2026-09-21

### Changed
- The workhorse model moves to qwen3.5:9b, and the reasoner role now uses Claude Opus 5 by default instead of a local Ollama model; gpt-oss is retired (#2).

### Upgrading
- `ask`, `reflect-week`, `consolidate-memory`, and the HUD Chat tab now reason through hosted Claude Opus 5 by default, falling back to the local workhorse only if Claude is unavailable. Spend is capped by a new `reasoner` config block and shown as its own line in `aos status`.

## [0.2.0] — 2026-09-15

### Added
- Sidebar HUD shows an update-available pill, next to the update notice already printed at session start.

## [0.1.0] — 2026-09-15

The first public release: an `aos` CLI, the AgenticOS runtime, a Claude Code plugin, and the Obsidian HUD.

### Added
- `aos` CLI: `init`, `doctor`, `status`, `provider`, `upgrade`, `uninstall`, `terminal`, `persona`, and `cost` subcommands, plus a vault template (seed tree, AGENTICOS.md, Obsidian seeds).
- Claude Code plugin: marketplace manifest, 14 slash commands, hooks, and the `agenticos` MCP server.
- Provider system that auto-resolves between a local Ollama model, headless Claude, or none, with a spend ledger and daily/per-call caps.
- Memory pipeline: the `wrap_session` tool, auto-wrap, and heuristic (or model-backed) summarization of working memory, file maps, and workspace insights.
- Persona ("Chief of Staff"): an identity interview, scheduled duties with launchd/cron templates, persona-flag-closer and persona-sitrep skills, and a cost analyzer.
- Obsidian HUD plugin: a dashboard reading vault and config state, a pipelines view, budget and cost tabs, and a provider-aware Chat tab.
- Opt-in in-HUD terminal, built from source on install.
- Update notifications: a GitHub release check surfaced as a session-start notice.
- Docs: README, install guide, and a release acceptance runbook.

[Unreleased]: https://github.com/zzoretich/AgenticOS-Workbench/compare/v0.21.0...HEAD
[0.21.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.21.0
[0.20.3]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.20.3
[0.20.2]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.20.2
[0.20.1]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.20.1
[0.20.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.20.0
[0.19.2]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.19.2
[0.19.1]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.19.1
[0.19.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.19.0
[0.18.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.18.0
[0.17.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.17.0
[0.16.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.16.0
[0.15.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.15.0
[0.14.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.14.0
[0.13.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.13.0
[0.12.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.12.0
[0.11.3]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.11.3
[0.11.2]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.11.2
[0.11.1]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.11.1
[0.11.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.11.0
[0.10.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.10.0
[0.9.2]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.9.2
[0.9.1]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.9.1
[0.9.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.9.0
[0.8.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.8.0
[0.7.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.7.0
[0.6.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.6.0
[0.5.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.5.0
[0.4.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.4.0
[0.3.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.3.0
[0.2.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.2.0
[0.1.0]: https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.1.0
