// The preload: the page's only way into main (phase 4, S9). It runs sandboxed, with context isolation, and exposes
// window.aos: named functions over the channels of ../shared/ipc.ts, never ipcRenderer itself, a generic invoke, or
// an event object. Main checks every call's sender and arguments; this file only carries them.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH, type AosBridge, type BootInfo, type ProcEvent, type ProtocolRequest, type PtyEvent, type Result } from "../shared/ipc";

const sync = <T>(channel: string, args: unknown): Result<T> => ipcRenderer.sendSync(channel, args) as Result<T>;
const invoke = <T>(channel: string, args: unknown): Promise<Result<T>> => ipcRenderer.invoke(channel, args) as Promise<Result<T>>;

/** Subscribes `cb` to a main → page event; returns the unsubscribe function. The event object stays here. */
function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const api: AosBridge = {
  boot: () => { const r = sync<BootInfo>(CH.boot, {}); return r.ok ? r.data : null; },
  ready: (info) => ipcRenderer.send(CH.ready, info),
  onCommand: (cb) => listen<unknown>(CH.command, (id) => { if (typeof id === "string") cb(id); }),
  onProtocol: (cb) => listen<ProtocolRequest | null>(CH.protocol, (req) => { if (req && typeof req.action === "string") cb(req); }),
  onVaultChanges: (cb) => listen<{ paths?: unknown } | null>(CH.vaultChanges, (c) => { if (Array.isArray(c?.paths)) cb(c.paths.map(String)); }),
  fs: {
    exists: (p) => sync(CH.fsExists, { p }),
    stat: (p) => sync(CH.fsStat, { p }),
    readText: (p) => sync(CH.fsReadText, { p }),
    readBytes: (p, position, length) => sync(CH.fsReadBytes, { p, position, length }),
    readdir: (p) => sync(CH.fsReaddir, { p }),
    walk: () => sync(CH.fsWalk, {}),
    writeText: (p, data, via) => sync(CH.fsWriteText, { p, data, via }),
    appendText: (p, data) => sync(CH.fsAppendText, { p, data }),
    mkdir: (p, recursive) => sync(CH.fsMkdir, { p, recursive }),
    remove: (p, recursive) => sync(CH.fsRemove, { p, recursive }),
    rename: (from, to) => sync(CH.fsRename, { from, to }),
    copy: (from, to) => sync(CH.fsCopy, { from, to }),
    trash: (p) => invoke(CH.fsTrash, { p }),
  },
  proc: {
    spawn: (req) => sync(CH.procSpawn, req),
    kill: (id, signal) => ipcRenderer.send(CH.procKill, { id, signal }),
    execSync: (req) => sync(CH.procExecSync, req),
    onEvent: (cb) => listen<ProcEvent>(CH.procEvent, cb),
  },
  pty: {
    available: () => sync(CH.ptyAvailable, {}),
    spawn: (req) => sync(CH.ptySpawn, req),
    write: (id, data) => ipcRenderer.send(CH.ptyWrite, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(CH.ptyResize, { id, cols, rows }),
    kill: (id, signal) => ipcRenderer.send(CH.ptyKill, { id, signal }),
    onEvent: (cb) => listen<PtyEvent>(CH.ptyEvent, cb),
  },
  shell: {
    openExternal: (url) => ipcRenderer.send(CH.shellOpenExternal, { url }),
    openPath: async (p) => { const r = await invoke<string>(CH.shellOpenPath, { p }); return r.ok ? r.data : r.error; },
    showItemInFolder: (p) => ipcRenderer.send(CH.shellShowItem, { p }),
  },
  plugin: {
    loadData: (id) => sync(CH.pluginLoadData, { id }),
    saveData: (id, json) => sync(CH.pluginSaveData, { id, json }),
  },
};

contextBridge.exposeInMainWorld("aos", api);
