// nodeHost.ts — the HudHost over Node (host.ts): what the HUD has in Obsidian, whose renderer has Node, and under
// node:test. The only HUD file that imports Node's I/O modules, node-pty or electron. The AgenticOS Workbench app never
// loads it: its build answers this module with one that refuses, and installs its own host first.
import * as childProcess from "child_process";
import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import type { HostChild, HostFs, HostPty, HostPtyProcess, HostSpawnOptions, HudHost } from "./host";

function readBytesSync(p: string, position: number, length: number): Uint8Array {
  const buf = Buffer.alloc(Math.max(0, length));
  const fd = nodeFs.openSync(p, "r");
  try {
    const n = nodeFs.readSync(fd, buf, 0, buf.length, position);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  } finally {
    nodeFs.closeSync(fd);
  }
}

const hostFs: HostFs = {
  existsSync: (p) => nodeFs.existsSync(p),
  statSync: (p) => nodeFs.statSync(p),
  readFileSync: (p, encoding) => nodeFs.readFileSync(p, encoding),
  readdirSync: ((p: string, opts?: { withFileTypes: true }) =>
    (opts ? nodeFs.readdirSync(p, opts) : nodeFs.readdirSync(p))) as HostFs["readdirSync"],
  readBytesSync,
  writeFileSync: (p, data) => nodeFs.writeFileSync(p, data),
  appendFileSync: (p, data) => nodeFs.appendFileSync(p, data),
  mkdirSync: (p, opts) => { nodeFs.mkdirSync(p, opts); },
  chmodSync: (p, mode) => nodeFs.chmodSync(p, mode),
  watch: (p, listener) => {
    const w = nodeFs.watch(p, { persistent: false }, () => listener());
    w.on("error", () => { /* the file went; the caller re-reads on its next event */ });
    return w;
  },
  promises: {
    readFile: (p, encoding) => nodeFs.promises.readFile(p, encoding),
    readdir: (p, opts) => nodeFs.promises.readdir(p, opts),
    stat: (p) => nodeFs.promises.stat(p),
    access: (p) => nodeFs.promises.access(p),
  },
};

/** The host's environment with `set` on top and `unset` removed. */
function childEnv(set: Record<string, string> = {}, unset: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, ...set };
  for (const k of unset) delete out[k];
  return out;
}

function spawn(command: string, args: string[], opts: HostSpawnOptions = {}): HostChild {
  const child = childProcess.spawn(command, args, {
    cwd: opts.cwd,
    env: childEnv(opts.env, opts.unsetEnv),
    // stdin is never written: /dev/null, so a CLI that reads it sees its end at once.
    stdio: opts.stdio === "ignore" ? "ignore" : ["ignore", "pipe", "pipe"],
    detached: opts.detached,
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return child as unknown as HostChild;
}

// ── node-pty, loaded on first use ───────────────────────────────────

type PtyLib = { spawn: (file: string, args: string[], options: Record<string, unknown>) => HostPtyProcess };

let ptyLib: PtyLib | null = null;
let ptyLoadError: string | null = null;
// Obsidian's renderer require() cannot resolve "node-pty" by bare name and __dirname is not reliable there: main.ts
// names the plugin folder, where "Install terminal support" puts it.
let pluginDir: string | null = null;

function loadPty(): PtyLib {
  if (ptyLib) return ptyLib;
  if (ptyLoadError) throw new Error(`node-pty failed to load: ${ptyLoadError}`);
  const candidates: string[] = [];
  if (pluginDir) {
    candidates.push(path.join(pluginDir, "node_modules", "node-pty"));
    candidates.push(path.join(pluginDir, "node_modules", "node-pty", "lib", "index.js"));
  }
  // last-ditch: bare name in case Electron's resolver finds it
  candidates.push("node-pty");
  const attempts: Array<{ where: string; err: string }> = [];
  for (const c of candidates) {
    try {
      ptyLib = require(c) as PtyLib;
      return ptyLib;
    } catch (e) {
      attempts.push({ where: c, err: e instanceof Error ? e.message : String(e) });
    }
  }
  ptyLoadError = `tried ${attempts.length} paths:\n${attempts.map((a) => `  • ${a.where} → ${a.err.split("\n")[0]}`).join("\n")}`;
  throw new Error(`node-pty failed to load: ${ptyLoadError}`);
}

const pty: HostPty = {
  spawn: (file, args, opts) => loadPty().spawn(file, args, { ...opts, env: childEnv(opts.env) }),
  loadError: () => { try { loadPty(); return null; } catch { return ptyLoadError; } },
  setPluginDir: (dir) => { pluginDir = dir; },
};

// ── the OS shell: Electron's, where there is one ────────────────────

function electronShell(): { openPath(p: string): Promise<string>; openExternal(u: string): Promise<void>; showItemInFolder(p: string): void } | null {
  try {
    const mod = require("electron") as { shell?: { openPath?: unknown } };
    return typeof mod?.shell?.openPath === "function" ? mod.shell as never : null;
  } catch { return null; }
}

export function createNodeHost(): HudHost {
  return {
    fs: hostFs,
    spawn,
    execFileSync: (file, args, opts) => childProcess.execFileSync(file, args, opts),
    pty,
    shell: {
      openPath: async (p) => electronShell()?.openPath(p) ?? "no OS shell outside Electron",
      openExternal: async (url) => { await electronShell()?.openExternal(url); },
      showItemInFolder: (p) => { electronShell()?.showItemInFolder(p); },
    },
    env: {
      get: (name) => process.env[name],
      homedir: () => os.homedir(),
      platform: () => process.platform,
      cwd: () => process.cwd(),
      electron: () => (process.versions as Record<string, string | undefined>).electron ?? null,
    },
  };
}
