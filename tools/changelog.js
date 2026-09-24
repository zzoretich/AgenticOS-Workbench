#!/usr/bin/env node
'use strict';
/**
 * changelog.js — CHANGELOG.md's version sections (spec 2026-09-23-ci-safety-net-design D7). release.yml publishes a
 * version's section as its GitHub release notes; CI checks that package.json's version has one; bump-version rolls
 * [Unreleased] into the new version.
 *
 *   node tools/changelog.js notes <x.y.z>               print the section's body (without its heading)
 *   node tools/changelog.js check <x.y.z|current>       exit 1 when the section is missing or empty
 *   node tools/changelog.js roll <x.y.z> [--date <d>]   [Unreleased] becomes `## [x.y.z] — <d>` (default: today, local)
 *                                                       under a fresh empty [Unreleased]; the compare links follow.
 *                                                       Already rolled: no change. Empty [Unreleased]: exit 1.
 * Exit: 0 ok · 1 missing, empty or nothing to roll · 2 usage
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const LINK = /^\[[^\]]+\]:\s*\S/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headingRe = (name) => new RegExp(`^## \\[${esc(name)}\\](\\s|$)`);

/** [start, end) line indexes of `## [name]`'s body: up to the next `## ` heading or the link references. */
function bounds(lines, name) {
  const head = lines.findIndex((l) => headingRe(name).test(l));
  if (head === -1) return null;
  let end = head + 1;
  while (end < lines.length && !/^## /.test(lines[end]) && !LINK.test(lines[end])) end++;
  return [head, end];
}

/** The trimmed body of `## [name]`, or null when there is no such section. */
function section(text, name) {
  const lines = text.split('\n');
  const b = bounds(lines, name);
  return b ? lines.slice(b[0] + 1, b[1]).join('\n').trim() : null;
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Returns { text, changed, message }; throws when [Unreleased] is missing or empty and the version is not there yet. */
function roll(text, version, date = localDate()) {
  if (section(text, version) != null) return { text, changed: false, message: `CHANGELOG.md already has [${version}]` };
  const lines = text.split('\n');
  const b = bounds(lines, 'Unreleased');
  if (!b) throw new Error('no ## [Unreleased] section to roll');
  if (!lines.slice(b[0] + 1, b[1]).join('\n').trim()) throw new Error(`[Unreleased] is empty — write what ${version} changes first`);
  lines.splice(b[0], 1, '## [Unreleased]', '', `## [${version}] — ${date}`);
  const at = lines.findIndex((l) => /^\[Unreleased\]:\s*\S/.test(l));
  if (at !== -1) {
    const m = lines[at].match(/^\[Unreleased\]:\s*(\S+)\/compare\/(\S+?)\.\.\.HEAD\s*$/);
    if (m) lines.splice(at, 1, `[Unreleased]: ${m[1]}/compare/v${version}...HEAD`, `[${version}]: ${m[1]}/releases/tag/v${version}`);
  }
  return { text: lines.join('\n'), changed: true, message: `CHANGELOG.md: [Unreleased] rolled into [${version}] — ${date}` };
}

function currentVersion(root) { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }

function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, err = console.error } = {}) {
  const [verb, arg] = argv;
  const version = verb === 'check' && arg === 'current' ? currentVersion(root) : arg;
  if (!['notes', 'check', 'roll'].includes(verb) || !version || !SEMVER.test(version)) {
    err('usage: node tools/changelog.js notes|check|roll <x.y.z> (check also takes `current`; roll takes --date YYYY-MM-DD)');
    return 2;
  }
  const file = path.join(root, 'CHANGELOG.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { err('CHANGELOG.md: not found'); return 1; }
  if (verb === 'roll') {
    const i = argv.indexOf('--date');
    try {
      const r = roll(text, version, i !== -1 ? argv[i + 1] : undefined);
      if (r.changed) fs.writeFileSync(file, r.text);
      log(r.message);
      return 0;
    } catch (e) { err(`CHANGELOG.md: ${e.message}`); return 1; }
  }
  const body = section(text, version);
  if (!body) { err(`CHANGELOG.md: ${body == null ? 'no' : 'an empty'} ## [${version}] section — run: node tools/changelog.js roll ${version}`); return 1; }
  log(verb === 'notes' ? body : `changelog: [${version}] present`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { section, roll, localDate, main };
