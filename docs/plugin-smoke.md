# Obsidian plugin — manual smoke checklist

Run before tagging a release, on a vault created by `aos init` (not the developer vault). Repeat the provider rows for each provider you can reach (`aos provider none|ollama|claude`; the scripts rewrite `brain/_index/provider-state.json` on the next hook run — start one `claude` session and exit, or run `aos scan-vault --quiet`).

## Release procedure

1. `CHANGELOG.md`'s `## [Unreleased]` lists what the release changes, with an **Upgrading** subsection for anything a user must do after `aos upgrade` (re-trust hooks under `/hooks`, a new prerequisite, a re-clone).
2. `npm run version:bump -- X.Y.Z && npm install --package-lock-only --ignore-scripts` (one product version: root `package.json`, `brain/scripts/package.json`, `obsidian-plugin/{manifest,package,versions}.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `codex-plugin/.codex-plugin/plugin.json`; the install refreshes `package-lock.json` — npm owns its format, and `--check` verifies it). The bump also rolls `[Unreleased]` into `## [X.Y.Z] — <date>` and fails when it is empty.
3. `git commit -am "chore: release vX.Y.Z" && git tag vX.Y.Z`; push the tag only after in-chat confirmation.
4. `release.yml`'s read-only `build` job verifies the bump and the CHANGELOG section, runs the gate, `tsc` and the plugin tests, and builds; its `publish` job (the only one with a write token) creates the release with that CHANGELOG section as the notes and attaches `main.js`, `manifest.json`, `styles.css`.

## Install paths

- [ ] Copy the three release assets into `<vault>/.obsidian/plugins/agentic-os/`, enable the plugin: it loads with no console errors and `[agentic-os] loaded` is logged.
- [ ] Settings → Agentic OS shows the AgenticOS section: Vault root blank, Claude config dir placeholder from `agenticos.json`, Node binary blank; **Probe** fills a path and shows a notice.
- [ ] Provider row reflects `provider-state.json` (name + reason); the refresh icon re-reads it.

## Settings

- [ ] Vault root: typing a path that is not a directory (e.g. a file, or a path that does not exist) is ignored while typing — nothing is saved, no Notice.
- [ ] Vault root: leaving the field (blur) on a value that is not a directory shows a Notice once ("Vault root: … is not a directory — keeping …") and restores the field to the saved value.
- [ ] Vault root: typing a valid directory changes nothing until the field loses focus; on blur it saves once and, if it differs from this vault, shows the 10 s explanation once (Task 1 of Plan 5b — no per-keystroke save or Notice); reopen Settings — the saved value is shown, including after closing the modal with Escape while the field was focused.

## Pulse

- [ ] LEDs: every manifest pipeline appears (incl. `EMBED`, which reads `EMBED off` under `claude`/`none`); never-ran and `disabled` stages are gray (`is-neutral`) with the reason in the tooltip; nothing red on a fresh vault.
- [ ] Briefing row label is the persona's name from `persona/IDENTITY.md` (upper-cased); with no persona layer it reads `BRIEFING`. **(Plan 5)** `aos persona rename <name>` changes it on the next refresh — the persona layer and that command ship in Plan 5, so until then verify only the `BRIEFING` fallback and, if you want the named case, hand-write a `persona/IDENTITY.md` with an H1.
- [ ] COST row absent while `costEnabled` is off or `cost.monthlyBudget` is null; **(Plan 5)** present after `aos cost enable` with a budget and the toggle on — `aos cost enable` returns 1 until Plan 5 ships `extras/cost`, so until then set `cost.monthlyBudget` in `brain/config.json` by hand and turn the toggle on in Settings.
- [ ] **(Plan 5)** On a fresh install (Cost/Telemetry toggles never saved) `aos cost enable --budget 100` then a plugin reload shows the COST row with **no** toggle change — Settings → Cost module enabled already reads on (seeded from `agenticos.json` `cost.enabled`); flip it off in Settings and `aos cost enable` no longer overrides it (the saved toggle wins). Same precondition: until Plan 5, write `"cost": { "enabled": true }` into `agenticos.json` by hand to exercise the seeding.
- [ ] Fix Queue shows no anchor/backfill cards while cost is off; `open-health` still appears when health.md has errors.
- [ ] Command deck `/scan` spawns `scan-vault.js` with the resolved node (notice `▶ /scan`, then `✓ /scan: …`).
- [ ] Heartbeat pill: absent on a vault whose watchdog never ran; after `aos routines run heartbeat` a green `♥ <age>` pill sits next to the update pill and its tooltip lists each duty with status, last run and next fire. Backdate `checkedAt` in `brain/_index/persona-heartbeat.json` by 2 h → amber within a second (the file is watched); set one duty's `status` to `missed` → rose with `· 1 missed` in the label.

## To-Do

- [ ] The To-Do rail button sits between Pulse and Proposals. On a vault without `TODO.md` the tab reads "Nothing open"; `open TODO.md` creates it from the seed (same text as `vault-template/TODO.md`) and opens it.
- [ ] Quick-add: type `Renew passport #personal`, pick `⏫ high` and a date, press Enter → `- [ ] Renew passport ⏫ 📅 <date> #personal` is appended to the end of `## Open`; the input clears. Tokens typed inline (`Call dentist 🔽 📅 2026-10-01`) are kept as written.
- [ ] Items group into OVERDUE (rose, with `<n>d late`) / TODAY (amber) / UPCOMING / SOMEDAY and sort 🔺 ⏫ 🔼 (none) 🔽 within a group. The badge counts overdue + today and updates within a second of an edit, **with another tab active** (edit `TODO.md` by hand to check).
- [ ] Ticking a row moves it, with any indented lines under it, to the top of `## Done` as `- [x] … ✅ <today>`; `▸ DONE THIS WEEK` lists it; unticking there moves it back to the end of `## Open` without the ✅.
- [ ] Double-click edits the whole line (tokens included); Enter saves, Escape cancels. The priority button cycles · → ⏫ → 🔼 → 🔽; the row's date picker sets or clears 📅; ✕ asks before deleting.
- [ ] Tag chips filter the list (`all` clears); clicking a tag on a row filters by it.
- [ ] Stale guard: open `TODO.md` in an editor, change an item's text, then (before the tab refreshes) tick the old row → the notice "TODO.md changed underneath — reloaded" and nothing is written. With a `/todo` capture landing while you type in quick-add, your draft survives the re-render.
- [ ] Past local midnight, a TODAY item moves to OVERDUE within a minute without a reload.

## Proposals

- [ ] The Proposals rail button sits right after Pulse. With `persona/proposals/` holding no proposal files the badge is hidden; copy any proposal into it (e.g. `2026-09-20-demo.md` with `kind: product`, `surface: hud`) and an amber `1` appears within a second, **with another tab active** — delete the file and it goes away.
- [ ] PENDING lists each file with slug, target, kind pill, surface, age and, when `persona/flag-closer/confirmations.json` counts it, `confirmed <n>d` (green at 2+). A proposal missing its `recheck` or premise table shows `⚠ <n>` with the reasons in the tooltip.
- [ ] Clicking a row expands `needs: approve / reject` (or `accept → backlog / dismiss` for workflow/product), the recipe, What / Why / Risk rendered as Markdown and the premise table; `Open file` opens the proposal in a new tab. Group heads (`▾ PENDING`, `▾ BACKLOG`, `▾ HISTORY`) collapse and expand.
- [ ] BACKLOG lists `persona/backlog.md` sections newest first; HISTORY lists ledger outcomes newest first (no `filed` rows) with ✓ / ✗ / ◇ / – marks, and the rates line reads `last 28 d · approval <x>% · accept <y>%` (or `n/a`), matching `node brain/scripts/persona/ledger.js summary`.
- [ ] `Review in Claude ❯_` switches to Term with a new session in the vault running `claude "review persona flags"` — no extra blank shell beside it, and that session is the visible one even when other sessions were open. On a Codex-only vault (`hosts.claude.enabled: false`) the button reads `Review in Codex ❯_` and runs `codex '$agenticos:persona-flag-closer'` (`'$persona-flag-closer'` when Codex is wired directly).
- [ ] On a vault without `persona/`, the tab shows only the "isn't set up — run `aos persona`" line.
- [ ] Proposal pages: a freshly copied proposal's expanded row reads "The proposal's HTML page appears after the next scan"; run `node brain/scripts/persona/proposal-html.js` in the vault and, within a second, the row opens with a bold **Open the proposal in browser** that opens `brain/_index/proposals/<date>-<slug>.html` in the default browser. The page shows the kind pill, title, target, decision, recipe, the sections and the premise pills, with no console errors, in both light and dark system themes.
- [ ] The proposal's Markdown now carries `**[Open the proposal in browser](file:///…)**` under its `# ` title, and a second run of the renderer prints `"skipped"` for it without touching the file. A BACKLOG entry and a HISTORY row whose slug has a page show **Open the proposal in browser** and `page ↗`.

## Spaces / Memory / Runs

- [ ] Spaces lists workspaces from `snapshot.json`; insight footer says `local` when no model tag is present.
- [ ] Spaces rows carry a sessions chip (`claude N · codex M · Nd ago`) for every workspace either CLI has worked in since the last scan; a workspace with no sessions shows no chip.
- [ ] An "outside workspaces" footer under the list names each working directory sessions ran in elsewhere (`~`-shortened, newest first, at most eight); hovering shows the `aos workspace adopt` command. It disappears once those folders are adopted and the vault rescanned.
- [ ] Memory graph renders; daily notes under the configured `dailyNote.layout` classify as `session` nodes.
- [ ] Runs tab updates within a second of a new line appended to `agent-runs/runs.jsonl` (bus `runs-appended`).

## Routines

- [ ] The Routines rail button lists every `brain/routines/*.md` with cadence, next fire (local clock), last run and a health chip; the three seeded duties show `guarded` under their slug.
- [ ] `+ new` → the drawer form: an invalid cron shows the runtime's error in red under the field; a valid one shows the cadence and the next three fire times; `create` writes `brain/routines/<slug>.md` and spawns `aos routines sync` (notice `▶ aos.js routines sync`); the row appears without a reload.
- [ ] Editing a seeded duty's schedule opens the "Guarded routine" confirm; Cancel writes nothing; "Write anyway" writes and the chip reads `stale` until the sync lands, then `ok`.
- [ ] `on`/`off` on a row rewrites only `enabled:` (the body is untouched) and re-applies; a disabled row dims and its next fire reads `—`.
- [ ] `▶` on a `command` routine (e.g. `argv: [node, brain/scripts/scan-vault.js, --quiet]`) runs it: `brain/_index/routines.json` gains `lastTrigger: "manual"` and the last column updates within a second.
- [ ] With `routines.externalLabels: ["<a launchd label you have>"]` in `brain/config.json`, "OUTSIDE THE RUNTIME" lists it read-only with its cadence; the Obsidian Git backup timer appears when that plugin has a timer on; neither row has actions.
- [ ] With the Codex app installed, the same section lists its Automations with a `codex` pill, cadence, next fire, last run and a chip (`active` / `paused`); the subhead reads `codex as of <age>` and `refresh` spawns `aos routines hosts --refresh` (notice `▶ aos.js routines hosts --refresh`). Without the app (or without `sqlite3`) one dim line names the reason.
- [ ] After `/routines cloud` in a Claude Code session, the cloud routines appear with a `claude` pill, the name linking to claude.ai/code/routines/…, a `(UTC)` cadence or `once at …`, and a `ran once` chip on a fired one-shot; `claude as of <age>` shows the snapshot's age.
- [ ] A duty run that bypassed the runtime (run `sh brain/scripts/persona/run-duty.sh monitor` by hand) shows in the duty's `last` column within a second, with tooltip `trigger: duty-log`, and a `missed` chip clears.

## Skills (both hosts)

- [ ] The Skills rail button (✦) lists YOUR SKILLS with a cyan `claude` and an amber `codex` pill per row (struck through where the host lacks it), a source pill (`claude`, `codex`, `claude.ai`) and a chip (`on both`, `can't share`, `differs`, `copy edited`, `not shared`); PLUGINS & BUILT-INS follow, listed only. The head counts "on both · Claude Code only · Codex only · from plugins", and the note reads "sharing on … as of <age>".
- [ ] Opening the tab with a cache older than ten minutes (or none) spawns `aos skills sync` once; `sync now` does the same and the list re-renders when `brain/_index/skills.json` changes.
- [ ] Typing in the filter narrows both sections by name, description or plugin without losing focus.
- [ ] `❯_ claude` opens a Term session running `claude '/<name>'`; `❯_ codex` runs `codex '$<name>'` (plugin skills: `$<plugin>:<name>`); only enabled hosts get a button. `⧉` copies the invocation; `open` opens the SKILL.md.
- [ ] `unshare` on a shared skill removes its copy from the other host and the chip reads `not shared`; `share` brings it back.
- [ ] *Claude Code:* write `~/.claude/skills/smoke-skill/SKILL.md` (`name` + `description`), end the session; `~/.agents/skills/smoke-skill/` appears with a translated SKILL.md and `.aos-mirror.json`, and a new Codex session lists `$smoke-skill`. `/skills` relays the table.
- [ ] *Codex:* write `~/.agents/skills/smoke-codex/SKILL.md`, end the session; `~/.claude/skills/smoke-codex/` appears and a new Claude Code session lists `/smoke-codex`. `$agenticos:skills` relays the table. Before trusting the new hook under `/hooks`, doctor's `codex hooks trusted` reads `15 of 16`.
- [ ] Edit a copy by hand, then `aos skills sync`: it is left alone, the chip reads `copy edited`, and `aos doctor` warns on the `skills` row; `aos skills reset <name>` restores it.
- [ ] With `hosts.codex.enabled: false`, the note reads "sharing off — sharing needs both hosts enabled", every row keeps only its `claude` pill, and nothing is written under `~/.agents/skills`.

## Agents (both hosts)

- [ ] The Agents rail button (♟) lists YOUR AGENTS with a cyan `claude` and an amber `codex` pill per row (struck through where the host lacks it), a `read-only` pill on an agent whose tools cannot write, a source pill (`claude`, `codex`) and a chip (`on both`, `can't share`, `differs`, `copy edited`, `not shared`); PLUGINS & CONFIG.TOML follow, listed only. The head counts "on both · Claude Code only · Codex only · from plugins and config.toml".
- [ ] Opening the tab with a cache older than ten minutes (or none) spawns `aos agents sync` once; `sync now` does the same and the list re-renders when `brain/_index/agents.json` changes. The filter narrows both sections without losing focus.
- [ ] `❯_ claude` opens a Term session running `claude --agent <name>` (the session is the agent); `❯_ codex` runs `codex '<starter prompt>'`, and Codex asks for the task, then spawns the role; only enabled hosts get a button. `⧉` copies `@agent-<name>` (Claude Code) or the name (Codex); `open` opens the agent file.
- [ ] `unshare` on a shared agent removes its copy from the other host and the chip reads `not shared`; `share` brings it back.
- [ ] *Claude Code:* write `~/.claude/agents/smoke-agent.md` (`name`, `description`, `tools: Read, Grep`), end the session; `~/.codex/agents/smoke-agent.toml` appears with `sandbox_mode = "read-only"` and an `# aos-mirror:` line, and a new Codex session spawns it when asked for `smoke-agent`. `/agenticos:agents` relays the table (the bare `/agents` opens Claude Code's own agent manager).
- [ ] *Codex:* write `~/.codex/agents/smoke_codex.toml` (`name`, `description`, `developer_instructions`), end the session; `~/.claude/agents/smoke-codex.md` appears and a new Claude Code session lists it under `/agents` and takes `@agent-smoke-codex`. `$agenticos:agents` relays the table. No new hook entry: doctor's `codex hooks trusted` count is unchanged.
- [ ] Edit a copy by hand, then `aos agents sync`: it is left alone, the chip reads `copy edited`, and `aos doctor` warns on the `agents` row; `aos agents reset <name>` restores it. A Claude Code agent named `explorer` reads `can't share`.
- [ ] With `hosts.codex.enabled: false`, the note reads "sharing off — sharing needs both hosts enabled", every row keeps only its `claude` pill, and nothing is written under `~/.codex/agents`. With `[agents] enabled = false` in Codex's `config.toml`, the head warns that Codex subagents are off.

## Cross-review and handoff (both hosts; each run spends)

- [ ] **Claude Code:** `aos doctor` shows `ok cross-review cross-provider` on a machine with both CLIs logged in. In a Claude Code session on a disposable git repo, "cross-review this plan" writes `PLAN.md`, runs `aos cross-review review --host claude …`, and reports a Codex verdict; the run's `result.json` under `<vault>/brain/_index/cross-review/runs/` says `"provider": "codex"`, `"independence": "cross-provider"`, `provider-spend.jsonl` gains a `cross-review:review` row, and no new rollout appears under `~/.codex/sessions/`.
- [ ] **Codex:** `$agenticos:cross-review` (*direct:* `$cross-review`) on the same repo runs `--host codex`, and the reviewer is Claude (`"provider": "claude"`); no new transcript appears under `<claude config dir>/projects/`. `$agenticos:handoff` with "who should handle this" returns a routing brief without launching anything; asked to run it, it calls `aos cross-review handoff` and reports `requestedModel` and `observedModels`.
- [ ] **One CLI:** with `AOS_NO_CODEX=1`, `aos doctor` shows `warn cross-review same-provider only: codex CLI not found`, and the skill offers a same-provider review whose result says `"independence": "same-provider"`; `aos cross-review check` refuses it without `--accept-same-provider`.

## Codex host

Run on a machine with the `codex` CLI logged in, after `aos init --host codex` (or `--host both`). A Codex CLI that installs plugins gets the `agenticos` plugin; the items marked *direct* apply to one without plugins.

- [ ] `codex plugin list` shows `agenticos@agenticos-workbench` installed at the repo version; `codex mcp list` shows `agenticos` running `sh ./bin/aos mcp-server` from the plugin folder; `~/.codex/hooks.json` holds no AgenticOS entries and `~/.agents/skills/` no generated skills.
- [ ] `aos doctor` shows `ok codex login`, `ok codex plugin agenticos@agenticos-workbench <version>`, `warn codex hooks trusted 0 of 16` before the `/hooks` review and `ok … 16 of 16` after it, `ok codex MCP declared agenticos from the plugin`, no `codex direct wiring` row, and `persona runner` / `routines runner` naming `codex` on a Codex-only machine (`claude` when both are wired); with `--host codex` alone no `claude` row appears and the vault's health has no "CLAUDE.md is missing" error. *Direct:* `ok codex hooks 5 of 5 events`, `ok codex MCP declared … with AOS_HOST=codex`, `ok codex skills 25 generated`; on an install wired before 0.7.0 the MCP row is a warn (`registered without AOS_HOST=codex`) until `aos upgrade`.
- [ ] On a machine wired directly before this release, `aos upgrade` installs the plugin, prints `direct wiring removed (5 hook entries, the MCP registration, 26 skills)` and the `/hooks` reminder; after trusting the entries once, a second `aos upgrade` (or a version bump) leaves them trusted.
- [ ] A `codex exec "say ok"` session (hooks trusted) ends with a `host: "codex"` row in `runs.jsonl` carrying `cost_usd` and the model (Codex ≥ 0.155 fires SessionEnd on exit). Quit a Codex TUI session after one turn: its live header (`brain/_index/agent-runs/live/sess-<id>.ndjson`, first line) carries `host_pid` = the `codex` process (`pgrep -x codex` while it runs) and `host_started`; the next session start or stop of either host closes the run without waiting out the idle window (the live file is gone; `runs.jsonl` has a `host: "codex"`, `end_reason: "reconciled"` row), and `aos reconcile-sessions --force` run by hand before that prints `reconciled codex session <id> (process exited)`. A Codex TUI session left idle, or an exec run on a CLI that does not fire SessionEnd, leaves `brain/_index/agent-runs/live/sess-<id>.ndjson` behind; after `telemetry.staleAfterMinutes` (set it to 1 for the check) the next session start or stop of either host runs `reconcile-sessions`: the live file is gone, `runs.jsonl` has a `host: "codex"` row with `end_reason: "reconciled"` and the model name, and the pipeline ledger shows `auto-cost` and `auto-wrap` runs for that session. `aos reconcile-sessions --dry-run --force` lists what a sweep would do.
- [ ] With no `claude` on PATH, `aos routines run <a prompt routine>` runs it through `codex exec` (`aos routines list` shows the run, `brain/_index/provider-spend.jsonl` gains a `provider: "codex"` row), and `sh <vault>/brain/scripts/persona/run-duty.sh sitrep --dry-run` prints the `codex exec -` invocation.
- [ ] In `codex`, `/hooks` lists the fifteen agenticos plugin entries (*direct:* the five AgenticOS entries); trust them. A new session's first prompt receives `<brain-context>`, and `<agenticos-conventions>` is present at session start (ask *what conventions apply here?*).
- [ ] `$agenticos:wrap`, `$agenticos:remember` and `$agenticos:recall` are offered as skills (*direct:* `$wrap`, `$remember`, `$recall`), and no `agenticos:source-command-*` skill appears; `$agenticos:recall <topic>` calls `mcp__agenticos__recall` without an approval prompt in a workspace-write sandbox.
- [ ] After a turn, `brain/_index/agent-runs/live/sess-<id>.ndjson` holds `tool_use_batch` rows with the Codex tool names (`Bash`, `apply_patch`, `mcp__agenticos__…`); the Stop hook produces no Codex error notice.
- [ ] With cost enabled, closing the thread (or `aos auto-cost --cost-one <session-id>` with `AOS_HOST=codex`) patches a `cost_source: "codex-rollout"` row into `runs.jsonl`; the HUD Runs tab shows it.
- [ ] With no `claude` on PATH and no `--from-local`, `aos upgrade` vendors from the Codex marketplace's folder (`upgrading <vault> from <that folder>`), and `aos status` reads `today (hooks) … / cap $<x> (codex.perDayUsd)` once the provider has resolved to `codex`.
- [ ] Skills say what Codex can do: `$agenticos:aos doctor` names the fix for each host, `$agenticos:feedback-review` asks its question as one numbered message, and no generated skill mentions `AskUserQuestion`, "the Read tool" or `/agenticos:<name>` (`grep -r` over the installed plugin's `skills/`). SESSION.md's "not wrapped" line names `$agenticos:wrap` on a Codex-only vault and both forms when both hosts are wired.
- [ ] The SessionStart update notice compares the Codex plugin's version (`(plugin <x>, vault <y>)`) when the vault is behind.
- [ ] With no `claude` on PATH, `aos graph build --semantic` names Codex in its consent line and runs: `aos graph` shows the semantic row `… · via codex`, `brain/_index/provider-spend.jsonl` gains `graph:semantic` rows with `provider: "codex"`, and `brain/graphify-out/graph.json` gains `concept` nodes.
- [ ] With cost enabled, a Codex run missed at SessionEnd is costed by `aos auto-cost --backfill` (`cost_source: "codex-rollout"`), and `aos auto-cost --cost-one <codex session id>` works on a machine with both hosts; the Pulse Fix Queue counts such runs until they are costed. The System drawer shows a `codex: n skills · n prompts · n hooks` chip, and `node <vault>/brain/scripts/persona/scan-arsenal.js` lists Codex skills and prompts with `"host": "codex"`.
- [ ] `aos uninstall --host codex` removes the plugin and the `agenticos-workbench` marketplace (`codex plugin list`, `codex plugin marketplace list`), `codex mcp list` no longer shows `agenticos`; *direct:* the entries leave `hooks.json` (the file itself only when nothing else was in it) and `~/.agents/skills/` keeps only skills you wrote yourself.

## Chat (per provider)

- [ ] `codex` (a Codex-only vault, `hosts.claude.enabled: false`): header says `· codex via ask.js (reasoner caps)`; a question answers with prose; `brain/_index/provider-spend.jsonl` gains a `reason:*` row with `provider: "codex"`; `aos status` shows `reasoner model=<reasoner.codexModel or codex default> provider=codex`.

- [ ] `none`: the Chat rail button is absent; `Open Workbench: Chat` command shows the "no provider — run `aos provider`" hint.
- [ ] `ollama` with no Claude login on record: header says `· local ask.js`; a question answers with prose (never a `<<<AOS_CONTEXT feature=ask>>>` block — that would mean `--local` was dropped from the spawn); the answer comes from the workhorse (the script's stderr notes the reasoner fallback); a failing `ask.js` (stop Ollama) shows its last stderr line, not `exit 1`.
- [ ] `claude`, or `ollama` with a Claude login on record (`brain/_index/provider-state.json` `claude.loggedIn: true`): header says `· claude (claude-opus-5, capped)` (or the configured `reasoner.model`); a question answers with `$0.xxxx` in the turn meta; `brain/_index/provider-spend.jsonl` gains a `feature:"reason:chat"` row with the reasoner model; `aos status` counts it on the reasoner line, not the hooks line; with `claude` logged out the error reads `Not logged in …`.

## Term

Precondition for both action rows: the plugin folder must be an `aos init` / `aos upgrade` bundle, i.e. `<vault>/.obsidian/plugins/agentic-os/package.json` exists. The three release assets copied by hand above do **not** include it.

- [ ] Fresh install: Term tab shows "Terminal unavailable" with **Install terminal support** and **Rebuild for this Electron** buttons.
- [ ] With only the three copied assets (no `package.json`), both **Install terminal support** and **Rebuild for this Electron** refuse with the notice "Terminal support needs the aos bundle: no package.json here — install the bundle with `aos upgrade` first" and spawn nothing.
- [ ] After `aos upgrade`: Install → notice with the spawn-helper count → reload → a shell opens (macOS); Linux with build tools compiles and opens. Windows is not supported in v1.
- [ ] Rebuild runs `npx --yes @electron/rebuild -v <process.versions.electron> -m <plugin dir> -w node-pty` (the version is visible in the console log line `[agentic-os] rebuild-pty:`).

## Telemetry toggle

- [ ] With Telemetry off: no `agent-runs/live/` is created on load and no orphan-sweep log line appears; Runs tab still reads existing `runs.jsonl`.
- [ ] Fresh install with `"telemetry": { "enabled": false }` in `agenticos.json` (or `brain/config.json`) and the toggle never saved: Settings → Telemetry enabled reads off without being touched and the row above holds; the same key drives `telemetry-hook.js`, so `aos` and the plugin agree.

## Review readiness

- [ ] No default hotkey on Omnisearch (Settings → Hotkeys shows it blank).
- [ ] DISK donut and COST DETAIL sparkline render (SVG nodes, no innerHTML) in the SYSTEM drawer.
- [ ] Clock and timestamps follow the OS locale.
