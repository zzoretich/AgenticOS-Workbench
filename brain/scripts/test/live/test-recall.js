#!/usr/bin/env node
// Unit tests for brain/scripts/sdk/lib/recall.js — plain node, no framework.
// Run: node brain/scripts/test/live/test-recall.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const recall = require('../../sdk/lib/recall.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-recall-'));
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function write(rel, content, mtimeDaysAgo) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeDaysAgo != null) {
    const t = new Date(Date.now() - mtimeDaysAgo * 86400000);
    fs.utimesSync(abs, t, t);
  }
  return abs;
}

try {
  // -- fixtures: one per corpus source ------------------------------------
  write('brain/memory/reference/k8s-old.md',
    `---\ntype: memory\nupdated: ${day(80)}\n---\n\n# K8s Old\nkubernetes cluster notes with kubeadm and kubernetes upgrades. See [[helm-notes]].\n`);
  write('brain/memory/reference/k8s-new.md',
    `---\ntype: memory\nupdated: ${day(2)}\n---\n\n# K8s New\nkubernetes cluster notes with kubeadm and kubernetes upgrades today.\n`);
  write('brain/patterns/helm-notes.md',
    '---\ntype: pattern\n---\n\n# Helm Notes\nhelm charts release pattern for deploys.\n', 5);
  write('2026/2026-08-August/2026-08-01.md',
    '---\ntype: daily-note\ndate: 2026-08-01\n---\n\n# 2026-08-01\nDeferred the graphify label refresh on LLM cost.\n', 9);
  write('persona/journal/2026-08-09.md',
    '---\ntype: persona-journal\ndate: 2026-08-09\n---\n\n# 2026-08-09\nduty: monitor — watchdog verified daily brief launchd healthy.\n', 1);

  // -- tokenize ------------------------------------------------------------
  assert.deepStrictEqual(recall.tokenize('The Cluster-Uses Kubernetes!'),
    ['cluster', 'uses', 'kubernetes']);

  // -- build ---------------------------------------------------------------
  const idx = recall.buildRecallIndex({ vault: root });
  assert.strictEqual(idx.docCount, 5, 'all four corpus sources indexed');
  assert.strictEqual(idx.df.kubernetes, 2);
  const paths = idx.docs.map(d => d.path);
  assert.ok(paths.includes('2026/2026-08-August/2026-08-01.md'), 'daily note indexed');
  assert.ok(paths.includes('persona/journal/2026-08-09.md'), 'journal indexed');

  // -- ranking: recency boost breaks the tie -------------------------------
  const hits = recall.queryRecall(idx, 'kubernetes cluster', { limit: 5 });
  assert.strictEqual(hits[0].path, 'brain/memory/reference/k8s-new.md',
    'newer doc outranks equal-tf stale doc');
  assert.strictEqual(hits[1].path, 'brain/memory/reference/k8s-old.md');

  // -- age flags -----------------------------------------------------------
  const old = hits.find(h => h.path.endsWith('k8s-old.md'));
  assert.strictEqual(old.stale, true);
  assert.match(old.flag, /^stale: \d+d$/);
  assert.strictEqual(hits[0].stale, false);
  assert.match(hits[0].flag, /^\d+d$/);

  // -- 1-hop wiki-link expansion ------------------------------------------
  assert.ok(hits.some(h => h.path === 'brain/patterns/helm-notes.md'),
    'helm-notes pulled in via [[helm-notes]] despite zero term match');

  // -- every corpus source reachable by query ------------------------------
  assert.strictEqual(recall.queryRecall(idx, 'graphify', {})[0].path,
    '2026/2026-08-August/2026-08-01.md');
  assert.strictEqual(recall.queryRecall(idx, 'watchdog', {})[0].path,
    'persona/journal/2026-08-09.md');

  // -- snippets carry real content -----------------------------------------
  assert.ok(hits[0].snippet.includes('kubernetes'), 'snippet contains a query term');

  // -- save / load roundtrip -----------------------------------------------
  recall.saveIndex(idx, root);
  const loaded = recall.loadIndex(root);
  assert.strictEqual(loaded.docCount, 5);

  // -- wake recall: capped at 3, driven by SESSION.md -----------------------
  write('brain/_index/SESSION.md', '## Working Memory\nkubernetes cluster upgrade in flight.\n');
  const wp = recall.writeWakeRecall(loaded, { vault: root });
  const wake = fs.readFileSync(wp, 'utf8');
  const bullets = wake.split('\n').filter(l => l.startsWith('- '));
  assert.ok(bullets.length >= 1 && bullets.length <= 3, 'wake recall capped at 3 snippets');
  assert.ok(wake.includes('k8s-new.md'));

  // -- empty SESSION.md → stale wake file removed ---------------------------
  write('brain/_index/SESSION.md', '');
  assert.strictEqual(recall.writeWakeRecall(loaded, { vault: root }), null);
  assert.ok(!fs.existsSync(wp), 'stale wake file deleted when nothing to recall');

  console.log('ok test-recall — all assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
