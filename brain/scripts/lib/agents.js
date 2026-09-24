'use strict';
/**
 * agents.js — every agent of both session hosts in one list, and the sync that makes each host's user agents universal
 * (spec 2026-09-23-universal-agents).
 *
 *   discover(roots)            what is on disk: each host's user agents, our mirrors (by their marker), the enabled
 *                              Claude Code plugins' agents, and the roles Codex's config.toml declares
 *   plan(found, opts)          one row per agent with its status (D3) and the mirror writes/removals that make it so
 *   apply(actions)             performs them; every write and removal re-checks the marker and its hash first
 *   sync({ vault, userCfg })   discover → plan → apply → brain/_index/agents.json (D7); the hook (skills-sync.js), the
 *                              CLI and the HUD all end up here
 *
 * A mirror is one file in the other host's agents folder: <claude config dir>/agents/<name>.md ↔
 * <codex home>/agents/<name>.toml, translated by lib/agent-translate.js, carrying `# aos-mirror: {…}` (D1). A file without
 * that marker is never written or removed; a mirror that no longer hashes to its writtenHash was edited by hand and is
 * left alone until `aos agents reset <name>` (D3). Plugin agents and config.toml roles are listed only (D2). Every root
 * is injectable, so tests never touch a real home.
 */
const fs = require('fs');
const path = require('path');
const A = require('./agent-translate.js');
const ST = require('./skill-translate.js');
const H = require('./host.js');
const { hostsOf, claudePlugins } = require('./skills.js');

const SCHEMA = 1;
const DISPLAY_MAX = 300;
const HOSTS = ['claude', 'codex'];
const EXT = { claude: '.md', codex: '.toml' };
const KIND = { claude: 'md', codex: 'toml' };
const SKIP_FILES = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md']);

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function listFiles(dir, ext) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith(ext) && !n.startsWith('.') && !SKIP_FILES.has(n) && isFile(path.join(dir, n))).sort(); } catch { return []; }
}

// ── config and roots ─────────────────────────────────────────────────────────

/** agents config by loadConfig() precedence: the shipped defaults ← <vault>/brain/config.json ← agenticos.json. */
function agentsConfig({ vault, userCfg } = {}) {
  const defaults = readJson(path.join(__dirname, '..', 'config.default.json')) || {};
  const vaultCfg = (vault && readJson(path.join(vault, 'brain', 'config.json'))) || {};
  const layers = [defaults.agents, vaultCfg.agents, userCfg && userCfg.agents].map((x) => x || {});
  const a = Object.assign({ sync: true, exclude: [] }, ...layers);
  a.exclude = Array.isArray(a.exclude) ? a.exclude.map((n) => String(n).toLowerCase()) : [];
  return a;
}

/** Where each host keeps its agents and the files that say which plugins and roles are on. */
function roots({ userCfg = null, env = process.env } = {}) {
  const claude = path.resolve((userCfg && userCfg.claudeConfigDir) || H.claudeConfigDir(env));
  const codex = H.codexHome(env, userCfg);
  return {
    claudeAgents: path.join(claude, 'agents'),
    claudePlugins: path.join(claude, 'plugins', 'installed_plugins.json'),
    claudeSettings: path.join(claude, 'settings.json'),
    codexAgents: path.join(codex, 'agents'),
    codexConfig: path.join(codex, 'config.toml'),
  };
}

// ── discovery ────────────────────────────────────────────────────────────────

/** One agent file of `host`, parsed; `marker` is set when it is one of our mirrors. */
function readAgent(file, host) {
  const text = readText(file);
  if (text === null) return null;
  const base = path.basename(file, EXT[host]);
  const parsed = host === 'claude' ? A.readClaude(text) : A.readCodex(text);
  const marker = A.readMarker(text, KIND[host]);
  const description = parsed.ok ? parsed.description || (host === 'claude' ? ST.firstProse(parsed.body) : '') : '';
  return {
    file, host, base, text, hash: A.sha(text), parsed, marker,
    name: (parsed.ok && parsed.name) || base,
    description: ST.clip(description, DISPLAY_MAX),
    readOnly: parsed.ok ? (host === 'claude' ? A.isReadOnlyTools(parsed.tools) : parsed.sandbox === 'read-only') : false,
  };
}

/**
 * Codex config.toml, read line by line (it holds far more than agent roles): `[agents.<name>]` roles with their
 * description, and whether subagents are switched off (`[features] multi_agent = false`, `[agents] enabled = false`).
 */
function codexConfigRoles(toml) {
  const roles = [];
  let section = null;
  let cur = null;
  let off = null;
  for (const line of String(toml || '').split(/\r?\n/)) {
    const sec = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
    if (sec) {
      section = sec[1];
      const role = section.match(/^agents\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
      cur = role ? { name: role[1] || role[2] || role[3], description: '' } : null;
      if (cur) roles.push(cur);
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!kv) continue;
    if (cur && kv[1] === 'description') {
      const m = kv[2].match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
      if (m) { try { cur.description = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]; } catch { cur.description = m[1] || m[2] || ''; } }
    }
    if (section === 'features' && kv[1] === 'multi_agent' && /^false\b/.test(kv[2])) off = 'Codex subagents are off (features.multi_agent = false in config.toml)';
    if (section === 'agents' && kv[1] === 'enabled' && /^false\b/.test(kv[2])) off = 'Codex subagents are off (agents.enabled = false in config.toml)';
  }
  return { roles, off };
}

function discover(r) {
  const found = { claude: { user: [], mirrors: [] }, codex: { user: [], mirrors: [] }, listed: [], codexRoles: new Set(), codexOff: null };
  for (const host of HOSTS) {
    const dir = host === 'claude' ? r.claudeAgents : r.codexAgents;
    for (const f of listFiles(dir, EXT[host])) {
      const a = readAgent(path.join(dir, f), host);
      if (a) (a.marker ? found[host].mirrors : found[host].user).push(a);
    }
  }
  for (const { plugin, root } of claudePlugins(r)) {
    for (const f of listFiles(path.join(root, 'agents'), '.md')) {
      const a = readAgent(path.join(root, 'agents', f), 'claude');
      if (a) found.listed.push({ host: 'claude', scope: 'plugin', plugin, name: a.name, description: a.description, path: a.file, readOnly: a.readOnly });
    }
  }
  const cfg = codexConfigRoles(readText(r.codexConfig));
  found.codexOff = cfg.off;
  for (const role of cfg.roles) {
    found.codexRoles.add(ST.codexName(role.name) || role.name);
    found.listed.push({ host: 'codex', scope: 'config', plugin: null, name: role.name, description: ST.clip(role.description, DISPLAY_MAX), path: r.codexConfig, readOnly: false });
  }
  return found;
}

// ── invocations ──────────────────────────────────────────────────────────────

function shq(s) { return /^[\w.:@/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** How each host uses an agent (D7): Claude Code mentions it or runs a session as it; Codex spawns a role it is asked for. */
function side(host, name, file, via) {
  if (host === 'claude') return { path: file, via, invoke: `@agent-${name}`, run: `claude --agent ${shq(name)}` };
  const prompt = `Use the ${name} agent. Ask me what it should work on, then spawn it with my answer as its task.`;
  return { path: file, via, invoke: name, run: `codex ${shq(prompt)}` };
}

// ── plan ─────────────────────────────────────────────────────────────────────

function idOf(a) { return ST.codexName(a.name) || ST.codexName(a.base) || a.base.toLowerCase(); }

function isEdited(m) { return !m.marker || A.sha(m.marker.unmarked) !== m.marker.meta.writtenHash; }

/** Target file and translation for mirroring `src` (native on `from`) into the other host. */
function translate(src, from, r) {
  const res = from === 'claude'
    ? A.toCodex(src.parsed, { source: src.file, sourceHash: src.hash, id: idOf(src) })
    : A.toClaude(src.parsed, { source: src.file, sourceHash: src.hash, id: idOf(src) });
  const to = from === 'claude' ? 'codex' : 'claude';
  const dir = to === 'codex' ? r.codexAgents : r.claudeAgents;
  return { file: path.join(dir, `${res.ok ? res.name : idOf(src)}${EXT[to]}`), res };
}

/**
 * Rows (D7) and actions. `on` is what each host will have once the actions ran: side() or null.
 * opts: { roots, config: agentsConfig(), hosts: enabled hosts }.
 */
function plan(found, { roots: r, config, hosts }) {
  const bothHosts = HOSTS.every((h) => hosts.includes(h));
  const syncOn = config.sync !== false && bothHosts;
  const offReason = config.sync === false ? 'sharing is off (agents.sync is false)' : bothHosts ? null : 'sharing needs both hosts enabled';
  const exclude = new Set(config.exclude || []);

  const ids = new Map();
  const slot = (id) => { if (!ids.has(id)) ids.set(id, { claude: null, codex: null, mirror: { claude: null, codex: null } }); return ids.get(id); };
  for (const h of HOSTS) {
    for (const a of found[h].user) { const e = slot(idOf(a)); if (!e[h]) e[h] = a; }
    for (const m of found[h].mirrors) slot(m.marker.meta.id || idOf(m)).mirror[h] = m;
  }

  const rows = [];
  const actions = [];
  const removeIfClean = (m) => { if (m && !isEdited(m)) actions.push({ type: 'remove', id: m.marker.meta.id || idOf(m), file: m.file }); };
  const native = (a) => (a ? side(a.host, a.name, a.file, 'native') : null);
  const mirrorSide = (m) => side(m.host, m.name, m.file, 'mirror');

  for (const [id, e] of [...ids].sort((a, b) => a[0].localeCompare(b[0]))) {
    const src = e.claude || e.codex;
    const row = {
      id,
      name: src ? src.name : id,
      description: src ? src.description : '',
      origin: src ? { host: src.host, scope: 'user', plugin: null, path: src.file } : null,
      on: { claude: native(e.claude), codex: native(e.codex) },
      readOnly: src ? src.readOnly : false,
      status: 'universal',
      note: null,
    };

    if (!src) {
      // Only mirrors are left: their source is gone. A clean one goes with it; an edited one is the user's now.
      for (const h of HOSTS) {
        const m = e.mirror[h];
        if (!m) continue;
        if (isEdited(m)) {
          Object.assign(row, { name: m.name, description: m.description, readOnly: m.readOnly, status: 'edited' });
          row.origin = { host: h, scope: 'mirror', plugin: null, path: m.file };
          row.on[h] = mirrorSide(m);
          row.note = `the source was removed and this copy was edited: delete ${m.file} or keep it as your own`;
        } else if (syncOn) actions.push({ type: 'remove', id, file: m.file });
      }
      if (row.origin) rows.push(row);
      continue;
    }

    if (e.claude && e.codex) {
      row.status = A.sameInstructions(e.claude.parsed, e.codex.parsed) ? 'universal' : 'differs';
      if (row.status === 'differs') row.note = 'a different agent of the same name on each host; the sync leaves both alone';
      if (syncOn) { removeIfClean(e.mirror.claude); removeIfClean(e.mirror.codex); }
      rows.push(row);
      continue;
    }

    const from = src.host;
    const to = from === 'claude' ? 'codex' : 'claude';
    const mirror = e.mirror[to];
    const { file, res } = translate(src, from, r);

    if (exclude.has(id)) {
      row.status = 'excluded';
      row.note = `not shared (aos agents include ${id})`;
      if (syncOn) removeIfClean(mirror);
      if (mirror && isEdited(mirror)) row.on[to] = mirrorSide(mirror);
    } else if (!res.ok) {
      row.status = 'invalid';
      row.note = res.reason;
      if (syncOn) removeIfClean(mirror);
    } else if (to === 'codex' && found.codexRoles.has(res.name)) {
      row.status = 'differs';
      row.note = `Codex's config.toml already declares a ${res.name} role; the sync leaves both alone`;
      if (syncOn) removeIfClean(mirror);
    } else if (mirror && path.resolve(mirror.file) !== path.resolve(file)) {
      // The source was renamed: the old mirror goes (when clean) and a new one is written below.
      if (syncOn) removeIfClean(mirror);
      if (isEdited(mirror)) { row.status = 'edited'; row.note = `the copy at ${mirror.file} was edited; aos agents reset ${id} replaces it`; row.on[to] = mirrorSide(mirror); }
      else if (!syncOn) { row.status = 'pending'; row.note = offReason; }
      else { actions.push(mirrorAction(id, from, src, file, res)); row.on[to] = side(to, res.name, file, 'mirror'); }
    } else if (mirror && isEdited(mirror)) {
      row.status = 'edited';
      row.note = `the copy at ${mirror.file} was edited; aos agents reset ${id} replaces it`;
      row.on[to] = mirrorSide(mirror);
    } else if (!mirror && fs.existsSync(file)) {
      row.status = 'differs';
      row.note = `${file} exists and is not an AgenticOS mirror; the sync leaves it alone`;
    } else if (!syncOn) {
      row.status = mirror && mirror.text === res.content ? 'universal' : 'pending';
      if (row.status === 'pending') row.note = offReason;
      if (mirror) row.on[to] = mirrorSide(mirror);
    } else {
      actions.push(mirrorAction(id, from, src, file, res));
      row.on[to] = side(to, res.name, file, 'mirror');
    }
    rows.push(row);
  }

  // Plugin agents and config.toml roles: listed, never mirrored (D2).
  const listed = found.listed.map((l) => {
    const name = l.scope === 'plugin' ? `${l.plugin}:${l.name}` : l.name;
    return {
      id: name,
      name: l.name,
      description: l.description,
      origin: { host: l.host, scope: l.scope, plugin: l.plugin, path: l.path },
      on: { claude: l.host === 'claude' ? side('claude', name, l.path, l.scope) : null, codex: l.host === 'codex' ? side('codex', name, l.path, l.scope) : null },
      readOnly: l.readOnly,
      status: 'listed',
      note: l.scope === 'plugin' ? `from the ${l.plugin} plugin` : `declared in config.toml; move it to agents/${l.name}.toml in the Codex home to share it`,
    };
  }).sort((a, b) => (a.origin.plugin || '~').localeCompare(b.origin.plugin || '~') || a.name.localeCompare(b.name));

  return { rows: [...rows, ...listed], actions, sync: { on: syncOn, reason: offReason } };
}

function mirrorAction(id, from, src, file, res) {
  return { type: 'mirror', id, from, source: src.file, sourceHash: src.hash, file, content: res.content };
}

// ── apply ────────────────────────────────────────────────────────────────────

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ } throw e; }
}

function kindOf(file) { return file.endsWith('.toml') ? 'toml' : 'md'; }

/** A file is ours to touch only while it carries our marker and still hashes to what we wrote. */
function stillOurs(file) {
  const text = readText(file);
  return text !== null && A.isPristine(text, kindOf(file));
}

function applyMirror(a) {
  const cur = readText(a.file);
  if (cur === a.content) return false;
  if (cur !== null && !stillOurs(a.file)) throw new Error(`${a.file} changed since the plan; left alone`);
  fs.mkdirSync(path.dirname(a.file), { recursive: true });
  writeAtomic(a.file, a.content);
  return true;
}

/** Removes a mirror file. Without `force` it refuses an edited one; `aos agents reset` passes force to discard the edit. */
function removeMirror(file, { force = false } = {}) {
  const text = readText(file);
  if (text === null) return false;
  if (!A.readMarker(text, kindOf(file))) return false;
  if (!force && !A.isPristine(text, kindOf(file))) return false;
  fs.rmSync(file, { force: true });
  return true;
}

function apply(actions) {
  const out = { written: [], removed: [], errors: [] };
  for (const a of actions) {
    try {
      if (a.type === 'mirror') { if (applyMirror(a)) out.written.push(a.id); }
      else if (a.type === 'remove') { if (removeMirror(a.file)) out.removed.push(a.id); }
    } catch (e) {
      out.errors.push({ id: a.id, message: e.message });
    }
  }
  return out;
}

// ── cache ────────────────────────────────────────────────────────────────────

function cacheFile(vault) { return path.join(vault, 'brain', '_index', 'agents.json'); }

function readCache(file) {
  const c = readJson(file);
  return c && c.schema === SCHEMA && Array.isArray(c.agents) ? c : null;
}

function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(cache, null, 2)}\n`);
}

// ── entry points ─────────────────────────────────────────────────────────────

/**
 * Discover, plan, apply (unless dryRun), and write the cache (unless dryRun). Returns { cache, actions, result }.
 * opts: { vault, userCfg, env, roots, now, dryRun }.
 */
function sync({ vault, userCfg = null, env = process.env, roots: r, now = new Date(), dryRun = false } = {}) {
  const R = r || roots({ userCfg, env });
  const hosts = hostsOf(userCfg);
  const found = discover(R);
  const p = plan(found, { roots: R, config: agentsConfig({ vault, userCfg }), hosts });
  const result = dryRun ? { written: [], removed: [], errors: [] } : apply(p.actions);
  const failed = new Map(result.errors.map((e) => [e.id, e.message]));
  for (const row of p.rows) {
    if (!failed.has(row.id)) continue;
    row.status = 'error';
    row.note = failed.get(row.id);
    for (const h of HOSTS) if (row.on[h] && row.on[h].via === 'mirror') row.on[h] = null;
  }
  const cache = {
    schema: SCHEMA,
    scannedAt: now.toISOString(),
    hosts: { claude: hosts.includes('claude'), codex: hosts.includes('codex') },
    codexAgents: { on: !found.codexOff, reason: found.codexOff },
    sync: { on: p.sync.on, reason: p.sync.reason, at: dryRun ? null : now.toISOString(), written: result.written, removed: result.removed, errors: result.errors },
    agents: p.rows,
  };
  if (!dryRun && vault) writeCache(cacheFile(vault), cache);
  return { cache, actions: p.actions, result };
}

/** Delete an edited mirror so the next sync writes it fresh (`aos agents reset <name>`). */
function reset({ userCfg = null, env = process.env, roots: r, id }) {
  const R = r || roots({ userCfg, env });
  const want = String(id || '').toLowerCase();
  const found = discover(R);
  const removed = [];
  for (const m of [...found.claude.mirrors, ...found.codex.mirrors]) {
    if ((m.marker.meta.id || idOf(m)) === want && removeMirror(m.file, { force: true })) removed.push(m.file);
  }
  return removed;
}

/** True for a file a reader should skip: one of our mirrors (spec D8). */
function isMirrorFile(file) {
  const text = readText(file);
  return text !== null && !!A.readMarker(text, kindOf(file));
}

module.exports = {
  SCHEMA, agentsConfig, roots, discover, codexConfigRoles, plan, apply, sync, reset, isMirrorFile,
  cacheFile, readCache, writeCache, side,
};
