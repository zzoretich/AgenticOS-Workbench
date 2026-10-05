// node-pty ships its prebuilt macOS spawn-helper without the executable bit, and a pty cannot start a shell without
// it. Inside Obsidian the HUD's "Install terminal support" button fixes this at runtime; the app fixes it at install.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const prebuilds = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/node-pty/prebuilds");
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
