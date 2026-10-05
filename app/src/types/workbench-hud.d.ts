// The Workbench HUD as the app sees it. The build points these names at ../obsidian-plugin; tsc
// sees only these shapes, so the vendor source is not type-checked against the compat layer until phase 4.

declare module "@workbench/hud" {
  import type { App, Plugin, PluginManifest } from "obsidian";

  export default class AgenticOSPlugin extends Plugin {
    constructor(app: App, manifest: PluginManifest);
  }
}

declare module "@workbench/hud-manifest" {
  const manifest: {
    id: string;
    name: string;
    version: string;
    minAppVersion?: string;
    description?: string;
    author?: string;
    isDesktopOnly?: boolean;
  };
  export default manifest;
}
