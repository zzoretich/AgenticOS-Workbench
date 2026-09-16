// Memory-file lister for brain/memory/<type>/*.md. Pure parsing core;
// only listMemories touches Obsidian, via its param.
import type { App } from "obsidian";

export const MEMORY_ROOT = "brain/memory";
export type MemoryType = "user" | "feedback" | "projects" | "reference";

export interface MemoryMeta {
  path: string;        // vault-relative
  slug: string;        // filename sans .md
  type: MemoryType | string;
  title: string;
  created: string | null;
  updated: string | null;
  reviewed: boolean | null;  // from `reviewed:` frontmatter when present (P4 auto-writes)
}

export function parseMemoryMeta(path: string, raw: string): MemoryMeta {
  const parts = path.split("/");
  const slug = (parts[parts.length - 1] ?? "").replace(/\.md$/, "");
  const type = parts.length >= 3 ? parts[parts.length - 2] : "unknown";
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const grab = (key: string): string | null => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const h1 = raw.match(/^#\s+(.+)$/m);
  const reviewedRaw = grab("reviewed");
  return {
    path, slug, type,
    title: h1 ? h1[1].trim() : slug,
    created: grab("created"),
    updated: grab("updated"),
    reviewed: reviewedRaw === null ? null : reviewedRaw === "true",
  };
}

export function filterMemories(list: MemoryMeta[], query: string, type: string | null): MemoryMeta[] {
  const q = query.trim().toLowerCase();
  return list.filter((m) =>
    (type === null || m.type === type) &&
    (!q || m.title.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q))
  );
}

// ── IO ──
export async function listMemories(app: App): Promise<MemoryMeta[]> {
  const out: MemoryMeta[] = [];
  const adapter = app.vault.adapter;
  let types: string[] = [];
  try { types = (await adapter.list(MEMORY_ROOT)).folders.map((f) => f.split("/").pop()!); } catch { return out; }
  for (const t of types) {
    let files: string[] = [];
    try { files = (await adapter.list(`${MEMORY_ROOT}/${t}`)).files.filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      try { out.push(parseMemoryMeta(f, await adapter.read(f))); } catch { /* unreadable file — skip */ }
    }
  }
  return out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}
