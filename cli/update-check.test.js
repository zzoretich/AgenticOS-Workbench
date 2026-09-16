'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('./update-check.js');

// update-check.js resolves the vault and config from the environment, so a developer's exported
// AOS_CONFIG/AOS_VAULT would redirect this file's writes at their real vault
// (same class as cli/cost-cmd.test.js:10-13).
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;

test('cmpSemver orders releases and refuses what it cannot order', () => {
  assert.equal(U.cmpSemver('0.1.0', '0.1.0'), 0);
  assert.equal(U.cmpSemver('0.1.0', '0.1.1'), -1);
  assert.equal(U.cmpSemver('0.1.0', '0.2.0'), -1);
  assert.equal(U.cmpSemver('0.9.9', '1.0.0'), -1);
  assert.equal(U.cmpSemver('1.0.0', '0.9.9'), 1);
  assert.equal(U.cmpSemver('v1.2.3', '1.2.3'), 0, 'a leading v is accepted on either side');
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0'), -1, 'a prerelease precedes its release');
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(U.cmpSemver('1.0.0-alpha-1', '1.0.0'), -1, 'a hyphen inside the prerelease is not a separator');
  assert.equal(U.cmpSemver('nightly', '1.0.0'), null);
  assert.equal(U.cmpSemver('1.0', '1.0.0'), null, 'two-part versions are not orderable');
  assert.equal(U.cmpSemver(null, '1.0.0'), null);
});

test('parseTag normalises a release tag or refuses it', () => {
  assert.equal(U.parseTag('v0.2.0'), '0.2.0');
  assert.equal(U.parseTag('0.2.0'), '0.2.0');
  assert.equal(U.parseTag('v1.0.0-rc.1'), '1.0.0-rc.1');
  assert.equal(U.parseTag('nightly'), null);
  assert.equal(U.parseTag('v2-beta'), null);
  assert.equal(U.parseTag(''), null);
  assert.equal(U.parseTag(undefined), null);
});

test('lowerVersion implements the skew rule from design section 8', () => {
  assert.equal(U.lowerVersion('0.2.0', '0.1.0'), '0.1.0');
  assert.equal(U.lowerVersion('0.1.0', '0.2.0'), '0.1.0');
  assert.equal(U.lowerVersion('0.1.0', '0.1.0'), '0.1.0');
  assert.equal(U.lowerVersion(null, '0.1.0'), '0.1.0', 'an unobserved plugin version falls back to the vault');
  assert.equal(U.lowerVersion('0.1.0', null), '0.1.0');
  assert.equal(U.lowerVersion(null, null), null);
});
