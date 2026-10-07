// theme:* — light and dark (../theme.ts). The page reads the state at boot and on every change, and sets the choice
// from the App settings tab, the ribbon's toggle or the palette; the menu's View ▸ Appearance sets it in main directly.

import { CH, type ThemeSource, type ThemeState } from "../../shared/ipc";
import { NoArgs, ThemeSetArgs } from "./schemas";
import { onSync, type Trust } from "./trust";

export interface ThemeIpc {
  state: () => ThemeState;
  /** Applies and saves the choice; answers what it resolves to. */
  set: (source: ThemeSource) => ThemeState;
}

export function registerThemeIpc(trust: Trust, t: ThemeIpc): void {
  onSync(CH.themeState, trust, NoArgs, () => ({ ok: true, data: t.state() }));
  onSync(CH.themeSet, trust, ThemeSetArgs, ({ source }) => ({ ok: true, data: t.set(source) }));
}
