#!/usr/bin/env node
// Rebuild node-pty against a specific Electron ABI, FROM A REPO CHECKOUT:
//   npm run rebuild-pty -- <electron-version>   (or ELECTRON_VERSION=…)
// This file is deliberately not part of the installed bundle (cli/aos.js:329 BUNDLE_FILES is
// main.js/manifest.json/styles.css/package.json; release.yml attaches the first three), so the
// plugin's own "Rebuild for this Electron" button does NOT run it — terminalInstall.rebuildPty()
// invokes the same npx command directly with process.versions.electron (Ruling A13).
// The version is NEVER pinned here either.
// Find the version in Obsidian: Ctrl/Cmd-Shift-I → console → process.versions.electron
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] || process.env.ELECTRON_VERSION;
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("usage: npm run rebuild-pty -- <electron-version>   e.g. 43.1.1 (process.versions.electron in Obsidian's dev console)");
  process.exit(2);
}
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("npx", ["--yes", "@electron/rebuild", "-v", version, "-m", pluginDir, "-w", "node-pty"], { stdio: "inherit", cwd: pluginDir });
console.log(`rebuild-pty: node-pty rebuilt for Electron ${version}`);
