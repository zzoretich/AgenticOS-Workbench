// fs:* — the page's file system (services/fs.ts does the checking; this is the bridge's side of it).

import { shell } from "electron";
import { CH, type Result } from "../../shared/ipc";
import { failure, refused, type FsService } from "../services/fs";
import { AppendArgs, FolderArgs, NoArgs, PathArgs, RangeArgs, TwoPathArgs, WriteArgs } from "./schemas";
import { onInvoke, onSync, type Trust } from "./trust";

export function registerFsIpc(trust: Trust, svc: () => FsService | null): void {
  const noVault: Result<never> = { ok: false, error: "no vault", code: "ENOENT" };
  /** Runs `fn` on the service; a refusal is logged here with what was asked (the page logs it in its guard log). */
  const with_ = <T>(what: string, fn: (s: FsService) => Result<T>): Result<T> => {
    const s = svc();
    const r = s ? fn(s) : noVault;
    if (!r.ok && r.code === "EROFS") console.warn(`[main] refused ${what} (${r.error})`);
    return r;
  };
  onSync(CH.fsExists, trust, PathArgs, ({ p }) => with_(`exists ${p}`, (s) => s.exists(p)));
  onSync(CH.fsStat, trust, PathArgs, ({ p }) => with_(`stat ${p}`, (s) => s.stat(p)));
  onSync(CH.fsReadText, trust, PathArgs, ({ p }) => with_(`read ${p}`, (s) => s.readText(p)));
  onSync(CH.fsReadBytes, trust, RangeArgs, ({ p, position, length }) => with_(`read ${p}`, (s) => s.readBytes(p, position, length)));
  onSync(CH.fsReaddir, trust, PathArgs, ({ p }) => with_(`list ${p}`, (s) => s.readdir(p)));
  onSync(CH.fsWalk, trust, NoArgs, () => with_("walk", (s) => s.walk()));
  onSync(CH.fsWriteText, trust, WriteArgs, ({ p, data, via }) => with_(`write ${p}`, (s) => s.writeText(p, data, via)));
  onSync(CH.fsAppendText, trust, AppendArgs, ({ p, data }) => with_(`append ${p}`, (s) => s.appendText(p, data)));
  onSync(CH.fsMkdir, trust, FolderArgs, ({ p, recursive }) => with_(`mkdir ${p}`, (s) => s.mkdir(p, recursive)));
  onSync(CH.fsRemove, trust, FolderArgs, ({ p, recursive }) => with_(`remove ${p}`, (s) => s.remove(p, recursive)));
  onSync(CH.fsRename, trust, TwoPathArgs, ({ from, to }) => with_(`rename ${from} → ${to}`, (s) => s.rename(from, to)));
  onSync(CH.fsCopy, trust, TwoPathArgs, ({ from, to }) => with_(`copy ${from} → ${to}`, (s) => s.copy(from, to)));
  // The Trash: Files' delete, which the user can undo from Finder.
  onInvoke(CH.fsTrash, trust, PathArgs, async ({ p }) => {
    const s = svc();
    if (!s) return noVault;
    if (!s.canTrash(p)) { console.warn(`[main] refused trash ${p}`); return refused("no write surface allows it"); }
    try { await shell.trashItem(p); return { ok: true, data: null }; } catch (err) { return failure(err); }
  });
}
