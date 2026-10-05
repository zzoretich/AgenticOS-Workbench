#!/usr/bin/env node
// Builds the app's payload (install-and-update I1): the release tree the packaged app carries in
// Contents/Resources/payload, from which it runs `aos init` and `aos upgrade` with the user's own Node. It holds what
// those two read and nothing else, plus the runtime's production dependencies, so an install from the app needs no npm
// (cli/aos.js vendorRuntime copies them when payload.json says runtimeDeps). electron-builder ships it with
// extraResources; `npm run dist` and `npm run dist:test` build it first.
//
//   node scripts/make-payload.mjs [--out payload] [--cache tests/.cache] [--skip-deps] [--quiet]
//
// Contents (<out>):
//   package.json             the checkout's name and version (cli/aos.js productVersion)
//   LICENSE, .claude-plugin/, .agents/plugins/   the license and both marketplace manifests (isRepoRoot)
//   brain/scripts/           the runtime, without tests or a lockfile, with node_modules (npm install --omit=dev)
//   cli/                     the aos subcommands, without tests, fixtures or the CI rehearsal
//   plugin/, codex-plugin/   the Claude Code plugin and the generated Codex plugin
//   vault-template/          the seed vault
//   extras/{schedule,cost}/  the schedule and cost sources, without the python tests
//   payload.json             { schema, version, commit, builtAt, runtimeDeps }
//
// The runtime's dependencies are installed once into <cache>/runtime-deps/<hash> (network on the first run only), the
// same cache and key the fixture builder uses (scripts/make-fixture-vault.mjs), so CI's cache serves both. --skip-deps
// leaves them out (runtimeDeps: false; the CLI then runs npm, as from a checkout). The tree is built beside <out> and
// renamed into place, and refused if any of its text names this machine's home folder.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.resolve(repo, ".."); // the repository root: the app lives in <repo>/app

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const OUT = path.resolve(flag("--out", path.join(repo, "payload")));
const CACHE = path.resolve(flag("--cache", path.join(repo, "tests", ".cache")));
const SKIP_DEPS = argv.includes("--skip-deps");
const QUIET = argv.includes("--quiet");
const NODE = process.execPath;

if (!fs.existsSync(path.join(WB, "brain", "scripts", "package.json"))) {
  console.error(`no Workbench runtime at ${WB}: run this from the app folder of a full checkout`);
  process.exit(2);
}

/** Files only (a symlink or socket in the sources is not part of a release), each keeping its mode. */
function copyTree(src, dest, { exclude = null } = {}) {
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude.test(childRel)) continue;
      if (e.isDirectory()) { walk(childRel); continue; }
      if (!e.isFile()) continue;
      const target = path.join(dest, childRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(src, childRel), target, fs.constants.COPYFILE_FICLONE);
    }
  };
  walk("");
}

// The same rules cli/aos.js applies when it vendors from a checkout, so the payload is no bigger than what it installs.
const TREES = [
  [".claude-plugin"],
  [".agents/plugins"],
  ["brain/scripts", /(^|\/)(node_modules|test|package-lock\.json)(\/|$)/],
  ["cli", /(^|\/)(fixtures|rehearsal)(\/|$)|\.test\.js$/],
  ["plugin"],
  ["codex-plugin"],
  ["vault-template"],
  ["extras/schedule", /(^|\/)(__pycache__|test_[^/]*\.py)(\/|$)/],
  ["extras/cost", /(^|\/)(__pycache__|test_[^/]*\.py)(\/|$)/],
];

const staging = `${OUT}.tmp-${process.pid}`;
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

try {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(WB, "package.json"), "utf8"));
  const pkg = Object.fromEntries(["name", "version", "private", "description", "license"].filter((k) => rootPkg[k] !== undefined).map((k) => [k, rootPkg[k]]));
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.copyFileSync(path.join(WB, "LICENSE"), path.join(staging, "LICENSE"));
  for (const [rel, exclude] of TREES) {
    if (!fs.existsSync(path.join(WB, rel))) throw new Error(`${rel} is missing from the checkout`);
    copyTree(path.join(WB, rel), path.join(staging, rel), { exclude });
  }

  // Privacy: a release never carries a path of the machine it was built on. Text files only, node_modules not yet in.
  const home = os.homedir();
  const leaks = [];
  const scan = (rel) => {
    for (const e of fs.readdirSync(path.join(staging, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { scan(childRel); continue; }
      const f = path.join(staging, childRel);
      if (fs.statSync(f).size > 1024 * 1024) continue;
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) continue;
      if (buf.toString("utf8").includes(home)) leaks.push(childRel);
    }
  };
  scan("");
  if (leaks.length) throw new Error(`the payload would name this machine's home folder in: ${leaks.join(", ")}`);

  let deps = "left out (--skip-deps)";
  if (!SKIP_DEPS) {
    const pkgText = fs.readFileSync(path.join(WB, "brain", "scripts", "package.json"), "utf8");
    const key = createHash("sha256").update(pkgText).update(process.versions.node.split(".")[0]).update(process.platform).digest("hex").slice(0, 16);
    const cached = path.join(CACHE, "runtime-deps", key);
    deps = `cache hit ${key}`;
    if (!fs.existsSync(path.join(cached, "node_modules"))) {
      const tmp = `${cached}.tmp-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, "package.json"), pkgText);
      // The npm next to this node when there is one (Homebrew, nodejs.org, setup-node), else the first on PATH; a cache
      // of our own, the command the CLI would otherwise run in the vault.
      const sibling = path.join(path.dirname(NODE), "npm");
      const npmBin = fs.existsSync(sibling) ? sibling : "npm";
      const env = { ...process.env, PATH: [path.dirname(NODE), process.env.PATH ?? ""].join(":"), npm_config_cache: path.join(CACHE, "npm"), npm_config_update_notifier: "false" };
      const npm = spawnSync(npmBin, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: tmp, env, encoding: "utf8", timeout: 300_000 });
      if (npm.status !== 0) throw new Error(`npm install failed: ${(npm.stderr || npm.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
      fs.rmSync(cached, { recursive: true, force: true });
      fs.renameSync(tmp, cached);
      deps = `installed into cache ${key}`;
    }
    // Without npm's .bin folders: links to executable scripts nothing runs, and the only symlinks the app's signature
    // would otherwise have to seal.
    fs.cpSync(path.join(cached, "node_modules"), path.join(staging, "brain", "scripts", "node_modules"), {
      recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true,
      filter: (src) => !/(^|\/)\.bin(\/|$)/.test(path.relative(cached, src)),
    });
  }

  let commit = null;
  try { commit = execFileSync("git", ["-C", WB, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* not a git checkout */ }
  const manifest = { schema: 1, version: pkg.version, commit, builtAt: new Date().toISOString(), runtimeDeps: !SKIP_DEPS };
  fs.writeFileSync(path.join(staging, "payload.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.renameSync(staging, OUT);

  let files = 0;
  let bytes = 0;
  const count = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) count(p);
      else if (e.isFile()) { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  count(OUT);
  if (!QUIET) console.log(`payload ${pkg.version}${commit ? ` (${commit.slice(0, 7)})` : ""}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${path.relative(process.cwd(), OUT) || "."}; runtime dependencies ${deps}`);
} catch (err) {
  fs.rmSync(staging, { recursive: true, force: true });
  console.error(`make-payload: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
