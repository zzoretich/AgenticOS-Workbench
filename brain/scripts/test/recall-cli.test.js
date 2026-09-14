'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'sdk', 'recall-cli.js');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-cli-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(v, 'brain', 'memory', 'reference'), { recursive: true });
  // Plan 2 rule: every test forces provider `none`. Under `auto`, getProvider() would ping Ollama and then run a
  // real `claude -p` login probe; with `none` recall stays BM25 and the test never resolves a provider.
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  fs.writeFileSync(path.join(v, 'brain', 'memory', 'reference', 'zebra-deploy.md'),
    '---\ntype: memory\nupdated: 2026-09-01\n---\n\n# Zebra deploy\n\nThe zebra service deploys from the release branch every Tuesday.\n');
  fs.writeFileSync(path.join(v, 'brain', '_index', 'SESSION.md'), '# Current Session Working Memory\n\n## Active Task\nzebra deploy\n');
  return v;
}
function run(v, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(os.tmpdir(), 'no-such-agenticos.json') },
  });
}

test('--warm builds recall-index.json and the wake file', () => {
  const v = vault();
  const r = run(v, ['--warm']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recall: indexed 1 docs/);
  const idx = JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'recall-index.json'), 'utf8'));
  assert.equal(idx.docCount, 1);
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-wake.md')));
});

test('a query prints ranked hits, building the index when it is missing', () => {
  const v = vault();
  const r = run(v, ['zebra', 'release', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const hits = JSON.parse(r.stdout);
  assert.equal(hits[0].path, 'brain/memory/reference/zebra-deploy.md');
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-index.json')));
  const text = run(v, ['zebra']);
  assert.match(text.stdout, /brain\/memory\/reference\/zebra-deploy\.md \(/);
});

test('no query and no --warm is a usage error', () => {
  const r = run(vault(), []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
