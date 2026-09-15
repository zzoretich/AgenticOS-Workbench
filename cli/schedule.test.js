'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./schedule.js');

const VARS = S.scheduleVars({ vault: '/home/alice/AgenticOS', configDir: '/home/alice/.claude', node: '/usr/bin/node', model: 'haiku', effort: 'medium', agentName: 'Atlas', home: '/home/alice' });

test('scheduleVars derives the config path and log dir', () => {
  assert.equal(VARS.AOS_CONFIG, '/home/alice/.claude/agenticos.json');
  assert.equal(VARS.LOG_DIR, '/home/alice/AgenticOS/persona/journal/logs');
  assert.equal(VARS.AGENT_NAME, 'Atlas');
});

test('renderLaunchd fills every placeholder for each duty', () => {
  for (const duty of S.DUTIES) {
    const xml = S.renderLaunchd(duty, VARS);
    assert.match(xml, new RegExp(`<string>com\\.agenticos\\.${duty}</string>`));
    assert.match(xml, /<string>\/home\/alice\/AgenticOS\/brain\/scripts\/persona\/run-duty\.sh<\/string>/);
    assert.match(xml, /<key>PERSONA_NAME<\/key><string>Atlas<\/string>/);
    assert.ok(!xml.includes('{{'), `${duty}: no unrendered placeholder`);
  }
  assert.match(S.renderLaunchd('sitrep', VARS), /<key>Weekday<\/key><integer>5<\/integer>/);
  // execution amendment 2026-09-15 (A30): substituted values are XML-escaped in the plist (cron stays raw).
  assert.match(S.renderLaunchd('monitor', { ...VARS, AGENT_NAME: 'R&D <lab>' }), /<key>PERSONA_NAME<\/key><string>R&amp;D &lt;lab&gt;<\/string>/);
  assert.ok(S.renderCron({ ...VARS, AGENT_NAME: 'R&D' }).includes('PERSONA_NAME=R&D'));
});

test('renderCron yields three lines, each ending with the com.agenticos.<duty> marker', () => {
  assert.equal(S.CRON_TAG, '# com.agenticos.');
  const lines = S.renderCron(VARS).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const duty of S.DUTIES) assert.ok(lines.some(l => l.endsWith(`${S.CRON_TAG}${duty}`) && l.includes(`run-duty.sh ${duty}`)), duty);
  assert.ok(lines.every(l => /# com\.agenticos\.(monitor|reflect|sitrep)$/.test(l)), 'every line ends with a duty label Plan 3\'s DUTY_CRON_RE accepts');
  assert.ok(!lines.join('').includes('{{'));
});

test('stripAgenticosCron removes only lines carrying the marker', () => {
  const text = '0 1 * * * echo keep-me\n0 2 * * * old # com.agenticos.monitor\n# a comment about agenticos that stays\n';
  assert.equal(S.stripAgenticosCron(text), '0 1 * * * echo keep-me\n# a comment about agenticos that stays');
});

test('installSchedules on darwin writes three plists and (re)loads them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  const vars = { ...VARS, LOG_DIR: path.join(dir, 'logs') };
  const calls = [];
  // execution amendment 2026-09-15 (A30): a failing `launchctl load` is reported, never thrown — the reflect load fails here.
  const exec = (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === 'load' && args[1].endsWith('com.agenticos.reflect.plist')) throw new Error('boom'); };
  const warnings = [];
  const r = S.installSchedules({ platform: 'darwin', vars, launchAgentsDir: dir, exec, warn: (m) => warnings.push(m) });
  assert.deepEqual(r.written.map(p => path.basename(p)).sort(), ['com.agenticos.monitor.plist', 'com.agenticos.reflect.plist', 'com.agenticos.sitrep.plist']);
  assert.equal(calls.filter(c => c[1] === 'load').length, 3);
  assert.deepEqual(r.warnings, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /launchctl load .*com\.agenticos\.reflect\.plist: boom/);
  assert.ok(fs.existsSync(path.join(dir, 'logs')), 'log dir created');
  assert.equal(S.isInstalled({ platform: 'darwin', launchAgentsDir: dir }), true);
  const rm = S.removeSchedules({ platform: 'darwin', launchAgentsDir: dir, exec: (cmd, args) => calls.push([cmd, ...args]) });
  assert.equal(rm.removed.length, 3);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.plist')).length, 0);
  assert.equal(S.isInstalled({ platform: 'darwin', launchAgentsDir: dir }), false);
});

test('installSchedules on linux merges into the existing crontab without duplicates; remove strips only our lines', () => {
  let crontab = '0 1 * * * echo keep-me\n0 2 * * * old-line # com.agenticos.monitor\n';
  // execution amendment 2026-09-15 (A10): launchAgentsDir is injected — removeSchedules deletes duty plists on EVERY
  // platform, so without it this test would unlink from the real ~/Library/LaunchAgents. No schedule test may ever
  // resolve the real dir or the real crontab.
  const io = { launchAgentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'la-lin-')), readCrontab: () => crontab, writeCrontab: (t) => { crontab = t; } };
  const vars = { ...VARS, LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cron-logs-')) };
  S.installSchedules({ platform: 'linux', vars, ...io });
  const lines = crontab.trim().split('\n');
  assert.equal(lines[0], '0 1 * * * echo keep-me');
  assert.equal(lines.filter(l => l.includes(S.CRON_TAG)).length, 3);
  assert.ok(!crontab.includes('old-line'));
  assert.equal(S.isInstalled({ platform: 'linux', ...io }), true);
  S.removeSchedules({ platform: 'linux', ...io });
  assert.equal(crontab.trim(), '0 1 * * * echo keep-me');

  // execution amendment 2026-09-15 (A56): a failed `crontab -l` (not "no crontab") must never be treated as
  // empty — no readCrontab/writeCrontab injected here, so the real readCrontabWith/writeCrontabWith seams run
  // through this fake exec.
  {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === '-l') throw Object.assign(new Error('crontab: permission denied'), { stderr: 'crontab: permission denied', status: 1 });
      return '';
    };
    const warnings = [];
    const vars2 = { ...VARS, LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cron-logs-')) };
    const r = S.installSchedules({ platform: 'linux', vars: vars2, launchAgentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'la-lin-')), exec, warn: (m) => warnings.push(m) });
    assert.ok(!calls.some(c => c[1] === '-'), 'no crontab - call recorded');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /crontab -l failed/);
    assert.deepEqual(r.warnings, warnings);
    assert.equal(r.written.length, 0, 'no cron entry written');
  }

  // A genuine "no crontab for <user>" IS empty — the three duty lines are written.
  {
    let writeInput = null;
    const exec = (cmd, args, opts) => {
      if (args[0] === '-l') throw Object.assign(new Error('no crontab for atlas'), { stderr: 'no crontab for atlas', status: 1 });
      if (args[0] === '-') { writeInput = opts && opts.input; }
      return '';
    };
    const vars3 = { ...VARS, LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cron-logs-')) };
    const r = S.installSchedules({ platform: 'linux', vars: vars3, launchAgentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'la-lin-')), exec });
    assert.equal(r.warnings.length, 0);
    assert.equal(r.written.length, 1);
    const writtenLines = writeInput.trim().split('\n');
    assert.equal(writtenLines.length, 3);
    for (const duty of S.DUTIES) assert.ok(writtenLines.some(l => l.endsWith(`${S.CRON_TAG}${duty}`)), duty);
  }

  // execution amendment 2026-09-15 (A57): a failing `crontab -` on removeSchedules is reported, never thrown —
  // `aos uninstall` must finish its teardown.
  {
    const existingCrontab = `0 9 * * * echo mine\n${S.renderCron(VARS).trim()}\n`;
    const exec = (cmd, args) => {
      if (args[0] === '-l') return existingCrontab;
      if (args[0] === '-') throw Object.assign(new Error('crontab: /var/spool/cron: Permission denied'), { status: 1 });
      return '';
    };
    const rm = S.removeSchedules({ platform: 'linux', launchAgentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'la-lin-')), exec });
    assert.equal(rm.warnings.length, 1);
    assert.match(rm.warnings[0], /crontab - failed/);
  }
});

test('unsupported platforms install nothing and say so', () => {
  // launchAgentsDir injected for uniformity (execution amendment 2026-09-15, A10) — never the real dir.
  const r = S.installSchedules({ platform: 'win32', vars: { ...VARS, LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'w-')) }, launchAgentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'la-win-')) });
  assert.deepEqual(r.written, []);
  assert.equal(r.unsupported, true);
});

test('removeSchedules deletes the three duty plists on any platform (Plan 3 uninstall test on ubuntu) and never the Ollama supervisor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-'));
  for (const f of ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist', 'com.agenticos.ollama.plist']) fs.writeFileSync(path.join(dir, f), '<plist/>\n');
  const calls = [];
  const rm = S.removeSchedules({ platform: 'linux', launchAgentsDir: dir, exec: (cmd, args) => { calls.push([cmd, ...args]); return ''; }, readCrontab: () => '', writeCrontab: () => { throw new Error('no crontab write expected'); } });
  assert.deepEqual(rm.removed.map(p => path.basename(p)).sort(), ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist']);
  assert.ok(fs.existsSync(path.join(dir, 'com.agenticos.ollama.plist')), 'com.agenticos.ollama is Plan 2\'s, installed by hand');
  assert.equal(calls.filter(c => c[0] === 'launchctl').length, 0, 'launchctl only runs on darwin');
});
