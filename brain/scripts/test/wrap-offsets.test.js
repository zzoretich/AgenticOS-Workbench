'use strict';
// lib/wrap-offsets.js: how much of each session auto-wrap already extracted (spec 2026-09-24-no-duplicate-sessions D3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { wrappedChars, unwrappedPart, hasNewDialogue, markWrapped, KEEP } = require('../lib/wrap-offsets.js');

const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woff-')), 'agent-runs', 'wrap-offsets.json');

test('markWrapped records an offset per session and wrappedChars reads it back', () => {
  assert.equal(wrappedChars('s1', { file: FILE }), 0);
  assert.equal(markWrapped('s1', 120, { file: FILE }), true);
  assert.equal(wrappedChars('s1', { file: FILE }), 120);
  assert.equal(wrappedChars('s2', { file: FILE }), 0);
  assert.equal(wrappedChars('', { file: FILE }), 0);
  assert.equal(markWrapped('', 5, { file: FILE }), false);
  assert.equal(markWrapped('s3', -1, { file: FILE }), false);
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).schema, 1);
  assert.ok(!fs.readdirSync(path.dirname(FILE)).some((n) => n.endsWith('.tmp')), 'no temp file left behind');
});

test('an unreadable store reads as empty and is replaced on the next mark', () => {
  const file = path.join(path.dirname(FILE), 'broken.json');
  fs.writeFileSync(file, 'not json');
  assert.equal(wrappedChars('s1', { file }), 0);
  assert.equal(markWrapped('s1', 9, { file }), true);
  assert.equal(wrappedChars('s1', { file }), 9);
});

test('unwrappedPart is what follows the offset, or all of it when the transcript started over', () => {
  const text = 'user: a\nassistant: b\nuser: c';
  assert.equal(unwrappedPart(text, 0), text);
  assert.equal(unwrappedPart(text, 'user: a\nassistant: b'.length), '\nuser: c');
  assert.equal(unwrappedPart(text, text.length), '');
  assert.equal(unwrappedPart('user: short', 999), 'user: short');
});

test('hasNewDialogue needs a user line with text', () => {
  assert.equal(hasNewDialogue('\nuser: c'), true);
  assert.equal(hasNewDialogue('user: first'), true);
  assert.equal(hasNewDialogue('assistant: only me\n'), false);
  assert.equal(hasNewDialogue(''), false);
  assert.equal(hasNewDialogue('user: '), false);
});

test('the store keeps only the newest sessions', () => {
  const file = path.join(path.dirname(FILE), 'keep.json');
  const sessions = {};
  for (let i = 0; i < KEEP; i++) sessions[`old-${i}`] = { chars: 1, at: new Date(2026, 0, 1, 0, 0, i).toISOString() };
  fs.writeFileSync(file, JSON.stringify({ schema: 1, sessions }));
  markWrapped('new', 7, { file, now: new Date(2026, 8, 24) });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(j.sessions).length, KEEP);
  assert.equal(j.sessions.new.chars, 7);
  assert.equal(j.sessions['old-0'], undefined, 'the oldest one went');
});
