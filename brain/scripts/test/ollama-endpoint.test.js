'use strict';
// Pure resolution test — no socket is opened, so a live Ollama on this machine is never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { endpoint } = require('../sdk/lib/ollama.js');

test('endpoint: explicit opts win, then OLLAMA_HOST/PORT, then the local default', () => {
  assert.deepEqual(endpoint({ host: 'h', port: '7' }), { host: 'h', port: 7 });
  const saved = { host: process.env.OLLAMA_HOST, port: process.env.OLLAMA_PORT };
  try {
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_PORT;
    assert.deepEqual(endpoint(), { host: '127.0.0.1', port: 11434 });
    process.env.OLLAMA_HOST = '10.1.2.3';
    process.env.OLLAMA_PORT = '9999';
    assert.deepEqual(endpoint(), { host: '10.1.2.3', port: 9999 });
    assert.deepEqual(endpoint({ host: 'h', port: 7 }), { host: 'h', port: 7 }, 'opts still beat env');
  } finally {
    for (const [k, v] of [['OLLAMA_HOST', saved.host], ['OLLAMA_PORT', saved.port]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
