import { Notice, Setting } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { readAgenticosJson, sessionHosts, VAULT_CONFIG_PATH } from "../data/aosConfig";
import type { SessionHost } from "../data/aosConfig";
import { failureText, needsUpgrade } from "../data/aosRun";
import {
  FollowUps, parseConfigList, groupBySection, changedCount, masterRows, parseInput, inputText, valueArg, sameValue, confirmFor,
  appliesLabel, sourceLabel, sourceTitle, spendLine, hostNote, resultSummary, argsFor,
} from "../data/settingsModel";
import type { ConfigList, ConfigRow, FollowUp, SetResult } from "../data/settingsModel";
import { ConfirmModal } from "../ui/ConfirmModal";
import { renderPluginSettings } from "../ui/pluginSettingRows";
import type { PluginRowsHandle } from "../ui/pluginSettingRows";

const SOURCE_PILL: Record<string, string> = { machine: "aos-pill-amber", vault: "aos-pill-cyan", default: "aos-pill-dim", unset: "aos-pill-dim" };

/**
 * SETTINGS — the whole system's settings in one tab, opened from ⚙ at the foot of the rail (spec 2026-09-24-settings-tab).
 * It renders what `aos config list --json` returns (D2) and changes a setting only through `aos config set|unset`
 * (D3): the runtime validates, picks the file that wins, writes atomically and runs the side effects; this tab shows the
 * outcome. Master switches head it (D5), risky changes ask first (D6), follow-ups become buttons (D9), and the plugin's
 * own settings render through the same renderer as Obsidian's settings pane (D11). Logic lives in
 * src/data/settingsModel.ts; this class only renders and wires.
 */
export class SettingsTab {
  private host: HTMLElement | null = null;
  private list: ConfigList | null = null;
  private failure: { text: string; upgrade: boolean } | null = null;
  private hosts: SessionHost[] = ["claude"];
  private loading = false;
  private busy = new Set<string>();
  private rowErrors = new Map<string, string>();
  private followUps = new FollowUps();
  private pluginRows: PluginRowsHandle | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      // A hand edit to brain/config.json (or another host's `aos config`) re-reads the list; agenticos.json lives
      // outside the vault, so its changes show on the next open or ⟳.
      const watch = (f: TAbstractFile) => { if (f.path === VAULT_CONFIG_PATH && this.view.isTabActive("settings")) this.schedule(); };
      this.view.registerEvent(this.plugin.app.vault.on("modify", watch));
    }
    this.render();
  }

  unmount(): void {
    void this.pluginRows?.commit();
    this.pluginRows = null;
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
      const r = await this.plugin.aosJson<unknown>(["config", "list", "--json"]);
      const list = r.code === 0 ? parseConfigList(r.json) : null;
      if (list) { this.list = list; this.failure = null; }
      else this.failure = { text: r.parseError ?? (r.code === 0 ? "aos config list answered in an unexpected shape" : failureText(r)), upgrade: r.code !== 0 ? needsUpgrade(r) : true };
    } finally {
      this.loading = false;
    }
    this.render();
  }

  // ── writes (every one is `aos config`; the refreshed list is the source of truth afterwards) ──

  private async change(row: ConfigRow, next: unknown): Promise<void> {
    if (sameValue(row.value, next)) return;
    const ask = confirmFor(row, next);
    if (ask && !(await ConfirmModal.ask(this.plugin.app, ask.title, ask.message, ask.cta))) { this.render(); return; }
    await this.write(row.key, ["config", "set", row.key, valueArg(next), "--json"]);
  }

  private async reset(row: ConfigRow): Promise<void> {
    const ask = confirmFor(row, row.default);
    if (ask && !(await ConfirmModal.ask(this.plugin.app, ask.title, ask.message, ask.cta))) return;
    await this.write(row.key, ["config", "unset", row.key, "--json"]);
  }

  private async write(key: string, args: string[]): Promise<void> {
    this.busy.add(key);
    this.rowErrors.delete(key);
    this.render();
    const r = await this.plugin.aosJson<SetResult>(args);
    this.busy.delete(key);
    if (r.code === 0 && r.json) {
      new Notice(resultSummary(r.json), 6000);
      this.followUps.add(r.json.followUps);
      this.view.setBadge("settings", this.followUps.size);
      if (key === "telemetry.enabled") this.plugin.rebindLiveSources();
    } else if (r.code === 2) {
      this.rowErrors.set(key, failureText(r));
    } else {
      new Notice(`${key} not changed: ${failureText(r)}`, 8000);
    }
    await this.refresh();
  }

  private async runFollowUp(f: FollowUp): Promise<void> {
    const args = argsFor(f.command);
    if (!args) return;
    new Notice(`▶ ${f.command}`);
    const r = await this.plugin.aos(args, 300_000);
    if (r.code === 0) { this.followUps.remove(f.command); new Notice(`${f.command}: done`); }
    else new Notice(`${f.command} failed: ${failureText(r)}`, 8000);
    this.view.setBadge("settings", this.followUps.size);
    this.render();
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("settings")) return;
    const host = this.host;
    if (!host) return;
    void this.pluginRows?.commit();
    host.empty();

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "SETTINGS" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: this.list ? `${changedCount(this.list)} changed from the defaults` : this.loading || !this.failure ? "loading…" : "" });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const reload = actions.createEl("button", { cls: "aos-ws-action", text: "⟳ reload" });
    reload.setAttr("title", "Read every setting again (aos config list)");
    reload.addEventListener("click", () => void this.refresh());

    if (this.list) {
      const files = host.createDiv({ cls: "aos-rt-note aos-dim" });
      files.appendText("Values come from ");
      files.createSpan({ cls: "aos-pill aos-pill-amber", text: "this machine", attr: { title: this.list.files.machine } });
      files.appendText(" (agenticos.json), ");
      files.createSpan({ cls: "aos-pill aos-pill-cyan", text: "this vault", attr: { title: this.list.files.vault } });
      files.appendText(" (brain/config.json) or the ");
      files.createSpan({ cls: "aos-pill aos-pill-dim", text: "default" });
      files.appendText(". A change is written to the file that wins; ↺ goes back to the default.");
    }

    if (this.failure) this.renderFailure(host);
    if (this.followUps.size) this.renderFollowUps(host);
    if (this.list) {
      this.renderMaster(host, this.list);
      for (const { section, rows } of groupBySection(this.list)) {
        if (section.id === "hosts") continue;
        host.createDiv({ cls: "aos-rt-subhead aos-dim", text: section.label.toUpperCase() });
        const box = host.createDiv({ cls: "aos-st-section" });
        for (const row of rows) this.renderRow(box, row);
      }
    }

    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "WORKBENCH — THIS OBSIDIAN PLUGIN" });
    this.pluginRows = renderPluginSettings(host.createDiv({ cls: "aos-st-section aos-st-plugin" }), this.plugin, () => this.render());

    if (this.list) this.renderHosts(host, this.list);
  }

  private renderFailure(host: HTMLElement): void {
    const box = host.createDiv({ cls: "aos-st-failure" });
    box.createDiv({ text: this.failure!.upgrade
      ? "This vault's AgenticOS runtime has no `aos config` yet: run `aos upgrade` to control every setting from here. The plugin's own settings below still work."
      : `Could not read the settings: ${this.failure!.text}` });
    if (this.failure!.upgrade) {
      const b = box.createEl("button", { cls: "aos-ws-action", text: "❯_ aos upgrade" });
      b.addEventListener("click", () => this.view.runInTerm("aos upgrade"));
    }
  }

  private renderFollowUps(host: HTMLElement): void {
    const bar = host.createDiv({ cls: "aos-st-follow" });
    bar.createSpan({ text: `⚠ ${this.followUps.size} step${this.followUps.size === 1 ? "" : "s"} left:` });
    for (const f of this.followUps.list()) {
      const b = bar.createEl("button", { cls: "aos-ws-action", text: f.command });
      b.setAttr("title", f.why);
      b.addEventListener("click", () => void this.runFollowUp(f));
    }
  }

  private renderMaster(host: HTMLElement, list: ConfigList): void {
    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "MASTER SWITCHES" });
    const grid = host.createDiv({ cls: "aos-st-master" });
    for (const { sw, row, on } of masterRows(list)) {
      const chip = grid.createEl("label", { cls: `aos-st-switch${on ? " is-on" : ""}${this.busy.has(row.key) ? " is-busy" : ""}` });
      chip.setAttr("title", `${row.key} — ${row.help}`);
      const box = chip.createEl("input", { attr: { type: "checkbox" } });
      box.checked = on;
      box.addEventListener("change", () => void this.change(row, sw.valueFor(box.checked)));
      chip.createSpan({ cls: "aos-st-switchlabel", text: sw.label });
    }
  }

  private renderRow(box: HTMLElement, row: ConfigRow): void {
    const s = new Setting(box).setName(row.label);
    const dimmed = hostNote(row, this.hosts);
    s.settingEl.addClass("aos-st-row");
    if (dimmed) s.settingEl.addClass("is-dim");
    const busy = this.busy.has(row.key);

    const desc = s.descEl;
    desc.empty();
    desc.createDiv({ text: row.help });
    const meta = desc.createDiv({ cls: "aos-st-meta" });
    meta.createSpan({ cls: "aos-st-key", text: row.key });
    if (this.list) meta.createSpan({ cls: `aos-pill ${SOURCE_PILL[row.source] ?? "aos-pill-dim"}`, text: sourceLabel(row.source), attr: { title: sourceTitle(row.source, this.list.files) } });
    meta.createSpan({ cls: "aos-dim", text: row.readonly && row.how ? `change with: ${row.how}` : appliesLabel(row.applies) });
    const spent = spendLine(row);
    if (spent) meta.createSpan({ cls: "aos-st-spend", text: spent });
    if (dimmed) desc.createDiv({ cls: "aos-st-hostnote", text: dimmed });
    if (row.note) desc.createDiv({ cls: "aos-st-hostnote", text: row.note });
    const err = this.rowErrors.get(row.key);
    if (err) desc.createDiv({ cls: "aos-st-err", text: err });

    if (row.readonly) {
      s.addText((t) => t.setValue(row.value === null ? "" : inputText(row.value)).setPlaceholder("not set").setDisabled(true));
      return;
    }
    if (row.type === "bool") {
      s.addToggle((t) => t.setValue(row.value === true).setDisabled(busy).onChange((v) => void this.change(row, v)));
    } else if (row.type === "enum" && row.values) {
      s.addDropdown((d) => {
        for (const v of row.values!) d.addOption(valueArg(v), valueArg(v));
        if (row.nullable) d.addOption("null", "host default");
        d.setValue(valueArg(row.value));
        d.setDisabled(busy);
        d.onChange((text) => {
          const next = text === "null" && row.nullable ? null : row.values!.find((v) => valueArg(v) === text) ?? text;
          void this.change(row, next);
        });
      });
    } else {
      s.addText((t) => {
        t.setValue(inputText(row.value)).setDisabled(busy);
        if (row.nullable) t.setPlaceholder("host default");
        // Commit once, on blur or Enter — never per keystroke, so a half-typed number never reaches `aos config`.
        const commit = () => {
          if (inputText(row.value) === t.getValue()) return;
          const parsed = parseInput(row, t.getValue());
          if (!parsed.ok) { this.rowErrors.set(row.key, parsed.error); this.render(); return; }
          void this.change(row, parsed.value);
        };
        t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") t.inputEl.blur(); });
        t.inputEl.addEventListener("blur", commit);
      });
    }
    if (row.source !== "default" && row.source !== "unset") {
      s.addExtraButton((b) => b.setIcon("rotate-ccw").setDisabled(busy)
        .setTooltip(`Back to the default (${valueArg(row.default)}): aos config unset ${row.key}`)
        .onClick(() => void this.reset(row)));
    }
  }

  private renderHosts(host: HTMLElement, list: ConfigList): void {
    const rows = list.settings.filter((r) => r.section === "hosts");
    if (!rows.length) return;
    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "HOSTS & INSTALL — CHANGED ONLY THROUGH THE INSTALLER" });
    const acts = host.createDiv({ cls: "aos-st-actions" });
    const doctor = acts.createEl("button", { cls: "aos-ws-action", text: "❯_ aos doctor" });
    doctor.setAttr("title", "Check every install path, binary, host and hook in the Term tab");
    doctor.addEventListener("click", () => this.view.runInTerm("aos doctor"));
    const upgrade = acts.createEl("button", { cls: "aos-ws-action", text: "❯_ aos upgrade" });
    upgrade.setAttr("title", "Refresh the runtime and both plugins, and re-resolve the binaries, in the Term tab");
    upgrade.addEventListener("click", () => this.view.runInTerm("aos upgrade"));
    const box = host.createDiv({ cls: "aos-st-section" });
    for (const row of rows) this.renderRow(box, row);
  }
}
