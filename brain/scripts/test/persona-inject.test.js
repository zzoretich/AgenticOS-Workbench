'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'inject-context.js');
let n = 0;

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(v, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'IDENTITY.md'), '# Atlas\nvoice: dry\n');
  fs.writeFileSync(path.join(v, 'persona', 'STATE.md'), '# Persona State\n## Flags\n');
  fs.writeFileSync(path.join(v, 'brain', '_index', 'BRAIN.md'), '# BRAIN\n');
  return v;
}
/** Runs the hook against vault `v`. `cfgPath` (execution amendment 2026-09-15, A9) is the agenticos.json the hook
 *  should read; by default a path that does not exist, so only brain/config.json and the defaults apply. */
function run(v, cfgPath = path.join(v, 'no-agenticos.json')) {
  const env = { ...process.env, AOS_VAULT: v, AOS_CONFIG: cfgPath };
  delete env.AOS_HEADLESS; delete env.BRAIN_VAULT;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: `persona-inject-${process.pid}-${n++}` }), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the persona block is injected with the identity and state', () => {
  const out = run(vault());
  assert.match(out, /<persona>\n# Atlas\n/);
  assert.match(out, /# Persona State/);
  assert.match(out, /<\/persona>\n<brain-context>/);
});

test('persona/DISABLED suppresses the block but not the brain context', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'persona', 'DISABLED'), 'x');
  const out = run(v);
  assert.ok(!out.includes('<persona>'));
  assert.match(out, /<brain-context>/);
});

test('persona.enabled=false in brain/config.json suppresses the block when no agenticos.json overrides it', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ persona: { enabled: false } }));
  const out = run(v);
  assert.ok(!out.includes('<persona>'));
  assert.match(out, /<brain-context>/);
});

// execution amendment 2026-09-15 (A9): the switch users actually reach. lib/config.js merges agenticos.json LAST and
// `aos init` pins persona.enabled=true there, so the real off-switch is agenticos.json — proven here with a
// brain/config.json that says true and an agenticos.json that says false.
test('persona.enabled=false in agenticos.json (merged last; the file aos init writes) suppresses the block', () => {
  const v = vault();
  const cfgPath = path.join(v, 'agenticos.json');
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ persona: { enabled: true } }));
  fs.writeFileSync(cfgPath, JSON.stringify({ persona: { enabled: false } }));
  const out = run(v, cfgPath);
  assert.ok(!out.includes('<persona>'), 'agenticos.json wins over brain/config.json');
  assert.match(out, /<brain-context>/);
});

// final review Minor 11 (tests-5): every case above is satisfied by an or-of-falses gate as well as by
// last-wins, because no case has the two files disagreeing in THIS direction. lib/config.js merges
// agenticos.json LAST, so a `true` there must beat a `false` in brain/config.json and inject the block.
test('persona.enabled=true in agenticos.json overrides false in brain/config.json (last wins, not an or-of-falses)', () => {
  const v = vault();
  const cfgPath = path.join(v, 'agenticos.json');
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ persona: { enabled: false } }));
  fs.writeFileSync(cfgPath, JSON.stringify({ persona: { enabled: true } }));
  const out = run(v, cfgPath);
  assert.match(out, /<persona>\n# Atlas\n/, 'agenticos.json wins over brain/config.json in both directions');
  assert.match(out, /<brain-context>/);
});
