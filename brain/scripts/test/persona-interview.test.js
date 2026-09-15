'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const I = require('../persona/interview.js');

const TEMPLATES = path.join(__dirname, '..', '..', '..', 'vault-template', 'persona');
const ANSWERS = { name: 'Atlas', addressAs: 'boss', voice: 'dry, brief', priorities: 'shipping, tests', dutyModel: 'haiku', dutyEffort: 'medium', schedule: 'no' };

function configDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  fs.mkdirSync(path.join(root, 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Does demo things\n---\n');
  return root;
}
function vaultDir() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}

test('normalizeAnswers validates and coerces', () => {
  const a = I.normalizeAnswers(ANSWERS, { defaultModel: 'haiku' });
  assert.deepEqual(a.priorities, ['shipping', 'tests']);
  assert.equal(a.schedule, false);
  // execution amendment 2026-09-15 (A28): names are 2–40 chars, so the short fixtures are 'Ab', not 'A'.
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, { defaultModel: 'sonnet' }).dutyModel, 'sonnet');
  assert.equal(I.normalizeAnswers({ name: 'Ab' }, {}).schedule, true);
  assert.throws(() => I.normalizeAnswers({}, {}), /name is required/);
  assert.throws(() => I.normalizeAnswers({ name: 'Ab', dutyEffort: 'max' }, {}), /dutyEffort/);
  assert.throws(() => I.normalizeAnswers({ name: '../x' }, {}), /invalid agent name/);
  assert.throws(() => I.normalizeAnswers({ name: 'A' }, {}), /invalid agent name/);
});

test('writePersona renders the full layout from the templates', () => {
  const vault = vaultDir();
  const answers = I.normalizeAnswers(ANSWERS, {});
  const r = I.writePersona({ vault, configDir: configDir(), templatesDir: TEMPLATES, answers, node: '/opt/node/bin/node', now: new Date('2026-09-04T00:00:00Z') });
  const p = (rel) => fs.readFileSync(path.join(vault, 'persona', rel), 'utf8');
  assert.deepEqual(r.written.sort(), ['IDENTITY.md', 'PLAYBOOK.md', 'STATE.md', 'answers.json', 'autoapply.json', 'duties/monitor.md', 'duties/reflect.md', 'duties/sitrep.md', 'proposals/README.md'].sort());
  assert.match(p('IDENTITY.md'), /^# Atlas$/m);
  assert.match(p('IDENTITY.md'), /address the user as boss/);
  assert.match(p('IDENTITY.md'), /^updated: 2026-09-04$/m);
  assert.match(p('STATE.md'), /^# Persona State$/m);
  assert.match(p('STATE.md'), /## Flags\n\n## Priorities\n- shipping\n- tests\n/);
  assert.match(p('PLAYBOOK.md'), /^# Atlas PLAYBOOK — the front door$/m);
  assert.match(p('duties/sitrep.md'), new RegExp(`/opt/node/bin/node ${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/brain/scripts/persona/sitrep-state.js diff`));
  assert.match(p('duties/monitor.md'), /\{yyyy\}\/\{yyyy\}-\{MM\}-\{MMMM\}\/\{yyyy\}-\{MM\}-\{dd\}\.md/);
  assert.equal(JSON.parse(p('answers.json')).name, 'Atlas');
  assert.deepEqual(JSON.parse(p('autoapply.json')), { classes: [] });
  assert.ok(fs.statSync(path.join(vault, 'persona', 'journal', 'logs')).isDirectory());
  for (const rel of ['IDENTITY.md', 'STATE.md', 'duties/monitor.md', 'duties/reflect.md', 'duties/sitrep.md', 'proposals/README.md']) assert.ok(!p(rel).includes('{{'), `${rel} fully rendered`);
  assert.ok(!fs.existsSync(path.join(vault, 'persona', 'DISABLED')));
});

test('a prefilled re-run keeps STATE.md, PLAYBOOK.md and proposals/README.md but regenerates IDENTITY.md', () => {
  const vault = vaultDir(); const cfg = configDir();
  I.writePersona({ vault, configDir: cfg, templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}) });
  fs.appendFileSync(path.join(vault, 'persona', 'STATE.md'), '- [ ] keep me\n');
  const r = I.writePersona({ vault, configDir: cfg, templatesDir: TEMPLATES, answers: I.normalizeAnswers({ ...ANSWERS, voice: 'warmer' }, {}) });
  assert.deepEqual(r.kept.sort(), ['PLAYBOOK.md', 'STATE.md', 'autoapply.json', 'proposals/README.md']);
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'STATE.md'), 'utf8'), /keep me/);
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8'), /^warmer$/m);
});

test('renameAgent rewrites the name everywhere it was rendered', () => {
  const vault = vaultDir();
  I.writePersona({ vault, configDir: configDir(), templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}) });
  const r = I.renameAgent({ vault, newName: 'Beacon' });
  assert.equal(r.from, 'Atlas'); assert.equal(r.to, 'Beacon');
  assert.ok(r.changed.includes('IDENTITY.md') && r.changed.includes('PLAYBOOK.md') && r.changed.includes('duties/monitor.md'));
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'PLAYBOOK.md'), 'utf8'), /^# Beacon PLAYBOOK/m);
  assert.equal(I.currentName(vault), 'Beacon');
  assert.throws(() => I.renameAgent({ vault: vaultDir(), newName: 'X' }), /no persona to rename/);
});

test('ask() reads answers from a stream, applying defaults and prefill', async () => {
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  const p = I.ask({ defaultModel: 'haiku', exampleName: 'Atlas' }, { voice: 'terse' }, { input, output });
  for (const line of ['Atlas', '', '', 'docs', '', '', 'n']) input.write(line + '\n');
  const raw = await p;
  assert.equal(raw.name, 'Atlas');
  assert.equal(raw.addressAs, 'you');
  assert.equal(raw.voice, 'terse');
  assert.equal(raw.priorities, 'docs');
  assert.equal(raw.dutyModel, 'haiku');
  assert.equal(raw.schedule, 'n');
});

test('CLI --answers writes the layout and prints a JSON summary', () => {
  const vault = vaultDir();
  const file = path.join(vault, 'answers-in.json');
  fs.writeFileSync(file, JSON.stringify(ANSWERS));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'persona', 'interview.js'), '--vault', vault, '--config-dir', configDir(), '--templates', TEMPLATES, '--answers', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.schedule, false);
  assert.ok(out.written.includes('IDENTITY.md'));
  const usage = spawnSync(process.execPath, [path.join(__dirname, '..', 'persona', 'interview.js'), '--vault', vault, '--yes'], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: '' } });
  assert.equal(usage.status, 0, 'a second --yes run reuses persona/answers.json and finds the checkout templates without --templates');
  assert.equal(I.defaultTemplatesDir(), TEMPLATES, 'from the checkout the fallback is vault-template/persona');
});

test('CLI positional `rename <name>` (the launcher form, contract §4.3) renames without starting the interview', () => {
  const bin = path.join(__dirname, '..', 'persona', 'interview.js');
  const vault = vaultDir();
  I.writePersona({ vault, configDir: configDir(), templatesDir: TEMPLATES, answers: I.normalizeAnswers(ANSWERS, {}) });
  assert.deepEqual(I.positionals(['--vault', vault, 'rename', 'Beacon', '--yes']), ['rename', 'Beacon']);
  // stdin is closed (`input: ''`): if main() fell through to ask(), readline would end the process with exit 1, not 0.
  const r = spawnSync(process.execPath, [bin, '--vault', vault, 'rename', 'Beacon'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.from, 'Atlas'); assert.equal(out.to, 'Beacon');
  assert.ok(out.changed.includes('IDENTITY.md'));
  assert.match(fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  // The launcher passes no --vault; it exports AOS_VAULT (contract §4.1 step 4).
  const viaEnv = spawnSync(process.execPath, [bin, 'rename', 'Cairn'], { encoding: 'utf8', input: '', env: { ...process.env, AOS_VAULT: vault } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(I.currentName(vault), 'Cairn');
  const usage = spawnSync(process.execPath, [bin, '--vault', vault, 'rename'], { encoding: 'utf8', input: '' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: interview\.js \[--vault <dir>\] rename <name>/);
  const none = spawnSync(process.execPath, [bin, '--vault', vaultDir(), 'rename', 'X'], { encoding: 'utf8', input: '' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no persona to rename/);
});
