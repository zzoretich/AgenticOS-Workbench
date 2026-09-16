import { App } from "obsidian";

export const SESSION_PATH = "brain/_index/SESSION.md";

export interface PromoteItem {
  text: string;
  line: number;
  source: "tag" | "section";
}

export interface SessionState {
  raw: string;
  promoteItems: PromoteItem[];
  thingsToRemember: string[];
  activeTask: string | null;
  decisions: string[];
}

export async function loadSession(app: App): Promise<SessionState | null> {
  try {
    const raw = await app.vault.adapter.read(SESSION_PATH);
    return parseSession(raw);
  } catch (err) {
    console.error("[agentic-os] failed to load SESSION.md:", err);
    return null;
  }
}

function parseSession(raw: string): SessionState {
  const lines = raw.split("\n");

  const promoteItems: PromoteItem[] = [];
  const thingsToRemember: string[] = [];
  const decisions: string[] = [];
  let activeTask: string | null = null;

  let currentSection: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      currentSection = heading[1].toLowerCase();
      continue;
    }

    if (!trimmed) continue;
    if (trimmed.startsWith("#") && !trimmed.startsWith("- ")) continue;

    // collect by section
    if (currentSection === "active task" && !activeTask) {
      activeTask = trimmed.replace(/^[-*]\s*/, "");
    } else if (currentSection === "things to remember") {
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        thingsToRemember.push(trimmed.replace(/^[-*]\s*/, ""));
      }
    } else if (currentSection === "decisions made") {
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        decisions.push(trimmed.replace(/^[-*]\s*/, ""));
      }
    } else if (currentSection === "promote to memory on close") {
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        promoteItems.push({
          text: trimmed.replace(/^[-*]\s*/, ""),
          line: i + 1,
          source: "section",
        });
      }
    }

    // collect by #promote tag anywhere
    if (/#promote\b/.test(trimmed)) {
      promoteItems.push({
        text: trimmed.replace(/^[-*]\s*/, "").replace(/#promote\b/, "").trim(),
        line: i + 1,
        source: "tag",
      });
    }
  }

  // dedupe by text
  const seen = new Set<string>();
  const dedupedPromote = promoteItems.filter((p) => {
    if (seen.has(p.text)) return false;
    seen.add(p.text);
    return true;
  });

  return { raw, promoteItems: dedupedPromote, thingsToRemember, decisions, activeTask };
}
