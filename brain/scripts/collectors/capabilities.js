const path = require('path');
const os = require('os');
const { VAULT, safeStat, listDir, exists, readJson, readText } = require('./util');

function classifyGsd(names) {
  let gsd = 0;
  const custom = [];
  for (const n of names) {
    if (n.startsWith('gsd-') || n.startsWith('gsd_')) gsd++;
    else custom.push(n);
  }
  return { gsd, custom };
}

function collectCapabilities() {
  const out = {};

  // agents/*.md
  const agentsDir = path.join(VAULT, 'agents');
  const agentFiles = listDir(agentsDir).filter(n => n.endsWith('.md'));
  const agentBases = agentFiles.map(n => n.replace(/\.md$/, ''));
  const agentsClass = classifyGsd(agentBases);
  out.agents = {
    count: agentFiles.length,
    gsd: agentsClass.gsd,
    custom: agentsClass.custom,
    totalBytes: agentFiles.reduce((acc, n) => acc + (safeStat(path.join(agentsDir, n))?.size || 0), 0),
  };

  // commands/*.md
  const commandsDir = path.join(VAULT, 'commands');
  const commandFiles = listDir(commandsDir).filter(n => n.endsWith('.md'));
  out.commands = {
    count: commandFiles.length,
    names: commandFiles.map(n => n.replace(/\.md$/, '')).sort(),
  };

  // skills/*/ — each should contain SKILL.md
  const skillsDir = path.join(VAULT, 'skills');
  const skillDirs = listDir(skillsDir).filter(n => safeStat(path.join(skillsDir, n))?.isDirectory());
  const missingSkillMd = [];
  for (const d of skillDirs) {
    if (!exists(path.join(skillsDir, d, 'SKILL.md'))) missingSkillMd.push(d);
  }
  const skillsClass = classifyGsd(skillDirs);
  out.skills = {
    count: skillDirs.length,
    gsd: skillsClass.gsd,
    customCount: skillsClass.custom.length,
    custom: skillsClass.custom,
    missingSkillMd,
  };

  // hooks/*.{js,sh}
  const hooksDir = path.join(VAULT, 'hooks');
  const hookFiles = listDir(hooksDir).filter(n => /\.(js|sh|ps1)$/.test(n));
  const settings = readJson(path.join(VAULT, 'settings.json')) || {};
  const referencedScripts = new Set();
  const HOME = process.env.HOME || os.homedir() || '';
  // Expand env-var home references so paths like "$HOME/.claude/hooks/x.sh"
  // resolve to a real on-disk path instead of being harvested as "/.claude/...".
  const expandHome = (s) => String(s || '')
    .replace(/\$\{HOME\}/g, HOME)
    .replace(/\$HOME\b/g, HOME)
    .replace(/(^|[\s"'=])~(?=\/)/g, `$1${HOME}`);
  const harvestPaths = (cmd) => {
    const matches = expandHome(cmd).match(/(?:[A-Za-z]:[\/\\]|\/)[^\s"']+/g) || [];
    for (const m of matches) referencedScripts.add(path.normalize(m).replace(/\\/g, '/'));
  };
  const settingsHooks = settings.hooks || {};
  for (const event of Object.keys(settingsHooks)) {
    for (const m of (settingsHooks[event] || [])) {
      for (const h of (m.hooks || [])) harvestPaths(h.command);
    }
  }
  if (settings.statusLine?.command) harvestPaths(settings.statusLine.command);
  const hookPathsPresent = hookFiles.map(n => path.join(hooksDir, n).replace(/\\/g, '/'));
  const wired = hookFiles.filter(n => {
    const full = path.join(hooksDir, n).replace(/\\/g, '/');
    for (const ref of referencedScripts) {
      if (ref.toLowerCase() === full.toLowerCase()) return true;
    }
    return false;
  });
  const allUnwired = hookFiles.filter(n => !wired.includes(n));
  // Split unwired into (a) acknowledged-intentional (suppressed via config) and
  // (b) genuinely unexpected orphans that should fire a warning.
  const scannerCfg = readJson(path.join(VAULT, 'brain/_index/scanner-config.json')) || {};
  const allowedOrphanSet = new Set(scannerCfg.allowedOrphanHooks || []);
  const acknowledgedOrphans = allUnwired.filter(n => allowedOrphanSet.has(n));
  const orphans = allUnwired.filter(n => !allowedOrphanSet.has(n));
  const missingRefs = [];
  for (const ref of referencedScripts) {
    if (!exists(ref)) missingRefs.push(ref);
  }
  out.hooks = {
    count: hookFiles.length,
    wired: wired.length,
    orphans,
    acknowledgedOrphans,
    missingRefs,
    settingsReferenced: referencedScripts.size,
  };

  // brain/scripts/*
  const bScriptsDir = path.join(VAULT, 'brain/scripts');
  const bScripts = listDir(bScriptsDir).filter(n => /\.(js|sh|ps1)$/.test(n));
  const bWired = bScripts.filter(n => {
    const full = path.join(bScriptsDir, n).replace(/\\/g, '/');
    for (const ref of referencedScripts) {
      if (ref.toLowerCase() === full.toLowerCase()) return true;
    }
    return false;
  });
  out.brainScripts = {
    count: bScripts.length,
    names: bScripts,
    wired: bWired.length,
  };

  // plugins/ top-level
  const pluginsDir = path.join(VAULT, 'plugins');
  out.pluginsTopLevel = {
    present: exists(pluginsDir),
    count: listDir(pluginsDir).length,
  };

  return out;
}

module.exports = { collectCapabilities };
