# Changelog

All notable changes to AgenticOS Workbench. Versions follow the tags. From the next release on, each version's section is also its GitHub release notes, and an **Upgrading** subsection lists anything you need to do after `aos upgrade`.

## [Unreleased]

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

[Unreleased]: https://github.com/zzoretich/AgenticOS-Workbench/compare/v0.18.0...HEAD
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
