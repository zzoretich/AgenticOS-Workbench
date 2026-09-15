'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pooledCalibration } = require('../cost-budget.js');

const CLEAN = { ts: '2026-06-05T00:00:00Z', prevTs: '2026-06-04T05:22:00Z',
                realDelta: 49.91, tgRawDelta: 149.98 };
const POISON_NEG = { ts: '2026-08-05T15:37:33Z', prevTs: '2026-06-05T00:00:00Z',
                     realDelta: -341.23, tgRawDelta: 7857.15 };
const POISON_XMONTH_POS = { ts: '2026-09-20T00:00:00Z', prevTs: '2026-08-05T15:37:33Z',
                            realDelta: 38.0, tgRawDelta: 900.0 };
const LEGACY_NO_PREVTS = { ts: '2026-06-05T00:00:00Z', realDelta: 49.91, tgRawDelta: 149.98 };

test('negative realDelta rows are excluded from the pool', () => {
  const p = pooledCalibration([CLEAN, POISON_NEG]);
  assert.equal(p.intervals, 1);
  assert.equal(p.value, Math.round((49.91 / 149.98) * 1e4) / 1e4);
});

test('cross-month intervals are excluded even with positive delta', () => {
  const p = pooledCalibration([CLEAN, POISON_XMONTH_POS]);
  assert.equal(p.intervals, 1);
});

test('legacy rows without prevTs still pool when delta is positive', () => {
  const p = pooledCalibration([LEGACY_NO_PREVTS]);
  assert.equal(p.intervals, 1);
});

test('all-poison ledger returns null (calibration left unchanged by caller)', () => {
  assert.equal(pooledCalibration([POISON_NEG]), null);
});

const fs = require('fs');
const path = require('path');
const { defaultBudget, readConfig, deriveState } = require('../cost-budget.js');

test('defaultBudget and readConfig take the monthly budget from cost.monthlyBudget', () => {
  const vault = process.env.BRAIN_VAULT || process.env.AOS_VAULT;
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ cost: { enabled: true, monthlyBudget: 150 } }));
  assert.equal(defaultBudget(), 150);
  const c = readConfig();
  assert.equal(c.budget, 150);
  assert.equal(deriveState(c).budget, 150);
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ cost: { enabled: true, monthlyBudget: null } }));
  assert.equal(defaultBudget(), 0);
  assert.equal(deriveState({ month: '', anchorUsd: 0, anchorAt: '', calibration: 1 }).budget, 0);
});
