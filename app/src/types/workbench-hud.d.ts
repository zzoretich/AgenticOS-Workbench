// The Workbench HUD as the app sees it. The build points these names at ../obsidian-plugin; tsc
// sees only these shapes, so the vendor source is not type-checked against the compat layer until phase 4.

declare module "@workbench/hud" {
  import type { App, Plugin, PluginManifest } from "obsidian";

  export default class AgenticOSPlugin extends Plugin {
    constructor(app: App, manifest: PluginManifest);
  }
}

// ../obsidian-plugin/package.json, read for its version only (a named import keeps the rest out of the bundle).
declare module "@workbench/hud-package" {
  export const version: string;
}
