// Obsidian's Vault and its DataAdapter, backed by the real filesystem under one vault root.
//
// Events: changed paths arrive either from the main process's watcher (the app) or from a recursive fs.watch here
// (tests, or no main watcher), and become create/modify/delete in Obsidian's shape. The runtime writes shared files
// atomically (write a temp file, rename it over the target), which a watcher reports as a rename; the startup index of
// known paths is what lets that surface as `modify`, the event the HUD listens for.

import * as fs from "node:fs";
import * as path from "node:path";
import { Events, type EventRef } from "./events";
import { TAbstractFile, TFile, TFolder, normalizePath, type FileStats } from "./files";
import { canMakeFolder, canWrite, refuse } from "./guard";
import { isIgnored, isIgnoredName } from "./ignore";

export { isIgnored };

/** Delivers batches of changed vault-relative paths; returns an unsubscribe function. */
export type ChangeFeed = (onPaths: (paths: string[]) => void) => () => void;

function toStats(s: fs.Stats): FileStats { return { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; }

export interface ListedFiles { files: string[]; folders: string[] }

export class DataAdapter {
  constructor(private readonly base: string) {}

  getBasePath(): string { return this.base; }
  getName(): string { return path.basename(this.base); }
  getFullPath(p: string): string { return this.abs(p); }

  private abs(p: string): string {
    const n = normalizePath(p);
    return n === "/" ? this.base : path.join(this.base, n);
  }

  /** Throws unless the write policy lets an enabled surface write each of these vault paths. */
  private writable(op: string, ...paths: string[]): void {
    for (const p of paths) if (!canWrite(this.abs(p))) throw refuse("write", `${op} ${normalizePath(p)}`);
  }

  async exists(p: string): Promise<boolean> { return fs.existsSync(this.abs(p)); }

  async stat(p: string): Promise<(FileStats & { type: "file" | "folder" }) | null> {
    try {
      const s = await fs.promises.stat(this.abs(p));
      return { type: s.isDirectory() ? "folder" : "file", ...toStats(s) };
    } catch { return null; }
  }

  async read(p: string): Promise<string> { return fs.promises.readFile(this.abs(p), "utf8"); }
  async readBinary(p: string): Promise<ArrayBuffer> {
    const b = await fs.promises.readFile(this.abs(p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  async list(p: string): Promise<ListedFiles> {
    const n = normalizePath(p);
    const prefix = n === "/" ? "" : `${n}/`;
    const out: ListedFiles = { files: [], folders: [] };
    const entries = await fs.promises.readdir(this.abs(p), { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix + e.name;
      if (e.isDirectory()) out.folders.push(rel);
      else out.files.push(rel);
    }
    return out;
  }

  async write(p: string, data: string): Promise<void> {
    this.writable("write", p);
    await fs.promises.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fs.promises.writeFile(this.abs(p), data, "utf8");
  }
  async append(p: string, data: string): Promise<void> {
    this.writable("append", p);
    await fs.promises.appendFile(this.abs(p), data, "utf8");
  }
  async process(p: string, fn: (data: string) => string): Promise<string> {
    this.writable("process", p);
    const next = fn(await this.read(p));
    await this.write(p, next);
    return next;
  }
  async mkdir(p: string): Promise<void> {
    if (!canMakeFolder(this.abs(p))) throw refuse("write", `mkdir ${normalizePath(p)}`);
    await fs.promises.mkdir(this.abs(p), { recursive: true });
  }
  async remove(p: string): Promise<void> {
    this.writable("remove", p);
    await fs.promises.rm(this.abs(p), { force: true });
  }
  async rmdir(p: string, recursive: boolean): Promise<void> {
    this.writable("rmdir", p);
    await fs.promises.rm(this.abs(p), { recursive, force: true });
  }
  /** Moves a file or folder to the macOS Trash (Obsidian's `trash(file, true)`); the user can put it back from there. */
  async trashSystem(p: string): Promise<void> {
    this.writable("trash", p);
    await (require("electron") as typeof import("electron")).shell.trashItem(this.abs(p));
  }
  async rename(from: string, to: string): Promise<void> {
    this.writable("rename", from, to);
    await fs.promises.rename(this.abs(from), this.abs(to));
  }
  async copy(from: string, to: string): Promise<void> {
    this.writable("copy", to);
    await fs.promises.copyFile(this.abs(from), this.abs(to));
  }
}

export class Vault extends Events {
  readonly adapter: DataAdapter;
  readonly configDir = ".obsidian";
  private known = new Set<string>();
  private indexed = false;
  private watcher: fs.FSWatcher | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(base: string) {
    super();
    this.adapter = new DataAdapter(base);
  }

  getName(): string { return this.adapter.getName(); }
  getRoot(): TFolder { return new TFolder(this, "/"); }

  on(name: "create" | "modify" | "delete" | "rename" | "closed" | string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    return super.on(name, callback, ctx);
  }

  // ── lookup ──────────────────────────────────────────────────────────

  getAbstractFileByPath(p: string): TAbstractFile | null {
    const n = normalizePath(p);
    if (n === "/") return this.getRoot();
    try {
      const s = fs.statSync(this.adapter.getFullPath(n));
      return s.isDirectory() ? new TFolder(this, n) : new TFile(this, n, toStats(s));
    } catch { return null; }
  }
  getFileByPath(p: string): TFile | null {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(p: string): TFolder | null {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFolder ? f : null;
  }

  listChildren(folder: string): TAbstractFile[] {
    const abs = this.adapter.getFullPath(folder);
    const prefix = folder === "/" ? "" : `${folder}/`;
    try {
      return fs.readdirSync(abs).filter((n) => !isIgnored(n)).map((n) => this.getAbstractFileByPath(prefix + n)).filter((f): f is TAbstractFile => !!f);
    } catch { return []; }
  }

  /** Every indexed file (Obsidian's in-memory file list). Built on first use by a walk of the vault. */
  getFiles(): TFile[] {
    this.ensureIndex();
    const out: TFile[] = [];
    for (const rel of this.known) {
      const f = this.getFileByPath(rel);
      if (f) out.push(f);
    }
    return out;
  }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter((f) => f.extension === "md"); }
  getAllLoadedFiles(): TAbstractFile[] { return this.getFiles(); }

  async read(file: TFile): Promise<string> { return this.adapter.read(file.path); }
  async cachedRead(file: TFile): Promise<string> { return this.adapter.read(file.path); }

  // ── writes (each checked by the adapter against the write policy) ───

  async create(p: string, data: string): Promise<TFile> {
    const n = normalizePath(p);
    if (await this.adapter.exists(n)) throw new Error(`File already exists: ${n}`);
    await this.adapter.write(n, data);
    return this.getFileByPath(n)!;
  }
  async createFolder(p: string): Promise<TFolder> {
    await this.adapter.mkdir(p);
    return this.getFolderByPath(p)!;
  }
  async modify(file: TFile, data: string): Promise<void> { await this.adapter.write(file.path, data); }
  async append(file: TFile, data: string): Promise<void> { await this.adapter.append(file.path, data); }
  async process(file: TFile, fn: (data: string) => string): Promise<string> { return this.adapter.process(file.path, fn); }
  async delete(file: TAbstractFile): Promise<void> { await this.adapter.remove(file.path); }
  /** `system` true (what the HUD passes) moves it to the macOS Trash. false deletes it: Obsidian would use the vault's .trash folder, which the app does not keep. */
  async trash(file: TAbstractFile, system = true): Promise<void> {
    if (system) await this.adapter.trashSystem(file.path);
    else await this.adapter.remove(file.path);
  }
  async rename(file: TAbstractFile, to: string): Promise<void> { await this.adapter.rename(file.path, to); }

  // ── index and watcher ───────────────────────────────────────────────

  private ensureIndex(): void {
    if (this.indexed) return;
    this.indexed = true;
    const base = this.adapter.getBasePath();
    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (isIgnoredName(e.name)) continue;
        const rel = prefix + e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
        else if (e.isFile()) this.known.add(rel);
      }
    };
    walk(base, "");
  }

  /**
   * Starts emitting vault events; the host calls this once the layout is ready. With a feed (the main process's
   * watcher) events come from there; without one, a recursive fs.watch runs here.
   */
  startWatching(feed?: ChangeFeed): void {
    if (this.watcher || this.unsubscribe) return;
    this.ensureIndex();
    if (feed) {
      this.unsubscribe = feed((paths) => {
        for (const p of paths) {
          const rel = normalizePath(p);
          if (!isIgnored(rel)) this.emitFor(rel);
        }
      });
      return;
    }
    const base = this.adapter.getBasePath();
    this.watcher = fs.watch(base, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = normalizePath(filename.toString());
      if (isIgnored(rel)) return;
      // Coalesce the burst an atomic write produces into one event per path.
      const t = this.pending.get(rel);
      if (t) clearTimeout(t);
      this.pending.set(rel, setTimeout(() => { this.pending.delete(rel); this.emitFor(rel); }, 40));
    });
    this.watcher.on("error", (err) => console.error("[compat] vault watcher error", err));
  }

  stopWatching(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private emitFor(rel: string): void {
    let s: fs.Stats | null = null;
    try { s = fs.statSync(this.adapter.getFullPath(rel)); } catch { s = null; }
    if (s?.isDirectory()) {
      this.trigger("create", new TFolder(this, rel));
      return;
    }
    if (s) {
      const file = new TFile(this, rel, toStats(s));
      const existed = this.known.has(rel);
      this.known.add(rel);
      this.trigger(existed ? "modify" : "create", file);
      return;
    }
    if (this.known.delete(rel)) this.trigger("delete", new TFile(this, rel, { ctime: 0, mtime: 0, size: 0 }));
  }
}
