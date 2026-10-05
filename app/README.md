# AgenticOS Workbench — the app

The Workbench as a macOS app. The HUD in `../obsidian-plugin` runs in its own Electron window, compiled unchanged
against an Obsidian compatibility package (`compat/`), so the same source is the Workbench everywhere. The runtime,
the Claude Code and Codex plugins, the routines and the vault format are the ones in this repo.

Design and roadmap: `docs/superpowers/specs/2026-10-05-workbench-app-design.md` and
`docs/superpowers/plans/2026-10-05-workbench-app.md`. macOS only.

## Run it from a checkout

Requires Node 22.12+ and an AgenticOS install (the app reads the vault from `agenticos.json`, or `$AOS_APP_VAULT`).

```sh
cd app
npm ci
node node_modules/electron/install.js   # Electron 44 fetches its binary on first use
npm start
```

Every Workbench surface writes to the vault, as the HUD always has; writes outside the surfaces in
`src/shared/write-policy.ts` are refused and logged. `AOS_APP_WRITE` narrows a run: `""` is read-only, `todo,chat` turns
on only those. The Term tab is a real shell: what you run there, or what a ❯_ button types for you, runs for real.

A dev run keeps its data in `~/Library/Application Support/AgenticOS Workbench (dev)`, apart from an installed app's.
Run a second instance with `AOS_APP_USER_DATA=<another folder>`.

## Build a signed app

Needs a "Developer ID Application" identity in the login keychain, and a notarytool keychain profile.

```sh
APPLE_KEYCHAIN_PROFILE=<profile> npm run dist                            # package, sign, notarize the app, build the DMG
APPLE_KEYCHAIN_PROFILE=<profile> npm run dist:verify -- --notarize-dmg   # notarize and staple the DMG, verify both
npm run smoke:packaged                                                    # run the packaged app on a synthetic install
```

## Layout

```
compat/          the `obsidian` module as the app provides it (the HUD imports it by that name)
src/main/        Electron main: window, menubar item, app menu, agenticos:// links, app://hud, vault watcher
src/renderer/    boot, the fs/child_process write guards, host chrome
src/shared/      the main ↔ renderer IPC contract, and the write policy (the surfaces)
scripts/         build, compat tripwire, fixture generator, unit-test runner, live-vault driver, packaged checks
build/           the packaged app's entitlements and icon (electron-builder.yml is beside this file)
tests/           unit tests, and the end-to-end suite with its coverage map (tests/e2e/COVERAGE.md)
```

## Scripts

| Command | Does |
|---|---|
| `npm start` | build, then open the app |
| `npm run build` | bundle main and renderer into `out/` |
| `npm run typecheck` | strict `tsc` over the app and the compat package |
| `npm run test:unit` | unit tests (the write policy and the guards, links, tray, menu, paths) |
| `npm run check:compat` | fail if the HUD uses an Obsidian API, DOM helper or icon `compat/` lacks |
| `npm run test:e2e` | build, generate the synthetic fixture vault, run the Playwright `_electron` suite |
| `npm run fixture` | generate the fixture vault alone (`tests/.fixture/`) |
| `npm run spike:screens` | drive the app on your real vault; screenshots and a report in `spike-output/` (never commit it) |
| `npm run dist` | build, then package, sign and (with `APPLE_KEYCHAIN_PROFILE`) notarize the app and its DMG into `dist/` |
| `npm run dist:verify` | check the build's signature, entitlements, fuses, contents, notarization and DMG |
| `npm run smoke:packaged` | run the packaged app on a fresh synthetic install (`-- --live`: on your vault, read-only) |

`app/` has its own lockfile and is not an npm workspace, so the runtime's installs and the repo's other CI jobs never
pull Electron or native modules. CI runs all of the above on macOS (`.github/workflows/ci.yml`, job `app`).
