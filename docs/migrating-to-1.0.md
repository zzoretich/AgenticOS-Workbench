# Migrating to 1.0

AgenticOS 1.0 stops using Obsidian. The Workbench, the dashboard that ran as an Obsidian plugin, is now a macOS app of
its own, **AgenticOS Workbench**. Your vault, memories, notes, persona, routines and the Claude Code and Codex plugins
carry over unchanged, and the vault is still plain Markdown.

This page is for an install from before 1.0 (0.21.0 or earlier) that used the Workbench in Obsidian. A new install
needs none of it: download the app and follow its setup wizard ([docs/install.md](install.md)).

## What changes

| Before 1.0 | From 1.0 |
|---|---|
| The Workbench is an Obsidian plugin in `<vault>/.obsidian/plugins/agentic-os/` | The **AgenticOS Workbench** app in Applications (macOS, Apple silicon). It finds your vault through `agenticos.json`, as the runtime does |
| Notes are browsed, searched and edited in Obsidian | The app's **Files** tab: the vault as a tree, **Open file…** (⌘O), **Search vault…** (⌘⇧F), new note, rename, move and delete to the Trash, and its own note editor. Renaming a note does not rewrite the links to it |
| Links from the status line and proposal pages open Obsidian (`obsidian://…`) | They are `agenticos://workbench?tab=<tab>` and `agenticos://note?file=<path>` links, which the app registers. The Workbench still accepts the old `obsidian://agenticos?tab=<tab>` form |
| `aos upgrade` replaced the plugin in the vault | The app updates itself from GitHub Releases, then offers to update the runtime in your vault. `aos upgrade` still updates the runtime and both plugins from a terminal |
| The Term tab needed **Install terminal support** | The terminal works as soon as the app opens |
| `aos init` needed Obsidian, installed the plugin and seeded `.obsidian/` | No Obsidian anywhere. New vaults are plain folders; your existing `.obsidian/` is left alone |
| Releases attached `main.js`, `manifest.json` and `styles.css` | Releases attach the app: `AgenticOS-Workbench-<version>-arm64.dmg`, plus the zip and `latest-mac.yml` its updates use |

Your Workbench settings (the sidebar, the status bar, paths, terminal height, …) carry over: the first time the app
opens your vault, it copies them from the old plugin folder into its own data
(`~/Library/Application Support/AgenticOS Workbench/plugins/agentic-os.json`). It never writes the old folder.

## Upgrade, step by step

1. **Install the app.** Download `AgenticOS-Workbench-<version>-arm64.dmg` from the
   [latest release](https://github.com/zzoretich/UniDeX-Agent-Harness/releases/latest), open it, and drag **AgenticOS
   Workbench** to Applications. It is signed and notarized, so macOS asks only once whether to open an app downloaded
   from the internet. It needs a Mac with Apple silicon.
2. **Open it.** It finds your install and opens the Workbench, with no setup wizard, and says once what changed. Your
   vault's runtime is older than the one the app carries, so it then offers **Update the runtime in your vault**
   (later, the status bar's `⬆ Runtime 0.21.0 → 1.0.0` opens the same dialog). **Update now** runs `aos upgrade` from
   the runtime inside the app, with its output shown: it re-vendors `brain/scripts`, refreshes the Claude Code and
   Codex plugins and re-renders your routine schedules. Notes, memory and persona are not touched. From a terminal,
   `aos upgrade` does the same.
3. **Re-render the schedules with Homebrew's stable Node.** In a terminal, run `aos routines sync` once. The upgrade
   records Homebrew's stable `opt/` link to Node (it survives `brew upgrade`, the versioned `Cellar/` path does not),
   and the sync puts it into your routine schedules.
4. **Check.** `aos doctor` exits 0, and its `workbench app` row names `AgenticOS Workbench` and its version (the app
   records itself in `brain/_index/hud-host.json` each time it starts). Under Codex, if its `codex hooks trusted` row
   counts fewer than all, open `codex`, run `/hooks` and trust the agenticos entries once.
5. **Remove the old plugin.** Quit Obsidian, then remove `.obsidian/plugins/agentic-os/` from your vault: in Finder
   (⇧⌘. shows hidden folders), or `rm -r ~/AgenticOS/.obsidian/plugins/agentic-os` for the default vault. `aos upgrade`
   mentions the folder while it is there and never deletes it. Do this after step 2, so the app has copied your
   settings.

## Obsidian itself

Nothing in AgenticOS needs Obsidian any more, and nothing is installed into it. You may still open the vault in
Obsidian, or any other Markdown editor, but that is unsupported: there is no Workbench inside it, and AgenticOS no
longer writes Obsidian's settings (`aos config set dailyNote.layout` no longer rewrites Obsidian's Daily Notes
setting). If you use Obsidian for nothing else, you can delete Obsidian.app and the vault's `.obsidian/` folder once
the app has opened your vault.

Other Obsidian plugins keep working in Obsidian, and AgenticOS depends on none of them. One that ran on a timer while
Obsidian was open, such as a git backup, stops when Obsidian is closed. A routine runs a command on a schedule without
it: a `brain/routines/<slug>.md` file of kind `command`, which you can create in the Workbench's Routines tab.

## Flags that went away

`aos init --no-obsidian`, `aos init --terminal` and `aos terminal install` are still accepted, so older scripts keep
working, and do nothing.

## Troubleshooting

- **The app opens its setup wizard instead of your Workbench.** It found no install: no `agenticos.json` in
  `~/.claude`, or the vault it names is gone. If you moved the vault, pick its new folder in the wizard: `aos init`
  keeps every file in an existing vault and records where it is now.
- **AgenticOS Workbench ▸ Check for Updates… is greyed out.** Updates are off: `updates.check` is `false` in your
  config (⚙ Settings → Updates), which also stops the runtime's update check. Its tooltip says why.
- **macOS says the app is not supported on this Mac.** The app is built for Apple silicon only. On an Intel Mac the
  runtime and both plugins still install and run from a terminal ([docs/install.md](install.md)), without the
  Workbench.
