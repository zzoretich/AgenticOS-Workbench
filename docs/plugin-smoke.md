# Obsidian plugin — manual smoke checklist

Run before tagging a release, on a vault created by `aos init` (not the developer vault). Repeat the provider rows for each provider you can reach (`aos provider none|ollama|claude`; the scripts rewrite `brain/_index/provider-state.json` on the next hook run — start one `claude` session and exit, or run `aos scan-vault --quiet`).

## Release procedure

1. `npm run version:bump -- X.Y.Z && npm install --package-lock-only --ignore-scripts` (one product version: root `package.json`, `obsidian-plugin/{manifest,package,versions}.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`; the install refreshes `package-lock.json`, the seventh surface — npm owns its format, and `--check` verifies it).
2. `git commit -am "chore: release vX.Y.Z" && git tag vX.Y.Z`; push the tag only after in-chat confirmation.
3. `release.yml` verifies the bump, runs the gate + plugin tests, builds, and attaches `main.js`, `manifest.json`, `styles.css`.

## Install paths

- [ ] Copy the three release assets into `<vault>/.obsidian/plugins/agentic-os/`, enable the plugin: it loads with no console errors and `[agentic-os] loaded` is logged.
- [ ] Settings → Agentic OS shows the AgenticOS section: Vault root blank, Claude config dir placeholder from `agenticos.json`, Node binary blank; **Probe** fills a path and shows a notice.
- [ ] Provider row reflects `provider-state.json` (name + reason); the refresh icon re-reads it.

## Settings

- [ ] Vault root: typing a path that is not a directory (e.g. a file, or a path that does not exist) is ignored while typing — nothing is saved, no Notice.
- [ ] Vault root: leaving the field (blur) on a value that is not a directory shows a Notice once ("Vault root: … is not a directory — keeping …") and restores the field to the saved value.

## Pulse

- [ ] LEDs: every manifest pipeline appears (incl. `EMBED`, which reads `EMBED off` under `claude`/`none`); never-ran and `disabled` stages are gray (`is-neutral`) with the reason in the tooltip; nothing red on a fresh vault.
- [ ] Briefing row label is the persona's name from `persona/IDENTITY.md` (upper-cased); with no persona layer it reads `BRIEFING`. **(Plan 5)** `aos persona rename <name>` changes it on the next refresh — the persona layer and that command ship in Plan 5, so until then verify only the `BRIEFING` fallback and, if you want the named case, hand-write a `persona/IDENTITY.md` with an H1.
- [ ] COST row absent while `costEnabled` is off or `cost.monthlyBudget` is null; **(Plan 5)** present after `aos cost enable` with a budget and the toggle on — `aos cost enable` returns 1 until Plan 5 ships `extras/cost`, so until then set `cost.monthlyBudget` in `brain/config.json` by hand and turn the toggle on in Settings.
- [ ] **(Plan 5)** On a fresh install (Cost/Telemetry toggles never saved) `aos cost enable --budget 100` then a plugin reload shows the COST row with **no** toggle change — Settings → Cost module enabled already reads on (seeded from `agenticos.json` `cost.enabled`); flip it off in Settings and `aos cost enable` no longer overrides it (the saved toggle wins). Same precondition: until Plan 5, write `"cost": { "enabled": true }` into `agenticos.json` by hand to exercise the seeding.
- [ ] Fix Queue shows no anchor/backfill cards while cost is off; `open-health` still appears when health.md has errors.
- [ ] Command deck `/scan` spawns `scan-vault.js` with the resolved node (notice `▶ /scan`, then `✓ /scan: …`).

## Spaces / Memory / Runs

- [ ] Spaces lists workspaces from `snapshot.json`; insight footer says `local` when no model tag is present.
- [ ] Memory graph renders; daily notes under the configured `dailyNote.layout` classify as `session` nodes.
- [ ] Runs tab updates within a second of a new line appended to `agent-runs/runs.jsonl` (bus `runs-appended`).

## Chat (per provider)

- [ ] `none`: the Chat rail button is absent; `Open Workbench: Chat` command shows the "no provider — run `aos provider`" hint.
- [ ] `ollama`: header says `· local ask.js`; a question answers with prose (never a `<<<AOS_CONTEXT feature=ask>>>` block — that would mean `--local` was dropped from the spawn); a failing `ask.js` (stop Ollama) shows its last stderr line, not `exit 1`.
- [ ] `claude`: header says `· headless claude (haiku, capped)`; a question answers with `$0.00xx` in the turn meta; `brain/_index/provider-spend.jsonl` gains a `feature:"chat"` row; with `claude` logged out the error reads `Not logged in …`.

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
