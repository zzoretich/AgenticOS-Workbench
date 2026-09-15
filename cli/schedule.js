'use strict';
/**
 * schedule.js — renders and installs the Chief of Staff duty schedules.
 *   macOS: ~/Library/LaunchAgents/com.agenticos.<duty>.plist, loaded with launchctl
 *   Linux: crontab lines ending in "# com.agenticos.<duty>" (merged; never touches other lines).
 *   `aos uninstall` (Plan 3, delegating to removeSchedules below) removes exactly the three duty
 *   schedules — the com.agenticos.monitor|reflect|sitrep plists and the crontab lines tagged
 *   "# com.agenticos.<duty>"; the optional com.agenticos.ollama supervisor from extras/ollama
 *   (Plan 2, installed by hand) is left alone. The duty plists are deleted on every platform
 *   (only launchctl is darwin-only) so the uninstall test passes on the ubuntu CI runner too.
 * Templates: extras/schedule/launchd/*.plist.tmpl and extras/schedule/cron.tmpl — resolved
 * relative to this file, so the checkout (cli/../extras/schedule) and the vendored copy
 * (<vault>/brain/scripts/cli/../extras/schedule, installed by `aos init`) both work.
 * Zero dependencies. Every external call is injectable for tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DUTIES = ['monitor', 'reflect', 'sitrep'];
const CRON_TAG = '# com.agenticos.';
// execution amendment 2026-09-15 (A30): match exactly the three duty labels (Plan 3's DUTY_CRON_RE), so a hand-added
// "# com.agenticos.<other>" crontab line is never stripped and com.agenticos.ollama can never match.
const CRON_LINE_RE = /# com\.agenticos\.(monitor|reflect|sitrep)(\s|$)/;
const TEMPLATES_DIR = path.join(__dirname, '..', 'extras', 'schedule');

function launchdLabel(duty) { return `com.agenticos.${duty}`; }
function defaultLaunchAgentsDir() { return path.join(os.homedir(), 'Library', 'LaunchAgents'); }
function defaultWarn(message) { process.stderr.write(`schedule: ${message}\n`); }

function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
/** plists are XML: the agent name and every path are free user text, so escape the three reserved characters
 *  (a vault under ~/R&D would otherwise produce a plist launchctl rejects). execution amendment 2026-09-15 (A30) */
function xmlEscape(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function scheduleVars({ vault, configDir, node, logDir, model, effort, agentName, home = os.homedir() }) {
  return {
    VAULT: vault,
    AOS_CONFIG: path.join(configDir, 'agenticos.json'),
    NODE: node || 'node',
    LOG_DIR: logDir || path.join(vault, 'persona', 'journal', 'logs'),
    MODEL: model || 'haiku',
    EFFORT: effort || 'medium',
    AGENT_NAME: agentName || 'persona',
    HOME: home,
  };
}

function renderLaunchd(duty, vars, templatesDir = TEMPLATES_DIR) {
  const escaped = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, xmlEscape(v)]));   // execution amendment 2026-09-15 (A30)
  return renderTemplate(fs.readFileSync(path.join(templatesDir, 'launchd', `${launchdLabel(duty)}.plist.tmpl`), 'utf8'), escaped);
}
function renderCron(vars, templatesDir = TEMPLATES_DIR) {
  return renderTemplate(fs.readFileSync(path.join(templatesDir, 'cron.tmpl'), 'utf8'), vars);
}
function stripAgenticosCron(text) {
  return String(text || '').split('\n').filter(l => !CRON_LINE_RE.test(l)).join('\n').replace(/\n+$/, '');   // execution amendment 2026-09-15 (A30)
}

// execution amendment 2026-09-15 (A56): a failed `crontab -l` is NOT the same as "no crontab" — only ENOENT
// (no crontab binary at all) or an explicit "no crontab for <user>" stderr means genuinely empty; any other
// failure (spool lock contention, a permission error) means the read is unreliable and the crontab must be
// left untouched rather than treated as empty and overwritten by the next `crontab -`.
function readCrontabResult(exec) {
  try {
    const text = exec('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '';
    return { text, unreadable: false };
  } catch (e) {
    const message = e && (e.stderr || e.message) ? String(e.stderr || e.message).trim() : String(e);
    if (e && e.code === 'ENOENT') return { text: '', unreadable: false };   // no cron here: nothing to merge, nothing to write
    if (/no crontab/i.test(message)) return { text: '', unreadable: false };   // genuinely empty crontab
    return { text: '', unreadable: true, message };
  }
}
function readCrontabWith(exec) {
  const r = readCrontabResult(exec);
  return r.unreadable ? null : r.text;   // null: "unreadable" — distinct from '' ("genuinely empty")
}
function writeCrontabWith(exec, text) {
  exec('crontab', ['-'], { input: text.endsWith('\n') ? text : `${text}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

function installSchedules({ platform = process.platform, vars, templatesDir = TEMPLATES_DIR,
  launchAgentsDir = defaultLaunchAgentsDir(), exec = execFileSync, readCrontab, writeCrontab, warn = defaultWarn } = {}) {
  fs.mkdirSync(vars.LOG_DIR, { recursive: true });
  if (platform === 'darwin') {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    const written = []; const warnings = [];
    for (const duty of DUTIES) {
      const file = path.join(launchAgentsDir, `${launchdLabel(duty)}.plist`);
      fs.writeFileSync(file, renderLaunchd(duty, vars, templatesDir));
      try { exec('launchctl', ['unload', file], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
      // execution amendment 2026-09-15 (A30): a failing load is reported, never thrown — it must not abort `aos init` step 8.
      try { exec('launchctl', ['load', file], { stdio: 'ignore' }); }
      catch (e) { const m = `launchctl load ${file}: ${e && e.message ? e.message : e}`; warnings.push(m); warn(m); }
      written.push(file);
    }
    return { platform, written, labels: DUTIES.map(launchdLabel), warnings };
  }
  if (platform === 'linux') {
    const warnings = [];
    let current;
    if (readCrontab) {
      current = readCrontab();
    } else {
      // execution amendment 2026-09-15 (A56): an injected readCrontab always returns a string (tests' fakes never
      // signal "unreadable"); only the default seam, going through the real crontab binary via exec, can be unreadable.
      const r = readCrontabResult(exec);
      if (r.unreadable) {
        const m = `crontab -l failed (${r.message}) — crontab left untouched; install the duty lines by hand`;
        warnings.push(m); warn(m);
        return { platform, written: [], labels: [], warnings };
      }
      current = r.text;
    }
    const write = writeCrontab || ((t) => writeCrontabWith(exec, t));
    const kept = stripAgenticosCron(current);
    // execution amendment 2026-09-15 (A57): a failing `crontab -` is reported, never thrown — it must not abort
    // `aos init` step 8 (darwin's launchctl load failure is already handled the same way, above).
    try {
      write(`${kept ? `${kept}\n` : ''}${renderCron(vars, templatesDir).trim()}\n`);
    } catch (e) {
      const m = `crontab - failed (${e && e.message ? e.message : e})`;
      warnings.push(m); warn(m);
      return { platform, written: [], labels: [], warnings };
    }
    return { platform, written: ['crontab'], labels: DUTIES.map(d => `${CRON_TAG}${d}`), warnings };
  }
  return { platform, written: [], labels: [], unsupported: true, warnings: [] };
}

function removeSchedules({ platform = process.platform, launchAgentsDir = defaultLaunchAgentsDir(), exec = execFileSync, readCrontab, writeCrontab, warn = defaultWarn } = {}) {
  const removed = []; const warnings = [];
  // The three duty plists go on every platform (Plan 3's uninstall test seeds them under $HOME on
  // ubuntu too; a stray plist on Linux is harmless to delete). Only launchctl is darwin-specific.
  // Anything else in launchAgentsDir — com.agenticos.ollama included — is never matched.
  for (const duty of DUTIES) {
    const file = path.join(launchAgentsDir, `${launchdLabel(duty)}.plist`);
    if (!fs.existsSync(file)) continue;
    if (platform === 'darwin') { try { exec('launchctl', ['unload', file], { stdio: 'ignore' }); } catch { /* already unloaded */ } }
    fs.unlinkSync(file);
    removed.push(file);
  }
  if (platform === 'linux') {
    let current;
    if (readCrontab) {
      current = readCrontab();
    } else {
      // execution amendment 2026-09-15 (A56): same unreadable-vs-empty distinction as installSchedules — a
      // teardown must finish, so an unreadable crontab is left alone rather than guessed at.
      const r = readCrontabResult(exec);
      if (r.unreadable) {
        const m = `crontab -l failed (${r.message}) — crontab left untouched`;
        warnings.push(m); warn(m);
        return { platform, removed, warnings };
      }
      current = r.text;
    }
    if (CRON_LINE_RE.test(current)) {   // execution amendment 2026-09-15 (A30)
      const write = writeCrontab || ((t) => writeCrontabWith(exec, t));
      // execution amendment 2026-09-15 (A57): a failing `crontab -` is reported, never thrown — `aos uninstall`
      // must finish its teardown even when the crontab write fails.
      try { write(`${stripAgenticosCron(current)}\n`); removed.push('crontab'); }
      catch (e) { const m = `crontab - failed (${e && e.message ? e.message : e})`; warnings.push(m); warn(m); }
    }
  }
  return { platform, removed, warnings };
}

function isInstalled({ platform = process.platform, launchAgentsDir = defaultLaunchAgentsDir(), exec = execFileSync, readCrontab } = {}) {
  if (platform === 'darwin') return DUTIES.some(d => fs.existsSync(path.join(launchAgentsDir, `${launchdLabel(d)}.plist`)));
  if (platform === 'linux') return CRON_LINE_RE.test((readCrontab || (() => readCrontabWith(exec)))());   // execution amendment 2026-09-15 (A30)
  return false;
}

module.exports = { DUTIES, CRON_TAG, CRON_LINE_RE, TEMPLATES_DIR, launchdLabel, renderTemplate, xmlEscape, scheduleVars, renderLaunchd, renderCron, stripAgenticosCron, installSchedules, removeSchedules, isInstalled };
