// agenticos:// links. The app's equivalents of the obsidian:// links the runtime emits today:
//   agenticos://workbench?tab=<rail id>   → the Workbench, on that tab   (obsidian://agenticos?tab=…)
//   agenticos://note?file=<vault path>    → that note                    (obsidian://open?file=…)
//   agenticos://<action>?…                → a handler the HUD registered for <action>

import type { ProtocolRequest } from "../shared/ipc";

export const SCHEME = "agenticos";

export function parseAgenticosUrl(raw: string): ProtocolRequest | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== `${SCHEME}:`) return null;
  // agenticos://workbench?tab=x parses with "workbench" as the host; agenticos:/workbench?… as the path.
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).split("/")[0].toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(action)) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(k) && v.length <= 1024) params[k] = v;
  }
  return { action, params };
}

/** The first agenticos:// URL in a process argv (how a second instance, or a cold start on some platforms, gets it). */
export function urlFromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${SCHEME}://`)) ?? null;
}
