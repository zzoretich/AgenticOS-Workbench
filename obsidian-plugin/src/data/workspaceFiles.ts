import * as path from "path";
import { fs, utf8, utf8Bytes } from "../host";

export const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);

export function isIgnored(name: string): boolean {
  return IGNORED.has(name);
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export const TEXT_EXTS = new Set([
  ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
  ".yml", ".yaml", ".css", ".scss", ".html", ".xml", ".svg", ".sh", ".bash",
  ".zsh", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".toml",
  ".ini", ".cfg", ".conf", ".env", ".log", ".csv", ".sql",
  // dotfile basenames (extname() returns "" for these)
  ".gitignore", ".eslintrc", ".prettierrc", ".editorconfig",
]);

export const MAX_PREVIEW_BYTES = 200 * 1024;
export const MAX_PREVIEW_LINES = 5000;

export function truncate(text: string): { text: string; truncated: boolean } {
  let truncated = false;
  let out = text;
  const bytes = utf8Bytes(out);
  if (bytes.length > MAX_PREVIEW_BYTES) {
    out = utf8(bytes.subarray(0, MAX_PREVIEW_BYTES));
    // a byte cut can land mid-codepoint; toString() leaves a trailing U+FFFD — drop it
    if (out.endsWith("�")) out = out.slice(0, -1);
    truncated = true;
  }
  const lines = out.split("\n");
  if (lines.length > MAX_PREVIEW_LINES) {
    out = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
    truncated = true;
  }
  return { text: out, truncated };
}

export async function listDir(absDir: string): Promise<DirEntry[]> {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (isIgnored(d.name)) continue;
    entries.push({ name: d.name, isDir: d.isDirectory() });
  }
  return sortEntries(entries);
}

const SNIFF_BYTES = 8192;

export type PreviewKind = "text" | "binary" | "empty";

export interface PreviewResult {
  kind: PreviewKind;
  size: number;
  text?: string;
  truncated?: boolean;
}

export async function readPreview(absPath: string): Promise<PreviewResult> {
  const stat = await fs.promises.stat(absPath);
  const size = stat.size;
  if (size === 0) return { kind: "empty", size };

  const sniff = fs.readBytesSync(absPath, 0, Math.min(SNIFF_BYTES, size));
  if (!looksTextual(path.basename(absPath), sniff)) {
    return { kind: "binary", size };
  }
  const readLen = Math.min(size, MAX_PREVIEW_BYTES);
  // small file already fully captured by the sniff read — no second I/O
  const data = readLen <= sniff.length ? sniff.subarray(0, readLen) : fs.readBytesSync(absPath, 0, readLen);
  const { text, truncated } = truncate(utf8(data));
  return { kind: "text", size, text, truncated: truncated || size > MAX_PREVIEW_BYTES };
}

export function looksTextual(name: string, sample: Uint8Array): boolean {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  if (ext && TEXT_EXTS.has(ext)) return true;
  if (lower.startsWith(".") && TEXT_EXTS.has(lower)) return true;
  // No bytes to sniff for an unknown file type → can't confirm text.
  if (sample.length === 0) return false;
  // Fallback heuristic: a NUL byte means binary.
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}
