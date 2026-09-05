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
