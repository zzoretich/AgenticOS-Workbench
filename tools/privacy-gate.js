#!/usr/bin/env node
'use strict';
/**
 * privacy-gate.js — fails when any repo file contains a forbidden term.
 * Terms: tools/privacy-terms.js (the public tools/privacy-terms.json plus the owner's private list).
 * Exceptions: tools/privacy-exceptions.json ([{path, term}]; term "*" exempts the whole file). An exception may name a
 * private term only for a file that already shows it publicly. Scans git-tracked AND untracked-but-not-ignored files
 * so an export is gated before it is committed. A tools/*.local.* file that is tracked or not ignored is a violation.
 *
 * The logs of a public repository are public, so when CI is set a private-term hit prints without its term or line,
 * and under GitHub Actions every private term is registered with ::add-mask:: before anything else prints.
 *
 * Usage: node tools/privacy-gate.js [--root <dir>] [--json] [--require-private] [--stdin <label>]
 *   --require-private  exit 2 unless private terms loaded (this repo's CI, the export, the owner's pre-commit)
 *   --stdin <label>    scan stdin as one file named <label> instead of the repo (commit messages, PR text)
 * Exit: 0 clean · 1 violations · 2 usage error
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadTerms } = require('./privacy-terms.js');

const EXCEPTIONS_FILE = path.join(__dirname, 'privacy-exceptions.json');
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.node']);
const LOCAL_FILE = /^tools\/[^/]*\.local\.[^/]*$/;
const FLAGS = new Set(['--json', '--require-private']);
const VALUED = new Set(['--root', '--stdin']);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function listFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean).map(f => f.split(path.sep).join('/'));
}

function prepare(terms, privateTerms, exceptions) {
  return {
    terms: [...terms, ...privateTerms],
    privateSet: new Set(privateTerms.map(t => String(t).toLowerCase())),
    pairs: new Set((exceptions || []).map(e => `${e.path}\u0000${String(e.term).toLowerCase()}`)),
    wholeFiles: new Set((exceptions || []).filter(e => e.term === '*').map(e => e.path)),
  };
}

function scanText(rel, text, p, violations) {
  const lines = text.split('\n');
  for (const term of p.terms) {
    const t = String(term).toLowerCase();
    if (p.pairs.has(`${rel}\u0000${t}`)) continue;
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(t)) {
        violations.push({ file: rel, line: i + 1, term, text: line.trim().slice(0, 120), private: p.privateSet.has(t) });
      }
    });
  }
}

function scan({ root, terms, privateTerms = [], exceptions, files }) {
  const p = prepare(terms, privateTerms, exceptions);
  const violations = [];
  for (const rel of files) {
    if (LOCAL_FILE.test(rel)) {
      violations.push({ file: rel, line: 0, term: 'tools/*.local.*', text: 'private file must stay untracked and ignored', private: false });
      continue;
    }
    if (p.wholeFiles.has(rel)) continue;
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    scanText(rel, text, p, violations);
  }
  return violations;
}

function scanString({ label, text, terms, privateTerms = [], exceptions }) {
  const violations = [];
  scanText(label, text, prepare(terms, privateTerms, exceptions), violations);
  return violations;
}

function parseArgs(args) {
  const a = { flags: new Set(), values: {} };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (FLAGS.has(k)) a.flags.add(k);
    else if (VALUED.has(k) && args[i + 1] !== undefined) a.values[k] = args[++i];
    else throw new Error(`unknown or incomplete argument: ${k}`);
  }
  return a;
}

function format(v, redact) {
  return v.private && redact ? `${v.file}:${v.line}: [private term]` : `${v.file}:${v.line}: [${v.term}] ${v.text}`;
}

function main(argv, env = process.env) {
  let a, terms;
  try { a = parseArgs(argv.slice(2)); terms = loadTerms({ env }); } catch (e) {
    console.error(`privacy-gate: ${e.message}`);
    console.error('usage: node tools/privacy-gate.js [--root <dir>] [--json] [--require-private] [--stdin <label>]');
    process.exit(2);
  }
  if (terms.private.length === 0) {
    if (a.flags.has('--require-private')) {
      console.error('privacy-gate: --require-private, but no private terms loaded (tools/privacy-terms.local.txt or AOS_PRIVACY_TERMS)');
      // GitHub gives a Dependabot run the Dependabot secrets only, never the Actions secret of the same name.
      if (env.GITHUB_ACTOR === 'dependabot[bot]') {
        console.error('privacy-gate: a Dependabot run reads Dependabot secrets only — fix: '
          + 'gh secret set AOS_PRIVACY_TERMS --app dependabot < tools/privacy-terms.local.txt');
      }
      process.exit(2);
    }
    console.error(`privacy-gate: no private terms loaded; checking the ${terms.public.length} public terms only`);
  }
  if (env.GITHUB_ACTIONS === 'true') for (const t of terms.private) console.log(`::add-mask::${t}`);
  const redact = Boolean(env.CI);
  const exceptions = readJson(EXCEPTIONS_FILE, []);
  let violations, scanned;
  if (a.values['--stdin'] !== undefined) {
    const label = a.values['--stdin'];
    violations = scanString({ label, text: fs.readFileSync(0, 'utf8'), terms: terms.public, privateTerms: terms.private, exceptions });
    scanned = `stdin (${label})`;
  } else {
    const root = path.resolve(a.values['--root'] || process.cwd());
    const files = listFiles(root);
    violations = scan({ root, terms: terms.public, privateTerms: terms.private, exceptions, files });
    scanned = `${files.length} file(s)`;
  }
  if (a.flags.has('--json')) {
    console.log(JSON.stringify(violations.map(v => (v.private && redact ? { file: v.file, line: v.line, private: true } : v)), null, 2));
  } else {
    for (const v of violations) console.log(format(v, redact));
  }
  console.error(`privacy-gate: ${violations.length} violation(s) across ${scanned} · ${terms.public.length} public + ${terms.private.length} private terms`);
  process.exit(violations.length ? 1 : 0);
}

if (require.main === module) main(process.argv);
module.exports = { scan, scanString, listFiles, format };
