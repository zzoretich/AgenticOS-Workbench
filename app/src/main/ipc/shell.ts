// shell:* — what the page hands to the OS: https links, documents and folders (policy/shell.ts decides which).

import { shell } from "electron";
import { CH } from "../../shared/ipc";
import type { ReadScope } from "../policy/read-scope";
import { externalAllowed, openPathAction } from "../policy/shell";
import { PathArgs, UrlArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

/** Opens a link in the browser when it is https; anything else is refused and logged. Main uses it too. */
export function openExternalSafe(url: string): void {
  if (externalAllowed(url)) void shell.openExternal(url);
  else console.warn(`[main] refused to open ${url.slice(0, 200)}`);
}

export function registerShellIpc(trust: Trust, scope: () => ReadScope | null, vaultRoot: () => string | null): void {
  onSend(CH.shellOpenExternal, trust, UrlArgs, ({ url }) => openExternalSafe(url));
  // Electron's contract: "" when it opened, else why not.
  onInvoke(CH.shellOpenPath, trust, PathArgs, async ({ p }) => {
    const s = scope();
    if (!s) return { ok: true, data: "no vault" };
    const what = openPathAction(p, s, vaultRoot());
    if ("refusal" in what) { console.warn(`[main] refused to open ${p} (${what.refusal})`); return { ok: true, data: what.refusal }; }
    if (what.action === "reveal") { shell.showItemInFolder(p); return { ok: true, data: "" }; }
    return { ok: true, data: await shell.openPath(p) };
  });
  onSend(CH.shellShowItem, trust, PathArgs, ({ p }) => {
    const s = scope();
    if (s?.canRead(p)) shell.showItemInFolder(p);
    else console.warn(`[main] refused to show ${p}`);
  });
}
