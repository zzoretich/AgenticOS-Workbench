'use strict';
/**
 * update-check.js — `aos update-check` / `aos update-status` / `aos update-notice`.
 *
 * One producer owns the network and the clock (`update-check`, run detached); every other surface is a
 * pure read of two files in <vault>/brain/_index/:
 *   update-check.json   state (schema 1)
 *   update-line.txt     pre-rendered status line fragment: zero bytes, or one line plus "\n"
 *
 * Design: docs/superpowers/specs/2026-09-15-update-notification-design.md
 * Contract: every path exits 0 with empty stdout — a hook must never fail a Claude Code session.
 * Zero dependencies; the HTTP getter and the clock are injectable (the `getFn` seam mirrors
 * cli/aos.js download()).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const REPO_SLUG = 'zzoretich/AgenticOS-Workbench';
const LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const STORE_REL = path.join('brain', '_index', 'update-check.json');
const LINE_REL = path.join('brain', '_index', 'update-line.txt');
const SCHEMA = 1;
const DEFAULT_INTERVAL_HOURS = 24;
const MAX_BACKOFF_DOUBLINGS = 4;
const MAX_BODY_BYTES = 1e6;

// A release tag this CLI is willing to order. Anything else is ignored rather than announced.
const TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The normalised version inside a tag ("v0.2.0" -> "0.2.0"), or null when it is not orderable semver. */
function parseTag(tag) {
  const m = TAG_RE.exec(String(tag == null ? '' : tag).trim());
  return m ? m[1] : null;
}

function parseSemver(v) {
  const core = parseTag(v);
  if (!core) return null;
  // indexOf, not split('-'): a prerelease may itself contain hyphens ("1.0.0-alpha-1").
  const i = core.indexOf('-');
  return {
    nums: (i === -1 ? core : core.slice(0, i)).split('.').map(Number),
    pre: i === -1 ? '' : core.slice(i + 1),
  };
}

/**
 * Semver §11 prerelease precedence, over the dot-separated identifiers: numeric identifiers
 * compare numerically, a numeric identifier ranks below an alphanumeric one, and a shorter set of
 * identifiers ranks below a longer one when every shared identifier is equal. An absent prerelease
 * (a real release) outranks any prerelease.
 * A plain `a < b` string compare is wrong here: it puts "rc.9" above "rc.10".
 */
function cmpPre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const ai = a.split('.');
  const bi = b.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === undefined) return -1;
    if (bi[i] === undefined) return 1;
    if (ai[i] === bi[i]) continue;
    const an = /^\d+$/.test(ai[i]);
    const bn = /^\d+$/.test(bi[i]);
    if (an && bn) return Number(ai[i]) < Number(bi[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ai[i] < bi[i] ? -1 : 1;
  }
  return 0;
}

/** -1 | 0 | 1, or null when either side is not orderable. A prerelease precedes its release. */
function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  return cmpPre(pa.pre, pb.pre);
}

/** The skew rule (design §8): a user is only as upgraded as their least-upgraded part. */
function lowerVersion(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const c = cmpSemver(a, b);
  if (c === null) return a;
  return c <= 0 ? a : b;
}

module.exports = {
  REPO_SLUG, LATEST_URL, STORE_REL, LINE_REL, SCHEMA,
  DEFAULT_INTERVAL_HOURS, MAX_BACKOFF_DOUBLINGS, MAX_BODY_BYTES, TAG_RE,
  parseTag, cmpSemver, lowerVersion,
};
