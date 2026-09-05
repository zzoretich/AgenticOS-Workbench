'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'embv-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'user'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'user', 'profile.md'), '---\ntype: memory\n---\n\n# Profile\n\nlikes terse answers\n');
process.env.BRAIN_VAULT = TMP;
const { refreshEmbedIndex, indexPath } = require('../embed-vault.js');

const NONE = { name: 'none', reason: 'forced', capabilities: { chat: false, embed: false, structured: false }, embed: async () => { throw new Error('must not be called'); } };
const CLAUDE = { ...NONE, name: 'claude', capabilities: { chat: true, embed: false, structured: true } };

test('a provider without embeddings → disabled/no-embed and no index write', async () => {
  for (const p of [NONE, CLAUDE]) {
    const r = await refreshEmbedIndex({ provider: p });
    assert.equal(r.disabled, true);
    assert.equal(r.reason, 'no-embed');
    assert.equal(r.provider, p.name);
    assert.equal(r.embedded, 0);
  }
  assert.ok(!fs.existsSync(indexPath(TMP)));
});

test('a provider with embeddings embeds through provider.embed', async () => {
  const OLLAMA = { name: 'ollama', reason: 'forced', capabilities: { chat: true, embed: true, structured: true }, embed: async (texts) => texts.map(() => [1, 0, 0]) };
  const r = await refreshEmbedIndex({ provider: OLLAMA });
  assert.equal(r.embedded, 1);
  assert.equal(r.disabled, undefined);
  assert.ok(fs.existsSync(indexPath(TMP)));
});
