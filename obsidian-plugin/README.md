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
