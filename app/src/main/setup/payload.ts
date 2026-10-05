// The runtime the app carries (phase 5, I1): a release tree in Contents/Resources/payload, built by
// scripts/make-payload.mjs. `aos init` and `aos upgrade` run from its cli/aos.js, which finds the tree from its own
// location. A dev run carries none unless $AOS_APP_PAYLOAD names one (a built payload, or a checkout of this repo).

import * as fs from "node:fs";
import * as path from "node:path";
import type { PayloadInfo } from "../../shared/ipc";

export interface Payload extends PayloadInfo {
  root: string;
  /** <root>/cli/aos.js */
  cli: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(file: string): Record<string, unknown> | null {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")) as unknown; return j && typeof j === "object" ? j as Record<string, unknown> : null; } catch { return null; }
}

/** A release tree at `root`, or null when it is not one: it needs cli/aos.js and a version (payload.json's, else package.json's). */
export function readPayload(root: string): Payload | null {
  const cli = path.join(root, "cli", "aos.js");
  if (!fs.existsSync(cli)) return null;
  const manifest = readJson(path.join(root, "payload.json"));
  const version = manifest?.schema === 1 ? manifest.version : readJson(path.join(root, "package.json"))?.version;
  if (typeof version !== "string" || !SEMVER.test(version)) return null;
  return { root, cli, version, runtimeDeps: manifest?.runtimeDeps === true && fs.existsSync(path.join(root, "brain", "scripts", "node_modules")) };
}

/** The payload this run uses: $AOS_APP_PAYLOAD, else the bundle's (packaged only), else none. */
export function findPayload(o: { packaged: boolean; resourcesPath: string; env: NodeJS.ProcessEnv }): Payload | null {
  if (o.env.AOS_APP_PAYLOAD) return path.isAbsolute(o.env.AOS_APP_PAYLOAD) ? readPayload(o.env.AOS_APP_PAYLOAD) : null;
  return o.packaged ? readPayload(path.join(o.resourcesPath, "payload")) : null;
}

/** -1, 0 or 1 for two x.y.z[-pre] versions (a prerelease precedes its release), or null when either is not one. */
export function cmpVersion(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b || !SEMVER.test(a) || !SEMVER.test(b)) return null;
  const split = (v: string) => { const i = v.indexOf("-"); return { nums: (i < 0 ? v : v.slice(0, i)).split(".").map(Number), pre: i < 0 ? "" : v.slice(i + 1) }; };
  const pa = split(a), pb = split(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true }) < 0 ? -1 : 1;
}
