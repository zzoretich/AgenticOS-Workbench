# Agentic OS (Obsidian plugin)

The Workbench HUD for an AgenticOS vault. Desktop-only, dark UI. It renders caches written by the brain scripts (`brain/_index/*`) and never calls a model itself.

## Views

| View | Shows |
|---|---|
| Workbench (Pulse · Spaces · Memory · Runs · Chat · Term) | pipeline LEDs, fix queue, workspaces and file maps, memory browser and graph, agent runs, chat, embedded terminal |
| Sidebar HUD | ambient ledger, run and roster summary |
| Memory / Run Inspector | one memory or run, opened from the drawer or a command |
| Quick Capture | writes a memory through the same writer the scripts use |

## Data contracts

Every file under `brain/_index/` is read-only for the plugin; a script under `brain/scripts/` owns it. See the design spec for shapes and freshness windows.

## Dev loop

```
npm install
npm run dev     # gen:tokens, then esbuild watch
npm run build   # gen:tokens, then production bundle (main.js)
npm test        # check:hex gate, then node:test via tsx
```

- `src/ui/tokens.ts` is generated from the `.aos-root` block in `styles.css`; never hand-edit it.
- `check:hex` fails on any hex color outside `tokens.ts`.
- The embedded terminal needs `node-pty` installed next to `main.js`; without it the Term tab shows "Terminal unavailable" and everything else works.

## Terminal support (opt-in)

The plugin bundle never includes `node-pty` (native module). Enable the terminal once per install:

This needs the plugin folder that `aos init` / `aos upgrade` writes, which includes `package.json`. If you installed the three release assets by hand (or through BRAT), run `aos upgrade` first: `npm install` in a folder without `package.json` exits successfully having installed nothing, and the button says so instead of pretending it worked.

1. Open the Term tab and click **Install terminal support** — it runs `npm install --omit=dev` in the plugin folder using the same `node` the plugin resolved (Settings → AgenticOS → Node binary) and marks node-pty's prebuilt `spawn-helper` executable. Equivalent by hand: `cd <vault>/.obsidian/plugins/agentic-os && npm install --omit=dev && chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
2. Reload Obsidian.

macOS (arm64 and x64) uses node-pty 1.1.0's shipped N-API prebuilds. Windows is not supported in v1. If the Term tab still reports an ABI error, click **Rebuild for this Electron** — it runs `npx --yes @electron/rebuild -v <process.versions.electron> -m . -w node-pty` in the plugin folder; the version is read at runtime, never pinned.

### Terminal on Linux

node-pty ships no Linux prebuild, so the same `npm install` compiles it: install `python3`, `make` and `g++` (Debian/Ubuntu: `sudo apt install python3 make g++`; Fedora: `sudo dnf install python3 make gcc-c++`) before clicking **Install terminal support**. If the compiled module then fails to load with a NODE_MODULE_VERSION mismatch, use **Rebuild for this Electron**, which needs the same toolchain.
