#!/usr/bin/env node
'use strict';
/**
 * export-from-vault.js — one-way, allowlisted, scrubbed copy from the owner's
 * vault into this repo. Never deletes at the destination. Never overwrites an
 * existing destination file unless --force. Refuses any destination inside the
 * Claude config dir. Runs the privacy gate, private terms included, on the destination afterwards.
 *
 * The table of what to copy and how to scrub it (ALLOWLIST, EXCLUDE, SCRUBS) names the owner's private identifiers,
 * so it lives in the gitignored tools/export-scrubs.local.js; tools/export-scrubs.example.js documents its shape.
 *
 * Usage: node tools/export-from-vault.js --source <vault> [--dest <repo>] [--scrubs <file>] [--diff] [--force] [--allow-violations]
 * Exit: 0 ok · 1 gate violations · 2 usage error, no table or no private terms · 3 unmatched scrubs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, listFiles, format } = require('./privacy-gate.js');
const { loadTerms } = require('./privacy-terms.js');

const LOCAL_TABLE = path.join(__dirname, 'export-scrubs.local.js');

function parseArgs(argv) {
  const a = { source: null, dest: path.resolve(__dirname, '..'), scrubs: LOCAL_TABLE, diff: false, force: false, allowViolations: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--source') a.source = path.resolve(argv[++i]);
    else if (k === '--dest') a.dest = path.resolve(argv[++i]);
    else if (k === '--scrubs') a.scrubs = path.resolve(argv[++i]);
    else if (k === '--diff') a.diff = true;
    else if (k === '--force') a.force = true;
    else if (k === '--allow-violations') a.allowViolations = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.source) throw new Error('--source <vault> is required');
  return a;
}

function claudeConfigDir() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

function assertSafeDest(dest) {
  const cfg = claudeConfigDir();
  const rel = path.relative(cfg, path.resolve(dest));
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) throw new Error(`refusing to export into the Claude config dir: ${dest}`);
}

function loadTable(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`no export table at ${file}: copy tools/export-scrubs.example.js to tools/export-scrubs.local.js and fill it in`);
  }
  const table = require(file);
  for (const k of ['ALLOWLIST', 'EXCLUDE', 'SCRUBS']) {
    if (!Array.isArray(table[k])) throw new Error(`${file}: ${k} must be an array`);
  }
  return table;
}

function walk(dir, exclude = [], base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (exclude.some(re => re.test(rel))) continue;
    if (e.isDirectory()) walk(abs, exclude, base, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function applyScrubs(destRel, text, report, scrubs) {
  let out = text;
  for (const s of scrubs) {
    const files = Array.isArray(s.file) ? s.file : [s.file];
    if (!files.includes(destRel)) continue;
    const before = out;
    out = out.replace(s.from, s.to);
    (before === out ? report.unmatched : report.applied).push({ file: destRel, from: String(s.from) });
  }
  return out;
}

function plan({ source, dest, force, table }) {
  const report = { copy: [], skip: [], differ: [], applied: [], unmatched: [] };
  const visited = new Set();
  for (const entry of table.ALLOWLIST) {
    const srcRoot = path.join(source, entry.from);
    if (!fs.existsSync(srcRoot)) { report.skip.push({ file: entry.from, reason: 'missing in source' }); continue; }
    const rels = fs.statSync(srcRoot).isDirectory() ? walk(srcRoot, table.EXCLUDE) : [''];
    for (const rel of rels) {
      const src = rel ? path.join(srcRoot, rel) : srcRoot;
      const destRel = rel ? `${entry.to}/${rel}` : entry.to;
      visited.add(destRel);
      const target = path.join(dest, destRel);
      const raw = fs.readFileSync(src);
      const isText = !raw.includes(0);
      const content = isText ? Buffer.from(applyScrubs(destRel, raw.toString('utf8'), report, table.SCRUBS), 'utf8') : raw;
      if (fs.existsSync(target)) {
        if (fs.readFileSync(target).equals(content)) { report.skip.push({ file: destRel, reason: 'identical' }); continue; }
        report.differ.push({ file: destRel });
        if (!force) continue;
      }
      report.copy.push({ file: destRel, content, dest: target });
    }
  }
  for (const s of table.SCRUBS) {
    const files = Array.isArray(s.file) ? s.file : [s.file];
    for (const f of files) {
      if (!visited.has(f)) report.unmatched.push({ file: f, from: String(s.from) });
    }
  }
  return report;
}

function runGate(dest, terms) {
  const exceptions = JSON.parse(fs.readFileSync(path.join(__dirname, 'privacy-exceptions.json'), 'utf8'));
  return scan({ root: dest, terms: terms.public, privateTerms: terms.private, exceptions, files: listFiles(dest) });
}

function main() {
  const args = parseArgs(process.argv);
  assertSafeDest(args.dest);
  const table = loadTable(args.scrubs);
  const terms = loadTerms();
  if (!terms.private.length) {
    throw new Error('no private terms loaded (tools/privacy-terms.local.txt or AOS_PRIVACY_TERMS): the export gate needs them');
  }
  const report = plan({ ...args, table });
  const copied = new Set(report.copy.map(c => c.file));
  const kept = report.differ.filter(d => !copied.has(d.file)).length;
  for (const u of report.unmatched) console.error(`scrub did not match: ${u.file} :: ${u.from}`);
  if (args.diff) {
    for (const c of report.copy) console.log(`would write ${c.file}`);
    for (const d of report.differ) console.log(copied.has(d.file)
      ? `DIFFERS (would overwrite: --force): ${d.file}`
      : `DIFFERS (kept; --force overwrites): ${d.file}`);
    console.log(`${report.copy.length} to write · ${kept} differ · ${report.skip.length} skipped · ${report.applied.length} scrubs applied · ${report.unmatched.length} unmatched`);
    process.exit(report.unmatched.length ? 3 : 0);
  }
  for (const c of report.copy) { fs.mkdirSync(path.dirname(c.dest), { recursive: true }); fs.writeFileSync(c.dest, c.content); }
  for (const d of report.differ) console.error(copied.has(d.file)
    ? `overwrote (forced, was different): ${d.file}`
    : `kept existing (differs): ${d.file}`);
  console.log(`wrote ${report.copy.length} file(s) · ${kept} kept · ${report.applied.length} scrubs applied · ${report.unmatched.length} unmatched`);
  const violations = runGate(args.dest, terms);
  for (const v of violations) console.log(format(v, Boolean(process.env.CI)));
  console.error(`privacy-gate: ${violations.length} violation(s)`);
  if (violations.length && !args.allowViolations) process.exit(1);
  if (report.unmatched.length) process.exit(3);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(2); }
}
module.exports = { plan, applyScrubs, walk, loadTable, assertSafeDest, claudeConfigDir };
