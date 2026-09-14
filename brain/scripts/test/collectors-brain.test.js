'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// A private vault: the BRAIN_VAULT vault test/setup.js creates is shared by every test process of the run, so this test
// must not rewrite that vault's brain/config.json (a concurrent reader could momentarily see provider "auto").
// AOS_VAULT outranks BRAIN_VAULT in lib/paths.js, and setup.js never requires paths.js, so setting it before the first
// require below is enough — no require-cache surgery.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-brain-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ provider: 'none', dailyNote: { layout: '{yyyy}/{yyyy}-{MM}-{dd}.md' } }));
process.env.AOS_VAULT = VAULT;
const paths = require('../lib/paths.js');
const { collectBrain } = require('../collectors/brain.js');

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

test('collectBrain counts daily notes under a custom dailyNote.layout and sees today', () => {
  assert.equal(paths.VAULT, VAULT, 'the collector must read this test\'s private vault');
  for (const d of ['brain/memory/user', 'brain/memory/feedback', 'brain/memory/projects', 'brain/memory/reference', 'brain/patterns', 'brain/reflections', 'templates']) {
    fs.mkdirSync(path.join(VAULT, d), { recursive: true });
  }
  fs.writeFileSync(path.join(VAULT, 'MEMORY.md'), '# Memory Index\n');
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  for (const d of [today, yesterday]) {
    const dir = path.join(VAULT, String(d.getFullYear()));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ymd(d)}.md`), `# ${ymd(d)}\n`);
  }
  const b = collectBrain();
  assert.equal(b.counts.sessions, 2);
  assert.equal(b.sessions.today, `${ymd(today)}.md`);
  assert.equal(b.sessions.todayPresent, true);
  assert.equal(b.sessions.streak, 2);
  assert.equal(b.sessions.latestDate, ymd(today));
  assert.equal(b.sessions.oldestDate, ymd(yesterday));
});
