// The page's file system, in main (phase 4, S2 and S3). Every read is checked against the read scope and every write
// against the write policy before it reaches the disk; what is refused comes back as EROFS, and nothing is thrown at
// the bridge. No Electron here, so the unit tests drive it directly (tests/unit/fs-service.test.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { isIgnoredName } from "../../../compat/src/ignore";
import type { DirEntryInfo, Result, StatInfo, WalkEntry, WriteVia } from "../../shared/ipc";
import type { ReadScope } from "../policy/read-scope";
import type { WritePolicy } from "../policy/write-policy";

/** The largest file the page may read whole, or write in one call. */
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** The most bytes one ranged read returns. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024;
/** The most files a vault walk lists. */
export const MAX_WALK = 200_000;

export const refused = (why: string): Result<never> => ({ ok: false, error: why, code: "EROFS" });

/** A Node error as a Result: its code, and no path (the page knows which path it asked for). */
export function failure(err: unknown): Result<never> {
  const code = (err as NodeJS.ErrnoException)?.code;
  return { ok: false, error: typeof code === "string" ? code : "failed", code: typeof code === "string" ? code : "EIO" };
}

const ok = <T>(data: T): Result<T> => ({ ok: true, data });

function stats(s: fs.Stats, link = false): StatInfo {
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, file: s.isFile(), dir: s.isDirectory(), link };
}

export interface FsServiceOptions {
  vaultRoot: string | null;
  userData: string;
  scope: () => ReadScope;
  policy: () => WritePolicy;
}

export class FsService {
  constructor(private readonly o: FsServiceOptions) {}

  exists(p: string): Result<boolean> {
    if (!this.o.scope().canProbe(p)) return refused("outside what the app reads");
    return ok(fs.existsSync(p));
  }

  stat(p: string): Result<StatInfo> {
    if (!this.o.scope().canProbe(p)) return refused("outside what the app reads");
    try { return ok(stats(fs.statSync(p))); } catch (err) { return failure(err); }
  }

  readText(p: string): Result<string> {
    if (!this.o.scope().canRead(p)) return refused("outside what the app reads");
    try {
      if (fs.statSync(p).size > MAX_TEXT_BYTES) return { ok: false, error: "too large", code: "EFBIG" };
      return ok(fs.readFileSync(p, "utf8"));
    } catch (err) { return failure(err); }
  }

  readBytes(p: string, position: number, length: number): Result<Uint8Array> {
    if (!this.o.scope().canRead(p)) return refused("outside what the app reads");
    const want = Math.min(Math.max(0, length), MAX_RANGE_BYTES);
    let fd: number | null = null;
    try {
      fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, position);
      return ok(new Uint8Array(buf.buffer, buf.byteOffset, n).slice());
    } catch (err) { return failure(err); } finally { if (fd !== null) fs.closeSync(fd); }
  }

  readdir(p: string): Result<DirEntryInfo[]> {
    if (!this.o.scope().canList(p)) return refused("outside what the app reads");
    try {
      return ok(fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, file: d.isFile(), dir: d.isDirectory(), link: d.isSymbolicLink() })));
    } catch (err) { return failure(err); }
  }

  /** Every file under the vault with its stats, skipping what the vault index skips (dot-paths, node_modules, worktrees). */
  walk(): Result<WalkEntry[]> {
    const root = this.o.vaultRoot;
    if (!root) return refused("no vault");
    const out: WalkEntry[] = [];
    const visit = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= MAX_WALK) return;
        if (isIgnoredName(e.name)) continue;
        const rel = prefix + e.name;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) visit(abs, `${rel}/`);
        else if (e.isFile()) {
          try { const s = fs.statSync(abs); out.push({ rel, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }); } catch { /* gone */ }
        }
      }
    };
    visit(root, "");
    return ok(out);
  }

  /** Creates the missing folders above `p`, each one only where the policy lets a folder be made. */
  private makeParents(p: string): Result<null> | null {
    const missing: string[] = [];
    for (let dir = path.dirname(p); !fs.existsSync(dir); dir = path.dirname(dir)) {
      if (dir === path.dirname(dir)) break;
      missing.unshift(dir);
    }
    for (const dir of missing) {
      if (!this.o.policy().canMakeFolder(dir)) return refused("a folder no write surface creates");
      try { fs.mkdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") return failure(err); }
    }
    return null;
  }

  writeText(p: string, data: string, via: WriteVia): Result<null> {
    const policy = this.o.policy();
    if (!(via === "editor" ? policy.canSave(p) : policy.canWrite(p))) return refused("no write surface allows it");
    if (Buffer.byteLength(data) > MAX_TEXT_BYTES) return { ok: false, error: "too large", code: "EFBIG" };
    const parents = this.makeParents(p);
    if (parents) return parents;
    try { fs.writeFileSync(p, data, "utf8"); return ok(null); } catch (err) { return failure(err); }
  }

  appendText(p: string, data: string): Result<null> {
    if (!this.o.policy().canWrite(p)) return refused("no write surface allows it");
    if (Buffer.byteLength(data) > MAX_TEXT_BYTES) return { ok: false, error: "too large", code: "EFBIG" };
    try { fs.appendFileSync(p, data, "utf8"); return ok(null); } catch (err) { return failure(err); }
  }

  /** A folder: nothing to do when it exists; otherwise the policy decides, for it and (recursive) each missing parent. */
  mkdir(p: string, recursive: boolean): Result<null> {
    if (fs.existsSync(p)) return recursive || fs.statSync(p).isDirectory() ? ok(null) : { ok: false, error: "EEXIST", code: "EEXIST" };
    if (!this.o.policy().canMakeFolder(p)) return refused("a folder no write surface creates");
    if (recursive) {
      const parents = this.makeParents(p);
      if (parents) return parents;
    }
    try { fs.mkdirSync(p); return ok(null); } catch (err) { return failure(err); }
  }

  remove(p: string, recursive: boolean): Result<null> {
    if (!this.o.policy().canWrite(p)) return refused("no write surface allows it");
    try { fs.rmSync(p, { recursive, force: true }); return ok(null); } catch (err) { return failure(err); }
  }

  rename(from: string, to: string): Result<null> {
    const policy = this.o.policy();
    if (!policy.canWrite(from) || !policy.canWrite(to)) return refused("no write surface allows both ends");
    try { fs.renameSync(from, to); return ok(null); } catch (err) { return failure(err); }
  }

  copy(from: string, to: string): Result<null> {
    if (!this.o.scope().canRead(from)) return refused("outside what the app reads");
    if (!this.o.policy().canWrite(to)) return refused("no write surface allows it");
    try { fs.copyFileSync(from, to); return ok(null); } catch (err) { return failure(err); }
  }

  /** Whether `p` may go to the Trash (the IPC layer hands it to Electron's shell.trashItem). */
  canTrash(p: string): boolean { return this.o.policy().canWrite(p); }

  /** A plugin's settings: the app's own copy, else what Obsidian kept in the vault (read, never written). */
  loadPluginData(id: string): Result<unknown> {
    const files = [path.join(this.o.userData, "plugins", `${id}.json`)];
    if (this.o.vaultRoot) files.push(path.join(this.o.vaultRoot, ".obsidian", "plugins", id, "data.json"));
    for (const f of files) {
      try { return ok(JSON.parse(fs.readFileSync(f, "utf8")) as unknown); } catch { /* the next one */ }
    }
    return ok(null);
  }

  savePluginData(id: string, json: string): Result<null> {
    try { JSON.parse(json); } catch { return { ok: false, error: "not JSON", code: "EINVAL" }; }
    const dir = path.join(this.o.userData, "plugins");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), json, "utf8");
      return ok(null);
    } catch (err) { return failure(err); }
  }
}
