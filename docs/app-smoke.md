# The Workbench app — manual smoke checklist

Run before tagging a release, in the AgenticOS Workbench app on a vault created by `aos init` or the app's wizard (not the developer vault). Most rows are also automated: the app's end-to-end suite asserts them on a synthetic vault (`app/tests/e2e/COVERAGE.md` maps every row to its spec), and `npm run dist:test && npm run smoke:packaged` runs the packaged app on a fresh install. This list is the pass by hand, against real hosts. Repeat the provider rows for each provider you can reach (`aos provider none|ollama|claude`; the scripts rewrite `brain/_index/provider-state.json` on the next hook run — start one `claude` session and exit, or run `aos scan-vault --quiet`).

## Release procedure

1. `CHANGELOG.md`'s `## [Unreleased]` lists what the release changes, with an **Upgrading** subsection for anything a user must do after `aos upgrade` (re-trust hooks under `/hooks`, a new prerequisite, a re-clone).
2. `npm run version:bump -- X.Y.Z`, then `npm install --package-lock-only --ignore-scripts` at the root **and in `app/`** (one product version: root `package.json`, `brain/scripts/package.json`, `obsidian-plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `codex-plugin/.codex-plugin/plugin.json`, `app/package.json`; the installs refresh both lockfiles — npm owns their format, and `--check` verifies them). The bump also rolls `[Unreleased]` into `## [X.Y.Z] — <date>` and fails when it is empty.
3. `git commit -am "chore: X.Y.Z"`, then `git push origin main && git tag vX.Y.Z && git push origin vX.Y.Z` — the tag only after in-chat confirmation.
4. `release.yml`'s read-only `build` job verifies the bump and the CHANGELOG section, and runs the gate and the HUD's `tsc` and tests; its `publish` job (the only one with a write token) creates the release with that CHANGELOG section as the notes. It attaches nothing: a re-run refreshes the notes only.
5. In a clean checkout at the tag, on the maintainer's Mac: `cd app && APPLE_KEYCHAIN_PROFILE=<profile> npm run release:app` (`-- --dry-run` first). It builds the app with its bundled runtime, signs and notarizes it, staples and verifies the DMG, checks `latest-mac.yml` against the zip the updater downloads (a DMG the feed lists gets its stapled checksum), and uploads the DMG, the zip, its blockmap and then the feed to the release. Until the feed is up, installed apps that check find no update and try again later.
6. The acceptance run (`docs/acceptance.md`): the update from the previous release, and a fresh account from the DMG.

## Install paths

- [ ] Open the app on the vault: the Workbench draws on Pulse with no error, and a dev run (`npm start` in `app/`) logs `[host] AgenticOS HUD <version> loaded` in its developer tools.
- [ ] The settings window's Agentic OS tab (⚙ at the ribbon's foot, or AgenticOS Workbench ▸ App Settings… ⌘⇧,) shows the Paths section as pickers: Vault root on "this vault (…)", Claude config dir on "auto (…)", Node binary on "auto" with the installed nodes listed; **Probe** picks a path and shows a notice.
- [ ] Provider row reflects `provider-state.json` (name + reason); the refresh icon re-reads it.

## The app

- [ ] With no install (a fresh account, or no `agenticos.json`), the app opens its setup wizard: Check lists Homebrew (optional), Node, Claude Code, Codex and their logins, Ollama, Python and uv, and a missing one's fix-it runs its command in the wizard's terminal, after which the checks run again.
- [ ] Choose offers only the hosts that are ready; Your agent checks the name as `aos persona` does; Install runs `aos init` with its output live; Finish shows the `CLAUDE.md` line as a diff (**Add the line** adds it, nothing else does) and, with Codex, the `/hooks` step; **Open the Workbench** opens it without a relaunch.
- [ ] Opened on an existing install, the app goes straight to the Workbench and shows the one-time note **AgenticOS Workbench is an app now** (closed with **Got it**) once per vault. When its runtime is newer than the vault's, **Update the runtime in your vault** follows (and the status bar's `⬆ Runtime <vault> → <app>` opens it again); **Update now** runs `aos upgrade` with its output, **Later** runs nothing.
- [ ] The settings an Obsidian-era vault kept in `.obsidian/plugins/agentic-os/data.json` are in effect on first start, and `~/Library/Application Support/AgenticOS Workbench/plugins/agentic-os.json` holds them before you change anything.
- [ ] AgenticOS Workbench ▸ Check for Updates… checks GitHub Releases (a release build only; greyed out with the reason when `updates.check` is false); a downloaded update shows **Restart to update** in the status bar and the menu.
- [ ] The menubar icon opens the sidebar HUD in a popover; closing the window hides it and ⌘Q quits; `aos doctor`'s `workbench app` row names the app and its version.

## Settings

- [ ] ⚙ Settings sits at the rail's foot (bottom-left) and stays visible in a pane too short for all fourteen tabs (thirteen without Chat), which scroll above it; Enter or Space on a focused rail button opens it. "Open Workbench: Settings" in the command palette (⌘P) and "Open Workbench settings" in the settings window open the same tab.
- [ ] The head reads "N changed from the defaults" and matches the `*` rows of `aos config list`. Every row shows its key, a pill (`this machine` / `this vault` / `default`, the file path on hover) and when it applies; daily caps show "today $x of $cap".
- [ ] Master switches: turning Telemetry off writes `telemetry.enabled` to `agenticos.json` (check with `aos config get telemetry.enabled`), shows the change as a Notice, and the chip follows; turning Background AI on from `none` asks first ("Turn on paid background calls?"), and Cancel leaves it off.
- [ ] No text box anywhere in ⚙ Settings or the settings window (spec 2026-09-24-settings-pickers): toggles, pickers, chips and buttons only. Every number row has − / + around its picker; + on a daily cap raises it to the next preset and asks first, − never asks; − is disabled at the lowest preset and + at the highest.
- [ ] A value set outside the presets (e.g. `aos config set cost.monthlyBudget 175`) shows in its picker as "$175.00 (custom)" and is not changed by opening the tab; − / + from it go to $150 / $200.
- [ ] `recallRoots` and `routines.tools` are chips; the last `routines.tools` chip cannot be turned off. `quickLinks`, the roster and external labels have an "Edit brain/config.json" button (opens the file); `skills.exclude` / `agents.exclude` have "Manage in Skills" / "Manage in Agents", which switch tabs. Hosts & install values are plain text.
- [ ] Setting `claude.model` leaves a "⚠ 1 step left: aos routines sync" bar and a `1` on the ⚙ badge; clicking it runs the sync, the bar goes and the badge clears.
- [ ] ↺ on a changed row puts it back to the default (`aos config unset`); Hosts & install rows are read-only and their "❯_ aos doctor" / "❯_ aos upgrade" buttons open the Term tab running them.
- [ ] *Claude Code only* (`hosts.codex.enabled: false`): every Codex row (`codex.*`, `*.codexModel`) is dimmed with "Codex is off on this machine; `aos init --host both` turns it on", and still editable. *Codex only* (`hosts.claude.enabled: false`): the Claude rows are dimmed the same way. *Both*: nothing dimmed.
- [ ] A vault whose runtime predates 0.17 (no `aos config`): the tab says to run `aos upgrade` with a "❯_ aos upgrade" button, and the WORKBENCH section below still works.
- [ ] The WORKBENCH section and the settings window's Agentic OS tab show the same plugin rows; a change in one appears in the other on reopen.
- [ ] Vault root: the picker offers this vault and the agenticos.json vault; picking one that no longer exists shows a Notice once ("Vault root: … is not a directory — keeping …") and the picker returns to the saved value; picking a different vault shows the 10 s explanation once.

## Config (both hosts)

- [ ] `aos config` lists every section with a source per row; `aos config set telemetry.redact false --dry-run` prints `(dry run) … (would write agenticos.json)` and changes no file; `aos config unset telemetry.redact` restores the default.
- [ ] `aos config set persona.enabled false` creates `persona/DISABLED`; `true` removes it. `aos config set vault /tmp` is refused with the `aos init` command; `AOS_HEADLESS=1 aos config set provider none` is refused.
- [ ] `aos doctor` shows a `config` row; add `"telemetry": {"enabeld": false}` to `brain/config.json` and it warns naming the key.
- [ ] *Claude Code:* `/aos config get provider` relays the value; `/aos config set codex.effort medium` relays the change line.
- [ ] *Codex:* `$agenticos:aos config get provider` (direct wiring: `$aos config get provider`) relays the value; the same `set` relays the change line.

## Pulse

- [ ] LEDs: every manifest pipeline appears (incl. `EMBED`, which reads `EMBED off` under `claude`/`none`); never-ran and `disabled` stages are gray (`is-neutral`) with the reason in the tooltip; nothing red on a fresh vault.
- [ ] Briefing row label is the persona's name from `persona/IDENTITY.md` (upper-cased); with no persona layer it reads `BRIEFING`. `aos persona rename <name>` changes it on the next refresh.
- [ ] COST row absent while `cost.enabled` is false or `cost.monthlyBudget` is null; present on the next render after `aos cost enable --budget 100` (or Session costing on in ⚙ Settings) — the HUD reads the system switch, there is no HUD-only toggle.
- [ ] Fix Queue shows no anchor/backfill cards while cost is off; `open-health` still appears when health.md has errors.
- [ ] Command deck `/scan` spawns `scan-vault.js` with the resolved node (notice `▶ /scan`, then `✓ /scan: …`).
- [ ] Command deck `/reflect-week` (a vault with daily notes this week) → `▶ /reflect-week`, then `✓ /reflect-week: [reflect] wrote brain/reflections/<YYYY-WW>.md` and the file exists. With `aos provider none` → `✗ /reflect-week: … no model provider …`, nothing written.
- [ ] Command deck `/remember` → a one-field modal; `the deck works` lands in `brain/_index/SESSION.md` as `- the deck works #promote` under `## Things to Remember`, `updated:` is today; `feedback: keep it` lands under `## Promote to Memory on Close`. No file appears under `brain/memory/`.
- [ ] Command deck `/pattern` → area, title and pattern; on an existing area it adds a `### <title>` subsection to `brain/patterns/<area>.md` and bumps `updated:`; on a new area (`testing`) it creates the file with `type: pattern` frontmatter and adds `- [Testing Patterns](brain/patterns/testing.md) — …` under `## Patterns` in `MEMORY.md`.
- [ ] Listener leak: switch Pulse → Memory → Pulse → Term → Pulse five times, then in a dev run's developer tools `aosHost.plugin.terminalPool._handlers.get("session-add").length` is at most 2 (the Pulse panel on screen, and the Term tab's kept for its next visit) and does not grow per visit.
- [ ] Heartbeat pill: absent on a vault whose watchdog never ran; after `aos routines run heartbeat` a green `♥ <age>` pill sits next to the update pill and its tooltip lists each duty with status, last run and next fire. Backdate `checkedAt` in `brain/_index/persona-heartbeat.json` by 2 h → amber within a second (the file is watched); set one duty's `status` to `missed` → rose with `· 1 missed` in the label.

## Files
- [ ] The rail shows Files second; the tree lists the vault's top level, folders first, without dot-folders, node_modules or graphify-out
- [ ] A folder opens and closes in place; a click on a note opens it in a tab
- [ ] Search finds lines across notes with the hit highlighted; "all text files" adds code and data files; a line opens its note; Escape clears it
- [ ] Open file… (⌘O) matches paths fuzzily, Markdown first; Search vault… (⌘⇧F) opens Files with the cursor in the search box
- [ ] + note makes a Markdown note in the chosen folder (created if missing) and opens it; the form says why it refuses (exists, brain/_index or brain/scripts, a climb out, no name)
- [ ] Rename keeps the folder and the extension; Move puts the file in another folder; both keep the bytes
- [ ] ✕ asks first; Move to Trash puts the file in the macOS Trash; brain/_index and brain/scripts files offer no actions

## To-Do

- [ ] The To-Do rail button sits between Files and Proposals. On a vault without `TODO.md` the tab reads "Nothing open"; `open TODO.md` creates it from the seed (same text as `vault-template/TODO.md`) and opens it.
- [ ] Quick-add: type `Renew passport #personal`, pick `⏫ high` and a date, press Enter → `- [ ] Renew passport ⏫ 📅 <date> #personal` is appended to the end of `## Open`; the input clears. Tokens typed inline (`Call dentist 🔽 📅 2026-10-01`) are kept as written.
- [ ] Items group into OVERDUE (rose, with `<n>d late`) / TODAY (amber) / UPCOMING / SOMEDAY and sort 🔺 ⏫ 🔼 (none) 🔽 within a group. The badge counts overdue + today and updates within a second of an edit, **with another tab active** (edit `TODO.md` by hand to check).
- [ ] Ticking a row moves it, with any indented lines under it, to the top of `## Done` as `- [x] … ✅ <today>`; `▸ DONE THIS WEEK` lists it; unticking there moves it back to the end of `## Open` without the ✅.
- [ ] Double-click edits the whole line (tokens included); Enter saves, Escape cancels. The priority button cycles · → ⏫ → 🔼 → 🔽; the row's date picker sets or clears 📅; ✕ asks before deleting.
- [ ] Tag chips filter the list (`all` clears); clicking a tag on a row filters by it.
- [ ] Stale guard: open `TODO.md` in an editor, change an item's text, then (before the tab refreshes) tick the old row → the notice "TODO.md changed underneath — reloaded" and nothing is written. With a `/todo` capture landing while you type in quick-add, your draft survives the re-render.
- [ ] Past local midnight, a TODAY item moves to OVERDUE within a minute without a reload.

## Proposals

- [ ] The Proposals rail button sits right after To-Do. With `persona/proposals/` holding no proposal files the badge is hidden; copy any proposal into it (e.g. `2026-09-20-demo.md` with `kind: product`, `surface: hud`) and an amber `1` appears within a second, **with another tab active** — delete the file and it goes away.
- [ ] PENDING lists each file with slug, target, kind pill, surface, age and, when `persona/flag-closer/confirmations.json` counts it, `confirmed <n>d` (green at 2+). A proposal missing its `recheck` or premise table shows `⚠ <n>` with the reasons in the tooltip.
- [ ] Clicking a row expands `needs: approve / reject` (or `accept → backlog / dismiss` for workflow/product), the recipe, What / Why / Risk rendered as Markdown and the premise table; `Open file` opens the proposal in a new tab. Group heads (`▾ PENDING`, `▾ BACKLOG`, `▾ HISTORY`) collapse and expand.
- [ ] BACKLOG lists `persona/backlog.md` sections newest first; HISTORY lists ledger outcomes newest first (no `filed` rows) with ✓ / ✗ / ◇ / – marks, and the rates line reads `last 28 d · approval <x>% · accept <y>%` (or `n/a`), matching `node brain/scripts/persona/ledger.js summary`.
- [ ] `Review in Claude ❯_` switches to Term with a new session in the vault running `claude "review persona flags"` — no extra blank shell beside it, and that session is the visible one even when other sessions were open. On a Codex-only vault (`hosts.claude.enabled: false`) the button reads `Review in Codex ❯_` and runs `codex '$agenticos:persona-flag-closer'` (`'$persona-flag-closer'` when Codex is wired directly).
- [ ] On a vault without `persona/`, the tab shows only the "isn't set up — run `aos persona`" line.
- [ ] Proposal pages: a freshly copied proposal's expanded row reads "The proposal's HTML page appears after the next scan"; run `node brain/scripts/persona/proposal-html.js` in the vault and, within a second, the row opens with a bold **Open the proposal in browser** that opens `brain/_index/proposals/<date>-<slug>.html` in the default browser. The page shows the kind pill, title, target, decision, recipe, the sections and the premise pills, with no console errors, in both light and dark system themes.
- [ ] The proposal's Markdown now carries `**[Open the proposal in browser](file:///…)**` under its `# ` title, and a second run of the renderer prints `"skipped"` for it without touching the file. A BACKLOG entry and a HISTORY row whose slug has a page show **Open the proposal in browser** and `page ↗`.

## Notifications

- [ ] The Notifications rail button sits right after Proposals. With no `brain/notifications/` the badge is hidden and the tab says "No notifications yet" with the `/notifications` hint for the enabled hosts.
- [ ] Run `aos notify post --from demo --level edition --title "Demo edition" --body-file - <<< $'Intro\n\n## Section one\n\nText.'` (with `--actions-json` naming a file that holds `[{"kind":"ask","label":"Deep dive","skill":"agenticos:ask-brain","arg":"demo","anchor":"section-one"},{"kind":"react","label":"More like this","value":1,"ref":"s1","anchor":"section-one"}]`). Within a second, **with another tab active**, an amber `1` appears on the rail.
- [ ] `aos notify post --from demo --level breaking --title "Demo breaking"` raises a desktop notification titled `BREAKING · Demo breaking`, and the rail badge turns rose. `aos config set notifications.osAlert false`, post again, and no desktop notification appears.
- [ ] The Unread view lists both items, newest first, with a level pill, sender and age. Clicking the edition expands it: the intro, then **SECTION ONE** with its text and the two buttons under it. The row turns read (dot gone, badge down by one). `Mark all read` clears the badge.
- [ ] The level chips and the sender dropdown (shown once two senders exist) filter the list. The All and Archived views work, and Archive / Unarchive / Mark unread / Open note all act on the row.
- [ ] `More like this` turns cyan and appends one line to `brain/notifications/reactions.jsonl`.
- [ ] Claude Code: `Deep dive ❯_` switches to Term with a new session in the vault running `claude '/agenticos:ask-brain demo'`. Codex-only vault (`hosts.claude.enabled: false`): the button runs `codex '$agenticos:ask-brain demo'` (`'$ask-brain demo'` when Codex is wired directly). With both hosts enabled there is one button per host.
- [ ] An item whose frontmatter is hand-edited to `actions: [{"kind":"run","label":"x","command":"echo hi"}]` shows no button. A file with no frontmatter under `brain/notifications/<year>/` shows the "1 unreadable file(s)" footer.
- [ ] In a Claude Code session, `/notifications` lists the unread items. In a Codex session, `$agenticos:notifications` does the same (`$notifications` when wired directly). Both mark items read on request.

## Agent teams (both hosts)

- [ ] `aos team init` seeds `persona/teams/example/`; `aos team list` shows it, and `aos team status example` lists three idle members.
- [ ] `aos team put example --from lead '{"id":"demo-01","status":"gate","gate":{"name":"discuss","state":"pending"}}'` then `AOS_HEADLESS=1 aos team gate approve example demo-01 --expect '{}'` is refused (exit 1); without `AOS_HEADLESS` it moves the item to plan with the lead as owner and posts the decision.
- [ ] A seat dispatched with `--detach` survives closing the terminal; its `wait` line exits with the run's row, and `kill -9` of the dispatcher is recorded as `killed` by the next `aos team board`.
- [ ] In a Claude Code session, `/team` lists the teams with pending gates first. In a Codex session, `$agenticos:team` does the same (`$team` with direct wiring).

## Agent Teams tab (both hosts)

- [ ] The Agent Teams rail button (⁂) sits right after Agents, and "Open Workbench: Agent Teams" in the command palette opens it. With no `persona/teams/` it says "No teams yet" with the `/team` hint for the enabled hosts; **Seed the example team** runs `aos team init` and the Example team appears.
- [ ] Put `demo-01` at the Discuss gate (the `aos team put` line above). Within a second, **with another tab active**, an amber `1` appears on the rail. The tab leads with NEEDS YOU · 1: the card shows the item, "Discuss gate", how long it has waited, the spend, the lead's last `gate` post, the budget presets (half, the proposal, double) and − / +. A preset below the spend is disabled.
- [ ] **Approve · $X** asks first, and Cancel writes nothing. Approve moves `demo-01` to plan, Interact shows "Discuss gate approved by the user at $X", the badge clears, and Term opens the lead's agent (`claude --agent team-lead '…'`, on the lead's own provider when that host is enabled) with a prompt saying the user approved the Discuss gate on `demo-01` at $X, that it is recorded, and this vault's `aos team` line; the dialog named that host before you confirmed. Cancel opens nothing. With a gate pending again, click Approve, and while the dialog is open run `aos team put example --from lead '{"id":"demo-01","title":"changed"}'` in a terminal: confirming is refused with "demo-01 changed after this view was drawn, so nothing was written", and the card redraws.
- [ ] **Redirect ❯_** opens Term running the lead's agent (`claude --agent team-lead '…'`); the prompt names the gate and the exact line that records the redirect in this vault (`AOS_VAULT='<vault>' '<node>' '<vault>/brain/scripts/team.js' gate redirect 'example' 'demo-01' --expect '…' --note '…'`). With both hosts enabled there is one button per host. With a Claude config folder or Codex home other than the terminal's default, the command starts with `CLAUDE_CONFIG_DIR='…'` or `CODEX_HOME='…'`.
- [ ] Board: one column per stage, ◆ on a stage with a gate, status chips (working cyan, gate amber, blocked rose, done green, done items folded into "N done"). A detached dispatch shows "<member> · <provider> · Nm" on its card. Clicking a card opens its detail: facts, posts, runs, and a budget stepper whose "Set to $X" is refused below spend plus live holds, with the CLI's reason under it. On a `paused` item the hint says raising it opens the lead, and a recorded raise opens the lead in Term to take the next step; a raise on a working item opens nothing.
- [ ] Roster: every member with a provider pill, model and effort, status (idle, working, blocked, paused), current item and last run; `❯_ claude` / `❯_ codex` start the member's agent. A team whose `TEAM.md` names a `parent:` is indented under it in the team chips and listed under IN THE TREE.
- [ ] Interact: the channel with @mentions highlighted and item filter chips. "keep it under $40, it's fine" posts as `you`, addressed `@lead`, exactly as typed (`aos team tail example`). Enter sends, Shift+Enter adds a line, and an unsent message keeps its text and focus when a new post lands.
- [ ] Manage has no text box. The provider, model and effort pickers offer only the presets (the lead's provider has no `opposite`), and a change rewrites one line of `TEAM.md`. The Team running switch writes or removes `DISABLED` (the chip dims, and the paused banner offers Resume); a member's switch sets `paused`. Add a member lists your agents not on the team; Remove asks first and is refused for a member who owns an open item.
- [ ] A `TEAM.md` with an unsupported line gives its chip a rose `!` and an error card naming the line, with Open TEAM.md; the other teams work, and `aos team list` shows it as unreadable.
- [ ] *Codex only* (`hosts.claude.enabled: false`): every Talk and Redirect button, and the session an Approve opens, runs `codex '…'` (the agent's Codex starter, or "Use the <agent> agent for this. …"), and no Claude button shows. *Claude Code only*: only `claude --agent …` buttons.
- [ ] `kill -9` a detached dispatcher, then open the tab: within a minute the member leaves "working" (the tab's `aos team list` sweep records the killed run), and its blocker shows in Interact.

## Status line (both hosts)

- [ ] *Claude Code:* `aos statusline install` names the status line it chains. On the next refresh the terminal shows the model line and the context line; with a gate pending (the `aos team put` line above) a third line reads `◆ gate demo-01 (discuss)`, and Cmd-clicking it (a terminal with OSC 8 links) opens the Workbench on Agent Teams.
- [ ] *Claude Code:* the chained status line still works (e.g. its bridge file under the temp dir is refreshed), and a subagent started in the session shows a row with its model, effort, context share and age.
- [ ] *Claude Code:* replace `statusLine` in `settings.json` by hand: `aos update-notice` (the SessionStart hook) prints `AgenticOS status line: replaced by …`, `aos doctor` shows `warn  status line  taken by …`, and `aos statusline install` takes it back and chains the replacement.
- [ ] *Codex:* `aos statusline install` writes `[tui] status_line = [...]  # agenticos statusline` into `config.toml`; `codex` shows those footer items, and a new session starts with `AgenticOS: 1 gate needs you (demo-01 discuss)`. An existing `status_line` is refused without `--force`.
- [ ] `aos statusline uninstall` restores `settings.json` and `config.toml` exactly (`diff` against the `.aos-statusline.bak` copies before running it) and removes the backups.
- [ ] The app's status bar: `⚡ live · ◆ gate demo-01 · …` within a minute of the gate, **with the Workbench tab closed**; clicking the gate opens Agent Teams, a flag opens `persona/STATE.md`, and a quiet vault reads `all clear`. `idle` is dimmed.
- [ ] Paste `agenticos://workbench?tab=notifications` into a browser: the app comes forward on Notifications, and starts on it when it was not running; `tab=nope` opens the Workbench on its current tab.

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
- [ ] `aos doctor` shows `ok codex login`, `ok codex plugin agenticos@agenticos-workbench <version>`, `warn codex hooks trusted 0 of 16` before the `/hooks` review and `ok … 16 of 16` after it, `ok codex MCP declared agenticos from the plugin`, no `codex direct wiring` row, and `persona runner` / `routines runner` naming `codex` on a Codex-only machine (`claude` when both are wired); with `--host codex` alone no `claude` row appears and the vault's health has no "CLAUDE.md is missing" error. *Direct:* `ok codex hooks 5 of 5 events`, `ok codex MCP declared … with AOS_HOST=codex`, `ok codex skills 25 generated`; on an install wired before 0.7.0 the MCP row is a FAIL (`registered without AOS_HOST=codex`) until `aos upgrade`.
- [ ] On a machine wired directly before this release, `aos upgrade` installs the plugin, prints `direct wiring removed (5 hook entries, the MCP registration, 28 skills)` and the `/hooks` reminder; after trusting the entries once, a second `aos upgrade` (or a version bump) leaves them trusted.
- [ ] A `codex exec "say ok"` session (hooks trusted) ends with a `host: "codex"` row in `runs.jsonl` carrying `cost_usd` and the model (Codex ≥ 0.155 fires SessionEnd on exit). Quit a Codex TUI session after one turn: its live header (`brain/_index/agent-runs/live/sess-<id>.ndjson`, first line) carries `host_pid` = the `codex` process (`pgrep -x codex` while it runs) and `host_started`; the next session start or stop of either host closes the run without waiting out the idle window (the live file is gone; `runs.jsonl` has a `host: "codex"`, `end_reason: "reconciled"` row), and `aos reconcile-sessions --force` run by hand before that prints `reconciled codex session <id> (process exited)`. A Codex TUI session left idle, or an exec run on a CLI that does not fire SessionEnd, leaves `brain/_index/agent-runs/live/sess-<id>.ndjson` behind; after `telemetry.staleAfterMinutes` (set it to 1 for the check) the next session start or stop of either host runs `reconcile-sessions`: the live file is gone, `runs.jsonl` has a `host: "codex"` row with `end_reason: "reconciled"` and the model name, and the pipeline ledger shows `auto-cost` and `auto-wrap` runs for that session. `aos reconcile-sessions --dry-run --force` lists what a sweep would do.
- [ ] With no `claude` on PATH, `aos routines run <a prompt routine>` runs it through `codex exec` (`aos routines list` shows the run, `brain/_index/provider-spend.jsonl` gains a `provider: "codex"` row), and `sh <vault>/brain/scripts/persona/run-duty.sh sitrep --dry-run` prints the `codex exec -` invocation.
- [ ] In `codex`, `/hooks` lists the sixteen agenticos plugin entries (*direct:* the five AgenticOS entries); trust them. A new session's first prompt receives `<brain-context>`, and `<agenticos-conventions>` is present at session start (ask *what conventions apply here?*).
- [ ] `$agenticos:wrap`, `$agenticos:remember` and `$agenticos:recall` are offered as skills (*direct:* `$wrap`, `$remember`, `$recall`), and no `agenticos:source-command-*` skill appears; `$agenticos:recall <topic>` calls `mcp__agenticos__recall` without an approval prompt in a workspace-write sandbox.
- [ ] After a turn, `brain/_index/agent-runs/live/sess-<id>.ndjson` holds `tool_use_batch` rows with the Codex tool names (`Bash`, `apply_patch`, `mcp__agenticos__…`); the Stop hook produces no Codex error notice.
- [ ] With cost enabled, closing the thread (or `aos auto-cost --cost-one <session-id>` with `AOS_HOST=codex`) appends a `cost_source: "codex-rollout"` record to `costs.jsonl` (`runs.jsonl` is unchanged); the HUD Runs tab shows the cost on the session's run within a second.
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

- [ ] On a fresh install the Term tab opens a live shell at once (the app carries the terminal), with no "Terminal unavailable".

## Telemetry switch

- [ ] With `telemetry.enabled` false (⚙ Settings → Telemetry, or `aos config set telemetry.enabled false`): no `agent-runs/live/` is created on load and the plugin starts no `reconcile-sessions.js`; Runs tab still reads existing `runs.jsonl`; the hooks record nothing either — one key for `telemetry-hook.js` and the plugin.
- [ ] Workbench settings from 0.17 or earlier (the Obsidian-era `data.json` the app copies, or its own) that stored `costEnabled`/`telemetryEnabled` lose both keys on the first load (the console logs `pruned dead settings keys`).

## Review readiness

- [ ] The HUD's Omnisearch command registers no default hotkey; the app binds ⌘K to it (View ▸ Search…), and ⌘P opens the command palette.
- [ ] DISK donut and COST DETAIL sparkline render (SVG nodes, no innerHTML) in the SYSTEM drawer.
- [ ] Clock and timestamps follow the OS locale.
