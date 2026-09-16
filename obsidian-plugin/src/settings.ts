import { App, PluginSettingTab, Setting } from "obsidian";
import type AgenticOSPlugin from "../main";

export interface AgenticOSSettings {
  statusBarEnabled: boolean;
  autoOpenSidebarOnStart: boolean;
  liveTailPollMs: number;
  // Terminal
  terminalEmbedded: boolean;
  terminalEmbedHeight: number;
  terminalShell: string;
  terminalCwd: string;
  terminalFontSize: number;
  terminalScrollback: number;
}

export const DEFAULT_SETTINGS: AgenticOSSettings = {
  statusBarEnabled: true,
  autoOpenSidebarOnStart: false,
  liveTailPollMs: 300,
  // Terminal — shell + cwd auto-resolve at plugin load if blank
  terminalEmbedded: true,
  terminalEmbedHeight: 280,
  terminalShell: "",
  terminalCwd: "",
  terminalFontSize: 13,
  terminalScrollback: 5000,
};

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
