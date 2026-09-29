'use strict';
/**
 * statusline-install.js — puts the AgenticOS status line into each host's own config and takes it out again (spec
 * 2026-09-28-statusline-design D1, D2, D7, D8, D9). Only `aos statusline install` calls it; `init` never does.
 *
 *   Claude Code  user-scope settings.json: `statusLine` (+ `subagentStatusLine`) run the vendored launcher. The value
 *                found there is recorded and chained (D2), and uninstall puts it back.
 *   Codex        config.toml: `[tui] status_line = [<built-in items>]` (Codex runs no status line command, D7). An
 *                existing status_line is never replaced without --force; uninstall removes only our unchanged line.
 *
 * Install state is machine-local, in agenticos-statusline.json beside agenticos.json — never under `hosts`, which would
 * change what enabledHosts() reports. Each host file is copied once to <file>.aos-statusline.bak before the first
 * write; a clean uninstall deletes that copy again, and one that found the file changed keeps it. Under AOS_HEADLESS=1
 * nothing is written: a host's config is the user's to change.
 */
const fs = require('fs');
const path = require('path');
const H = require('./host.js');
const CW = require('./config-write.js');
const fsx = require('./fsx.js');

const SCHEMA = 1;
const MARK = '# agenticos statusline';
const BAK = '.aos-statusline.bak';
const DEFAULT_ITEMS = ['model-with-reasoning', 'task-progress', 'project-name', 'git-branch', 'context-used', 'five-hour-limit', 'weekly-limit'];
const ITEM_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A request that is well formed but that the host's config or the run's mode refuses (exit 1). */
class Refusal extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const launcherOf = (vault) => path.join(vault, 'brain', 'scripts', 'bin', 'aos');
const commandFor = (vault, verb) => `sh ${shq(launcherOf(vault))} statusline ${verb}`;
/** True for a command this module wrote (for any vault): the vendored launcher running `statusline <verb>`. */
function isOurs(command, verb) {
  return typeof command === 'string' && new RegExp(`brain/scripts/bin/aos'?\\s+statusline\\s+${verb}\\s*$`).test(command);
}

function statePath(userConfigFile) { return path.join(path.dirname(userConfigFile), 'agenticos-statusline.json'); }
function readState(userConfigFile) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(userConfigFile), 'utf8'));
    if (isPlainObject(s) && s.schema === SCHEMA) return s;
  } catch { /* none yet */ }
  return { schema: SCHEMA };
}
function writeState(userConfigFile, state) {
  const keep = Object.keys(state).filter((k) => k !== 'schema');
  if (!keep.length) { try { fs.unlinkSync(statePath(userConfigFile)); } catch { /* already gone */ } return; }
  fsx.writeAtomic(statePath(userConfigFile), `${JSON.stringify(state, null, 2)}\n`);
}

function claudeSettingsFile({ userCfg = null, env = process.env } = {}) {
  return path.join(path.resolve((userCfg && userCfg.claudeConfigDir) || H.claudeConfigDir(env)), 'settings.json');
}
function codexConfigFile({ userCfg = null, env = process.env } = {}) { return path.join(H.codexHome(env, userCfg), 'config.toml'); }

/** The hosts an install targets: --host, else every enabled host, else Claude Code (a config with no hosts block). */
function targetHosts(userCfg, host = null) {
  if (host) {
    if (!H.HOSTS.includes(host)) throw new Refusal(`unknown host "${host}" (claude or codex)`);
    return [host];
  }
  const on = H.enabledHosts(userCfg);
  return on.length ? on : ['claude'];
}

function settingsOf(cfg) {
  const s = (cfg && cfg.statusline) || {};
  const items = Array.isArray(s.codexItems) ? s.codexItems.filter((i) => typeof i === 'string' && ITEM_RE.test(i)) : [];
  return {
    refreshSeconds: Number.isInteger(s.refreshSeconds) && s.refreshSeconds >= 1 ? s.refreshSeconds : 5,
    subagents: s.subagents !== false,
    codexItems: items.length ? items : DEFAULT_ITEMS,
  };
}

function backupOnce(file) {
  if (!fs.existsSync(file) || fs.existsSync(file + BAK)) return;
  fs.copyFileSync(file, file + BAK);
}
function dropBackup(file) { try { fs.unlinkSync(file + BAK); } catch { /* never made */ } }
function guardHeadless(env) {
  if (env && env.AOS_HEADLESS === '1') throw new Refusal("a host's status line is the user's to change, and a headless run cannot change it");
}

// ── Claude Code ──

function readSettings(file) {
  let s;
  try { s = CW.readStrict(file); } catch (e) { throw new Refusal(`${file} is not valid JSON; fix it first (${e.message})`); }
  if (s === null) return {};
  if (!isPlainObject(s)) throw new Refusal(`${file} is not a JSON object`);
  return s;
}
const writeSettings = (file, s) => fsx.writeAtomic(file, `${JSON.stringify(s, null, 2)}\n`);

function installClaude(ctx, { chainOutput = false } = {}) {
  const file = claudeSettingsFile(ctx);
  if (!fs.existsSync(path.dirname(file))) return { host: 'claude', ok: false, skipped: true, message: `no Claude Code config folder at ${path.dirname(file)}` };
  const settings = readSettings(file);
  const state = readState(ctx.userConfigFile);
  const was = state.claude || null;
  const opts = settingsOf(ctx.cfg);
  const cur = settings.statusLine;
  const curSub = settings.subagentStatusLine;
  // D9: re-installing over our own line keeps what we first chained; a slot someone else took chains the newcomer.
  const previous = cur && isOurs(cur.command, 'render') ? (was ? was.previous : null) : (cur === undefined ? null : cur);
  const previousSubagent = curSub && isOurs(curSub.command, 'subagents') ? (was ? was.previousSubagent : null) : (curSub === undefined ? null : curSub);
  const command = commandFor(ctx.vault, 'render');
  backupOnce(file);
  settings.statusLine = { type: 'command', command, padding: 0, refreshInterval: opts.refreshSeconds, hideVimModeIndicator: true };
  let subagentCommand = null;
  if (opts.subagents) {
    subagentCommand = commandFor(ctx.vault, 'subagents');
    settings.subagentStatusLine = { type: 'command', command: subagentCommand };
  } else if (curSub && isOurs(curSub.command, 'subagents')) {
    if (previousSubagent) settings.subagentStatusLine = previousSubagent; else delete settings.subagentStatusLine;
  }
  writeSettings(file, settings);
  state.claude = { installedAt: (ctx.now || new Date()).toISOString(), command, subagentCommand, previous, previousSubagent: opts.subagents ? previousSubagent : null, chainOutput: !!chainOutput };
  writeState(ctx.userConfigFile, state);
  const chained = previous && typeof previous.command === 'string' && !isOurs(previous.command, 'render') ? previous.command : null;
  return { host: 'claude', ok: true, file, chained, retook: !!(was && cur && !isOurs(cur.command, 'render')) };
}

function uninstallClaude(ctx) {
  const state = readState(ctx.userConfigFile);
  const was = state.claude;
  if (!was) return { host: 'claude', ok: true, skipped: true, message: 'not installed' };
  const file = claudeSettingsFile(ctx);
  const notes = [];
  if (fs.existsSync(file)) {
    const settings = readSettings(file);
    let changed = false;
    for (const [key, verb, prev] of [['statusLine', 'render', was.previous], ['subagentStatusLine', 'subagents', was.previousSubagent]]) {
      const cur = settings[key];
      if (cur && isOurs(cur.command, verb)) {
        if (prev) settings[key] = prev; else delete settings[key];
        changed = true;
      } else if (cur && key === 'statusLine') notes.push(`the status line is now ${cur.command}; left as it is`);
    }
    if (changed) writeSettings(file, settings);
    if (!notes.length) dropBackup(file);
  }
  delete state.claude;
  writeState(ctx.userConfigFile, state);
  return { host: 'claude', ok: true, file, restored: was.previous && was.previous.command ? was.previous.command : null, notes };
}

// ── Codex (config.toml, line-based: no TOML library, D7) ──

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
const tableName = (raw) => raw.split('.').map(unquote).join('.');

/** The last line of the value that starts on line i (brackets counted outside strings and comments). */
function valueEnd(lines, i) {
  let depth = 0;
  let started = false;
  for (let j = i; j < lines.length; j++) {
    const s = j === i ? lines[j].slice(lines[j].indexOf('=') + 1) : lines[j];
    let quote = null;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (quote) { if (ch === '\\' && quote === '"') k++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '#') break;
      if (ch === '[') { depth++; started = true; } else if (ch === ']') depth--;
    }
    if (!started || depth <= 0) return j;
  }
  return lines.length - 1;
}

/** Where tui.status_line lives (or could) in a config.toml. */
function scanToml(text) {
  const lines = text.split('\n');
  let table = '';
  const out = { lines, tui: null, key: null, inlineTui: false, lastTopDotted: -1, firstHeader: -1 };
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER_RE.exec(lines[i]);
    if (h && !/=/.test(lines[i].split('#')[0])) {
      if (out.firstHeader < 0) out.firstHeader = i;
      if (out.tui && out.tui.end === null) out.tui.end = i;
      const arrayOfTables = lines[i].trim().startsWith('[[');
      table = arrayOfTables ? `[[${tableName(h[1])}]]` : tableName(h[1]);
      if (table === 'tui') out.tui = { start: i, end: null };
      continue;
    }
    if (table === '') {
      if (/^\s*"?tui"?\s*=\s*\{/.test(lines[i])) out.inlineTui = true;
      if (/^\s*"?tui"?\s*\./.test(lines[i])) out.lastTopDotted = i;
      if (/^\s*"?tui"?\s*\.\s*"?status_line"?\s*=/.test(lines[i])) out.key = { start: i, end: valueEnd(lines, i), dotted: true };
    } else if (table === 'tui' && /^\s*"?status_line"?\s*=/.test(lines[i])) {
      out.key = { start: i, end: valueEnd(lines, i), dotted: false };
    }
  }
  if (out.tui && out.tui.end === null) out.tui.end = lines.length;
  return out;
}

const ourLine = (items, dotted) => `${dotted ? 'tui.' : ''}status_line = [${items.map((i) => JSON.stringify(i)).join(', ')}]  ${MARK}`;

/** Pure: config.toml text with our status_line in it. Refuses an existing one without `force`. */
function tomlInstall(text, items, { force = false } = {}) {
  const t = scanToml(text);
  if (t.inlineTui) throw new Refusal('config.toml sets `tui` as an inline table; add status_line there yourself, or run /statusline in Codex');
  const lines = t.lines.slice();
  if (t.key) {
    const found = lines.slice(t.key.start, t.key.end + 1).join('\n');
    const line = ourLine(items, t.key.dotted);
    if (found.includes(MARK)) {
      lines.splice(t.key.start, t.key.end - t.key.start + 1, line);
      return { text: lines.join('\n'), written: line, previous: undefined, createdTable: undefined };
    }
    if (!force) throw new Refusal(`config.toml already sets tui.status_line (${found.replace(/\s+/g, ' ').trim()}); pass --force to replace it (uninstall puts it back)`);
    lines.splice(t.key.start, t.key.end - t.key.start + 1, line);
    return { text: lines.join('\n'), written: line, previous: found, createdTable: false };
  }
  if (t.tui) {
    const line = ourLine(items, false);
    lines.splice(t.tui.start + 1, 0, line);
    return { text: lines.join('\n'), written: line, previous: null, createdTable: false };
  }
  if (t.lastTopDotted >= 0) {
    const line = ourLine(items, true);
    lines.splice(t.lastTopDotted + 1, 0, line);
    return { text: lines.join('\n'), written: line, previous: null, createdTable: false };
  }
  const line = ourLine(items, false);
  const body = text.replace(/\n*$/, '');
  return { text: `${body}${body ? '\n\n' : ''}[tui]\n${line}\n`, written: line, previous: null, createdTable: true };
}

/** Pure: config.toml text without our line (the previous value back in its place). `found` false when it changed. */
function tomlUninstall(text, rec) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === String(rec.written || '').trim());
  if (i < 0) return { text, found: false };
  if (rec.previous) lines.splice(i, 1, ...String(rec.previous).split('\n'));
  else lines.splice(i, 1);
  if (rec.createdTable) {
    const h = lines.findIndex((l) => { const m = HEADER_RE.exec(l); return m && tableName(m[1]) === 'tui' && !l.trim().startsWith('[['); });
    if (h >= 0) {
      let j = h + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || HEADER_RE.test(lines[j])) lines.splice(h, j - h); // the header we added, now empty
    }
  }
  const out = lines.join('\n');
  return { text: out.trim() ? out : '', found: true };
}

function installCodex(ctx, { force = false } = {}) {
  const file = codexConfigFile(ctx);
  if (!fs.existsSync(path.dirname(file))) return { host: 'codex', ok: false, skipped: true, message: `no Codex home at ${path.dirname(file)}` };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = readState(ctx.userConfigFile);
  const was = state.codex || null;
  const r = tomlInstall(text, settingsOf(ctx.cfg).codexItems, { force });
  if (r.text !== text) { backupOnce(file); fsx.writeAtomic(file, r.text); }
  state.codex = {
    installedAt: (ctx.now || new Date()).toISOString(),
    written: r.written,
    previous: r.previous === undefined ? (was ? was.previous : null) : r.previous,
    createdTable: r.createdTable === undefined ? !!(was && was.createdTable) : r.createdTable,
  };
  writeState(ctx.userConfigFile, state);
  return { host: 'codex', ok: true, file, replaced: !!r.previous };
}

function uninstallCodex(ctx) {
  const state = readState(ctx.userConfigFile);
  const was = state.codex;
  if (!was) return { host: 'codex', ok: true, skipped: true, message: 'not installed' };
  const file = codexConfigFile(ctx);
  const notes = [];
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* gone: nothing to take out */ }
  if (text !== null) {
    const r = tomlUninstall(text, was);
    if (!r.found) notes.push('the status_line in config.toml changed since install; left as it is');
    else {
      if (r.text !== text) fsx.writeAtomic(file, r.text);
      dropBackup(file);
    }
  }
  delete state.codex;
  writeState(ctx.userConfigFile, state);
  return { host: 'codex', ok: true, file, notes };
}

// ── Verbs ──

function install(ctx, { host = null, force = false, chainOutput = false } = {}) {
  guardHeadless(ctx.env);
  return targetHosts(ctx.userCfg, host).map((h) => (h === 'claude' ? installClaude(ctx, { chainOutput }) : installCodex(ctx, { force })));
}

function uninstall(ctx, { host = null } = {}) {
  guardHeadless(ctx.env);
  const hosts = host ? targetHosts(ctx.userCfg, host) : H.HOSTS;
  return hosts.map((h) => (h === 'claude' ? uninstallClaude(ctx) : uninstallCodex(ctx)));
}

/** Per host: installed, whether our line still holds the slot, and what it chains. Read-only. */
function status(ctx) {
  const state = readState(ctx.userConfigFile);
  const out = {};
  const cfile = claudeSettingsFile(ctx);
  let current = null;
  try { const s = CW.readStrict(cfile); current = s && s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine.command : null; } catch { current = null; }
  out.claude = {
    installed: !!state.claude,
    ownsSlot: isOurs(current, 'render'),
    current,
    chained: state.claude && state.claude.previous && typeof state.claude.previous.command === 'string' ? state.claude.previous.command : null,
    chainOutput: !!(state.claude && state.claude.chainOutput),
    subagents: !!(state.claude && state.claude.subagentCommand),
    file: cfile,
  };
  const xfile = codexConfigFile(ctx);
  let text = '';
  try { text = fs.readFileSync(xfile, 'utf8'); } catch { /* none */ }
  out.codex = {
    installed: !!state.codex,
    present: !!(state.codex && text.split('\n').some((l) => l.trim() === String(state.codex.written).trim())),
    file: xfile,
  };
  return out;
}

/** After `aos upgrade`: point our own entries at this vault's launcher and current items. Never retakes a lost slot (D9). */
function reapply(ctx) {
  const state = readState(ctx.userConfigFile);
  const done = [];
  if (state.claude) {
    const file = claudeSettingsFile(ctx);
    let settings = null;
    try { settings = readSettings(file); } catch { settings = null; }
    if (settings && settings.statusLine && isOurs(settings.statusLine.command, 'render')) {
      const next = { ...settings, statusLine: { ...settings.statusLine, command: commandFor(ctx.vault, 'render') } };
      if (settings.subagentStatusLine && isOurs(settings.subagentStatusLine.command, 'subagents')) next.subagentStatusLine = { ...settings.subagentStatusLine, command: commandFor(ctx.vault, 'subagents') };
      if (JSON.stringify(next) !== JSON.stringify(settings)) { writeSettings(file, next); done.push('claude'); }
      state.claude = { ...state.claude, command: next.statusLine.command, subagentCommand: next.subagentStatusLine && isOurs(next.subagentStatusLine.command, 'subagents') ? next.subagentStatusLine.command : null };
    }
  }
  if (state.codex) {
    const file = codexConfigFile(ctx);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    if (text !== null && text.split('\n').some((l) => l.trim() === String(state.codex.written).trim())) {
      const r = tomlInstall(text, settingsOf(ctx.cfg).codexItems);
      if (r.text !== text) { fsx.writeAtomic(file, r.text); done.push('codex'); }
      state.codex = { ...state.codex, written: r.written };
    }
  }
  if (state.claude || state.codex) writeState(ctx.userConfigFile, state);
  return done;
}

/** For the Claude session-start notice: the command now in our recorded slot, or null while we hold it (D9). */
function slotTakenBy(ctx) {
  const s = status(ctx).claude;
  return s.installed && !s.ownsSlot ? (s.current || '(none)') : null;
}

module.exports = {
  SCHEMA, MARK, DEFAULT_ITEMS, Refusal, isOurs, commandFor, statePath, readState, claudeSettingsFile, codexConfigFile,
  targetHosts, settingsOf, scanToml, tomlInstall, tomlUninstall, install, uninstall, status, reapply, slotTakenBy,
};
