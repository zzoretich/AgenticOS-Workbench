import { App, normalizePath, TFile, Notice } from "obsidian";

export type MemoryType = "user" | "feedback" | "projects" | "reference";

const TYPE_HEADING: Record<MemoryType, string> = {
  user: "User",
  feedback: "Feedback",
  projects: "Project",
  reference: "Reference",
};

export interface MemoryDraft {
  type: MemoryType;
  slug?: string;
  title?: string;
  description: string;
  body: string;
}

export interface PromoteSource {
  text: string;
  lineNumber: number;
}

export interface WriteResult {
  memoryPath: string;
  indexUpdated: boolean;
  sessionUpdated: boolean;
}

export function slugify(text: string, maxWords = 6): string {
  return text
    .toLowerCase()
    .replace(/[`*_~#>\[\]\(\)]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 80) || "untitled";
}

export function deriveTitle(text: string, maxChars = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

export function deriveDescription(text: string, maxChars = 90): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

export async function writeMemory(
  app: App,
  draft: MemoryDraft,
  promoteSource?: PromoteSource
): Promise<WriteResult> {
  const slug = draft.slug || slugify(draft.title || draft.description || "memory");
  const folder = `brain/memory/${draft.type}`;
  const memoryPath = normalizePath(`${folder}/${slug}.md`);
  await ensureFolder(app, folder);

  if (await app.vault.adapter.exists(memoryPath)) {
    throw new Error(`Memory already exists: ${memoryPath}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const title = draft.title || deriveTitle(draft.description);
  const fm = [
    "---",
    "type: memory",
    `tags: [memory/${draft.type}, status/active]`,
    `created: ${today}`,
    `updated: ${today}`,
    "---",
    "",
    `# ${title}`,
    "",
    draft.body.trim(),
    "",
  ].join("\n");

  await app.vault.create(memoryPath, fm);

  const indexUpdated = await appendToMemoryIndex(app, draft.type, title, memoryPath, draft.description);

  let sessionUpdated = false;
  if (promoteSource) {
    sessionUpdated = await removeSessionLine(app, promoteSource.lineNumber);
  }

  return { memoryPath, indexUpdated, sessionUpdated };
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!(await app.vault.adapter.exists(folder))) {
    await app.vault.createFolder(folder);
  }
}

async function appendToMemoryIndex(
  app: App,
  type: MemoryType,
  title: string,
  memoryPath: string,
  description: string
): Promise<boolean> {
  const indexPath = "MEMORY.md";
  if (!(await app.vault.adapter.exists(indexPath))) {
    console.warn("[agentic-os] MEMORY.md not found — skipping index update");
    return false;
  }
  const raw = await app.vault.adapter.read(indexPath);
  const lines = raw.split("\n");
  const heading = `## ${TYPE_HEADING[type]}`;
  const entry = `- [${title}](${memoryPath}) — ${description}`;

  let inserted = false;
  // Prefix match, case-sensitive, no word-boundary: "## Project" must match a
  // real "## Projects" heading; "## Feedback" must match "## Feedback (how to
  // work)". First matching heading wins. IDENTICAL rule in memory-writer.js —
  // behavioral parity between the two writers is a standing P4 contract.
  let headingIdx = lines.findIndex((l) => l.trim().startsWith(heading));

  if (headingIdx === -1) {
    // append new section at end
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push(heading);
    lines.push(entry);
    inserted = true;
  } else {
    // find end of this section (next ## heading or EOF)
    let insertAt = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { insertAt = i; break; }
    }
    // trim trailing blanks before next section
    while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    lines.splice(insertAt, 0, entry);
    inserted = true;
  }

  await app.vault.adapter.write(indexPath, lines.join("\n"));
  return inserted;
}

async function removeSessionLine(app: App, lineNumber: number): Promise<boolean> {
  const sessionPath = "brain/_index/SESSION.md";
  if (!(await app.vault.adapter.exists(sessionPath))) return false;
  const raw = await app.vault.adapter.read(sessionPath);
  const lines = raw.split("\n");
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return false;
  lines.splice(idx, 1);
  await app.vault.adapter.write(sessionPath, lines.join("\n"));
  return true;
}
