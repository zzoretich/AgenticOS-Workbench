#!/usr/bin/env node
'use strict';
/**
 * privacy-gate.js — fails when any repo file contains a forbidden term.
 * Terms: tools/privacy-terms.json. Exceptions: tools/privacy-exceptions.json
 * ([{path, term}]; term "*" exempts the whole file). Scans git-tracked AND
 * untracked-but-not-ignored files so an export is gated before it is committed.
 *
 * Usage: node tools/privacy-gate.js [--root <dir>] [--json]
 * Exit: 0 clean · 1 violations · 2 usage error
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TERMS_FILE = path.join(__dirname, 'privacy-terms.json');
const EXCEPTIONS_FILE = path.join(__dirname, 'privacy-exceptions.json');
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.node']);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function listFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean).map(f => f.split(path.sep).join('/'));
}

function scan({ root, terms, exceptions, files }) {
  const violations = [];
  const pairs = new Set((exceptions || []).map(e => `${e.path}\u0000${String(e.term).toLowerCase()}`));
  const wholeFiles = new Set((exceptions || []).filter(e => e.term === '*').map(e => e.path));
  for (const rel of files) {
    if (wholeFiles.has(rel)) continue;
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (const term of terms) {
      const t = String(term).toLowerCase();
      if (pairs.has(`${rel}\u0000${t}`)) continue;
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(t)) {
          violations.push({ file: rel, line: i + 1, term, text: line.trim().slice(0, 120) });
        }
      });
    }
  }
  return violations;
}

function main(argv) {
  const args = argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = path.resolve(rootIdx >= 0 ? args[rootIdx + 1] : process.cwd());
  const terms = readJson(TERMS_FILE, null);
  if (!Array.isArray(terms) || terms.length === 0) {
    console.error(`privacy-gate: no terms found in ${TERMS_FILE}`);
    process.exit(2);
  }
  const exceptions = readJson(EXCEPTIONS_FILE, []);
  const files = listFiles(root);
  const violations = scan({ root, terms, exceptions, files });
  if (args.includes('--json')) console.log(JSON.stringify(violations, null, 2));
  else for (const v of violations) console.log(`${v.file}:${v.line}: [${v.term}] ${v.text}`);
  console.error(`privacy-gate: ${violations.length} violation(s) across ${files.length} file(s)`);
  process.exit(violations.length ? 1 : 0);
}

if (require.main === module) main(process.argv);
module.exports = { scan, listFiles };
