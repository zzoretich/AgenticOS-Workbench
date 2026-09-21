'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentJson } = require('../sdk/lib/json-extract.js');

test('parses clean JSON directly', () => {
  assert.deepEqual(parseAgentJson('{"a":1}'), { a: 1 });
});

test('parses JSON with raw newlines and tabs inside string literals', () => {
  // the qwen3.5 workhorse emits multi-line "body" values with literal control characters,
  // which strict JSON.parse rejects ("Bad control character in string literal").
  const raw = '{"title": "x",\n "body": "line one\nline two\ttabbed"}';
  const obj = parseAgentJson(raw);
  assert.equal(obj.body, 'line one\nline two\ttabbed');
});

test('raw newlines OUTSIDE strings stay ordinary formatting', () => {
  assert.deepEqual(parseAgentJson('{\n  "a": 1\n}'), { a: 1 });
});

test('sanitation leaves already-escaped sequences alone', () => {
  // "a" holds a proper \n escape; "b" holds a literal newline. Both must survive.
  const raw = '{"a": "one\\ntwo", "b": "raw\nline"}';
  const obj = parseAgentJson(raw);
  assert.equal(obj.a, 'one\ntwo');
  assert.equal(obj.b, 'raw\nline');
});

test('parses fenced JSON with raw control chars inside strings', () => {
  const raw = '```json\n{"note": "first\nsecond"}\n```';
  assert.equal(parseAgentJson(raw).note, 'first\nsecond');
});

test('still throws when the reply has no JSON at all', () => {
  assert.throws(() => parseAgentJson('Sorry, there is nothing to extract here.'), /no JSON object found/);
});
