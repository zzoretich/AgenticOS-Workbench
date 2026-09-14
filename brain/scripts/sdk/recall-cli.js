#!/usr/bin/env node
'use strict';
/**
 * recall-cli.js — command-line recall over the vault.
 *
 *   node sdk/recall-cli.js --warm                      # (re)build brain/_index/recall-index.json + recall-wake.md
 *   node sdk/recall-cli.js <query…> [--limit N] [--json]   # ranked hits (self-heals a missing index)
 *
 * Reached as `aos recall …`. Zero model calls unless an embed index exists and the
 * provider offers embeddings (queryRecallHybrid falls back to BM25 on its own).
 * Exit: 0 ok · 2 usage.
 */
const { PATHS } = require('../lib/paths.js');
const recall = require('./lib/recall.js');

function parse(argv) {
  const o = { warm: false, json: false, limit: 5, terms: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--warm') o.warm = true;
    else if (a === '--json') o.json = true;
    else if (a === '--limit') o.limit = Number(argv[++i]) || 5;
    else o.terms.push(a);
  }
  return o;
}

function warm(vault) {
  const index = recall.buildRecallIndex({ vault });
  const p = recall.saveIndex(index, vault);
  recall.writeWakeRecall(index, { vault });
  return { index, p };
}

async function main(argv) {
  const o = parse(argv);
  const vault = PATHS.VAULT;
  if (o.warm) {
    const { index, p } = warm(vault);
    process.stdout.write(`recall: indexed ${index.docCount} docs → ${p}\n`);
    return 0;
  }
  if (!o.terms.length) {
    process.stderr.write('usage: recall-cli.js --warm | <query…> [--limit N] [--json]\n');
    return 2;
  }
  let index = recall.loadIndex(vault);
  if (!index) index = warm(vault).index;
  const { hybrid, hits } = await recall.queryRecallHybrid(index, o.terms.join(' '), { vault, limit: o.limit });
  if (o.json) { process.stdout.write(JSON.stringify(hits, null, 2) + '\n'); return 0; }
  if (!hits.length) { process.stdout.write(`no recall hits for "${o.terms.join(' ')}"\n`); return 0; }
  process.stdout.write(`${hybrid ? 'hybrid' : 'bm25'} recall for "${o.terms.join(' ')}"\n`);
  for (const h of hits) process.stdout.write(`- ${h.path} (${h.flag}, ${h.score}) — ${h.snippet.slice(0, 140)}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`recall: ${e.message}\n`); process.exit(1); });
}
module.exports = { main, parse };
