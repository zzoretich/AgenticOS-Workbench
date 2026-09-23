'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./persona-cmd.js');
// execution amendment 2026-09-15 (A12): resolveCtx reads AOS_VAULT before cfg.vault and readAgenticos reads AOS_CONFIG before
// the passed configDir, so an exported value would point every test at the real ~/.claude (cli/aos.test.js:35 does the same).
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT;

const ANSWERS = { name: 'Atlas', addressAs: 'boss', voice: 'dry', priorities: 'docs', dutyModel: 'haiku', dutyEffort: 'medium', schedule: 'yes' };

function world() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ version: '0.1.0', vault, node: '/usr/bin/node', claudeConfigDir: configDir, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 }, cost: { enabled: false }, persona: { enabled: true } }));
  const answersFile = path.join(vault, 'in.json');
  fs.writeFileSync(answersFile, JSON.stringify(ANSWERS));
  const logs = []; const io = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  return { configDir, vault, answersFile, io, logs };
}

test('resolveCtx reads vault, node and default model from agenticos.json', () => {
  const w = world();
  const ctx = P.resolveCtx({ configDir: w.configDir });
  assert.equal(ctx.vault, w.vault); assert.equal(ctx.node, '/usr/bin/node'); assert.equal(ctx.defaultModel, 'haiku');
  assert.throws(() => P.resolveCtx({ configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nocfg-')) }), /aos init/);
});

test('runInterview with an answers file writes the persona and installs schedules', async () => {
  const w = world(); const calls = [];
  const r = await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, platform: 'darwin',
    installSchedules: (o) => { calls.push(o); o.warn('launchctl load com.agenticos.reflect.plist: boom'); return { platform: 'darwin', written: ['x'], labels: ['com.agenticos.monitor'], warnings: ['launchctl load com.agenticos.reflect.plist: boom'] }; } });
  assert.equal(r.answers.name, 'Atlas');
  assert.match(fs.readFileSync(path.join(w.vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Atlas$/m);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].vars.AGENT_NAME, 'Atlas');
  assert.equal(calls[0].vars.NODE, '/usr/bin/node');
  assert.equal(calls[0].vars.AOS_CONFIG, path.join(w.configDir, 'agenticos.json'));
  assert.ok(w.logs.some(l => /scheduled com\.agenticos\.monitor/.test(l)));
  // execution amendment 2026-09-15 (A30 carry-in): schedule.js's launchctl warnings reach the caller's io seam, not a bare stderr line.
  assert.ok(w.logs.includes('ERR warning: launchctl load com.agenticos.reflect.plist: boom'), 'installSchedules warn → io.error');
});

test('schedule "no" (or schedule:false option) skips scheduling; dry-run writes nothing', async () => {
  const w = world(); let called = 0;
  fs.writeFileSync(w.answersFile, JSON.stringify({ ...ANSWERS, schedule: 'no' }));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, installSchedules: () => { called++; } });
  assert.equal(called, 0);
  const w2 = world();
  const r = await P.runInterview({ configDir: w2.configDir, answersFile: w2.answersFile, io: w2.io, dryRun: true, installSchedules: () => { called++; } });
  assert.equal(r.dryRun, true);
  assert.ok(!fs.existsSync(path.join(w2.vault, 'persona')));
  assert.equal(called, 0);
});

test('run(): off/on toggle DISABLED; rename rewrites and re-renders installed schedules; usage errors exit 2', async () => {
  const w = world();
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  assert.equal(await P.run(['off'], { configDir: w.configDir, io: w.io }), 0);
  assert.ok(fs.existsSync(path.join(w.vault, 'persona', 'DISABLED')));
  assert.equal(await P.run(['on'], { configDir: w.configDir, io: w.io }), 0);
  assert.ok(!fs.existsSync(path.join(w.vault, 'persona', 'DISABLED')));
  let rerendered = null;
  assert.equal(await P.run(['rename', 'Beacon'], { configDir: w.configDir, io: w.io, isInstalled: () => true, installSchedules: (o) => { rerendered = o.vars.AGENT_NAME; return { written: [], labels: [] }; } }), 0);
  assert.match(fs.readFileSync(path.join(w.vault, 'persona', 'IDENTITY.md'), 'utf8'), /^# Beacon$/m);
  assert.equal(rerendered, 'Beacon');
  assert.equal(await P.run(['rename'], { configDir: w.configDir, io: w.io }), 2);
  assert.equal(await P.run(['bogus'], { configDir: w.configDir, io: w.io }), 2);
});

test('run() with --yes (or a non-TTY stdin) and no stored answers skips the interview with exit 1 and never blocks on readline', async () => {
  const w = world();
  assert.equal(await P.run(['--yes'], { configDir: w.configDir, io: w.io }), 1);
  assert.ok(w.logs.some(l => /no --persona-json and no terminal/.test(l) && /answers\.json/.test(l)));
  const r = await P.runInterview({ configDir: w.configDir, io: w.io });   // node --test: stdin is a pipe, not a TTY
  assert.equal(r.skipped, true);
  assert.ok(!fs.existsSync(path.join(w.vault, 'persona')));
});

test('runInterview with --yes reuses persona/answers.json (non-interactive re-run)', async () => {
  const w = world();
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  const r = await P.runInterview({ configDir: w.configDir, yes: true, io: w.io, schedule: false });
  assert.equal(r.answers.name, 'Atlas');
  assert.ok(r.kept.includes('STATE.md'));
});

test('on a Codex host the interview asks for the Codex duty model and stores it as persona.codexModel (lib/headless.js reads it)', async () => {
  const w = world();
  const cfgFile = path.join(w.configDir, 'agenticos.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), hosts: { codex: { enabled: true } } }));
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ persona: { runner: 'codex' } }));
  fs.writeFileSync(w.answersFile, JSON.stringify({ ...ANSWERS, dutyCodexModel: 'gpt-5' }));
  await P.runInterview({ configDir: w.configDir, answersFile: w.answersFile, io: w.io, schedule: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.vault, 'brain', 'config.json'), 'utf8')).persona, { runner: 'codex', codexModel: 'gpt-5' });
  const w2 = world();   // no Codex host: brain/config.json is left alone
  await P.runInterview({ configDir: w2.configDir, answersFile: w2.answersFile, io: w2.io, schedule: false });
  assert.ok(!fs.existsSync(path.join(w2.vault, 'brain', 'config.json')));
});
