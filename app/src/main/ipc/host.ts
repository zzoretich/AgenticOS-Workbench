// host:* and plugin:* — boot, the plugin's commands for the menu, and the plugin's own settings in the app's data.

import { CH, type BootInfo, type ReadyInfo, type Result } from "../../shared/ipc";
import type { FsService } from "../services/fs";
import { NoArgs, PluginLoadArgs, PluginSaveArgs, ReadyInfoSchema } from "./schemas";
import { onSend, onSync, type Trust } from "./trust";

export interface HostIpc {
  boot: () => BootInfo;
  ready: (info: ReadyInfo) => void;
  fs: () => FsService | null;
}

export function registerHostIpc(trust: Trust, h: HostIpc): void {
  const noVault: Result<never> = { ok: false, error: "no vault", code: "ENOENT" };
  onSync(CH.boot, trust, NoArgs, () => ({ ok: true, data: h.boot() }));
  onSend(CH.ready, trust, ReadyInfoSchema, (info) => h.ready(info));
  onSync(CH.pluginLoadData, trust, PluginLoadArgs, ({ id }) => h.fs()?.loadPluginData(id) ?? noVault);
  onSync(CH.pluginSaveData, trust, PluginSaveArgs, ({ id, json }) => h.fs()?.savePluginData(id, json) ?? noVault);
}
