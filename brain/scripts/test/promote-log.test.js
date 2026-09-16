'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plog-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
process.env.BRAIN_VAULT = TMP;
const { TRAIL_PATH, appendTrail, readTrail, revertedSlugs } = require('../lib/promote-log.js');

beforeEach(() => { try { fs.unlinkSync(TRAIL_PATH); } catch {} });

test('append + read round-trips newest-first', () => {
  appendTrail({ session: 's1', action: 'written', slug: 'a', type: 'feedback', title: 'A' });
  appendTrail({ session: 's1', action: 'written', slug: 'b', type: 'user', title: 'B' });
  const rows = readTrail(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].slug, 'b');
  assert.ok(rows[0].ts);
});

test('readTrail tolerates a corrupt line', () => {
  appendTrail({ session: 's1', action: 'written', slug: 'a', type: 'feedback', title: 'A' });
  fs.appendFileSync(TRAIL_PATH, '{nope\n');
  assert.equal(readTrail(10).length, 1);
});

test('revertedSlugs collects every slug ever reverted', () => {
  appendTrail({ session: 's1', action: 'written', slug: 'a', type: 'feedback', title: 'A' });
  appendTrail({ session: 's2', action: 'reverted', slug: 'a', type: 'feedback', title: 'A' });
  assert.deepEqual([...revertedSlugs()], ['a']);
});
