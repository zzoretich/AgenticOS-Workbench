// The pure parts of `npm run release:app` (scripts/release-app.mjs), apart so the unit tests can reach them
// (tests/unit/release-feed.test.ts; types in release-feed.d.mts).

import { createHash } from "node:crypto";

export const REPO = "zzoretich/AgenticOS-Workbench";

/** electron-builder.yml's artifactName for this version: the DMG people download and the zip the updater installs. */
export function artifacts(version) {
  const base = `AgenticOS-Workbench-${version}-arm64`;
  return { dmg: `${base}.dmg`, zip: `${base}.zip`, blockmap: `${base}.zip.blockmap`, feed: "latest-mac.yml" };
}

/** What a release uploads, in order: the feed last, so a client never reads a feed whose files are not there yet. */
export function uploadOrder(version) {
  const a = artifacts(version);
  return [a.dmg, a.zip, a.blockmap, a.feed];
}

/** electron-updater's checksum: sha512, base64. */
export function sha512Base64(buf) { return createHash("sha512").update(buf).digest("base64"); }

/**
 * latest-mac.yml with one file's sha512 and size replaced (stapling the DMG after electron-builder wrote the feed
 * changes both). The top-level `path`/`sha512` pair is rewritten too when it names that file. Throws when the feed
 * does not list it.
 */
export function rewriteFeed(yml, file, { sha512, size }) {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- url: ${file}`);
  if (at < 0) throw new Error(`latest-mac.yml does not list ${file}`);
  const indent = lines[at].indexOf("-") + 2;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith(" ".repeat(indent)) || l.trim().startsWith("- ")) break;
    if (/^\s*sha512:/.test(l)) lines[i] = `${" ".repeat(indent)}sha512: ${sha512}`;
    else if (/^\s*size:/.test(l)) lines[i] = `${" ".repeat(indent)}size: ${size}`;
  }
  const top = lines.findIndex((l) => l === `path: ${file}`);
  if (top >= 0) {
    const s = lines.findIndex((l, i) => i > top && /^sha512:/.test(l));
    if (s >= 0) lines[s] = `sha512: ${sha512}`;
  }
  return lines.join("\n");
}

/**
 * The release's preconditions, as checks: the versions agree, HEAD carries the tag, the tree is clean, the notary
 * profile and gh are there, and the tag's release exists (release.yml makes it from the tag).
 */
export function releaseChecks(f) {
  const tag = `v${f.version}`;
  return [
    { name: "the app's version is the repo's", ok: f.version === f.rootVersion, detail: `app ${f.version} · repo ${f.rootVersion}` },
    { name: `HEAD carries the tag ${tag}`, ok: f.tags.includes(tag), detail: f.tags.join(", ") || "no tag on HEAD" },
    { name: "the working tree is clean", ok: f.clean, detail: f.clean ? "" : "commit or stash first" },
    { name: "APPLE_KEYCHAIN_PROFILE names a notarytool profile", ok: !!f.profile, detail: f.profile ? "set" : "unset" },
    { name: "gh is logged in", ok: f.gh, detail: "" },
    { name: `the GitHub release ${tag} exists`, ok: f.release, detail: f.release ? "" : "push the tag and let release.yml publish it first" },
  ];
}
