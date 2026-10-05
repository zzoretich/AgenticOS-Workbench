// What the sandboxed page may read through the bridge (phase 4, S3). The HUD reads the vault, the hosts' own folders
// (sessions, skills, agents, plugins), the macOS LaunchAgents its schedules live in, /etc/shells for the terminal picker,
// and the app's own data. Each folder comes from main's own environment and agenticos.json, whose paths only
// `aos init` and `aos upgrade` write (`aos config set` lists them read-only), never from the page.
//
// Two narrower allowances: whether a program exists, by its well-known name anywhere (the node, claude and shell
// pickers probe candidates such as /opt/homebrew/bin/node), and the names in nvm's version folder. Credential files
// are never read, even inside a root: a page that went wrong could otherwise hand a token to a link it opens.

import * as fs from "node:fs";
import * as path from "node:path";

export interface AgenticosPaths {
  claudeConfigDir?: string;
  hosts?: { claude?: { configDir?: string }; codex?: { home?: string } };
}

export interface ScopeOptions {
  vaultRoot: string | null;
  home: string;
  userData: string;
  /** Main's own environment. */
  env: Record<string, string | undefined>;
  /** agenticos.json as `aos init` wrote it, or null. */
  agenticos: AgenticosPaths | null;
}

/** Program names whose existence may be probed anywhere (nodeResolver, claudeAsk, the shell picker). */
export const PROGRAM_NAMES = new Set(["node", "npm", "npx", "claude", "codex", "zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh"]);

/** Basenames never read: the hosts' credential stores, and the usual secret files. */
const CREDENTIALS = /^(\.credentials\.json|auth\.json|\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i;

const abs = (p: string | undefined | null): string | null => (p && path.isAbsolute(p) ? path.resolve(p) : null);

function spellings(p: string): string[] {
  const out = new Set([path.resolve(p)]);
  try { out.add(fs.realpathSync(p)); } catch { /* not there (yet) */ }
  return [...out];
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** The Claude Code config folders main trusts: $CLAUDE_CONFIG_DIR, ~/.claude, and the ones agenticos.json records. */
export function claudeDirs(o: Pick<ScopeOptions, "home" | "env" | "agenticos">): string[] {
  return [...new Set([abs(o.env.CLAUDE_CONFIG_DIR), path.join(o.home, ".claude"), abs(o.agenticos?.claudeConfigDir), abs(o.agenticos?.hosts?.claude?.configDir)]
    .filter((p): p is string => !!p))];
}

/** The Codex homes main trusts: $CODEX_HOME, ~/.codex, and the one agenticos.json records. */
export function codexHomes(o: Pick<ScopeOptions, "home" | "env" | "agenticos">): string[] {
  return [...new Set([abs(o.env.CODEX_HOME), path.join(o.home, ".codex"), abs(o.agenticos?.hosts?.codex?.home)].filter((p): p is string => !!p))];
}

/** The agenticos.json files main trusts: $AOS_CONFIG, and agenticos.json in each trusted Claude folder. */
export function agenticosFiles(o: Pick<ScopeOptions, "home" | "env" | "agenticos">): string[] {
  return [...new Set([abs(o.env.AOS_CONFIG), ...claudeDirs(o).map((d) => path.join(d, "agenticos.json"))].filter((p): p is string => !!p))];
}

export class ReadScope {
  private readonly roots: string[];
  private readonly files: Set<string>;
  private readonly listOnly: string[];

  constructor(o: ScopeOptions) {
    const roots = [
      ...(o.vaultRoot ? [o.vaultRoot] : []),
      ...claudeDirs(o),
      ...codexHomes(o),
      path.join(o.home, ".agents"),
      path.join(o.home, "Library", "LaunchAgents"),
      o.userData,
    ];
    this.roots = [...new Set(roots.flatMap(spellings))];
    this.files = new Set(["/etc/shells", ...agenticosFiles(o)].flatMap(spellings));
    this.listOnly = spellings(path.join(o.home, ".nvm", "versions", "node"));
  }

  private static clean(p: unknown): string | null {
    if (typeof p !== "string" || !p || p.includes("\0") || !path.isAbsolute(p)) return null;
    return path.resolve(p);
  }

  /** Whether the page may read this file, list this folder, or stat it. */
  canRead(target: unknown): boolean {
    const p = ReadScope.clean(target);
    if (!p || CREDENTIALS.test(path.basename(p))) return false;
    return this.files.has(p) || this.roots.some((r) => inside(r, p));
  }

  /** Whether the page may list this folder's names (canRead, or nvm's version folder). */
  canList(target: unknown): boolean {
    const p = ReadScope.clean(target);
    return !!p && (this.canRead(p) || this.listOnly.includes(p));
  }

  /** Whether the page may ask if this path exists, or stat it (canRead, or a program by its well-known name). */
  canProbe(target: unknown): boolean {
    const p = ReadScope.clean(target);
    return !!p && (this.canRead(p) || this.canList(p) || PROGRAM_NAMES.has(path.basename(p)));
  }
}
