import { App, Modal } from "obsidian";

/** A yes/no dialog that resolves to true on confirm. Used by the Routines drawer for guarded duties. */
export class ConfirmModal extends Modal {
  private resolved = false;
  constructor(app: App, private title: string, private message: string, private confirmLabel = "Confirm", private resolve: (ok: boolean) => void = () => {}) {
    super(app);
  }

  static ask(app: App, title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, message, confirmLabel, resolve).open());
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-confirm-modal");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message });
    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: this.confirmLabel, cls: "mod-cta" });
    ok.addEventListener("click", () => { this.resolved = true; this.resolve(true); this.close(); });
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}
