'use strict';
// Shared files written from several processes at once lose nothing (spec 2026-09-24-locked-writers D2, D3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(VAULT, 'MEMORY.md'), '# Index\n\n## Reference\n');
const LIB = path.join(__dirname, '..', 'lib');

function runChildren(count, code) {
  return Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, String(i)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AOS_VAULT: VAULT } });
    let err = '';
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (status) => (status === 0 ? resolve() : reject(new Error(`child ${i} exited ${status}: ${err}`))));
  })));
}

test('routines that record their runs at the same time all keep their entry (patchState)', async () => {
  const file = path.join(VAULT, 'brain', '_index', 'routines.json');
  const code = `const store = require(${JSON.stringify(path.join(LIB, 'routines-store.js'))}); const slug = 'r' + process.argv[1];
    for (let i = 0; i < 25; i++) store.patchState(slug, (e) => ({ ...e, failStreak: (e.failStreak || 0) + 1 }), { file: ${JSON.stringify(file)} });`;
  await runChildren(3, code);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(st.routines).sort(), ['r0', 'r1', 'r2']);
  for (const slug of ['r0', 'r1', 'r2']) assert.equal(st.routines[slug].failStreak, 25, slug);
});

test('memories written at the same time all get their MEMORY.md line (writeMemory)', async () => {
  const code = `const { writeMemory } = require(${JSON.stringify(path.join(LIB, 'memory-writer.js'))}); const me = process.argv[1];
    for (let i = 0; i < 10; i++) writeMemory({ type: 'reference', title: 'note ' + me + ' ' + i, description: 'd', body: 'b' });`;
  await runChildren(3, code);
  const lines = fs.readFileSync(path.join(VAULT, 'MEMORY.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ['));
  assert.equal(lines.length, 30);
  assert.deepEqual(fs.readdirSync(VAULT).filter((n) => n.endsWith('.lock') || n.endsWith('.tmp')), []);
});
