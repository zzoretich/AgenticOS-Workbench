// The app's own pages come from app://hud/, a privileged scheme that main serves from out/renderer, never from
// file://. The packaged app's fuses switch off GrantFileProtocolExtraPrivileges, and with it Electron's file:// handler
// stops reading inside app.asar; Electron's security checklist prefers a custom scheme for local pages anyway. Dev
// runs and tests use the same scheme, so they run the page the way the packaged app does.

import { protocol } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { APP_ORIGIN } from "../shared/ipc";

const SCHEME = new URL(APP_ORIGIN).protocol.slice(0, -1);
const HOST = new URL(APP_ORIGIN).host;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** The file under `root` an app:// URL names, or null for anything else: another host, `..` out of root, a NUL byte. */
export function resolveAppUrl(root: string, raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== `${SCHEME}:` || url.host !== HOST) return null;
  let rel: string;
  try { rel = decodeURIComponent(url.pathname); } catch { return null; }
  if (rel.includes("\0")) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  return file.startsWith(`${base}${path.sep}`) ? file : null;
}

/** Before `ready`: app:// behaves like https (a standard, secure origin), so relative URLs, CSP 'self' and the clipboard work. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

/** After `ready`: serve GETs for files under `root` (read through Electron's fs, which reads inside app.asar). */
export function serveAppScheme(root: string): void {
  protocol.handle(SCHEME, (req) => {
    const file = req.method === "GET" ? resolveAppUrl(root, req.url) : null;
    if (!file) return new Response(null, { status: 404 });
    try {
      return new Response(fs.readFileSync(file), { headers: { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
