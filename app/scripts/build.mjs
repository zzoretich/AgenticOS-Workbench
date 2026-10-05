// Builds the app: the main process, the preload, and the page bundle that compiles the Workbench HUD source against the
// Obsidian compatibility layer. The page is sandboxed with no Node (phase 4): its bundle has no externals, `path` is the
// POSIX shim, the HUD's Node host (src/nodeHost.ts) is answered by a module that refuses, and any import of a Node
// built-in, electron or node-pty from the page's code is a build error naming the file. The HUD reaches the disk and
// processes through its HudHost, which the page installs over the preload's bridge (src/renderer/bridgeHost.ts).
//
// AOS_APP_TEST_BUILD=1 builds the smoke build (`npm run dist:test`): the one packaged build that accepts the debugging
// switches the release refuses (src/main/policy/debug.ts).

import * as esbuild from "esbuild";
import { builtinModules } from "node:module";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = (...p) => path.join(root, ...p);
const out = r("out");
const hud = r("../obsidian-plugin");
const testBuild = process.env.AOS_APP_TEST_BUILD === "1";

const redirects = {
  obsidian: r("compat/src/index.ts"),
  path: r("src/renderer/shims/path.ts"),
  "node:path": r("src/renderer/shims/path.ts"),
  // The HUD, by name (tsc sees typed stubs for these; see src/types/workbench-hud.d.ts).
  "@workbench/hud": path.join(hud, "main.ts"),
  "@workbench/hud-manifest": path.join(hud, "manifest.json"),
};

const NODE_ONLY = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), "electron", "node-pty"]);
NODE_ONLY.delete("path");

const pageResolve = {
  name: "page-resolve",
  setup(build) {
    build.onResolve({ filter: /^(obsidian|path|node:path|@workbench\/hud|@workbench\/hud-manifest)$/ }, (args) => ({ path: redirects[args.path] }));
    // The HUD's Node host never ships in the page: boot.ts installs the bridge host before the plugin loads.
    build.onResolve({ filter: /^\.\/nodeHost$/ }, (args) =>
      args.importer === path.join(hud, "src", "host.ts") ? { path: r("src/renderer/shims/no-node-host.ts") } : undefined);
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!NODE_ONLY.has(args.path)) return undefined;
      const from = path.relative(path.dirname(root), args.importer);
      return { errors: [{ text: `${from} imports "${args.path}": the page has no Node; go through the HudHost (obsidian-plugin/src/host.ts) or the bridge (window.aos)` }] };
    });
  },
};

// The HUD lives beside the app (../obsidian-plugin), so its imports (xterm and its addons) would resolve from the repo
// root's node_modules, which only a root install has. They resolve from the app's own, as they did when the HUD was
// vendored inside the app.
const nodePaths = [r("node_modules")];

rmSync(out, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [r("src/main/index.ts")],
  outfile: path.join(out, "main/index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // node-pty is native: main loads it at run time from the app's node_modules (unpacked from the archive when packaged).
  external: ["electron", "node-pty"],
  define: { __AOS_TEST_BUILD__: JSON.stringify(testBuild) },
  nodePaths,
  sourcemap: "linked",
  logLevel: "warning",
});

// The preload runs sandboxed: it may load electron and nothing else, so everything it imports is bundled in.
await esbuild.build({
  entryPoints: [r("src/preload/index.ts")],
  outfile: path.join(out, "preload/index.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "chrome130",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning",
});

await esbuild.build({
  entryPoints: [r("src/renderer/boot.ts")],
  outfile: path.join(out, "renderer/hud.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome130",
  plugins: [pageResolve],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  nodePaths,
  sourcemap: "linked",
  logLevel: "warning",
});

// Nothing in the page may still expect Node: a require() esbuild could not resolve would only fail when it ran. (Its own
// CommonJS wrapper is a function named __require; comments are skipped.)
const leftovers = readFileSync(path.join(out, "renderer/hud.js"), "utf8").split("\n")
  .filter((line) => !/^\s*(\/\/|\*)/.test(line) && /(__require|(?<![\w$.])require)\(\s*["'`]/.test(line))
  .map((line) => line.trim().slice(0, 120));
if (leftovers.length) throw new Error(`the page bundle still calls require:\n${leftovers.join("\n")}`);

mkdirSync(path.join(out, "renderer"), { recursive: true });
cpSync(r("src/renderer/index.html"), path.join(out, "renderer/index.html"));
cpSync(r("src/renderer/host.css"), path.join(out, "renderer/host.css"));
cpSync(r("compat/src/base.css"), path.join(out, "renderer/base.css"));
cpSync(path.join(hud, "styles.css"), path.join(out, "renderer/hud.css"));

console.log(`built out/main, out/preload and out/renderer${testBuild ? " (smoke build: debugging allowed)" : ""}`);
