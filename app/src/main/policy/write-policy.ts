// The write policy, enforced in the main process (phase 4, docs/superpowers/plans/2026-10-05-sandbox-renderer.md S3).
// The surface table and its matching live in ../../shared/surfaces.ts; this adds what only main may decide: which
// absolute path is which vault path (the vault as configured and as the disk spells it), and which `node <script>` is
// one of this vault's runtime scripts. Every write and spawn the page asks for over the bridge is checked here.
//
// Paths are checked lexically, after resolving `.` and `..`; an existing symlink inside the vault is followed by the
// OS as the user set it up. The bridge never creates links, so the page cannot add one.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES, SurfaceRules, type Surface } from "../../shared/surfaces";

export { BACKGROUND, SURFACES, SURFACE_IDS, argv, globToRegExp, parseSurfaces, type Surface, type SpawnRule } from "../../shared/surfaces";

/** A string, Buffer or file: URL as a path; anything else (a descriptor, a FileHandle) as null. */
export function pathOf(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target instanceof Uint8Array) return Buffer.from(target).toString();
  const url = target as { href?: unknown; protocol?: unknown } | null;
  if (url && typeof url === "object" && typeof url.href === "string" && url.protocol === "file:") {
    try { return fileURLToPath(url.href); } catch { return null; }
  }
  return null;
}

const NODE = /^node(\.exe)?$/;

export class WritePolicy {
  readonly rules: SurfaceRules;
  private readonly roots: string[];

  constructor(vaultRoot: string | null, enabled: readonly string[] = [], table: readonly Surface[] = SURFACES) {
    this.rules = new SurfaceRules(enabled, table);
    // The vault as configured and as the disk spells it (a symlinked home, /tmp → /private/tmp).
    const roots = new Set<string>();
    if (vaultRoot && path.isAbsolute(vaultRoot)) {
      roots.add(path.resolve(vaultRoot));
      try { roots.add(fs.realpathSync(vaultRoot)); } catch { /* not there yet */ }
    }
    this.roots = [...roots];
  }

  /** The enabled surfaces, in table order. */
  get surfaces(): readonly Surface[] { return this.rules.surfaces; }
  get ids(): string[] { return this.rules.ids; }

  /** The path inside the vault, `/`-separated, or null when it is not strictly inside it. */
  vaultPath(target: unknown): string | null {
    const p = pathOf(target);
    if (!p || p.includes("\0") || !path.isAbsolute(p)) return null;
    const abs = path.resolve(p);
    for (const root of this.roots) {
      const rel = path.relative(root, abs);
      if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      return rel.split(path.sep).join("/");
    }
    return null;
  }

  /** Whether an enabled HUD surface may create, change or remove this absolute path. */
  canWrite(target: unknown): boolean {
    const rel = this.vaultPath(target);
    return rel !== null && this.rules.canWrite(rel);
  }

  /** Whether this folder may be created: a HUD surface may write it, or a file it may write could live in it. */
  canMakeFolder(target: unknown): boolean {
    const rel = this.vaultPath(target);
    return rel !== null && this.rules.canMakeFolder(rel);
  }

  /** Whether the app's note editor may save this absolute path (an enabled editor surface, Notes). */
  canSave(target: unknown): boolean {
    const rel = this.vaultPath(target);
    return rel !== null && this.rules.canSave(rel);
  }

  /**
   * Whether `cmd args…`, run without a shell from `cwd`, is a background refresh or a command an enabled surface runs.
   * A relative script path counts only with a cwd to resolve it against, as node would. Which program `cmd` names is
   * policy/programs.ts's question, not this one's.
   */
  canSpawn(cmd: unknown, args: readonly unknown[] = [], cwd?: unknown): boolean {
    if (typeof cmd !== "string" || !cmd) return false;
    const list = args.map(String);
    const name = path.basename(cmd);
    if (NODE.test(name)) {
      const script = this.scriptOf(list[0], cwd);
      return !!script && this.rules.canRunScript(script, list.slice(1));
    }
    return this.rules.canRunProgram(name, list);
  }

  /** A path to one of this vault's runtime scripts → its name relative to brain/scripts. */
  private scriptOf(arg: string | undefined, cwd: unknown): string | null {
    if (!arg || arg.startsWith("-")) return null;
    const abs = path.isAbsolute(arg) ? arg : typeof cwd === "string" && path.isAbsolute(cwd) ? path.resolve(cwd, arg) : null;
    const rel = abs && this.vaultPath(abs);
    return rel && rel.startsWith("brain/scripts/") ? rel.slice("brain/scripts/".length) : null;
  }
}
