// What the page may hand to the OS (phase 4, S6). Links open in the browser over https only. A path opens with its
// default app only when it is a folder or a document the HUD shows (a proposal's page, a skill or agent file, a
// workspace's notes): never a program, a script, a .terminal or .command file, or a macOS bundle (an .app is a folder),
// all of which would run when opened. Those are shown in Finder instead (the Spaces tab opens any previewed file).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadScope } from "./read-scope";

/** The document types `openPath` opens. */
export const OPENABLE = new Set([
  ".md", ".markdown", ".txt", ".html", ".htm", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".log",
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
]);

/** Folder extensions macOS opens as a package (launches, installs or runs) rather than shows. */
const PACKAGES = new Set([
  ".app", ".appex", ".bundle", ".framework", ".plugin", ".prefpane", ".saver", ".qlgenerator", ".mdimporter", ".kext",
  ".xpc", ".workflow", ".action", ".scptd", ".wdgt", ".pkg", ".mpkg",
]);

/** Whether `url` may open in the browser: https only. */
export function externalAllowed(url: unknown): boolean {
  if (typeof url !== "string" || url.length > 8192) return false;
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

/**
 * What to do with `openPath(p)`: open it with its default app, show it in Finder (a file the app does not open, or a
 * package), or refuse it with a reason (outside what the app reads, or not there).
 */
export function openPathAction(p: string, scope: ReadScope): { action: "open" | "reveal" } | { refusal: string } {
  if (!scope.canRead(p)) return { refusal: "outside what the app reads" };
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return { refusal: "not there" }; }
  const ext = path.extname(p).toLowerCase();
  if (st.isDirectory()) {
    return PACKAGES.has(ext) || fs.existsSync(path.join(p, "Contents", "Info.plist")) ? { action: "reveal" } : { action: "open" };
  }
  if (!st.isFile()) return { refusal: "not a file or folder" };
  return OPENABLE.has(ext) ? { action: "open" } : { action: "reveal" };
}
