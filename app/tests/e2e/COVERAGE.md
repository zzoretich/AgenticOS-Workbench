# e2e coverage of `docs/app-smoke.md`

The per-tab checklist is `../docs/app-smoke.md` in this repo. Every checkbox item in it
is listed below with the spec that covers it, or why it is not covered here.

- **covered**: every read-only part of the item is asserted.
- **covered in part**: part of the item is asserted; the rest needs something named in the reason.
- **N/A in the app**: the item is about the runtime CLI or a host session (Claude Code or Codex).
- **not covered**: read-only, but not automated yet, with the reason.

Specs live in `tests/e2e/`; a reference is `file › test` (titles shortened). Run the suite with `npm run test:e2e`
(builds the app, generates the fixture with `scripts/make-fixture-vault.mjs`, runs every spec). The "Release procedure"
list at the top of app-smoke.md is the release process, not app behaviour: it is not counted.

## Totals

| Status | Items |
|---|---|
| covered | 90 |
| covered in part | 17 |
| N/A in the app | 39 |
| not covered | 5 |
| **total** | **151** |

Of the 112 items about the app (151 minus the 39 N/A), 107 are asserted (90 fully, 17 in part); the other 5 are not
covered, for the reasons below. Every write surface is enabled and tested. The
"in part" rows need something the fixture or the app lacks (a dispatched seat, a Codex database, the clipboard, the
OS handing over an `agenticos://` link, a published update). The writes, each surface on through `AOS_APP_WRITE`:
- To-Do (T1, T2, T4, T5, T7) in `todo-writes.spec.ts`;
- Notifications (N4, N5, N6) in `notifications-writes.spec.ts`;
- Capture (P7, P8) in `capture-writes.spec.ts`;
- Settings (S3, S6, S7, S8, I2) in `settings-writes.spec.ts`;
- Routines (RT2, RT3, RT4, RT5) in `routines-writes.spec.ts`;
- Skills & Agents sharing (SK5, AG4, and SK1, SK2, AG2 on a machine with both hosts) in `sharing-writes.spec.ts`;
- Pulse (P5, P6) in `pulse-writes.spec.ts`;
- Spaces' map now, ↻ and regen (beyond the checklist) in `spaces-writes.spec.ts`;
- Agent Teams (AT1, AT3, AT5's budget, AT7, AT8) in `teams-writes.spec.ts`, and the seed in `variants.spec.ts`;
- Chat (CH1, CH3, CH4) in `chat-writes.spec.ts`, against stub `claude` and `codex` CLIs and a stub Ollama server;
- Files (F5, F6, F7) in `files-writes.spec.ts`;
- the note editor, the app's own Notes surface (beyond the checklist), in `notes-writes.spec.ts`;
- the settings window (I3, S1, S11) in `settings-window.spec.ts`.

The 4 not covered: the To-Do midnight roll-over (needs a controllable clock), a duty run recorded outside the runtime
(needs a real duty run), a killed dispatcher (needs a dispatched seat), and the vault-root picker's Notices (need a
second vault in its list).

Tests beyond the checklist: boot and the write guard with every surface off (`shell`), every verified surface on by
default with no write-mode item and no Write Access menu (`variants`), a refused To-Do tick with the surface off (`todo`), other surfaces still
refused with To-Do on (`todo-writes`) and with Notifications on (`notifications-writes`), a state change `aos notify`
made underneath surviving the tab's next write (`notifications-writes`), Quick Capture and the deck's /feedback and
/project writing a memory and its MEMORY.md line, a missing type folder created, and a typed slug that climbs out of
brain/memory refused (`capture-writes`), on/off, ▶ and apply schedules refused with the surface off (`routines`), a
disabled routine saved while it stays off running no sync, create's refusals, a schedule changed underneath and applied
from the banner, and every other plist re-rendered byte for byte by each sync (`routines-writes`), unshare refused for a
skill and an agent with the sharing surface off (`skills-agents`), the other mirrors untouched by an unshare and a
share (`sharing-writes`), the promote trail's keep, edit and revert, the Fix Queue's backfill, brain rebuild and
re-anchor (`pulse-writes`), a keep and a Fix Queue run refused with the surface off (`pulse`), map now, ↻ one file
and ↻ regen under provider `none` (`spaces-writes`), ↻ regen and ↻ refused with the surface off
(`spaces-memory-runs`), a refused approve and seat pick with the surface off (`agent-teams`), the member pause
switch, the team's DISABLED switch and Add / Remove round trips back to the same TEAM.md (`teams-writes`), Chat's
exact `claude -p` recipe over the recall hits, a failed call with and without a cost, Cancel, a question typed as a
bullet, another HUD's turns read back, and Codex answering under a "local ask.js" header (`chat-writes`), a question
refused on both routes with the surface off (`variants`), the note editor's autosave, ⌘S, undo back to the original,
outside changes, the conflict strip, a deleted note, save on close, read-only runtime files and the terminal-focus
guard (`notes-writes`), Edit disabled with Notes off (`sidebar-omni-notes`), the tray popover with the SidebarHUD
(`shell`), a full-tour no-error check, user content unchanged
after the tour, note view and link following, ⌘K results and dispatch, the sidebar HUD's tiles and ticker, inspector
pop-outs into the split pane, external links routed to the OS, and one `test.fixme` documenting a compat gap (⧉ copy,
see below).

## Install paths

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| I1 | The app opens the vault on Pulse with no error; a dev run logs `[host] AgenticOS HUD <version> loaded` | covered | `shell › boots the Workbench…` (the HUD's version loaded), `shell › a tour … raises no renderer or main-process error`. |
| I2 | Paths section as pickers (this vault / auto / auto with nodes listed); Probe picks a path | covered | `settings › WORKBENCH section…` (the three pickers and the Probe button), `settings-writes › Probe resolves node again and saves it in the app's own settings` |
| I3 | Provider row reflects `provider-state.json` (name + reason); refresh re-reads it | covered | `settings-window › the plugin's tab…` in the app's settings window: `none (forced) — checked …` and its refresh button; `settings › WORKBENCH section…` renders the same tab directly. |

## The app

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| APP1 | No install: the wizard's checks; a fix-it runs in its terminal, then the checks run again; Ollama's missing models are a warning whose fix pulls them | covered | `setup › with no install, the wizard checks what aos init needs, on the login PATH`, `› a fix-it runs its fixed command in the wizard's terminal…`, `› Ollama's missing models do not hold up Continue…` (stand-in CLIs, `brew`, `ollama` and `curl`). The Install Ollama and its models command itself is run on stand-ins in `tests/unit/setup.test.ts`. |
| APP2 | Choose, Your agent, Install, Finish (the `CLAUDE.md` diff, the Codex `/hooks` step), Open the Workbench | covered in part | `setup › hosts offer only what is ready…`, `› the persona form checks the name…`, `› Install runs the payload's aos init…`, `› the CLAUDE.md line is shown as a diff…`, `› Open the Workbench attaches the vault without a relaunch…`. The Codex `/hooks` section is not asserted. |
| APP3 | An existing install: What changed once per vault; the runtime offer, Update now and Later | covered | `attach › the What changed note shows the first time…`, `› a runtime older than the app's offers aos upgrade, and runs it only when asked` |
| APP4 | Obsidian-era settings in effect on first start, and copied into the app's data before any change | covered | `variants › a vault whose HUD ran in Obsidian first › the app starts with Obsidian's plugin settings…` |
| APP5 | Check for Updates… (greyed out with the reason when off); Restart to update once downloaded | covered in part | `attach › the app's own update: off in a dev run, and Restart to update asks main…`. A real update needs a published release: the acceptance run's §8. |
| APP6 | The menubar popover; closing hides the window, ⌘Q quits; doctor's `workbench app` row | covered in part | `shell › tray popover…`, `shell › the app records itself in the vault…` (what the doctor row reads). Closing and quitting are the OS's; the row itself is the runtime's. |
| APP7 | Light and dark: follows macOS under Match macOS; the toggle, the palette, View ▸ Appearance and App settings switch it; it survives a restart; the windows and terminals follow | covered in part | `theme › with no choice saved, the page draws in the appearance macOS reports`, `› the ribbon's toggle switches to the opposite…`, `› the palette's command flips it back, and the menu shows the choice`, `› App settings ▸ Appearance goes back to Match macOS`, `› the choice outlives a restart…`. A spec cannot switch macOS's own appearance, and the popover's and terminals' repaint is not asserted (`tests/unit/theme.test.ts` covers the terminal colours' source). |
| APP8 | Both themes read well: no unreadable text, status colours keep their meaning, Inter and JetBrains Mono | covered in part | `obsidian-plugin/src/ui/tokens.test.ts` holds every text, status and terminal colour to 4.5:1 in both themes; `theme › the ribbon's toggle switches…` checks the tokens reach the page. Looking at each tab is by eye. |

## Files

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| F1 | Files second on the rail; the top level, folders first, without dot-folders, node_modules or graphify-out | covered | `files › Files sits second on the rail…` |
| F2 | A folder opens and closes in place; a click on a note opens it | covered | `files › a folder opens and closes in place…` |
| F3 | Search across notes with the hit highlighted; all text files; a line opens its note; Escape clears | covered | `files › search finds lines across notes…` |
| F4 | Open file… (⌘O) fuzzy, Markdown first; Search vault… (⌘⇧F) focuses the search box | covered | `files › Open file… matches paths fuzzily…`, `› Search vault… opens Files…` |
| F5 | + note in the chosen folder (created if missing), opened; the form says why it refuses | covered | `files-writes › + note makes a Markdown note in a new folder…`, `› the new-note form says why it refuses…` |
| F6 | Rename keeps the folder and extension; Move to another folder; both keep the bytes | covered | `files-writes › rename keeps the folder, the extension and the bytes`, `› move puts the file in another folder…` |
| F7 | ✕ asks first; Move to Trash; brain/_index and brain/scripts files offer no actions | covered | `files-writes › ✕ asks first…`, `files › folders AgenticOS writes itself have no new-note action…` |

## Settings

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| S1 | ⚙ at the rail's foot, visible in a short pane, Enter / Space open it; palette and settings-window entries | covered | `shell › rail: … ⚙ Settings at the foot`, `shell › rail: ⚙ stays reachable…`, `shell › rail: Enter or Space…`, `shell › commands…`; `settings-window › the plugin's tab…`: Open Workbench settings in the settings window closes it and opens the Settings tab. |
| S2 | "N changed from the defaults" matches `aos config list`; key, source pill (file on hover), when it applies; daily caps "today $x of $cap" | covered | `settings › head…`, `settings › every row…`, `settings › number rows…` |
| S3 | Master switches write (Telemetry off; Background AI asks first) | covered | `settings › master switches…` (state), `settings-writes › master switches write; Chief of Staff pauses duties through persona/DISABLED…`, `› Background AI asks before paid calls…`, `› Telemetry off and on…` |
| S4 | No text box; − / + on number rows; + on a cap asks first, − never asks; − / + disabled at the ends | covered | `settings › no text box…`, `settings › number rows…`, `settings › − is disabled at the lowest preset; + … asks first, and Cancel changes nothing`, `settings-writes › + on a spend cap asks first and Raise writes the next preset…` |
| S5 | A value outside the presets reads "$175.00 (custom)", is not changed by opening the tab; − / + go to $150 / $200 | covered | The fixture sets `cost.monthlyBudget 175` with `aos config set`. `settings › number rows…`; `shell › read-only guard…` checks `brain/config.json` is unchanged. |
| S6 | recallRoots / routines.tools chips (last chip locked); Edit brain/config.json buttons; Manage in Skills / Agents; hosts & install plain text | covered | `settings › list settings…`, `settings › quickLinks and external labels…`, `settings › hosts & install…`, `settings-writes › chips: a routine tool change asks first; switching all but one off locks the last one…` |
| S7 | Setting `claude.model` leaves a follow-up bar and a ⚙ badge; clicking runs the sync | covered | `settings-writes › a picker sets the key in the file that wins; its follow-up becomes a button and a ⚙ badge…`; with the surface off, `settings › …a change is refused…` |
| S8 | ↺ resets a row; hosts & install rows read-only; ❯_ aos doctor / aos upgrade open Term running them | covered | `settings › hosts & install…`, `settings › ❯_ aos doctor runs the vault's own doctor in a new Term session`, `settings-writes › ↺ goes back to the default…`. `aos upgrade` runs in Term, the user's shell, as doctor does. |
| S9 | Claude-only: Codex rows dimmed with the hint, still editable; Codex-only: Claude rows dimmed; both: nothing dimmed | covered | `settings › Codex rows are dimmed…`, `variants › a Codex-only machine › Settings…`, `variants › both hosts › Settings: nothing is dimmed` |
| S10 | A runtime before 0.17: "run aos upgrade" with a button; the WORKBENCH section works | covered | `variants › a runtime that predates aos config › Settings asks for aos upgrade…` |
| S11 | WORKBENCH section and the settings window's Agentic OS tab show the same rows; a change in one shows in the other | covered | `settings › WORKBENCH section…` (same rows, same renderer), `settings-window › the plugin's tab…` (the rows in the window), `settings-window › a change in the window shows in the WORKBENCH section…` (both ways; the plugin's settings live in the app's data folder). |
| S12 | Vault root picker: a missing vault shows a Notice; a different vault the 10 s explanation | not covered | Picking saves only the plugin's own settings (userData, which no write surface gates); reaching either Notice needs a second vault in the picker's list, which the fixture does not have. |

## Config (both hosts)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| C1 | `aos config` list / set --dry-run / unset | N/A in the app | Runtime CLI. (The fixture generator uses `aos config set` and `aos config list --json`.) |
| C2 | `persona.enabled` creates `persona/DISABLED`; `config set vault` and headless `provider` refused | N/A in the app | Runtime CLI. |
| C3 | `aos doctor` config row warns on an unknown key | N/A in the app | Runtime CLI. |
| C4 | Claude Code `/aos config …` | N/A in the app | Host session. |
| C5 | Codex `$agenticos:aos config …` | N/A in the app | Host session. |

## Pulse

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| P1 | LEDs: every manifest pipeline, EMBED off, never-ran / disabled gray with the reason, nothing red | covered | `pulse › LEDs…` |
| P2 | Briefing label is the persona's name; BRIEFING without a persona; `aos persona rename` | covered | `pulse › briefing row…`, `variants › an empty vault › Pulse: … BRIEFING`. The rename is a CLI write. |
| P3 | COST row absent while cost is off, present with cost on and a budget | covered | `pulse › COST row…`, `variants › session costing off › Pulse…`. Switching it on is a write. |
| P4 | No anchor / backfill cards while cost is off; open-health still shows | covered | `variants › session costing off › Pulse…`, `pulse › Fix Queue…` |
| P5 | Deck `/scan` spawns scan-vault.js | covered | `pulse-writes › deck /scan runs scan-vault.js…`. `scan-vault.js` with no argument is one of the background refreshes, so it runs whatever surface is on. |
| P6 | Deck `/reflect-week` writes the week's reflection (or fails under `none`) | covered | `pulse-writes › deck /reflect-week runs reflect-week.js --local; with no provider it reports why…` (the fixture's provider is `none`: no model is called). |
| P7 | Deck `/remember` opens a one-field form; the note lands in SESSION.md | covered | `pulse › command deck: /brain opens BRAIN.md; /remember and /pattern open their forms…`, `capture-writes › /remember appends to SESSION.md…`, `› /remember with no SESSION.md creates it` |
| P8 | Deck `/pattern` asks area, title and pattern; writes the pattern file and MEMORY.md | covered | Same Pulse test (the form opens; Cancel writes nothing), `capture-writes › /pattern appends to an existing area's file, and a new area gets its file and a MEMORY.md line` |
| P9 | Listener leak: switching tabs five times leaves one `session-add` listener | covered | `pulse › listener leak…` Compat keeps listeners in `_handlers` (Obsidian's internal `_` does not exist); the test asserts the count does not grow per visit. |
| P10 | Heartbeat pill: absent before the watchdog runs; ♥ with per-duty tooltip; amber at 2 h; rose with a missed duty | covered | `sidebar-omni-notes › sidebar HUD › … heartbeat pill…` (the fixture ran `aos routines run heartbeat`), `variants › an empty vault › sidebar: no heartbeat pill…` |

## To-Do

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| T1 | Rail between Pulse and Proposals; "Nothing open" without TODO.md; `open TODO.md` creates and opens it | covered | `shell › rail…`, `variants › an empty vault › To-Do…`, `todo › open TODO.md…` (an existing file), `todo-writes › without TODO.md, open TODO.md creates it from the template…` |
| T2 | Quick-add appends to `## Open` | covered | `todo › quick-add row…` (the controls), `todo-writes › quick-add appends to the end of ## Open…` (Enter and + add; the file byte for byte) |
| T3 | OVERDUE / TODAY / UPCOMING / SOMEDAY with late markers, priority order; badge follows a hand edit within a second with another tab active | covered | `todo › head counts and the four groups…`, `todo › badge counts overdue + today…` |
| T4 | Ticking moves the item to Done; unticking moves it back | covered | `todo-writes › ticking moves the item and its child line…`; with the surface off, `todo › …a tick is refused…` |
| T5 | Double-click edits the whole line; Enter saves, Escape cancels; priority / date / ✕ | covered | `todo › double-click edits the whole line…; Escape cancels and writes nothing`, `todo-writes › edit saves on Enter; the priority button cycles; the date picker sets 📅; ✕ asks first` |
| T6 | Tag chips filter; a row's tag filters; all clears | covered | `todo › tag chips…` |
| T7 | Stale guard: a changed line is reported, the quick-add draft survives | covered | `todo-writes › stale guard…` (the vault's events held back so the tab still shows the old line), `› a tick made in the other HUD shows here…` |
| T8 | Past local midnight a TODAY item moves to OVERDUE without a reload | not covered | Needs a controllable clock: the tab re-groups on a 60 s timer against the real clock. |

## Proposals

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| R1 | Rail after To-Do; badge hidden with no proposals; a copied-in proposal shows an amber count within a second with another tab active, and goes when deleted | covered | `shell › rail…`, `variants › an empty vault › badges…`, `proposals › badge…` |
| R2 | PENDING: slug, target, kind pill, surface, age, `confirmed Nd` (green at 2+), ⚠ with reasons | covered | `proposals › PENDING…` |
| R3 | Expanded row: needs, recipe, What / Why / Risk as Markdown, premises; Open file; group heads collapse | covered | `proposals › a row expands…`, `proposals › Open file…`, `proposals › group heads…` |
| R4 | BACKLOG newest first; HISTORY newest first without filed rows; rates match `ledger.js summary` | covered | `proposals › BACKLOG…`, `proposals › HISTORY…`, `proposals › head, review button and the 28-day rates line…` |
| R5 | Review in Claude ❯_ opens Term running `claude "review persona flags"` (no extra shell); Codex-only runs the flag-closer skill | covered | `proposals › Review in Claude ❯_…`, `variants › a Codex-only machine › Proposals…` (a directly wired Codex's `$persona-flag-closer` form is not exercised). |
| R6 | Without `persona/`: only the "isn't set up" line | covered | `variants › an empty vault › Proposals…` |
| R7 | "Appears after the next scan"; running `proposal-html.js` makes the row open the page in the browser; the page itself in light and dark | covered in part | `proposals › proposal pages…`, `proposals › proposal-html.js run in the vault…`. The page opens in the OS browser (recorded, not opened): its rendering is outside the app. |
| R8 | The Markdown gains the page link; a second run skips it; BACKLOG and HISTORY rows with a page link it | covered in part | `proposals › proposal-html.js run…` (the link line), `proposals › BACKLOG…` and `› HISTORY…` (page links). "A second run prints skipped" is the runtime's own output. |

## Notifications

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| N1 | Rail after Proposals; no `brain/notifications`: badge hidden, "No notifications yet" with the hint | covered | `shell › rail…`, `variants › an empty vault › Notifications…` |
| N2 | `aos notify post` shows an amber count within a second, with another tab active | covered | `notifications › a post from aos notify post…` (the fixture's edition carries the actions). |
| N3 | A breaking post raises a desktop notification and turns the badge rose; `osAlert false` suppresses it | covered in part | `notifications › rail badge … rose…`. The desktop alert comes from the runtime's `aos notify`, not the app. |
| N4 | Unread newest first; an edition expands to intro, sections and buttons; the row turns read; Mark all read | covered | `notifications › Unread lists…`, `› an edition expands…`, `› with the Notifications surface off, opening an unread item…` (refused), `notifications-writes › opening an unread item marks it read…`, `› Mark all read…`. In the Unread view the opened item leaves the list at once (upstream finding). |
| N5 | Level chips and sender dropdown; All and Archived views; Archive / Unarchive / Mark unread / Open note | covered | `notifications › level chips…`, `› a read item expands…`, `› Open note…`, `notifications-writes › Mark unread, Archive and Unarchive…` |
| N6 | More like this turns cyan and appends to `reactions.jsonl` | covered | A recorded vote renders chosen (`notifications › an edition expands…`); `notifications-writes › a vote appends one line to reactions.jsonl…` |
| N7 | Deep dive ❯_ opens a Claude Code / Codex session running the skill; one button per host with both | covered | `notifications › Deep dive ❯_…`, `variants › a Codex-only machine › Notifications…`, `variants › both hosts › Notifications…` |
| N8 | A hand-edited `run` action shows no button; a file without frontmatter shows the unreadable footer | covered | `notifications › an item hand-edited to carry a command…`, `› Unread lists…` (footer) |
| N9 | `/notifications` in Claude Code, `$agenticos:notifications` in Codex | N/A in the app | Host sessions. |

## Agent teams (both hosts)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| A1 | `aos team init / list / status` | N/A in the app | Runtime CLI (the generator uses init, put, post and list). |
| A2 | `aos team put` and the headless gate refusal | N/A in the app | Runtime CLI. |
| A3 | A `--detach` dispatch survives; `kill -9` is recorded | N/A in the app | Runtime CLI. |
| A4 | `/team` in Claude Code, `$agenticos:team` in Codex | N/A in the app | Host sessions. |

## Agent Teams tab (both hosts)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| AT1 | ⁂ after Agents; "Open Workbench: Agent Teams"; "No teams yet" with the hint; Seed runs `aos team init` | covered | `agent-teams › rail…`, `shell › commands…`, `variants › an empty vault › Agent Teams…`, `variants › no teams yet, with the Agent Teams surface on › Seed the example team…` |
| AT2 | A gate put on the board shows an amber count within a second; NEEDS YOU card: item, gate, wait, spend, the lead's pitch, presets, − / +, a preset below spend disabled | covered | `agent-teams › a gate put on the board…`, `› NEEDS YOU…`, `› a budget preset or − / +…` |
| AT3 | Approve asks first, Cancel writes nothing; Approve records, opens the lead; a stale `--expect` is refused | covered | `agent-teams › Approve asks first; Cancel records nothing and runs nothing`, `teams-writes › Approve records the decision…`, `› an approve drawn before the lead changed the item is refused by --expect…` |
| AT4 | Redirect ❯_ opens the lead's agent with the gate and the recording line; one button per host; a config-dir prefix when it differs | covered in part | `agent-teams › Redirect ❯_…`, `variants › a Codex-only machine › Agent Teams…`, `variants › both hosts › Agent Teams…`. The `CLAUDE_CONFIG_DIR='…'` prefix needs a config dir other than the terminal's; the fixture's are the same. |
| AT5 | Board columns, ◆, status chips, folded done items; a detached dispatch on its card; detail with facts, posts, runs and the budget stepper; the paused hint | covered in part | `agent-teams › board…`, `› an item's detail…`, `› a paused item's detail…`. "Set to $X" in `teams-writes › an item's budget…`. A live run marker needs a dispatched seat. |
| AT6 | Roster: provider pill, model and effort, status, item, last run; ❯_ claude / codex; sub-team indented and IN THE TREE | covered | `agent-teams › roster…`, `› a sub-team's roster…`, `› team chips…` |
| AT7 | Interact: the channel with @mentions and item chips; posting, Enter / Shift+Enter, the draft kept | covered | `agent-teams › interact…`, `teams-writes › Interact: Enter posts to the lead; Shift+Enter adds a line…` |
| AT8 | Manage has no text box; preset pickers; the running switch; Add lists agents not on the team; Remove | covered | `agent-teams › manage…`, `teams-writes › Manage: an effort pick…`, `› Manage: a member's switch…`, `› Manage: Add puts an agent on the team; Remove asks first…` |
| AT9 | An unsupported `TEAM.md` line: rose ! and an error card with Open TEAM.md; `aos team list` shows it unreadable | covered | `agent-teams › team chips…`, `› the broken team shows an error card…`. The CLI half is the runtime's. |
| AT10 | Codex-only: every Talk / Redirect / Approve session runs codex; Claude-only: only `claude --agent` | covered | `variants › a Codex-only machine › Agent Teams…`; the default fixture is Claude-only (`agent-teams › roster…`: only `❯_ claude`). |
| AT11 | `kill -9` of a detached dispatcher: the member leaves working within a minute | not covered | Needs a dispatched seat. (The tab's `aos team list --json` sweep is one of the background refreshes and runs.) |

## Status line (both hosts)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| SL1 | Claude Code: `aos statusline install`, the model / context / gate lines | N/A in the app | Host terminal. |
| SL2 | Claude Code: the chained status line and subagent rows | N/A in the app | Host terminal. |
| SL3 | Claude Code: a replaced `statusLine` is reported and taken back | N/A in the app | Runtime CLI. |
| SL4 | Codex: `[tui] status_line` in `config.toml` | N/A in the app | Host terminal. |
| SL5 | `aos statusline uninstall` restores both files | N/A in the app | Runtime CLI. |
| SL6 | The app's status bar: `⚡ live · ◆ gate…` with the Workbench tab closed; gate → Agent Teams; flag → STATE.md; "all clear"; idle dimmed | covered | `shell › status bar…` (three tests), `variants › an empty vault › badges … all clear` |
| SL7 | `agenticos://workbench?tab=notifications` from a browser opens that tab, also when the app was not running; `tab=nope` keeps the current one | covered in part | `shell › agenticos:// links…` calls the handler main runs for the OS's `open-url` (registered before `ready`, so a link that launched the app waits for the page). The browser-to-OS hand-off is the packaged app's registration, not something the suite can drive. |

## Spaces / Memory / Runs

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| SMR1 | Spaces lists workspaces from `snapshot.json`; the insight footer names the model, or `local` | covered | `spaces-memory-runs › Spaces › lists…`, `› overview…` |
| SMR2 | A sessions chip `claude N · codex M · Nd ago` where a host worked; none otherwise | covered | `› Spaces › lists workspaces … with a sessions chip only where a host worked` |
| SMR3 | The outside-workspaces footer: ~-shortened, newest first, the adopt command on hover; gone once adopted | covered in part | `› Spaces › an outside-workspaces footer…`. Adopting writes. |
| SMR4 | The memory graph renders; daily notes are session nodes | covered | `› Memory › graph…` |
| SMR5 | Runs updates within a second of a new `runs.jsonl` line | covered | `› Runs › a line appended to runs.jsonl…` |

## Routines

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| RT1 | Every routine with cadence, next fire, last run and health; the seeded duties guarded | covered | `routines › lists every routine file…`, `› the persona's duties are guarded…` |
| RT2 | + new: an invalid cron shows the error, a valid one the cadence and next three fires; create writes and syncs | covered | `routines › + new opens the editor…`, `routines-writes › + new creates a command routine the runtime schedules…`, `› a schedule changed underneath shows the banner; apply now and apply schedules…` |
| RT3 | Editing a guarded duty's schedule asks first; Cancel writes nothing; Write anyway | covered | `routines › changing a guarded duty's schedule asks first; Cancel writes nothing`, `› ✎ on a guarded duty…`, `routines-writes › a guarded duty's schedule change asks first; Write anyway…` |
| RT4 | on / off rewrites `enabled:` | covered | `routines-writes › off → on writes enabled: true and the sync installs and loads its plist…`; the dimmed row in `routines › the persona's duties are guarded…` |
| RT5 | ▶ on a command routine runs it | covered | `routines-writes › ▶ runs a command routine now…` |
| RT6 | `routines.externalLabels` and the Obsidian Git timer under OUTSIDE THE RUNTIME, read-only | covered | `routines › outside the runtime…` |
| RT7 | Codex Automations with pills and chips; `codex as of`; refresh spawns the hosts refresh; without the app one dim line names why | covered in part | `variants › a Codex-only machine › Routines…` (no Codex database: the reason line and its age). Automation rows need Codex's database; refresh is a spawn. |
| RT8 | Claude cloud routines after `/routines cloud`: claude pill, link, `(UTC)` or `once at`, `ran once` | covered | `routines › outside the runtime…`, `› a cloud routine's name links to claude.ai…` (imported with `aos routines import-cloud`). |
| RT9 | A duty run outside the runtime shows in `last` with `trigger: duty-log` | not covered | Needs a real duty run (a model call). |

## Skills (both hosts)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| SK1 | YOUR SKILLS with host pills, source pill and chip; PLUGINS & BUILT-INS; head counts; the sharing note | covered | `skills-agents › Skills: head counts…`, `› Skills: a row carries…` (Claude-only, sharing off); `sharing-writes › with both hosts, sharing is on…` |
| SK2 | A cache older than ten minutes spawns `aos skills sync` once; sync now; re-render on change | covered | `skills-agents › stale inventories…` (one "▶ aos.js skills sync" notice whether the spawn is allowed or refused), `sharing-writes › sync now runs the runtime's sync…` |
| SK3 | The filter narrows both sections without losing focus | covered | `› Skills: the filter narrows…` |
| SK4 | ❯_ claude / ❯_ codex run the skill; ⧉ copies; open opens SKILL.md | covered in part | `› Skills: open hands the SKILL.md to the OS; ❯_ claude runs the skill…`. ⧉ is a `test.fixme` (compat gap, below). ❯_ codex needs a skill on the Codex side. |
| SK5 | unshare / share | covered | `sharing-writes › Skills: unshare records the exclusion and removes the Codex copy…`; refused with the surface off in `skills-agents › both hosts, with the sharing surface off…` |
| SK6 | Claude Code: a new skill is mirrored to Codex at session end | N/A in the app | Host session hooks. |
| SK7 | Codex: a new skill is mirrored to Claude Code | N/A in the app | Host session hooks. |
| SK8 | A hand-edited copy is left alone, reads `copy edited`, doctor warns; reset | N/A in the app | Runtime CLI. |
| SK9 | `hosts.codex.enabled: false`: sharing off note, claude pill only, nothing written under `~/.agents/skills` | covered | `› Skills: head counts, the sharing note…`, `› Skills: a row carries a cyan claude pill, a struck codex pill…` |

## Agents (both hosts)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| AG1 | YOUR AGENTS with pills, the read-only pill, source and chip; PLUGINS & CONFIG.TOML; head counts | covered | `skills-agents › Agents: head counts, the sharing note, the read-only pill…` |
| AG2 | A stale cache spawns `aos agents sync` once; sync now; the filter keeps focus | covered | `› stale inventories…`, `› Agents: the filter narrows…`, `sharing-writes › sync now runs the runtime's sync…` |
| AG3 | ❯_ claude runs `claude --agent <name>`; ❯_ codex; ⧉ copies `@agent-<name>`; open | covered in part | `› Agents: … how to reach an agent` (the run and copy targets). ⧉ hits the clipboard gap; ❯_ codex needs a Codex-side agent. |
| AG4 | unshare / share | covered | `sharing-writes › Agents: unshare removes the Codex agent file; share writes it back byte for byte`; refused with the surface off in `skills-agents › both hosts, with the sharing surface off…` |
| AG5 | Claude Code: a new agent is mirrored to Codex | N/A in the app | Host session hooks. |
| AG6 | Codex: a new agent is mirrored to Claude Code | N/A in the app | Host session hooks. |
| AG7 | A hand-edited copy is left alone; `explorer` reads can't share | N/A in the app | Runtime CLI (`aos agents sync`, doctor). |
| AG8 | `hosts.codex.enabled: false`: sharing off, claude pill only; `[agents] enabled = false` warns | covered in part | `› Agents: head counts, the sharing note…`. The config.toml warning needs a Codex config. |

## Cross-review and handoff (both hosts; each run spends)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| X1 | Claude Code cross-review with a Codex verdict | N/A in the app | Host session, model calls. |
| X2 | Codex cross-review and handoff | N/A in the app | Host session, model calls. |
| X3 | One CLI: same-provider review | N/A in the app | Runtime CLI. |

## Codex host

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| CX1–CX15 | Plugin install, doctor rows, upgrade, `codex exec` telemetry, hooks, skills, reconcile, cost, graph, uninstall (15 items) | N/A in the app | The Codex CLI host and the runtime; the app is not in that process tree. |

## Chat (per provider)

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| CH1 | `codex`: header `· codex via ask.js (reasoner caps)`; an answer; the spend row | covered | `variants › a provider on record › Chat…` (the header), `chat-writes › codex (CH1)…`: `ask.js --local` answers through a stub `codex exec`, and the runtime records its `reason:ask` row. |
| CH2 | `none`: no Chat rail button; Open Workbench: Chat shows the hint | covered | `sidebar-omni-notes › Chat and Term › no provider…`, `shell › rail…` |
| CH3 | `ollama` without a Claude login: header `· local ask.js`; an answer | covered | `variants › a provider on record › Chat…` (the header), `chat-writes › ollama without a Claude login (CH3)…`: the answer comes from a stub Ollama server; nothing is billed. |
| CH4 | `claude`: header `· claude (claude-opus-5, capped)`; an answer with its cost | covered | `variants › a provider on record › the Chat rail button…`, `› Chat under claude…` (the header), `chat-writes › claude (CH4)…`: a stub `claude` answers, the turn shows its time and cost, and the chat log and the spend ledger gain their lines. |

## Term

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| TM1 | A fresh install's Term tab opens a live shell at once, with no "Terminal unavailable" | covered | `sidebar-omni-notes › Term: a live shell…` (node-pty is the app's own dependency). |

## Telemetry switch

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| TS1 | `telemetry.enabled` false: no `agent-runs/live`, no reconcile on load; Runs still reads `runs.jsonl`; the hooks record nothing | covered in part | `variants › telemetry off…`. The hooks are the runtime's. |
| TS2 | Settings from 0.17 or earlier lose `costEnabled` / `telemetryEnabled` on first load | covered | `variants › a data.json from 0.17 or earlier…` (in the app they live in userData, not the vault). |

## Review readiness

| # | Item | Status | Covered by / reason |
|---|---|---|---|
| RR1 | The HUD's Omnisearch command registers no default hotkey (the app binds ⌘K to it; ⌘P is the palette) | covered | `shell › commands…` |
| RR2 | DISK donut and COST DETAIL sparkline render as SVG nodes | covered | `pulse › SYSTEM drawer…` |
| RR3 | Timestamps follow the OS locale | not covered | The clock it read went with the top bar (UniDeX D3); each tab formats its own timestamps, and the suite runs in one locale. |

## Compat gaps found

1. **⧉ copy fails in the app.** `src/main/index.ts` denies every permission request
   (`session.setPermissionRequestHandler(() => cb(false))`), `clipboard-sanitized-write` included, so
   `navigator.clipboard.writeText` rejects and the HUD shows "copy failed" for Skills and Agents ⧉, Spaces' copy abs /
   copy rel, and the Agent Teams no-terminal fallback. Obsidian allows it. Repro: open Skills, click ⧉ on any row.
   Documented as `test.fixme` in `skills-agents › Skills: ⧉ copies the invocation to the clipboard`.
2. **The guard log hides the script name for a long vault path.** `describe()` (then in `src/renderer/guard/child_process.cjs`, now `src/renderer/bridgeHost.ts`)
   cuts each argument to 90 characters from its start, so `…/brain/scripts/reconcile-sessions.js` logs as
   `…/brain/scri…` and the spawns can only be told apart by their trailing arguments. `shell › read-only guard…` matches on
   those tails.
