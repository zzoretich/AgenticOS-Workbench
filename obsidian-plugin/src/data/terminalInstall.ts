// terminalInstall.ts — opt-in terminal support. BRAT and the community store deliver only
// main.js/manifest.json/styles.css, so node-pty (an esbuild external) never arrives with
// the plugin. "Install terminal support" runs `npm install --omit=dev` in the plugin
// folder: node-pty 1.1.0 is N-API and ships prebuilds for darwin-arm64/x64 and win32;
// the prebuilt spawn-helper is mode 644 in the tarball and must be chmod +x'd or every
// spawn fails EACCES. Linux has no prebuild: the same install compiles from source when
// python3 + make + a C++ toolchain are present (README "Terminal on Linux").
// Two preconditions, both learned from cli/aos.js (Ruling A13):
//   · `npm install` in a folder with no package.json exits 0 and installs NOTHING, so the
//     install refuses up front unless <pluginDir>/package.json exists (aos init / aos upgrade
//     write it; a release-asset or BRAT install has only the three bundle files) — cli/aos.js:550.
//   · "Rebuild for this Electron" cannot go through `npm run rebuild-pty`: scripts/ is not in
//     cli/aos.js:329 BUNDLE_FILES and release.yml attaches only main.js/manifest.json/styles.css,
//     so the script never reaches the folder where it would run. rebuildPty() calls
//     @electron/rebuild through npx with process.versions.electron — never a pinned version.
// Windows is not supported in v1 (cli/aos.js:548 refuses it): the PATH join below is ':'-only
// and the npm/npx siblings have no .cmd fallback.
import { spawn as nodeSpawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { npmSiblingOf } from "./nodeResolver";

export interface InstallDeps {
  spawn: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean }) => ChildProcess;
  readdirSync: (p: string) => string[];
  existsSync: (p: string) => boolean;
  chmodSync: (p: string, mode: number) => void;
}

const DEFAULT_DEPS: InstallDeps = {
  spawn: (file, args, opts) => nodeSpawn(file, args, opts),
  readdirSync: (p) => fs.readdirSync(p),
  existsSync: (p) => fs.existsSync(p),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
};

export interface InstallResult { ok: boolean; code: number | null; output: string; chmodded: string[] }

export function electronVersion(): string | null {
  return (process.versions as Record<string, string | undefined>).electron ?? null;
}

export function chmodSpawnHelpers(pluginDir: string, d: Pick<InstallDeps, "readdirSync" | "existsSync" | "chmodSync"> = DEFAULT_DEPS): string[] {
  const prebuilds = path.join(pluginDir, "node_modules", "node-pty", "prebuilds");
  const out: string[] = [];
  let dirs: string[] = [];
  try { dirs = d.readdirSync(prebuilds); } catch { return out; }
  for (const dir of dirs) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (!d.existsSync(helper)) continue;
    // On failure (e.g. a read-only checkout) the helper is skipped — absent from the
    // returned list — and a warning is logged; nothing else surfaces the reason.
    try { d.chmodSync(helper, 0o755); out.push(helper); }
    catch (e) { console.warn("[agentic-os] chmod failed:", helper, e instanceof Error ? e.message : String(e)); }
  }
  return out;
}

/** npx lives next to node, like npm; the bare name when node is not an absolute path. */
export function npxSiblingOf(nodeBin: string): string {
  if (!path.isAbsolute(nodeBin)) return "npx";
  return path.join(path.dirname(nodeBin), "npx");
}

function runTool(o: { exe: string; pluginDir: string; nodeBin: string; args: string[]; timeoutMs: number }, d: InstallDeps): Promise<{ code: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (path.isAbsolute(o.nodeBin)) env.PATH = `${path.dirname(o.nodeBin)}:${process.env.PATH ?? ""}`;
  return new Promise((resolve) => {
    let output = "";
    let child: ChildProcess;
    try { child = d.spawn(o.exe, o.args, { cwd: o.pluginDir, env, windowsHide: true }); }
    catch (e) { resolve({ code: null, output: e instanceof Error ? e.message : String(e) }); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, o.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { output += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { output += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, output: `${output}${e.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** The message shown (as a Notice, and logged) when the plugin folder is not an `aos` bundle. */
export const NO_PACKAGE_JSON = "no package.json here — install the bundle with `aos upgrade` first";

/** An `aos init` / `aos upgrade` bundle carries package.json; a release-asset or BRAT install does not. */
export function hasBundle(pluginDir: string, existsSync: (p: string) => boolean = fs.existsSync): boolean {
  return existsSync(path.join(pluginDir, "package.json"));
}

export async function installTerminalSupport(
  o: { pluginDir: string; nodeBin: string; timeoutMs?: number },
  d: InstallDeps = DEFAULT_DEPS,
): Promise<InstallResult> {
  // Without package.json, `npm install` exits 0 having installed nothing and the caller would
  // report success on an unchanged folder (cli/aos.js:550 refuses the same way).
  if (!hasBundle(o.pluginDir, d.existsSync)) {
    return { ok: false, code: null, output: NO_PACKAGE_JSON, chmodded: [] };
  }
  const r = await runTool({ exe: npmSiblingOf(o.nodeBin), pluginDir: o.pluginDir, nodeBin: o.nodeBin, args: ["install", "--omit=dev", "--no-audit", "--no-fund"], timeoutMs: o.timeoutMs ?? 10 * 60_000 }, d);
  const ok = r.code === 0;
  return { ok, code: r.code, output: r.output, chmodded: ok ? chmodSpawnHelpers(o.pluginDir, d) : [] };
}

export async function rebuildPty(
  o: { pluginDir: string; nodeBin: string; electron: string; timeoutMs?: number },
  d: InstallDeps = DEFAULT_DEPS,
): Promise<InstallResult> {
  // Same precondition as installTerminalSupport(): a release-asset / BRAT install has only
  // the three bundle files, so there is no node-pty to rebuild.
  if (!hasBundle(o.pluginDir, d.existsSync)) {
    return { ok: false, code: null, output: NO_PACKAGE_JSON, chmodded: [] };
  }
  // @electron/rebuild through npx, not `npm run rebuild-pty`: scripts/rebuild-pty.mjs is not
  // part of the installed bundle (cli/aos.js:329 BUNDLE_FILES, release.yml assets).
  const r = await runTool({ exe: npxSiblingOf(o.nodeBin), pluginDir: o.pluginDir, nodeBin: o.nodeBin, args: ["--yes", "@electron/rebuild", "-v", o.electron, "-m", o.pluginDir, "-w", "node-pty"], timeoutMs: o.timeoutMs ?? 15 * 60_000 }, d);
  const ok = r.code === 0;
  return { ok, code: r.code, output: r.output, chmodded: ok ? chmodSpawnHelpers(o.pluginDir, d) : [] };
}
