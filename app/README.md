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
`src/shared/surfaces.ts` are refused and logged. `AOS_APP_WRITE` narrows a run: `""` is read-only, `todo,chat` turns
on only those. The Term tab is a real shell: what you run there, or what a ❯_ button types for you, runs for real.

The page runs sandboxed, with context isolation and no Node. Every file it reads or writes, every process and terminal
it starts and everything it hands to the OS is a call over the preload's bridge (`window.aos`), which main checks
against the read scope, the write surfaces and the program rules (`src/main/policy/`). `../SECURITY.md` has the review.

A dev run keeps its data in `~/Library/Application Support/AgenticOS Workbench (dev)`, apart from an installed app's.
Run a second instance with `AOS_APP_USER_DATA=<another folder>`.

## Build a signed app

Needs a "Developer ID Application" identity in the login keychain, and a notarytool keychain profile.

```sh
APPLE_KEYCHAIN_PROFILE=<profile> npm run dist                            # package, sign, notarize the app, build the DMG
APPLE_KEYCHAIN_PROFILE=<profile> npm run dist:verify -- --notarize-dmg   # notarize and staple the DMG, verify both
npm run dist:test && npm run smoke:packaged                               # the smoke build, run on a synthetic install
```

## Layout

```
compat/          the `obsidian` module as the app provides it (the HUD imports it by that name)
src/main/        Electron main: window, menubar item, app menu, agenticos:// links, app://hud, vault watcher
src/main/ipc/    the bridge's handlers: sender check, zod schemas, a Result for every call
src/main/policy/ what the page may read, write, run and open (read scope, write policy, programs, shell, debug switches)
src/main/services/ the page's files, processes and terminals (node-pty), as main runs them
src/preload/     window.aos: the contextBridge of named functions, the page's only way into main
src/renderer/    boot, the HUD's host over the bridge, the POSIX path shim, host chrome
src/shared/      the IPC contract (no imports) and the write surfaces
scripts/         build, compat tripwire, fixture generator, unit-test runner, live-vault driver, packaged checks
build/           the packaged app's entitlements and icon (electron-builder.yml is beside this file)
tests/           unit tests, and the end-to-end suite with its coverage map (tests/e2e/COVERAGE.md)
```

## Scripts

| Command | Does |
|---|---|
| `npm start` | build, then open the app |
| `npm run build` | bundle main, the preload and the page into `out/` (a Node import from the page fails the build) |
| `npm run typecheck` | strict `tsc` over the app and the compat package |
| `npm run test:unit` | unit tests (the policies and services behind the bridge, the path shim, links, tray, menu, paths) |
| `npm run check:compat` | fail if the HUD uses an Obsidian API, DOM helper or icon `compat/` lacks |
| `npm run test:e2e` | build, generate the synthetic fixture vault, run the Playwright `_electron` suite |
| `npm run fixture` | generate the fixture vault alone (`tests/.fixture/`) |
| `npm run spike:screens` | drive the app on your real vault; screenshots and a report in `spike-output/` (never commit it) |
| `npm run dist` | build, then package, sign and (with `APPLE_KEYCHAIN_PROFILE`) notarize the app and its DMG into `dist/` |
| `npm run dist:verify` | check the build's signature, entitlements, fuses, contents, notarization and DMG, and that it refuses a debugger |
| `npm run dist:test` | the smoke build in `dist-test/`: packaged like `dist`, ad-hoc signed, the one build that accepts the DevTools port |
| `npm run smoke:packaged` | run the smoke build on a fresh synthetic install (`-- --live`: on your vault, read-only; `-- --app <path>`) |

`app/` has its own lockfile and is not an npm workspace, so the runtime's installs and the repo's other CI jobs never
pull Electron or native modules. CI runs all of the above on macOS (`.github/workflows/ci.yml`, job `app`).
