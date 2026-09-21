'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rlt-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'brain', 'routines'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'brain', 'routines', 'monitor.md'), '---\nschema: 1\nname: Monitor\nkind: duty\nschedule: "0 13 * * *"\nenabled: true\nguarded: true\n---\n');
fs.writeFileSync(path.join(TMP, 'brain', 'routines', 'bad.md'), '---\nschema: 1\nname: Bad\nkind: prompt\nschedule: "0 99 * * *"\nenabled: true\n---\nx\n');
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'routines.json'), JSON.stringify({
  schema: 1, syncedAt: '2026-09-21T00:00:00.000Z', synced: { monitor: 'duty|0 13 * * *|on' },
  routines: { monitor: { lastRunAt: new Date(Date.now() - 60_000).toISOString(), lastExit: 0, lastCostUsd: 0.09, lastDurationMs: 4000, failStreak: 0, lastTrigger: 'scheduled', lastError: null } },
}));
const SERVER = path.join(__dirname, '..', 'sdk', 'mcp-server.js');

async function withClient(fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') } });
  const client = new Client({ name: 'routine-list-test', version: '0.0.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

test('routine_list returns every routine with cadence, next fire times, last run and health', async () => {
  const out = await withClient(async (client) => JSON.parse((await client.callTool({ name: 'routine_list', arguments: {} })).content[0].text));
  assert.equal(out.schema, 1);
  assert.equal(out.count, 2);
  const m = out.routines.find((r) => r.slug === 'monitor');
  assert.equal(m.kind, 'duty');
  assert.equal(m.guarded, true);
  assert.equal(m.cadence, 'Every day at 13:00');
  assert.equal(m.next.length, 3);
  assert.ok(m.next.every((t) => new Date(t).getHours() === 13), 'fire times are 13:00 local');
  assert.equal(m.last.exit, 0);
  assert.equal(m.last.usd, 0.09);
  assert.equal(m.health, 'ok');
  const b = out.routines.find((r) => r.slug === 'bad');
  assert.equal(b.health, 'invalid');
  assert.match(b.errors[0], /^schedule: hour/);
  assert.deepEqual(b.next, []);
});

test('routine_list on a vault without brain/routines/ is an empty list', async () => {
  fs.rmSync(path.join(TMP, 'brain', 'routines'), { recursive: true, force: true });
  const out = await withClient(async (client) => JSON.parse((await client.callTool({ name: 'routine_list', arguments: {} })).content[0].text));
  assert.deepEqual(out, { schema: 1, count: 0, routines: [] });
});
