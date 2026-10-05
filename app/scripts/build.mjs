// Builds the app: the main process, and the renderer bundle that compiles the Workbench HUD source against the
// Obsidian compatibility layer. The HUD source is not modified; its `obsidian`, `fs` and `child_process` imports are
// answered by the app instead (the last two by the write guards, under every name Node accepts for them).

import * as esbuild from "esbuild";
import { builtinModules } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = (...p) => path.join(root, ...p);
const out = r("out");
const hud = r("../obsidian-plugin");

const redirects = {
  obsidian: r("compat/src/index.ts"),
  fs: r("src/renderer/guard/fs.cjs"),
  child_process: r("src/renderer/guard/child_process.cjs"),
  // The HUD, by name (tsc sees typed stubs for these; see src/types/workbench-hud.d.ts).
  "@workbench/hud": path.join(hud, "main.ts"),
  "@workbench/hud-manifest": path.join(hud, "manifest.json"),
};

// The same guards under the other names Node answers to. Only for the HUD's own imports: the compat layer and the guards
// themselves reach the real modules through `node:fs` and `node:child_process`.
const hudOnlyRedirects = {
  "node:fs": redirects.fs,
  "fs/promises": r("src/renderer/guard/fs-promises.cjs"),
  "node:fs/promises": r("src/renderer/guard/fs-promises.cjs"),
  "node:child_process": redirects.child_process,
};

const hostRedirects = {
  name: "host-redirects",
  setup(build) {
    build.onResolve({ filter: /^(obsidian|fs|child_process|@workbench\/hud|@workbench\/hud-manifest)$/ }, (args) => ({ path: redirects[args.path] }));
    build.onResolve({ filter: /^(node:fs|fs\/promises|node:fs\/promises|node:child_process)$/ }, (args) =>
      args.importer.startsWith(`${hud}${path.sep}`) ? { path: hudOnlyRedirects[args.path] } : undefined);
  },
};

// Everything else from Node stays a runtime require(), which the renderer provides in stage 1.
const nodeExternals = [...builtinModules.filter((m) => !(m in redirects)), ...builtinModules.map((m) => `node:${m}`)];

rmSync(out, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [r("src/main/index.ts")],
  outfile: path.join(out, "main/index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
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
  external: ["electron", "node-pty", ...nodeExternals],
  plugins: [hostRedirects],
  sourcemap: "linked",
  logLevel: "warning",
  // terminalSession.ts loads node-pty with require(<computed path>); that is intended and stays a runtime require.
  logOverride: { "unsupported-require-call": "silent" },
});

mkdirSync(path.join(out, "renderer"), { recursive: true });
cpSync(r("src/renderer/index.html"), path.join(out, "renderer/index.html"));
cpSync(r("src/renderer/host.css"), path.join(out, "renderer/host.css"));
cpSync(r("compat/src/base.css"), path.join(out, "renderer/base.css"));
cpSync(path.join(hud, "styles.css"), path.join(out, "renderer/hud.css"));

console.log("built out/main and out/renderer");
