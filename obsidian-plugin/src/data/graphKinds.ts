// graphKinds.ts — pure path → node-kind rule for the Memory graph, split out of graph.ts
// (which needs obsidian's TFile at runtime) so node:test can cover the layout-aware case.
// The layout is <vault>/brain/config.json dailyNote.layout (aosConfig.dailyNoteLayout);
// the caller passes it so this module stays free of fs and Obsidian.
import { DEFAULT_LAYOUT, isDailyNotePath } from "./dailyNote";

export type NodeKind = "memory" | "pattern" | "session" | "agent";

export function classifyPath(p: string, layout: string = DEFAULT_LAYOUT): NodeKind | null {
  if (p.startsWith("brain/memory/")) return "memory";
  if (p.startsWith("brain/patterns/")) return "pattern";
  if (isDailyNotePath(p, layout)) return "session";
  if (p.startsWith("agents/")) return "agent";
  return null;
}
