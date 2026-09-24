'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS_MOD = require.resolve('../lib/paths.js');
const CONFIG_MOD = require.resolve('../lib/config.js');
function fresh() { delete require.cache[PATHS_MOD]; delete require.cache[CONFIG_MOD]; return require(CONFIG_MOD); }

let v;
beforeEach(() => {
  v = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgv-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  process.env.AOS_VAULT = v;
  process.env.AOS_CONFIG = path.join(os.tmpdir(), 'no-such-agenticos.json');
});

test('loadConfig returns the shipped defaults when the vault has no config.json', () => {
  const { loadConfig, DEFAULTS } = fresh();
  assert.deepEqual(loadConfig(), DEFAULTS);
  assert.equal(DEFAULTS.dailyNote.layout, '{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md');
  assert.deepEqual(DEFAULTS.roster.orchestrators, {});
  assert.equal(DEFAULTS.scan.autoSweepOrphans, false);
});

test('vault config.json overrides defaults by deep merge', () => {
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({
    scan: { fileMapBudget: 5 },
    roster: { orchestrators: { Planner: { nickname: 'PLAN', trigger: '/plan' } } },
  }));
  const cfg = fresh().loadConfig();
  assert.equal(cfg.scan.fileMapBudget, 5);
  assert.equal(cfg.scan.embedBudget, 40);
  assert.equal(cfg.roster.orchestrators.Planner.nickname, 'PLAN');
});

test('agenticos.json overrides vault config', () => {
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'ollama' }));
  const file = path.join(os.tmpdir(), `aos-cfg-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ vault: v, provider: 'none' }));
  process.env.AOS_CONFIG = file;
  assert.equal(fresh().loadConfig().provider, 'none');
});

test('mutating the returned config does not leak into DEFAULTS or a later loadConfig()', () => {
  const { loadConfig, DEFAULTS } = fresh();
  const cfg = loadConfig();
  cfg.scan.fileMapBudget = 999;
  cfg.roster.orchestrators.Injected = { nickname: 'X' };
  cfg.recallRoots.push('mutated');
  assert.equal(DEFAULTS.scan.fileMapBudget, 40);
  assert.deepEqual(DEFAULTS.roster.orchestrators, {});
  assert.equal(DEFAULTS.recallRoots.length, 4);
  assert.deepEqual(loadConfig(), DEFAULTS);
});
