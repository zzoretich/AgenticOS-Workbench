// The settings window's App tab: what this app is attached to and what it may write, read-only. Every Workbench surface
// writes by default; $AOS_APP_WRITE narrows that for a run (tests, one-off runs), and this tab says which applies.

import { shell } from "electron";
import { Setting, SettingTab, type App } from "obsidian";
import type { WritePolicy } from "../shared/write-policy";

export interface AppFacts {
  vaultRoot: string;
  /** Where the vault came from (AOS_APP_VAULT, agenticos.json …). */
  vaultSource: string;
  userData: string;
  appVersion: string;
  hudVersion: string;
  electron: string;
  policy: () => WritePolicy;
  writeSource: () => string;
}

export class AppSettingTab extends SettingTab {
  constructor(app: App, private readonly facts: AppFacts) {
    super(app);
    this.id = "app";
    this.name = "App";
  }

  display(): void {
    const el = this.containerEl;
    const f = this.facts;
    el.empty();
    el.addClass("aos-app-settings");
    el.createEl("h2", { text: "AgenticOS app" });

    const folder = (name: string, desc: string, p: string) => new Setting(el).setName(name).setDesc(desc)
      .addButton((b) => b.setButtonText("Show in Finder").onClick(() => { shell.showItemInFolder(p); }))
      .then((s) => { s.descEl.createDiv({ cls: "aos-app-path", text: p }); });
    folder("Vault", `The AgenticOS vault this window shows (${f.vaultSource}).`, f.vaultRoot);
    folder("App data", "The app's own settings and the Workbench plugin's settings. Nothing here is in the vault.", f.userData);

    const policy = f.policy();
    const source = f.writeSource();
    const on = policy.surfaces.map((s) => s.label);
    new Setting(el)
      .setName("Write access")
      .setDesc(source === "AOS_APP_WRITE"
        ? "Set for this run by AOS_APP_WRITE."
        : "Every Workbench surface writes to the vault; anything else is refused.")
      .then((s) => { s.controlEl.createSpan({ cls: `aos-app-writes${on.length ? " is-writing" : ""}`, text: on.length ? on.join(", ") : "Read-only" }); });

    new Setting(el).setName("Versions").setDesc("The app, the Workbench HUD it runs (built from this release), and Electron.")
      .then((s) => { s.descEl.createDiv({ cls: "aos-app-path aos-app-versions", text: `app ${f.appVersion} · HUD ${f.hudVersion} · Electron ${f.electron}` }); });
  }
}
