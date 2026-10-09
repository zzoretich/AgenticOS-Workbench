// Names, icons and constants the Pulse cockpit and its popup share (spec 2026-10-08-pulse-cockpit-design).
import { clip } from "../../data/briefingBand";
import type { Area, NeedItem } from "../../data/pulseFacts";

export const AREA_LABEL: Record<Area, string> = {
  needs: "Needs you", health: "System health", agents: "Agents", workspaces: "Workspaces", todo: "To-Do",
  proposals: "Decisions", notifications: "Notifications", routines: "Routines", spend: "Spend", memory: "Memory",
};
export const AREA_ICON: Record<Area, string> = {
  needs: "inbox", health: "shield", agents: "bot", workspaces: "folder", todo: "square-check",
  proposals: "gavel", notifications: "bell", routines: "repeat", spend: "dollar-sign", memory: "brain",
};
/** The tab each area's "Open the … tab" button opens (Health opens the System drawer instead). */
export const AREA_TAB: Partial<Record<Area, string>> = {
  agents: "agents", workspaces: "spaces", todo: "todo", proposals: "proposals", notifications: "notifications",
  routines: "routines", spend: "runs", memory: "memory",
};

const BAND_WORDS: Record<string, string> = {
  error: "See the error →", proposal: "Review the proposal →", flag: "Review the flag →", gate: "Open the gate →",
  drafts: "Review the drafts →", overdue: "Open the to-dos →", today: "Open the to-dos →", review: "Review the memories",
};

/** The band's buttons for its top items: what each does to its item, "→" when it jumps; `label` is the action's own, for
 *  a kind with no words here. Two that would read alike ("Review the proposal →" twice) name their items instead. */
export function bandLabels(top: Array<{ n: Pick<NeedItem, "kind" | "title" | "ref">; label: string; jump: boolean }>): string[] {
  const labels = top.map(({ n, label, jump }) =>
    n.kind === "pipeline" || n.kind === "routine" ? (jump ? `See ${n.ref} →` : `Run ${n.ref}`) : BAND_WORDS[n.kind] ?? label);
  if (labels.length !== 2 || labels[0] !== labels[1]) return labels;
  return top.map(({ n, jump }, i) => `${labels[i].split(" ")[0]} “${clip(n.title, 24)}”${jump ? " →" : ""}`);
}

// The vault paths whose changes redraw Pulse: its facts, its caches and the briefing.
const WATCH = [/^brain\/_index\/(snapshot|pipelines|routines|briefing|promote-log|provider-spend)\./, /^persona\/(proposals\/|STATE\.md|teams\/)/,
  /^brain\/notifications\//, /^brain\/memory\//, /^TODO\.md$/, /^brain\/routines\//];
export function touchesPulse(p: string): boolean { return WATCH.some((re) => re.test(p)); }

/** The briefing routine as the vault template seeds it: vault-template/brain/routines/briefing.md, pinned by a test. */
export const BRIEFING_ROUTINE = `---
schema: 1
name: Briefing
kind: command
schedule: "*/30 7-22 * * *"
enabled: true
guarded: false
argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/persona/briefing.js"]
timeoutSec: 90
tags: [persona]
---
The Chief of Staff's paragraph at the top of the Workbench's Pulse tab (\`brain/scripts/persona/briefing.js\`). Every 30 minutes from 7:00 to 22:00 it reads the facts Pulse shows (what needs you, health, decisions, to-dos, notifications, routines, spend) and makes one model call only when they changed since the last paragraph, as a \`duty:briefing\` call against the daily duty cap (\`persona.perDayUsd\`). It writes \`brain/_index/briefing.json\`; Pulse composes the paragraph from the same facts whenever there is none or it is out of date. Nothing runs while the persona is off; \`persona.briefing.enabled: false\` turns this one off. Disable it with \`aos routines disable briefing\`.
`;
