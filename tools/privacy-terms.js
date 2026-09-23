#!/usr/bin/env node
'use strict';
/**
 * privacy-terms.js — the privacy gate's term list, in two tiers.
 *   public:  tools/privacy-terms.json, a JSON array of generic terms that say nothing about the owner (committed).
 *   private: tools/privacy-terms.local.txt (gitignored; AOS_PRIVACY_TERMS_FILE overrides the path)
 *            plus the AOS_PRIVACY_TERMS environment variable, which CI fills from the Actions secret of that name.
 *            Both use one format: a term per line, blank lines and `#` comments ignored. Sync the secret from the file:
 *              gh secret set AOS_PRIVACY_TERMS < tools/privacy-terms.local.txt
 * Every term is a case-insensitive substring match. A private term that is also public counts as public.
 *
 * Usage: node tools/privacy-terms.js --count                    "<n> public · <n> private"
 *        node tools/privacy-terms.js --check-message <file>     exit 1 when the file contains a term (commit-msg hook)
 * Exit: 0 ok · 1 term found · 2 usage error
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_FILE = path.join(__dirname, 'privacy-terms.json');
const PRIVATE_FILE = path.join(__dirname, 'privacy-terms.local.txt');

function parseList(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function dedupe(terms, skip = new Set()) {
  const seen = new Set(skip);
  return terms.filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function loadTerms({ env = process.env } = {}) {
  let pub;
  try { pub = JSON.parse(fs.readFileSync(PUBLIC_FILE, 'utf8')); } catch { pub = null; }
  if (!Array.isArray(pub) || pub.length === 0) throw new Error(`no terms found in ${PUBLIC_FILE}`);
  const publicTerms = dedupe(pub.map(String));
  let fromFile = [];
  try { fromFile = parseList(fs.readFileSync(env.AOS_PRIVACY_TERMS_FILE || PRIVATE_FILE, 'utf8')); } catch { /* absent */ }
  const privateTerms = dedupe([...fromFile, ...parseList(env.AOS_PRIVACY_TERMS)], new Set(publicTerms.map(t => t.toLowerCase())));
  return { public: publicTerms, private: privateTerms };
}

function main(argv) {
  const args = argv.slice(2);
  let terms;
  try { terms = loadTerms(); } catch (e) { console.error(`privacy-terms: ${e.message}`); process.exit(2); }
  if (args[0] === '--count') {
    console.log(`${terms.public.length} public · ${terms.private.length} private`);
    return;
  }
  if (args[0] === '--check-message' && args[1]) {
    const msg = fs.readFileSync(args[1], 'utf8').toLowerCase();
    const hit = [...terms.public, ...terms.private].filter(t => msg.includes(t.toLowerCase()));
    if (hit.length) { console.error(`commit-msg: forbidden term(s) in message: ${hit.join(', ')}`); process.exit(1); }
    return;
  }
  console.error('usage: node tools/privacy-terms.js --count | --check-message <file>');
  process.exit(2);
}

if (require.main === module) main(process.argv);
module.exports = { loadTerms, parseList, PUBLIC_FILE, PRIVATE_FILE };
