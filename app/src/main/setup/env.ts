// The PATH a terminal would have (phase 5, I3). An app started from Finder gets launchd's PATH (/usr/bin:/bin:/usr/sbin:
// /sbin), which finds none of what the wizard checks for: Homebrew, the user's node, claude, codex, ollama, uv. Main asks
// the user's login shell for its PATH once per preflight (the HUD's nodeResolver asks it the same way, for node), then
// adds the folders the installers it offers write to, so a tool installed by a fix-it is found without a new shell.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Printed before the PATH so the shell's own greeting (an interactive rc file may print one) cannot be mistaken for it. */
export const PATH_MARKER = "__AOS_PATH__=";

/** Where the installers the wizard offers put their programs: Homebrew (Apple silicon, Intel), uv and claude's own, cargo. */
export function installDirs(home: string): string[] {
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
}

const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The PATH in a login shell's output, after the marker; null when it is not there. */
export function parseLoginPath(out: string): string | null {
  const line = out.split("\n").reverse().find((l) => l.startsWith(PATH_MARKER));
  const value = line?.slice(PATH_MARKER.length).trim();
  return value ? value : null;
}

/** PATH lists joined in order, each folder once, relative entries dropped. */
export function mergePath(...lists: Array<string | string[] | null | undefined>): string {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dir of (Array.isArray(list) ? list : (list ?? "").split(":"))) if (dir && path.isAbsolute(dir)) seen.add(dir);
  }
  return [...seen].join(":");
}

export interface LoginPathDeps {
  shell: string | undefined;
  home: string;
  exec: (file: string, args: string[], opts: { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv }) => string;
  env: NodeJS.ProcessEnv;
}

/**
 * The PATH the wizard runs with. $AOS_SETUP_PATH replaces the whole lookup (the e2e suite's stand-in tools); otherwise
 * the login shell's PATH, then the installers' folders, then the system's. A shell that fails or hangs costs its 8 s
 * timeout and falls back to main's own PATH.
 */
export function loginPath(d: LoginPathDeps): string {
  if (d.env.AOS_SETUP_PATH !== undefined) return mergePath(d.env.AOS_SETUP_PATH);
  let fromShell: string | null = null;
  const shell = d.shell && path.isAbsolute(d.shell) ? d.shell : "/bin/zsh";
  try {
    fromShell = parseLoginPath(d.exec(shell, ["-lic", `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`], { encoding: "utf8", timeout: 8000, env: d.env }));
  } catch { /* no login shell: main's own PATH */ }
  return mergePath(fromShell ?? d.env.PATH, installDirs(d.home), SYSTEM);
}

export const defaultLoginPathDeps = (env: NodeJS.ProcessEnv, home: string): LoginPathDeps => ({
  shell: env.SHELL, home, env,
  exec: (file, args, opts) => childProcess.execFileSync(file, args, { ...opts, stdio: ["ignore", "pipe", "ignore"] }),
});

/** An executable file named `name` in one of PATH's folders, else null. */
export function findOnPath(name: string, PATH: string, isExec: (p: string) => boolean = isExecutable): string | null {
  for (const dir of PATH.split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    if (isExec(p)) return p;
  }
  return null;
}

export function isExecutable(p: string): boolean {
  try { return fs.statSync(p).isFile() && (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; }
}
