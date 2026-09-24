import { Notice, Setting } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { resolveNodeBinary, resetProbeForTests } from "../data/nodeResolver";
import { readAgenticosJson, claudeConfigDir as envClaudeConfigDir } from "../data/aosConfig";
import { setSpawnContext } from "../data/commandRegistry";
import { decideVaultRoot } from "../data/vaultRootField";
import { failureText } from "../data/aosRun";
import { resultSummary, valueArg } from "../data/settingsModel";
import type { SetResult } from "../data/settingsModel";
import * as fs from "fs";

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export interface PluginRowsHandle {
  /** Commits a vault-root edit still in its field: Chromium fires no blur when the container is detached. */
  commit(): Promise<void>;
}

/**
 * The plugin's own settings (data.json), rendered with Obsidian's Setting component into any container. Obsidian's
 * settings pane and the Workbench Settings tab both call this, so the two never drift (spec 2026-09-24-settings-tab
 * D11). `rerender` redraws the caller after a change that alters other rows (the node Probe).
 */
export function renderPluginSettings(containerEl: HTMLElement, plugin: AgenticOSPlugin, rerender: () => void): PluginRowsHandle {
  let commitVaultRoot: (() => Promise<void>) | null = null;

  new Setting(containerEl).setName("General").setHeading();

  new Setting(containerEl)
    .setName("Status bar enabled")
    .setDesc("Show live agent/run telemetry in the Obsidian status bar. Consumed by Plugin.rebuildStatusBar(), which reruns immediately when this changes.")
    .addToggle((t) =>
      t.setValue(plugin.settings.statusBarEnabled).onChange(async (v) => {
        plugin.settings.statusBarEnabled = v;
        await plugin.saveSettings();
        plugin.rebuildStatusBar();
      })
    );

  new Setting(containerEl)
    .setName("Auto-open sidebar on start")
    .setDesc("Open the compact HUD in the right sidebar whenever Obsidian launches. Checked once in Plugin.onload() on workspace layout-ready — takes effect on the next restart, not immediately.")
    .addToggle((t) =>
      t.setValue(plugin.settings.autoOpenSidebarOnStart).onChange(async (v) => {
        plugin.settings.autoOpenSidebarOnStart = v;
        await plugin.saveSettings();
      })
    );

  new Setting(containerEl)
    .setName("Poll interval (ms)")
    .setDesc("How often the local watcher polls brain/_index/agent-runs/ for new run events (ms). Consumed by LiveRunsWatcher, rebuilt immediately via Plugin.rebindLiveSources(); its events feed ChatTab's live tail.")
    .addText((t) =>
      t.setValue(String(plugin.settings.liveTailPollMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 100 && n <= 5000) {
          plugin.settings.liveTailPollMs = n;
          await plugin.saveSettings();
          plugin.rebindLiveSources();
        }
      })
    );

  new Setting(containerEl).setName("Paths").setHeading();

  new Setting(containerEl)
    .setName("Vault root")
    .setDesc("Absolute path used for spawns, the live-runs watcher and orphan sweep, brain/config.json, provider-state.json and persona/IDENTITY.md. Pulse/Runs/Memory/Spaces and the status bar always render this Obsidian vault, regardless of this setting. Leave blank to use this vault. Consumed by Plugin.vaultRoot() on every read/spawn — committed when the field loses focus, and in effect from that moment.")
    .addText((t) => {
      // Plan 4 Ruling F12: no onChange. Obsidian binds onChange to the input event, so saving there
      // committed every keystroke — stacking Notices, saving abandoned typo prefixes, and re-validating
      // an unchanged value. The field commits ONCE, on blur, through the pure decideVaultRoot(). The
      // same commit also runs from the caller's teardown (commit()), because Chromium fires no blur on
      // detachment (Escape closes the modal with the field still focused).
      t.setPlaceholder("(this vault)").setValue(plugin.settings.vaultRoot);
      commitVaultRoot = async () => {
        const adapter = plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
        const d = decideVaultRoot({
          typed: t.getValue(),
          saved: plugin.settings.vaultRoot,
          basePath: adapter.getBasePath ? adapter.getBasePath() : process.cwd(),
          isDirectory,
        });
        if (d.notice) new Notice(d.notice, d.noticeMs);
        t.setValue(d.value);
        if (d.action === "none") return;
        if (d.action === "reject") return;
        plugin.settings.vaultRoot = d.value;
        await plugin.saveSettings();
        // commandRegistry captured the context once in onload(); refresh it or ⌘K and the
        // command deck keep spawning in the old vault until Obsidian is reloaded.
        setSpawnContext({ node: plugin.nodeBin(), vaultRoot: plugin.vaultRoot() });
      };
      t.inputEl.addEventListener("blur", () => { void commitVaultRoot?.(); });
    });

  new Setting(containerEl)
    .setName("Claude config dir")
    .setDesc("Where Claude Code keeps projects/ transcripts and agents/. Leave blank to use agenticos.json, then $CLAUDE_CONFIG_DIR, then ~/.claude. Consumed by Plugin.claudeConfigDir() (Pulse backfill count).")
    .addText((t) =>
      t.setPlaceholder(readAgenticosJson()?.claudeConfigDir ?? envClaudeConfigDir()).setValue(plugin.settings.claudeConfigDir).onChange(async (v) => {
        plugin.settings.claudeConfigDir = v.trim();
        await plugin.saveSettings();
      })
    );

  const nodeSetting = new Setting(containerEl)
    .setName("Node binary")
    .setDesc("Absolute path to node for spawning brain scripts. Leave blank to auto-resolve (agenticos.json, common install locations, then one login-shell probe whose result is saved here). Consumed by Plugin.nodeBin() on every spawn.");
  nodeSetting.addText((t) =>
    t.setPlaceholder("auto").setValue(plugin.settings.nodePath).onChange(async (v) => {
      plugin.settings.nodePath = v.trim();
      await plugin.saveSettings();
      setSpawnContext({ node: plugin.nodeBin(), vaultRoot: plugin.vaultRoot() });
    })
  );
  nodeSetting.addButton((b) =>
    b.setButtonText("Probe").setTooltip("Re-run the resolver now and save what it finds").onClick(async () => {
      resetProbeForTests();
      const before = plugin.settings.nodePath;
      plugin.settings.nodePath = "";
      const found = resolveNodeBinary(plugin.settings);
      if (found === "node") plugin.settings.nodePath = before;
      else plugin.settings.nodePath = found;
      await plugin.saveSettings();
      setSpawnContext({ node: plugin.nodeBin(), vaultRoot: plugin.vaultRoot() });
      new Notice(found === "node" ? "node not found — set the path manually" : `node: ${found}`);
      rerender();
    })
  );

  new Setting(containerEl).setName("Terminal").setHeading();

  new Setting(containerEl)
    .setName("Embedded terminal panel")
    .setDesc("Show the embedded terminal strip on the Pulse tab. Disable to hide; the Term tab still offers a full-pane terminal. Consumed by PulseTab.renderTerminalSlot() on its next render.")
    .addToggle((t) =>
      t.setValue(plugin.settings.terminalEmbedded).onChange(async (v) => {
        plugin.settings.terminalEmbedded = v;
        await plugin.saveSettings();
      })
    );

  new Setting(containerEl)
    .setName("Shell")
    .setDesc("Default shell for new terminal sessions. Leave blank to use $SHELL (zsh on darwin, cmd.exe on win32). Read once by Plugin.onload() to build the shared TerminalPool — changes apply only after an Obsidian restart or plugin reload.")
    .addText((t) =>
      t.setValue(plugin.settings.terminalShell).onChange(async (v) => {
        plugin.settings.terminalShell = v.trim();
        await plugin.saveSettings();
      })
    );

  new Setting(containerEl)
    .setName("Working directory")
    .setDesc("Default working directory for new terminal sessions. Leave blank for vault root. Read once by Plugin.onload() to build the shared TerminalPool — changes apply only after an Obsidian restart or plugin reload.")
    .addText((t) =>
      t.setValue(plugin.settings.terminalCwd).onChange(async (v) => {
        plugin.settings.terminalCwd = v.trim();
        await plugin.saveSettings();
      })
    );

  new Setting(containerEl)
    .setName("Font size")
    .setDesc("xterm.js font size (px) for new terminal sessions. Consumed by TerminalPanel.createBinding() when a session is first opened — already-open sessions keep their current size until reopened.")
    .addText((t) =>
      t.setValue(String(plugin.settings.terminalFontSize)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 8 && n <= 32) {
          plugin.settings.terminalFontSize = n;
          await plugin.saveSettings();
        }
      })
    );

  new Setting(containerEl)
    .setName("Scrollback (lines)")
    .setDesc("xterm.js scrollback buffer (lines) for new terminal sessions. Consumed by TerminalPanel.createBinding() when a session is first opened — already-open sessions are unaffected until reopened.")
    .addText((t) =>
      t.setValue(String(plugin.settings.terminalScrollback)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 100 && n <= 100000) {
          plugin.settings.terminalScrollback = n;
          await plugin.saveSettings();
        }
      })
    );

  return { commit: async () => { await commitVaultRoot?.(); commitVaultRoot = null; } };
}

/**
 * One system setting written through `aos config set <key> <value> --json` (spec 2026-09-24-settings-tab D3), with the
 * outcome as a Notice: the change and its effects, or the CLI's own refusal. Returns the result on success, else null.
 * A telemetry change rebinds the live watcher at once (it decides whether agent-runs/live is created).
 */
export async function setSystemSetting(plugin: AgenticOSPlugin, key: string, value: unknown): Promise<SetResult | null> {
  const r = await plugin.aosJson<SetResult>(["config", "set", key, valueArg(value), "--json"]);
  if (r.code !== 0 || !r.json) {
    new Notice(`${key} not changed: ${r.code === 0 ? "unexpected reply from aos config" : failureText(r)}`, 8000);
    return null;
  }
  new Notice(resultSummary(r.json), 6000);
  if (key === "telemetry.enabled") plugin.rebindLiveSources();
  return r.json;
}
