import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AgenticOSPlugin from "../main";
import { DEFAULT_SETTINGS } from "./settingsDefaults";
import type { AgenticOSSettings } from "./settingsDefaults";
import { resolveNodeBinary, resetProbeForTests } from "./data/nodeResolver";
import { readProviderState, readAgenticosJson } from "./data/aosConfig";
import { setSpawnContext } from "./data/commandRegistry";

export { DEFAULT_SETTINGS };
export type { AgenticOSSettings };

export class AgenticOSSettingTab extends PluginSettingTab {
  plugin: AgenticOSPlugin;

  constructor(app: App, plugin: AgenticOSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Agentic OS" });

    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Status bar enabled")
      .setDesc("Show live agent/run telemetry in the Obsidian status bar. Consumed by Plugin.rebuildStatusBar(), which reruns immediately when this changes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.statusBarEnabled).onChange(async (v) => {
          this.plugin.settings.statusBarEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.rebuildStatusBar();
        })
      );

    new Setting(containerEl)
      .setName("Auto-open sidebar on start")
      .setDesc("Open the compact HUD in the right sidebar whenever Obsidian launches. Checked once in Plugin.onload() on workspace layout-ready — takes effect on the next restart, not immediately.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoOpenSidebarOnStart).onChange(async (v) => {
          this.plugin.settings.autoOpenSidebarOnStart = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Poll interval (ms)")
      .setDesc("How often the local watcher polls brain/_index/agent-runs/ for new run events (ms). Consumed by LiveRunsWatcher, rebuilt immediately via Plugin.rebindLiveSources(); its events feed ChatTab's live tail.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.liveTailPollMs)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 100 && n <= 5000) {
            this.plugin.settings.liveTailPollMs = n;
            await this.plugin.saveSettings();
            this.plugin.rebindLiveSources();
          }
        })
      );

    new Setting(containerEl).setName("AgenticOS").setHeading();

    new Setting(containerEl)
      .setName("Vault root")
      .setDesc("Absolute path of the AgenticOS vault the plugin reads (brain/_index, brain/config.json) and spawns scripts in. Leave blank to use this Obsidian vault. Consumed by Plugin.vaultRoot() on every read/spawn — takes effect immediately.")
      .addText((t) =>
        t.setPlaceholder("(this vault)").setValue(this.plugin.settings.vaultRoot).onChange(async (v) => {
          this.plugin.settings.vaultRoot = v.trim();
          await this.plugin.saveSettings();
          // commandRegistry captured the context once in onload(); refresh it or ⌘K and the
          // command deck keep spawning in the old vault until Obsidian is reloaded.
          setSpawnContext({ node: this.plugin.nodeBin(), vaultRoot: this.plugin.vaultRoot() });
        })
      );

    new Setting(containerEl)
      .setName("Claude config dir")
      .setDesc("Where Claude Code keeps projects/ transcripts and agents/. Leave blank to use agenticos.json, then $CLAUDE_CONFIG_DIR, then ~/.claude. Consumed by Plugin.claudeConfigDir() (Pulse backfill count).")
      .addText((t) =>
        t.setPlaceholder(readAgenticosJson()?.claudeConfigDir ?? "~/.claude").setValue(this.plugin.settings.claudeConfigDir).onChange(async (v) => {
          this.plugin.settings.claudeConfigDir = v.trim();
          await this.plugin.saveSettings();
        })
      );

    const nodeSetting = new Setting(containerEl)
      .setName("Node binary")
      .setDesc("Absolute path to node for spawning brain scripts. Leave blank to auto-resolve (agenticos.json, common install locations, then one login-shell probe whose result is saved here). Consumed by Plugin.nodeBin() on every spawn.");
    nodeSetting.addText((t) =>
      t.setPlaceholder("auto").setValue(this.plugin.settings.nodePath).onChange(async (v) => {
        this.plugin.settings.nodePath = v.trim();
        await this.plugin.saveSettings();
        setSpawnContext({ node: this.plugin.nodeBin(), vaultRoot: this.plugin.vaultRoot() });
      })
    );
    nodeSetting.addButton((b) =>
      b.setButtonText("Probe").setTooltip("Re-run the resolver now and save what it finds").onClick(async () => {
        resetProbeForTests();
        const before = this.plugin.settings.nodePath;
        this.plugin.settings.nodePath = "";
        const found = resolveNodeBinary(this.plugin.settings);
        if (found === "node") this.plugin.settings.nodePath = before;
        else this.plugin.settings.nodePath = found;
        await this.plugin.saveSettings();
        setSpawnContext({ node: this.plugin.nodeBin(), vaultRoot: this.plugin.vaultRoot() });
        new Notice(found === "node" ? "node not found — set the path manually" : `node: ${found}`);
        this.display();
      })
    );

    const state = readProviderState(this.plugin.vaultRoot());
    new Setting(containerEl)
      .setName("Provider")
      .setDesc(state
        ? `${state.name} (${state.reason}) — checked ${state.checkedAt}. Change it with \`aos provider <auto|ollama|claude|none>\`; the scripts write brain/_index/provider-state.json.`
        : "No provider state yet — run any Claude Code session (hooks write brain/_index/provider-state.json) or `aos provider`.")
      .addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Re-read provider state").onClick(() => this.display()));

    new Setting(containerEl)
      .setName("Cost module enabled")
      .setDesc("Show the COST row, cost Fix Queue cards, the re-anchor modal and the COST DETAIL drawer section. Also needs cost.monthlyBudget in brain/config.json (set by `aos cost enable`). Until you change it here it follows cost.enabled from agenticos.json (`aos cost enable` / `aos cost disable`); once saved, this toggle wins. Consumed by PulseTab/SystemDrawer on their next render.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.costEnabled).onChange(async (v) => {
          this.plugin.settings.costEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Telemetry enabled")
      .setDesc("When off, the plugin neither sweeps crashed runs on load nor creates brain/_index/agent-runs/live/. Until you change it here it follows telemetry.enabled from agenticos.json / brain/config.json (the same key telemetry-hook.js honors); once saved, this toggle wins. Consumed by Plugin.onload() (orphan sweep) and Plugin.rebindLiveSources() (rebuilt immediately).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.telemetryEnabled).onChange(async (v) => {
          this.plugin.settings.telemetryEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.rebindLiveSources();
        })
      );

    new Setting(containerEl).setName("Terminal").setHeading();

    new Setting(containerEl)
      .setName("Embedded terminal panel")
      .setDesc("Show the embedded terminal strip on the Pulse tab. Disable to hide; the Term tab still offers a full-pane terminal. Consumed by PulseTab.renderTerminalSlot() on its next render.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.terminalEmbedded).onChange(async (v) => {
          this.plugin.settings.terminalEmbedded = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Shell")
      .setDesc("Default shell for new terminal sessions. Leave blank to use $SHELL (zsh on darwin, cmd.exe on win32). Read once by Plugin.onload() to build the shared TerminalPool — changes apply only after an Obsidian restart or plugin reload.")
      .addText((t) =>
        t.setValue(this.plugin.settings.terminalShell).onChange(async (v) => {
          this.plugin.settings.terminalShell = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Default working directory for new terminal sessions. Leave blank for vault root. Read once by Plugin.onload() to build the shared TerminalPool — changes apply only after an Obsidian restart or plugin reload.")
      .addText((t) =>
        t.setValue(this.plugin.settings.terminalCwd).onChange(async (v) => {
          this.plugin.settings.terminalCwd = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("xterm.js font size (px) for new terminal sessions. Consumed by TerminalPanel.createBinding() when a session is first opened — already-open sessions keep their current size until reopened.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.terminalFontSize)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 8 && n <= 32) {
            this.plugin.settings.terminalFontSize = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Scrollback (lines)")
      .setDesc("xterm.js scrollback buffer (lines) for new terminal sessions. Consumed by TerminalPanel.createBinding() when a session is first opened — already-open sessions are unaffected until reopened.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.terminalScrollback)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 100 && n <= 100000) {
            this.plugin.settings.terminalScrollback = n;
            await this.plugin.saveSettings();
          }
        })
      );

  }
}
