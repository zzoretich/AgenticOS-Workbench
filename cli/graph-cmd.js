'use strict';
/**
 * graph-cmd.js — `aos graph` and the graphify install step (spec 2026-09-23-graphify D1–D3, D8).
 *   (none) | status   the pinned and installed graphify, the last build, counts, hubs and communities
 *   build             a structural rebuild now (<vault>/brain/scripts/graph-build.js, inline)
 *   on | off          graph.enabled in agenticos.json (off stops the scan-vault stage; the binary stays)
 * install() is `aos init` step 5c and an `aos upgrade` step: `uv tool install graphifyy==<PIN>` into a tool dir
 * AgenticOS owns (never the user's own uv tools or PATH), then graph.bin in agenticos.json, the vault's
 * .graphifyignore when absent, and a one-time move of a graphify-out/ that no aos build wrote (it came from another
 * root, and graphify would keep its stale nodes). doctorRows() gives `aos doctor` its graphify rows.
 * The pin is a constant, not a config key: `aos upgrade` copies every default into brain/config.json, where a user
 * value wins, so a pin kept in config would freeze at the first upgrade.
 * Test seams (env): AOS_UV_BIN ('' → uv absent), XDG_DATA_HOME (where the tool dir lives).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PIN = '0.9.66';
const PACKAGE = 'graphifyy';
const PYTHON = '>=3.10';
const MARKER = '.aos-graph.json';
const USAGE = 'usage: aos graph [status | build | on | off]';

function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function agenticosPath(configDir) { return process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json'); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); }
function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
function lastLine(s) { return String(s || '').trim().split('\n').filter(Boolean).pop() || ''; }
function which(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : null;
}
function ago(ms) {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** uv (spec D1, same seam shape as the other prerequisites): AOS_UV_BIN ('' → absent; a path → it, when it exists)
 *  → `uv` on PATH → ~/.local/bin/uv (the uv installer's default) → ~/.cargo/bin/uv (older installers) → null. */
function uvBin() {
  const v = process.env.AOS_UV_BIN;
  if (v !== undefined) return v && fs.existsSync(v) ? v : null;
  const c = [which('uv'), path.join(os.homedir(), '.local', 'bin', 'uv'), path.join(os.homedir(), '.cargo', 'bin', 'uv')];
  return c.find((p) => p && fs.existsSync(p)) || null;
}

/** ${XDG_DATA_HOME:-~/.local/share}/agenticos/graphify — ours alone; uninstall removes it. */
function toolHome() { return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'agenticos', 'graphify'); }
function toolDirs(home = toolHome()) { return { home, tools: path.join(home, 'tools'), bin: path.join(home, 'bin'), graphify: path.join(home, 'bin', 'graphify') }; }

/** "graphify 0.9.66" → "0.9.66"; null when the binary is absent or does not answer. */
function installedVersion(bin, exec = spawnSync) {
  if (!bin || !isExecutable(bin)) return null;
  const r = exec(bin, ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const m = /graphify\s+v?(\d+\.\d+\.\d+\S*)/.exec(`${r.stdout || ''}${r.stderr || ''}`);
  return r.error || !m ? null : m[1];
}

/** The graph config by loadConfig() precedence: the shipped defaults ← <vault>/brain/config.json ← agenticos.json. */
function graphConfig({ vault, userCfg } = {}) {
  const defaults = readJson(path.join(__dirname, '..', 'config.default.json')) || readJson(path.join(__dirname, '..', 'brain', 'scripts', 'config.default.json')) || {};
  const vaultCfg = (vault && readJson(path.join(vault, 'brain', 'config.json'))) || {};
  return { enabled: true, out: 'brain/graphify-out', staleDays: 7, ...(defaults.graph || {}), ...(vaultCfg.graph || {}), ...((userCfg && userCfg.graph) || {}) };
}
function outDir(vault, g) { return path.resolve(vault, g.out || 'brain/graphify-out'); }

/** Copy the seed .graphifyignore into a vault that has none; returns true when it wrote one. */
function seedIgnore(vault, template) {
  const dest = path.join(vault, '.graphifyignore');
  if (fs.existsSync(dest) || !template || !fs.existsSync(template)) return false;
  fs.copyFileSync(template, dest);
  return true;
}

/** A graph.json under the out dir with no aos marker was built by hand, from some other root: rename the dir once. */
function moveAside(vault, g) {
  const dir = outDir(vault, g);
  if (!fs.existsSync(path.join(dir, 'graph.json')) || fs.existsSync(path.join(dir, MARKER))) return null;
  let target = `${dir}.pre-aos`;
  if (fs.existsSync(target)) target = `${target}-${Date.now()}`;
  fs.renameSync(dir, target);
  return target;
}

/**
 * Install graphify PIN (or re-install on a version drift), record graph.bin, seed .graphifyignore, move a hand-built
 * graphify-out/ aside. uv is needed only when an install has to run. Throws when it is missing then, or when the
 * install does not end at PIN; nothing is recorded in either case.
 */
function install({ vault, configDir = claudeConfigDir(), uv = uvBin(), template, io = console, exec = spawnSync, home = toolHome() } = {}) {
  const d = toolDirs(home);
  const before = installedVersion(d.graphify, exec);
  let action = `kept ${PIN}`;
  if (before !== PIN) {
    if (!uv) throw new Error(`uv not found — install it (docs.astral.sh/uv), then run aos upgrade (graphify ${before ? `${before} is not the pinned ${PIN}` : `${PIN} is not installed`})`);
    const args = ['tool', 'install', '--python', PYTHON, ...(fs.existsSync(d.tools) ? ['--reinstall'] : []), `${PACKAGE}==${PIN}`];
    const r = exec(uv, args, {
      encoding: 'utf8', timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, UV_TOOL_DIR: d.tools, UV_TOOL_BIN_DIR: d.bin },
    });
    if (r.error || r.status !== 0) throw new Error(`uv tool install ${PACKAGE}==${PIN} failed: ${lastLine(r.stderr) || (r.error && r.error.message) || `exit ${r.status}`}`);
    const after = installedVersion(d.graphify, exec);
    if (after !== PIN) throw new Error(`${d.graphify} reports ${after || 'no version'} after the install, expected ${PIN}`);
    action = before ? `updated ${before} → ${PIN}` : `installed ${PIN}`;
  }
  const file = agenticosPath(configDir);
  const cfg = readJson(file);
  if (cfg) { cfg.graph = { ...(cfg.graph || {}), bin: d.graphify }; writeJson(file, cfg); }
  const g = graphConfig({ vault, userCfg: cfg });
  const seeded = vault ? seedIgnore(vault, template) : false;
  const moved = vault ? moveAside(vault, g) : null;
  io.log(`graph: graphify ${action} (${d.graphify})${seeded ? '; seeded .graphifyignore' : ''}${moved ? `; moved a hand-built graph to ${path.relative(vault, moved)}` : ''}`);
  return { bin: d.graphify, version: PIN, action, seeded, moved };
}

/** uninstall: the tool dir is ours alone. Refuses any path that is not …/agenticos/graphify. */
function removeTools(home = toolHome()) {
  if (!home.endsWith(`${path.sep}agenticos${path.sep}graphify`) || !fs.existsSync(home)) return null;
  fs.rmSync(home, { recursive: true, force: true });
  return home;
}

/** The graph lib that matches the vault's runtime: the vendored copy, else this checkout's. */
function graphLib(vault) {
  const vendored = path.join(vault, 'brain', 'scripts', 'sdk', 'lib', 'graph.js');
  return require(fs.existsSync(vendored) ? vendored : path.join(__dirname, '..', 'brain', 'scripts', 'sdk', 'lib', 'graph.js'));
}

/** `aos doctor` rows (name, ok, detail, level): the pinned binary, and whether the graph is fresh. */
function doctorRows({ cfg, vault, exec = spawnSync, now = Date.now() } = {}) {
  const rows = [];
  const bin = cfg && cfg.graph && cfg.graph.bin;
  const v = installedVersion(bin, exec);
  if (!v) rows.push({ name: `graphify ${PIN}`, ok: false, detail: bin ? `${bin} does not answer --version — run aos upgrade` : 'not installed — run aos upgrade', level: 'fail' });
  else rows.push({ name: `graphify ${PIN}`, ok: v === PIN, detail: v === PIN ? bin : `installed ${v}, pinned ${PIN} — run aos upgrade`, level: 'warn' });
  if (!vault) return rows;
  const g = graphConfig({ vault, userCfg: cfg });
  if (g.enabled === false) { rows.push({ name: 'graph fresh', ok: false, detail: 'graph off (aos graph on)', level: 'info' }); return rows; }
  const m = readJson(path.join(outDir(vault, g), MARKER));
  const at = m && Date.parse(m.lastStructural || m.builtAt);
  if (!at) { rows.push({ name: 'graph fresh', ok: false, detail: 'no graph yet — run aos graph build', level: 'warn' }); return rows; }
  const age = now - at;
  const fresh = age <= (Number(g.staleDays) || 7) * 86_400_000;
  rows.push({ name: 'graph fresh', ok: fresh, detail: `built ${ago(age)} ago · ${m.nodes} nodes · ${m.edges} edges${fresh ? '' : ` — older than ${g.staleDays} days, run aos graph build`}`, level: 'warn' });
  return rows;
}

function loadAgenticos(configDir) {
  const file = agenticosPath(configDir);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no agenticos.json at ${file} (run \`aos init\` first)`);
    throw new Error(`agenticos.json at ${file} does not parse: ${e.message}`);
  }
  if (!cfg || typeof cfg.vault !== 'string') throw new Error(`agenticos.json at ${file} has no vault (run \`aos init\` first)`);
  return { file, cfg };
}

function status({ cfg, io, exec = spawnSync, now = Date.now() }) {
  const vault = cfg.vault;
  const g = graphConfig({ vault, userCfg: cfg });
  const bin = cfg.graph && cfg.graph.bin;
  const v = installedVersion(bin, exec);
  io.log(`graphify   ${v ? `${v}${v === PIN ? '' : ` (pinned ${PIN} — run aos upgrade)`}` : `not installed (pinned ${PIN} — run aos upgrade)`}${bin ? ` · ${bin}` : ''}`);
  const dir = outDir(vault, g);
  const m = readJson(path.join(dir, MARKER));
  const built = m && Date.parse(m.lastStructural || m.builtAt);
  io.log(`graph      ${g.enabled === false ? 'off' : 'on'} · ${built ? `${m.mode || 'structural'} · built ${ago(now - built)} ago` : 'not built yet'} · ${path.relative(vault, dir)}`);
  const G = graphLib(vault);
  const block = G.pulse(G.loadGraph(path.join(dir, 'graph.json')));
  if (block) io.log(`\n${block}`);
  return 0;
}

function build({ cfg, configDir, io }) {
  const script = path.join(cfg.vault, 'brain', 'scripts', 'graph-build.js');
  if (!fs.existsSync(script)) throw new Error(`${script} missing — run aos upgrade`);
  const r = spawnSync(cfg.node || process.execPath, [script], {
    cwd: cfg.vault, stdio: 'inherit',
    env: { ...process.env, AOS_VAULT: cfg.vault, AOS_CONFIG: agenticosPath(configDir), AOS_DETACHED: '1' },
  });
  if (r.error) { io.error(`graph: ${r.error.message}`); return 1; }
  return typeof r.status === 'number' ? r.status : 1;
}

function setEnabled({ file, cfg, on, io }) {
  cfg.graph = { ...(cfg.graph || {}), enabled: on };
  writeJson(file, cfg);
  io.log(on ? 'graph: on (the next scan rebuilds it; aos graph build does it now)' : 'graph: off (scans stop rebuilding it; the graph and graphify stay)');
}

/** `aos graph …` — args is the positional `sub` array cli/aos.js parsed. */
async function run(args, opts = {}) {
  const io = opts.io || console;
  const sub = args[0] || 'status';
  try {
    const configDir = opts.configDir || claudeConfigDir();
    if (!['status', 'build', 'on', 'off'].includes(sub) || args.length > 1) { io.error(USAGE); return 2; }
    const { file, cfg } = loadAgenticos(configDir);
    if (sub === 'status') return status({ cfg, io });
    if (sub === 'build') return build({ cfg, configDir, io });
    setEnabled({ file, cfg, on: sub === 'on', io });
    return 0;
  } catch (e) {
    io.error(`graph: ${e.message}`);
    return 1;
  }
}

module.exports = {
  PIN, PACKAGE, PYTHON, MARKER, USAGE, uvBin, toolHome, toolDirs, installedVersion, graphConfig, outDir, seedIgnore, moveAside,
  install, removeTools, doctorRows, status, build, setEnabled, run,
};
