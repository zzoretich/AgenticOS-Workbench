#!/usr/bin/env node
// Deterministic re-verification for persona-flag-closer.
// A recipe re-runs the ORIGINAL check that found the problem:
//   exit 0  => finding still present => STILL-VALID (proposal still applicable)
//   nonzero => STALE (already fixed or premises changed)
//   126/127/timeout/spawn-fail => RECIPE-ERROR (the recipe itself is broken)
// Usage: node recheck.js <collect.json> [--root <vaultRoot>] [--record]
// --record persists consecutive-confirmation counters (monitor duty ONLY —
// interactive reviews must not inflate the auto-apply trust ladder).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { defaultRoot } = require('./collect.js');

function runRecipe(cmd, cwd) {
  try {
    execSync(cmd, { cwd, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/sh' });
    return 'STILL-VALID';
  } catch (e) {
    if (e.status === 126 || e.status === 127) return 'RECIPE-ERROR';
    if (typeof e.status === 'number') return 'STALE';
    return 'RECIPE-ERROR'; // timeout (SIGTERM) or spawn failure
  }
}

function loadConfig(root) {
  const p = path.join(root, 'persona/autoapply.json');
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { classes: Array.isArray(c.classes) ? c.classes : [] };
  } catch (_) {
    return { classes: [] }; // missing or corrupt config => NOTHING is whitelisted
  }
}

function gateAutoApply(proposal, config, confirmations) {
  if (!proposal.autoapply_class)
    return { eligible: false, reason: 'no autoapply_class declared' };
  if (!config.classes.includes(proposal.autoapply_class))
    return { eligible: false, reason: `class "${proposal.autoapply_class}" not whitelisted` };
  if (proposal.verdict !== 'STILL-VALID')
    return { eligible: false, reason: `verdict ${proposal.verdict}` };
  const n = confirmations[proposal.slug] || 0;
  if (n < 2)
    return { eligible: false, reason: `only ${n} consecutive confirmation(s), need 2+` };
  return { eligible: true, reason: `class whitelisted, ${n} confirmations` };
}

function recheck(review, root, opts = {}) {
  const stateDir = path.join(root, 'persona/flag-closer');
  const confPath = path.join(stateDir, 'confirmations.json');
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(confPath, 'utf8')); } catch (_) {}
  const config = loadConfig(root);
  for (const p of review.proposals) {
    p.verdict = p.recheck ? runRecipe(p.recheck, root) : 'NO-RECIPE';
    conf[p.slug] = p.verdict === 'STILL-VALID' ? (conf[p.slug] || 0) + 1 : 0;
    p.confirmations = conf[p.slug];
    p.autoApply = gateAutoApply(p, config, conf);
  }
  const live = new Set(review.proposals.map(p => p.slug));
  for (const k of Object.keys(conf)) if (!live.has(k)) delete conf[k];
  if (opts.record) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));
  }
  review.autoApplyWhitelist = config.classes;
  return review;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const input = args.find(a => !a.startsWith('--'));
  const rootIx = args.indexOf('--root');
  const root = rootIx >= 0 ? args[rootIx + 1] : defaultRoot();
  if (!root) { console.error('recheck: no vault — pass --root <vault> or run `aos init`'); process.exit(2); }
  const review = JSON.parse(fs.readFileSync(input, 'utf8'));
  console.log(JSON.stringify(recheck(review, root, { record: args.includes('--record') }), null, 2));
}
module.exports = { recheck, runRecipe, gateAutoApply, loadConfig };
