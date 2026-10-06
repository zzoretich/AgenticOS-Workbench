// `npm run release:app`: builds, signs, notarizes and uploads the app for a release (spec 2026-10-05-workbench-app-design
// D9, phase 5 I7). It runs on the maintainer's Mac, where the Developer ID certificate and the notarytool profile are;
// CI builds and tests unsigned. The tag comes first: release.yml publishes the release (notes from CHANGELOG.md) when
// the tag is pushed, and this attaches the app to it.
//
//   APPLE_KEYCHAIN_PROFILE=<profile> npm run release:app [-- --dry-run]
//
// 1. checks: the versions agree, HEAD carries v<version>, the tree is clean, the profile and gh are there, the release
//    exists. --dry-run prints them and the plan, and changes nothing.
// 2. npm run dist: the payload, the app (signed with the hardened runtime and notarized by electron-builder), the DMG and
//    the zip, and latest-mac.yml (the update feed; electron-builder never uploads: --publish never).
// 3. verify-dist --notarize-dmg: notarizes and staples the DMG, then checks the app, the payload, the feed and the DMG.
// 4. latest-mac.yml is checked against the zip the updater downloads (its sha512 and size), and a DMG it lists gets the
//    stapled DMG's (stapling changed both after the feed was written; electron-builder 26 lists only the zip).
// 5. gh release upload --clobber: the DMG, the zip, its blockmap, then latest-mac.yml, so a client that reads the new
//    feed finds its files. Until this step a client checking for updates gets no feed and tries again later.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, artifacts, releaseChecks, settleFeed, sha512Base64, uploadOrder } from "./release-feed.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(app, "..");
const DRY = process.argv.includes("--dry-run");
const version = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).version;
const rootVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const tag = `v${version}`;
const dist = path.join(app, "dist");
const a = artifacts(version);

const quiet = (cmd, args) => spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
const step = (what, cmd, args, opts = {}) => {
  console.log(`\n▸ ${what}${DRY ? " (dry run: not run)" : ""}\n  ${[cmd, ...args].join(" ")}`);
  if (DRY) return;
  const r = spawnSync(cmd, args, { cwd: app, stdio: "inherit", ...opts });
  if (r.status !== 0) { console.error(`\n${what} failed (exit ${r.status}); nothing after it ran`); process.exit(1); }
};

// ── 1. checks ────────────────────────────────────────────────────────

const checks = releaseChecks({
  version, rootVersion,
  tags: quiet("git", ["tag", "--points-at", "HEAD"]).stdout.split("\n").map((t) => t.trim()).filter(Boolean),
  clean: quiet("git", ["status", "--porcelain"]).stdout.trim() === "",
  profile: process.env.APPLE_KEYCHAIN_PROFILE,
  gh: quiet("gh", ["auth", "status"]).status === 0,
  release: quiet("gh", ["release", "view", tag, "--repo", REPO, "--json", "tagName"]).status === 0,
});
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
const failed = checks.filter((c) => !c.ok);
if (failed.length && !DRY) { console.error(`\n${failed.length} check${failed.length === 1 ? "" : "s"} failed; nothing was built or uploaded`); process.exit(1); }

// ── 2–3. build, sign, notarize, staple, verify ───────────────────────

step("build the payload and the app, signed and notarized (npm run dist)", "npm", ["run", "dist"]);
step("notarize and staple the DMG, then verify everything (verify-dist --notarize-dmg)", process.execPath, ["scripts/verify-dist.mjs", "--notarize-dmg"]);

// ── 4. the feed matches what is uploaded ─────────────────────────────

console.log(`\n▸ check ${a.feed} against ${a.zip} (a DMG it lists gets the stapled checksum)${DRY ? " (dry run: not run)" : ""}`);
if (!DRY) {
  const sum = (f) => { const b = fs.readFileSync(path.join(dist, f)); return { sha512: sha512Base64(b), size: b.length }; };
  const feedFile = path.join(dist, a.feed);
  try {
    fs.writeFileSync(feedFile, settleFeed(fs.readFileSync(feedFile, "utf8"), a, { dmg: sum(a.dmg), zip: sum(a.zip) }));
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}; nothing was uploaded`);
    process.exit(1);
  }
}

// ── 5. upload ────────────────────────────────────────────────────────

const files = uploadOrder(version).map((f) => path.join(dist, f));
if (!DRY) for (const f of files) if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
for (const f of files) step(`upload ${path.basename(f)} to ${tag}`, "gh", ["release", "upload", tag, f, "--clobber", "--repo", REPO]);

if (DRY) {
  console.log(`\ndry run: ${failed.length ? `${failed.length} check${failed.length === 1 ? "" : "s"} would stop a real run` : "the checks pass"}; nothing was built or uploaded`);
  process.exit(failed.length ? 1 : 0);
}
const url = execFileSync("gh", ["release", "view", tag, "--repo", REPO, "--json", "url", "-q", ".url"], { encoding: "utf8" }).trim();
console.log(`\nreleased the app for ${tag}: ${url}`);
