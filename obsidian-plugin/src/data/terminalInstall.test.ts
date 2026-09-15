import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { installTerminalSupport, chmodSpawnHelpers, rebuildPty, InstallDeps } from "./terminalInstall";

function fakeChild(out: string, code = 0): ChildProcess {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
  setImmediate(() => { c.stdout.emit("data", Buffer.from(out)); c.emit("close", code); });
  return c as unknown as ChildProcess;
}

const PLUGIN = "/vault/.obsidian/plugins/agentic-os";
const PREBUILDS = `${PLUGIN}/node_modules/node-pty/prebuilds`;

// `pkg` is whether <pluginDir>/package.json exists: true in an `aos init`/`aos upgrade`
// bundle, false in a release-asset or BRAT install (three files only).
function deps(children: ChildProcess[], tree: Record<string, string[]>, pkg = true, failChmodFor: string[] = []) {
  const calls: Array<{ file: string; args: string[]; cwd: string; path: string }> = [];
  const chmods: Array<[string, number]> = [];
  const d: InstallDeps = {
    spawn: (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd, path: String(opts.env.PATH) }); return children.shift()!; },
    readdirSync: (p) => { if (p in tree) return tree[p]; throw new Error("ENOENT"); },
    existsSync: (p) => p === `${PLUGIN}/package.json`
      ? pkg
      : Object.values(tree).flat().length > 0 && /spawn-helper$/.test(p) && Object.keys(tree).some((k) => p.startsWith(k)),
    chmodSync: (p, mode) => {
      if (failChmodFor.some((bad) => p.includes(bad))) throw new Error("EACCES");
      chmods.push([p, mode]);
    },
  };
  return { d, calls, chmods };
}

test("chmodSpawnHelpers makes every prebuilt spawn-helper executable", () => {
  const { d, chmods } = deps([], { [PREBUILDS]: ["darwin-arm64", "darwin-x64"] });
  const done = chmodSpawnHelpers(PLUGIN, d);
  assert.deepEqual(done, [`${PREBUILDS}/darwin-arm64/spawn-helper`, `${PREBUILDS}/darwin-x64/spawn-helper`]);
  assert.deepEqual(chmods.map((c) => c[1]), [0o755, 0o755]);
});

test("chmodSpawnHelpers is a no-op when there are no prebuilds (Linux source build)", () => {
  const { d } = deps([], {});
  assert.deepEqual(chmodSpawnHelpers(PLUGIN, d), []);
});

test("chmodSpawnHelpers logs a warning and skips a helper whose chmod fails, without throwing", () => {
  const { d, chmods } = deps([], { [PREBUILDS]: ["darwin-arm64", "darwin-x64"] }, true, ["darwin-arm64"]);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const done = chmodSpawnHelpers(PLUGIN, d);
    assert.deepEqual(done, [`${PREBUILDS}/darwin-x64/spawn-helper`]);
    assert.equal(chmods.length, 1);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("installTerminalSupport runs npm (node's sibling) in the plugin dir with node on PATH, then chmods", async () => {
  const { d, calls, chmods } = deps([fakeChild("added 4 packages\n")], { [PREBUILDS]: ["darwin-arm64"] });
  const r = await installTerminalSupport({ pluginDir: PLUGIN, nodeBin: "/opt/homebrew/bin/node" }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].args, ["install", "--omit=dev", "--no-audit", "--no-fund"]);
  assert.equal(calls[0].file, "/opt/homebrew/bin/npm");
  assert.equal(calls[0].cwd, PLUGIN);
  assert.ok(calls[0].path.startsWith("/opt/homebrew/bin:"));
  assert.match(r.output, /added 4 packages/);
  assert.deepEqual(r.chmodded, [`${PREBUILDS}/darwin-arm64/spawn-helper`]);
  assert.equal(chmods.length, 1);
});

test("a failed npm install reports ok:false with the output and skips chmod", async () => {
  const { d, chmods } = deps([fakeChild("gyp ERR! build error\n", 1)], { [PREBUILDS]: ["darwin-arm64"] });
  const r = await installTerminalSupport({ pluginDir: PLUGIN, nodeBin: "node" }, d);
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.match(r.output, /gyp ERR/);
  assert.equal(chmods.length, 0);
});

test("installTerminalSupport refuses a folder with no package.json instead of reporting a no-op success", async () => {
  // A release-asset / BRAT / community-store install holds only main.js, manifest.json and
  // styles.css; `npm install` there exits 0 and installs nothing (cli/aos.js:550 guards the same).
  const { d, calls, chmods } = deps([], { [PREBUILDS]: ["darwin-arm64"] }, false);
  const r = await installTerminalSupport({ pluginDir: PLUGIN, nodeBin: "/usr/bin/node" }, d);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.match(r.output, /no package\.json/);
  assert.match(r.output, /aos upgrade/);
  assert.equal(calls.length, 0, "npm is never spawned");
  assert.equal(chmods.length, 0);
});

test("rebuildPty refuses a folder with no package.json instead of spawning npx", async () => {
  // Mirrors the installTerminalSupport no-bundle test above: a release-asset / BRAT install
  // has only main.js, manifest.json and styles.css, so there is nothing for
  // @electron/rebuild to rebuild against.
  const { d, calls, chmods } = deps([], {}, false);
  const r = await rebuildPty({ pluginDir: PLUGIN, nodeBin: "/usr/bin/node", electron: "43.1.1" }, d);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.match(r.output, /no package\.json/);
  assert.equal(calls.length, 0, "npx is never spawned");
  assert.equal(chmods.length, 0);
});

test("rebuildPty calls @electron/rebuild through npx with the runtime electron version", async () => {
  // NOT `npm run rebuild-pty`: scripts/ is not in cli/aos.js BUNDLE_FILES nor in release.yml's
  // assets, so the script never reaches an installed plugin folder (Ruling A13).
  const { d, calls } = deps([fakeChild("rebuilt\n")], {});
  const r = await rebuildPty({ pluginDir: PLUGIN, nodeBin: "/usr/bin/node", electron: "43.1.1" }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].args, ["--yes", "@electron/rebuild", "-v", "43.1.1", "-m", PLUGIN, "-w", "node-pty"]);
  assert.equal(calls[0].file, "/usr/bin/npx");
});
