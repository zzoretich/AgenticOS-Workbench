'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectCapabilities } = require('../collectors/capabilities.js');
const { collectConfig } = require('../collectors/config.js');
const { collectRuntime } = require('../collectors/runtime.js');
const { collectFolderAtlas } = require('../collectors/folderAtlas.js');

function w(root, rel, body = '') { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
/** A vault and a SEPARATE Claude config dir, so a collector that still reads the vault for config-dir content sees nothing. */
function fixtures() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vault-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfg-'));
  w(vault, 'brain/_index/scanner-config.json', JSON.stringify({ allowedOrphanHooks: ['ack.sh'] }));
  w(vault, 'brain/scripts/inject-context.js', '');
  w(vault, 'MEMORY.md', '# Memory Index\n\n- [A](brain/memory/reference/a.md) — a\n');
  w(vault, 'templates/daily-note.md', '');
  w(cfg, 'agents/planner.md', ''); w(cfg, 'agents/gsd-x.md', '');
  w(cfg, 'commands/wrap.md', '');
  w(cfg, 'skills/recall/SKILL.md', ''); w(cfg, 'skills/broken/README.md', '');
  w(cfg, 'hooks/wired.sh', ''); w(cfg, 'hooks/ack.sh', ''); w(cfg, 'hooks/orphan.sh', '');
  w(cfg, 'settings.json', JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: `sh ${path.join(cfg, 'hooks', 'wired.sh')}` }] }] } }));
  w(cfg, 'plugins/one/plugin.json', '{}');
  w(cfg, 'CLAUDE.md', '# rules\nline two\n');
  w(cfg, 'history.jsonl', '{}\n{}\n');
  w(cfg, 'backups/.claude.json.backup.1', 'x');
  w(cfg, 'shell-snapshots/s1', 'x');
  w(cfg, 'cache/c1', 'x');
  w(cfg, 'downloads/d1', 'xx');
  w(cfg, 'ide/1.lock', '');
  w(cfg, 'sessions/4308.json', '{}');
  // projects/: a transcript at depth 2 (counted) and a subagent file at depth 3 (beyond the two-level stat walk).
  w(cfg, 'projects/-home-alice-app/abc.jsonl', '{}');
  w(cfg, 'projects/-home-alice-app/abc/subagents/x.jsonl', '{}');
  return { vault, cfg };
}

test('collectCapabilities reads agents/commands/skills/hooks/settings/plugins from the config dir and brain/scripts from the vault', () => {
  const { vault, cfg } = fixtures();
  const c = collectCapabilities({ vault, claudeConfigDir: cfg });
  assert.equal(c.agents.count, 2);
  assert.equal(c.agents.gsd, 1);
  assert.deepEqual(c.commands.names, ['wrap']);
  assert.equal(c.skills.count, 2);
  assert.deepEqual(c.skills.missingSkillMd, ['broken']);
  assert.equal(c.hooks.count, 3);
  assert.equal(c.hooks.wired, 1);
  assert.deepEqual(c.hooks.orphans, ['orphan.sh']);
  assert.deepEqual(c.hooks.acknowledgedOrphans, ['ack.sh']);
  assert.equal(c.brainScripts.count, 1);
  assert.equal(c.pluginsTopLevel.count, 1);
  const empty = collectCapabilities({ vault, claudeConfigDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empty-')) });
  assert.equal(empty.agents.count, 0);
  assert.equal(empty.brainScripts.count, 1, 'vault-side reads are unaffected by an empty config dir');
});

test('collectConfig reads settings.json, CLAUDE.md, history.jsonl from the config dir and MEMORY.md from the vault', () => {
  const { vault, cfg } = fixtures();
  const c = collectConfig({ vault, claudeConfigDir: cfg });
  assert.equal(c.settings.path, path.join(cfg, 'settings.json'));
  assert.equal(c.settings.model, 'x');
  assert.equal(c.settings.hookCount, 1);
  assert.equal(c.claudeMd.lines, 2);
  assert.equal(c.memoryMd.pointers, 1);
  assert.equal(c.historyJsonl.lines, 2);
  assert.equal(c.topLevelFiles.credentials, false);
});

test('collectRuntime reads the six runtime directories from the config dir', () => {
  const { vault, cfg } = fixtures();
  const r = collectRuntime({ vault, claudeConfigDir: cfg });
  assert.equal(r.backups.count, 1);
  assert.equal(r.shellSnapshots.count, 1);
  assert.equal(r.cache.files.length, 1);
  assert.equal(r.downloads.count, 1);
  assert.equal(r.downloads.totalBytes, 2);
  assert.equal(r.ide.active, true);
  assert.equal(r.runtimeSessions.count, 1);
});

test('collectFolderAtlas resolves Claude-owned folders against the config dir and vault folders against the vault', () => {
  const { vault, cfg } = fixtures();
  const rows = Object.fromEntries(collectFolderAtlas({ vault, claudeConfigDir: cfg }).map((r) => [r.name, r]));
  assert.equal(rows.agents.present, true);
  assert.equal(rows.agents.scope, 'config');
  assert.equal(rows.brain.present, true);
  assert.equal(rows.brain.scope, 'vault');
  assert.equal(rows.templates.present, true);
  assert.equal(rows.tasks.present, false);
  assert.equal(rows.tasks.scope, 'config');
  // Claude's churn trees are stat-walked two levels deep (a scan runs at every session end); the row says so.
  assert.equal(rows.projects.present, true);
  assert.equal(rows.projects.approx, true);
  assert.equal(rows.projects.files, 1, 'the depth-3 file is not counted');
  assert.equal(rows.agents.approx, undefined, 'ordinary rows are unchanged');
});
