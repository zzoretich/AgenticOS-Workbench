'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// BRAIN_VAULT must be set BEFORE graph-build.js (and paths.js beneath it) loads: the lock lives in its brain/_index.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-build-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = VAULT;
const GB = require('../graph-build.js');

// The same stand-in the CLI tests install through the fake uv (spec 2026-09-23-graphify §5).
const FAKE = path.resolve(__dirname, '..', '..', '..', 'cli', 'fixtures', 'fake-graphify.sh');
const OUT = path.join(VAULT, 'brain', 'graphify-out');
const LOG = path.join(VAULT, 'fake-graphify.log');
const KNOBS = ['FAKE_GRAPHIFY_EXIT', 'FAKE_GRAPHIFY_STDERR', 'FAKE_GRAPHIFY_SLEEP', 'ANTHROPIC_API_KEY'];

function rep() {
  return { counts: {}, wrote: [], status: null, reason: null,
    skip(r) { this.status = 'skipped'; this.reason = r; }, disable(r) { this.status = 'disabled'; this.reason = r; } };
}
const cfg = (over = {}) => ({ graph: { enabled: true, out: 'brain/graphify-out', timeoutSec: 30, bin: FAKE, ...over } });
const build = (c = cfg(), report = rep()) => GB.buildStructural({ report, cfg: c, vault: VAULT });

beforeEach(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.rmSync(LOG, { force: true });
  for (const k of KNOBS) delete process.env[k];
  process.env.FAKE_GRAPHIFY_LOG = LOG;
});

test('off, or no runnable graphify, is a disabled stage that never spawns', async () => {
  let r = rep();
  assert.deepEqual(await build(cfg({ enabled: false }), r), { status: 'disabled', reason: 'graph off' });
  assert.equal(r.status, 'disabled');
  r = rep();
  assert.deepEqual(await build(cfg({ bin: undefined }), r), { status: 'disabled', reason: 'graphify missing' });
  const plain = path.join(VAULT, 'not-executable');
  fs.writeFileSync(plain, '#!/bin/sh\n');
  assert.equal((await build(cfg({ bin: plain }))).reason, 'graphify missing');
  assert.ok(!fs.existsSync(LOG), 'graphify never ran');
});

test('a structural pass runs `update <vault>` into GRAPHIFY_OUT with backups off and writes the marker', async () => {
  const report = rep();
  const r = await build(cfg(), report);
  assert.equal(r.status, 'ok');
  assert.equal(r.out, OUT);
  assert.equal(r.nodes, 5);
  assert.equal(r.mode, 'structural');
  assert.equal(fs.readFileSync(LOG, 'utf8'), `update ${VAULT} | out=${OUT} nobackup=1 apikey=\n`);
  assert.deepEqual(report.counts, { nodes: 5, edges: 5, communities: 2 });
  assert.deepEqual(report.wrote, [path.join('brain', 'graphify-out', 'graph.json')]);
  const m = JSON.parse(fs.readFileSync(path.join(OUT, '.aos-graph.json'), 'utf8'));
  assert.equal(m.schema, 1);
  assert.equal(m.lastSemantic, null);
  assert.equal(m.builtAt, m.lastStructural);
  assert.ok(!fs.existsSync(path.join(OUT, 'graph.json.prev')), 'nothing to keep on the first run');
  await build();
  assert.ok(fs.existsSync(path.join(OUT, 'graph.json.prev')), 'the last good graph is kept before each run');
});

test('graphify never sees API keys, so its backend auto-detect cannot pick a paid backend', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  await build();
  assert.match(fs.readFileSync(LOG, 'utf8'), / apikey=\n$/);
  const env = GB.childEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', SOME_API_TOKEN: 'x', AWS_PROFILE: 'p', AZURE_OPENAI_ENDPOINT: 'e' }, '/o');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', GRAPHIFY_OUT: '/o', GRAPHIFY_NO_BACKUP: '1' });
});

test('a torn graph.json is deleted and rebuilt once (graphify refuses it even with --force)', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'graph.json'), 'x');
  const report = rep();
  const r = await build(cfg(), report);
  assert.equal(r.status, 'ok');
  assert.equal(report.counts.recovered, 1);
  assert.equal(fs.readFileSync(LOG, 'utf8').trim().split('\n').length, 2);
});

test('a failing graphify is an error with its last stderr line; an empty vault is a skip', async () => {
  process.env.FAKE_GRAPHIFY_EXIT = '3';
  process.env.FAKE_GRAPHIFY_STDERR = 'boom';
  await assert.rejects(build(), /graphify update exited 3: boom/);
  process.env.FAKE_GRAPHIFY_EXIT = '1';
  process.env.FAKE_GRAPHIFY_STDERR = 'No code files found - nothing to rebuild.';
  const report = rep();
  assert.deepEqual(await build(cfg(), report), { status: 'skipped', reason: 'nothing to graph' });
  assert.equal(report.status, 'skipped');
});

test('graph.timeoutSec kills a hung graphify', async () => {
  process.env.FAKE_GRAPHIFY_SLEEP = '5';
  await assert.rejects(build(cfg({ timeoutSec: 1 })), /graphify update timed out after 1s/);
});

test('a build already holding the lock makes this one a skip', async () => {
  fs.mkdirSync(GB.LOCK);
  try {
    const report = rep();
    assert.deepEqual(await build(cfg(), report), { status: 'skipped', reason: 'build running' });
    assert.equal(report.reason, 'build running');
    assert.ok(!fs.existsSync(LOG));
  } finally { fs.rmdirSync(GB.LOCK); }
});

test('a structural pass keeps the semantic stamp of an earlier model pass', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '.aos-graph.json'), JSON.stringify({ schema: 1, lastSemantic: '2026-09-22T00:00:00.000Z' }));
  const r = await build();
  assert.equal(r.mode, 'semantic');
  assert.equal(r.lastSemantic, '2026-09-22T00:00:00.000Z');
});
