import { App, Notice, TFile } from "obsidian";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { CaptureModal } from "../ui/CaptureModal";
import { MemoryType } from "./memoryWriter";

// Obsidian's spawn'd subprocesses don't inherit the user's shell PATH, so bare
// "node" fails ENOENT. Search common install locations.
export function resolveExe(name: string): string {
  if (name.startsWith("/")) return name;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      `/opt/homebrew/bin/${name}`,   // Apple Silicon Homebrew
      `/usr/local/bin/${name}`,       // Intel Homebrew / Node installer
      `/usr/bin/${name}`,
    );
  } else if (process.platform === "linux") {
    candidates.push(
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
      `/snap/bin/${name}`,
    );
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return name; // last resort — let spawn try the system PATH
}

// Spawn context set by main.ts at load (resolved node binary + vault root). executeCommand
// keeps its (app, cmd) signature because ⌘K and the command deck call it without plugin access.
let spawnCtx: { node: string; vaultRoot: string } | null = null;
export function setSpawnContext(ctx: { node: string; vaultRoot: string }): void { spawnCtx = ctx; }

export type CommandKind = "clipboard" | "openFile" | "exec" | "capture" | "openView";

export interface SlashCommand {
  name: string;
  kind: CommandKind;
  desc: string;
  // openFile
  path?: string;
  // exec
  cmd?: string;
  args?: string[];
  background?: boolean;
  // capture
  captureType?: MemoryType;
  // openView
  viewType?: string;
}

export const COMMAND_REGISTRY: SlashCommand[] = [
  { name: "/scan",           kind: "exec",      desc: "Refresh vault snapshot.json", cmd: "node", args: ["brain/scripts/scan-vault.js"] },
  { name: "/reflect",        kind: "exec",      desc: "Run weekly reflection", cmd: "node", args: ["brain/scripts/sdk/reflect-week.js"] },
  { name: "/brain",          kind: "openFile",  desc: "Open BRAIN.md", path: "brain/_index/BRAIN.md" },
  { name: "/remember",       kind: "capture",   desc: "Quick capture as feedback", captureType: "feedback" },
  { name: "/feedback",       kind: "capture",   desc: "New feedback memory", captureType: "feedback" },
  { name: "/project",        kind: "capture",   desc: "New project memory", captureType: "projects" },
  { name: "/pattern",        kind: "capture",   desc: "New pattern (stored as feedback)", captureType: "feedback" },
  { name: "/wrap",           kind: "clipboard", desc: "Run session-end protocol — copies" },
  { name: "/ask-brain",      kind: "clipboard", desc: "Ask the vault — copies" },
];

export async function executeCommand(app: App, cmd: SlashCommand): Promise<void> {
  switch (cmd.kind) {
    case "clipboard":
      await navigator.clipboard.writeText(cmd.name);
      new Notice(`Copied: ${cmd.name}`);
      return;

    case "openFile": {
      if (!cmd.path) return;
      const file = app.vault.getAbstractFileByPath(cmd.path);
      if (file instanceof TFile) {
        await app.workspace.getLeaf("tab").openFile(file);
      } else {
        new Notice(`Not found: ${cmd.path}`);
      }
      return;
    }

    case "capture": {
      new CaptureModal(app, { prefillType: cmd.captureType || "feedback" }).open();
      return;
    }

    case "exec": {
      if (!cmd.cmd) {
        new Notice(`✗ ${cmd.name}: no shell command configured`);
        return;
      }
      try {
        const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
        const base = adapter.getBasePath ? adapter.getBasePath() : process.cwd();
        const root = spawnCtx?.vaultRoot ?? base;
        const args = (cmd.args || []).map((a) =>
          a.startsWith("/") || a.startsWith("-") || a.startsWith("--") ? a : path.join(root, a)
        );
        const exe = cmd.cmd === "node" && spawnCtx ? spawnCtx.node : resolveExe(cmd.cmd);
        new Notice(`▶ ${cmd.name}`);
        const child = spawn(exe, args, {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          detached: !!cmd.background,
        });
        let out = "", err = "";
        child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
        child.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
        if (cmd.background) {
          child.unref();
          setTimeout(() => new Notice(`${cmd.name} running in background`), 200);
        } else {
          child.on("close", (code) => {
            if (code === 0) {
              const tail = out.trim().split("\n").pop() || "ok";
              new Notice(`✓ ${cmd.name}: ${tail.slice(0, 120)}`);
            } else {
              const tail = (err || out).trim().split("\n").pop() || `exit ${code}`;
              new Notice(`✗ ${cmd.name}: ${tail.slice(0, 120)}`);
            }
          });
          child.on("error", (e) => { new Notice(`✗ ${cmd.name}: ${e.message}`); });
        }
      } catch (e) {
        new Notice(`✗ ${cmd.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    case "openView": {
      if (!cmd.viewType) return;
      const { workspace } = app;
      const existing = workspace.getLeavesOfType(cmd.viewType);
      if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: cmd.viewType, active: true });
      workspace.revealLeaf(leaf);
      return;
    }
  }
}
