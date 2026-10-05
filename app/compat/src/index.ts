// The `obsidian` module as the AgenticOS app provides it. The build points every `import … from "obsidian"` in the
// Workbench HUD here. Importing it installs Obsidian's DOM helpers, which the HUD uses as globals.

import { installDomHelpers } from "./dom";

installDomHelpers();

export { DOM_HELPERS, createEl, createDiv, createSpan, createSvg, createFragment, type DomElementInfo } from "./dom";
export { Events, Component, type EventRef } from "./events";
export { TAbstractFile, TFile, TFolder, normalizePath, type FileStats } from "./files";
export { Vault, DataAdapter } from "./vault";
export { Workspace, WorkspaceLeaf, View, ItemView, NoteView, NoteView as MarkdownView, type ViewState } from "./workspace";
export { Modal, SuggestModal, FuzzySuggestModal, fuzzyScore, type FuzzyMatch } from "./modal";
export { Setting, ButtonComponent, ExtraButtonComponent, ToggleComponent, TextComponent, DropdownComponent } from "./setting";
export { MarkdownRenderer, setMarkdownHost } from "./markdown";
export { Notice, setIcon, getIconIds } from "./notice";
export { App, Plugin, SettingTab, PluginSettingTab, Commands, type PluginManifest, type Command, type Hotkey } from "./plugin";
export { guardState, setWriteGuard, canWrite, canMakeFolder, canSpawn, canSave, refuse, type GuardEntry, type GuardState, type WriteGuard } from "./guard";

export const Platform = { isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false, isMacOS: process.platform === "darwin", isWin: process.platform === "win32", isLinux: process.platform === "linux" };
export const apiVersion = "1.13.1-compat";
