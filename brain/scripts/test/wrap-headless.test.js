'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderLastSession } = require('../sdk/wrap-headless.js');

const NEW_SECTION = '## Last Session\n- **Date**: 2026-08-06\n- **Auto-summary**: new summary\n';

test('renderLastSession replaces the section WITHOUT accumulating trailing blank lines', () => {
  const brain = '# BRAIN\n\n## Active context\n- stuff\n\n## Last Session\n- **Date**: 2026-08-01\n- **Auto-summary**: old\n' + '\n'.repeat(120);
  const out = renderLastSession(brain, NEW_SECTION);
  assert.ok(out.includes('- **Date**: 2026-08-06'));
  assert.ok(!out.includes('old'));
  assert.ok(!/\n{3,}$/.test(out), 'must not end with piles of blank lines');
  // idempotent: re-rendering does not grow the file
  assert.equal(renderLastSession(out, NEW_SECTION).length, out.length);
});
