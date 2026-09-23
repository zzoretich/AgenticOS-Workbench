'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PATHS } = require('../lib/paths.js');
const brain = require('../sdk/lib/brain.js');

test('readMemory reads inside the vault and refuses siblings, .., absolute paths elsewhere and symlinks out', () => {
  const vault = PATHS.VAULT;
  fs.mkdirSync(path.join(vault, 'brain', 'memory', 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'memory', 'feedback', 'ok.md'), 'inside\n');
  fs.writeFileSync(path.join(vault, '..dotted.md'), 'still inside\n');
  const sibling = `${vault}-Workbench`;
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret.md'), 'sibling\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside\n');
  fs.symlinkSync(outside, path.join(vault, 'brain', 'link-out'));

  assert.equal(brain.readMemory('brain/memory/feedback/ok.md'), 'inside\n');
  assert.equal(brain.readMemory(path.join(vault, 'brain', 'memory', 'feedback', 'ok.md')), 'inside\n');
  assert.equal(brain.readMemory('..dotted.md'), 'still inside\n');
  assert.equal(brain.readMemory(path.join(sibling, 'secret.md')), null, 'a sibling sharing the vault name prefix');
  assert.equal(brain.readMemory(`../${path.basename(sibling)}/secret.md`), null);
  assert.equal(brain.readMemory(path.join(outside, 'secret.md')), null);
  assert.equal(brain.readMemory('brain/link-out/secret.md'), null, 'a symlink out of the vault');
  assert.equal(brain.readMemory(''), null);
  assert.equal(brain.readMemory('.'), null);
});
