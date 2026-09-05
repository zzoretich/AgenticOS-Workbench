'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { markerPath, MARKER_DIR } = require('../lib/markers.js');
const { PATHS } = require('../lib/paths.js');

test('markers live under tmpdir/agenticos/<vault-key>, never inside the vault', () => {
  const p = markerPath('.injected-abc');
  assert.ok(p.startsWith(path.join(os.tmpdir(), 'agenticos')));
  assert.equal(path.dirname(p), MARKER_DIR);
  assert.ok(fs.existsSync(MARKER_DIR), 'dir is created on demand');
  assert.ok(!p.startsWith(PATHS.VAULT));
  assert.equal(path.basename(p), '.injected-abc');
});

test('marker names are sanitized', () => {
  assert.equal(path.basename(markerPath('.injected-../x y')), '.injected-.._x_y');
});

test('markerPath never throws even when the tmpdir is unwritable', () => {
  const original = fs.mkdirSync;
  fs.mkdirSync = () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); };
  try {
    assert.doesNotThrow(() => markerPath('.injected-ro'));
    assert.equal(markerPath('.injected-ro'), path.join(MARKER_DIR, '.injected-ro'));
  } finally {
    fs.mkdirSync = original;
  }
});
