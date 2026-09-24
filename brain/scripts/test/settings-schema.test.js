'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/settings-schema.js');

const settable = S.SETTINGS.filter((e) => !e.machine);

test('drift (D3): every default has a setting, and every setting but the machine keys has a default', () => {
  const leaves = S.leafKeys(S.DEFAULTS);
  assert.deepEqual(leaves.filter((k) => !S.entry(k)), [], 'config.default.json keys with no schema entry');
  assert.deepEqual(settable.filter((e) => !leaves.includes(e.key)).map((e) => e.key), [], 'schema entries with no default');
});

test('every default passes its own entry, and every entry is well formed', () => {
  const sections = new Set(S.SECTIONS.map((s) => s.id));
  const keys = new Set();
  for (const e of S.SETTINGS) {
    assert.ok(!keys.has(e.key), `${e.key} listed twice`);
    keys.add(e.key);
    assert.ok(sections.has(e.section), `${e.key}: unknown section ${e.section}`);
    assert.ok(e.label && e.help && e.applies, `${e.key}: label, help and applies are required`);
    assert.ok(['bool', 'enum', 'number', 'string', 'model', 'list', 'object'].includes(e.type), `${e.key}: type ${e.type}`);
    if (e.type === 'enum') assert.ok(Array.isArray(e.values) && e.values.length, `${e.key}: enum without values`);
    if (e.readonly) assert.ok(e.how, `${e.key}: a read-only key names the command that changes it`);
  }
  for (const e of settable) assert.equal(S.validate(e, S.defaultOf(e)), null, `${e.key} default ${JSON.stringify(S.defaultOf(e))}`);
});

test('defaultOf never hands out the shipped defaults by reference', () => {
  const e = S.entry('recallRoots');
  S.defaultOf(e).push('mutated');
  assert.ok(!S.DEFAULTS.recallRoots.includes('mutated'));
  assert.equal(S.defaultOf(S.entry('vault')), undefined, 'a machine key has no default');
});

test('parseValue: each type from CLI text', () => {
  assert.equal(S.parseValue(S.entry('telemetry.enabled'), 'off'), false);
  assert.equal(S.parseValue(S.entry('telemetry.enabled'), 'TRUE'), true);
  assert.throws(() => S.parseValue(S.entry('telemetry.enabled'), 'maybe'), /telemetry\.enabled takes true or false/);
  assert.equal(S.parseValue(S.entry('provider'), 'codex'), 'codex');
  assert.throws(() => S.parseValue(S.entry('provider'), 'gpt'), /provider takes auto \| ollama \| claude \| codex \| none/);
  assert.equal(S.parseValue(S.entry('graph.semantic.enabled'), 'auto'), 'auto');
  assert.equal(S.parseValue(S.entry('graph.semantic.enabled'), 'on'), true, 'a mixed enum takes a boolean word');
  assert.equal(S.parseValue(S.entry('claude.perDayUsd'), '1.5'), 1.5);
  assert.throws(() => S.parseValue(S.entry('claude.perDayUsd'), ''), /takes a number/);
  assert.throws(() => S.parseValue(S.entry('claude.perDayUsd'), 'lots'), /takes a number/);
  assert.equal(S.parseValue(S.entry('codex.model'), 'null'), null, 'null on a nullable key');
  assert.equal(S.parseValue(S.entry('claude.model'), 'null'), 'null', 'a non-nullable model keeps the text (validate decides)');
  assert.deepEqual(S.parseValue(S.entry('recallRoots'), '["brain/memory"]'), ['brain/memory']);
  assert.throws(() => S.parseValue(S.entry('recallRoots'), 'brain/memory'), /takes JSON/);
  assert.deepEqual(S.parseValue(S.entry('roster.orchestrators'), '{"a":{}}'), { a: {} });
  assert.equal(S.parseValue(S.entry('dailyNote.layout'), ' {yyyy}.md '), '{yyyy}.md');
});

test('validate: bounds, zero caps (D10), nulls, lists and objects', () => {
  const v = (k, x) => S.validate(S.entry(k), x);
  assert.match(v('claude.perCallUsd', 0), /must be more than 0.*perDayUsd to 0/);
  assert.equal(v('claude.perDayUsd', 0), null, 'a daily cap of 0 means no spend');
  assert.match(v('claude.perDayUsd', -1), /at least 0/);
  assert.match(v('ollama.port', 70000), /at most 65535/);
  assert.match(v('persona.autoapply.minVerified', 1.5), /whole number/);
  assert.match(v('persona.autoapply.minVerified', 0), /at least 1/);
  assert.equal(v('cost.monthlyBudget', null), null);
  assert.match(v('claude.model', null), /cannot be null/);
  assert.match(v('claude.model', '  '), /non-empty/);
  assert.match(v('recallRoots', ['a', 1]), /list of strings/);
  assert.match(v('roster.orchestrators', []), /JSON object/);
  assert.match(v('codex.effort', 'max'), /must be one of/);
  assert.equal(v('crossReview.effort', 'max'), null);
});

test('dayCap (D10): 0 stays 0; only a missing, empty or non-numeric value takes the default', () => {
  assert.equal(S.dayCap(0, 5), 0);
  assert.equal(S.dayCap('0', 5), 0);
  assert.equal(S.dayCap(2.5, 5), 2.5);
  assert.equal(S.dayCap('3', 5), 3);
  for (const bad of [undefined, null, '', ' ', 'x', -1, NaN, Infinity, true, {}]) assert.equal(S.dayCap(bad, 5), 5, JSON.stringify(bad));
});

test('isPrefix and the machine keys: hosts and binaries are read-only, never in the defaults', () => {
  assert.equal(S.isPrefix('graph.semantic'), true);
  assert.equal(S.isPrefix('hosts'), true);
  assert.equal(S.isPrefix('graph.semantic.enabled'), false);
  for (const k of ['vault', 'node', 'hosts.codex.enabled', 'claude.bin']) {
    assert.equal(S.entry(k).readonly, true, k);
    assert.equal(S.getPath(S.DEFAULTS, k), undefined, k);
  }
});
