'use strict';
/**
 * persona-cmd.js — `aos persona` and the init-time identity interview (spec §9.2 step 8, §10).
 *   aos persona                 re-run the interview, prefilled from <vault>/persona/answers.json
 *   aos persona rename <name>   rewrite the agent's name in IDENTITY/PLAYBOOK/STATE/duties/answers,
 *                               and re-render installed schedules
 *   aos persona on | off        remove / create <vault>/persona/DISABLED (kill switch)
 * Zero dependencies beyond node built-ins; the file work is brain/scripts/persona/interview.js
 * and cli/schedule.js. This file runs from two places — the repo checkout (`node cli/aos.js`)
 * and the vendored copy at <vault>/brain/scripts/cli/ (the `aos` launcher) — so interview.js and
 * the templates are resolved lazily against the vault first, then the checkout.
 * Every external effect is injectable. Schedule warnings (a failed `launchctl load`) are routed
 * through the caller's io.error — execution amendment 2026-09-15 (A30).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const schedule = require('./schedule.js');

const REPO = path.join(__dirname, '..');
const TEMPLATE_DIRS = [path.join(__dirname, '..', 'persona', 'templates'), path.join(REPO, 'vault-template', 'persona')];

/** Vendored templates (<vault>/brain/scripts/persona/templates) first, then the checkout's vault-template/persona. */
function templatesDir() {
  const d = TEMPLATE_DIRS.find(x => fs.existsSync(path.join(x, 'identity.template.md')));
  if (!d) throw new Error(`persona templates not found (looked in ${TEMPLATE_DIRS.join(', ')}) — run \`aos upgrade\``);
  return d;
}
/** The vault's own interview.js when installed (same version as its templates), else the checkout's. */
function interviewModule(vault) {
  const vendored = path.join(vault, 'brain', 'scripts', 'persona', 'interview.js');
  return require(fs.existsSync(vendored) ? vendored : path.join(REPO, 'brain', 'scripts', 'persona', 'interview.js'));
}

function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function readAgenticos(configDir) {
  const file = process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function resolveCtx(opts = {}) {
  const configDir = opts.configDir || claudeConfigDir();
  const cfg = readAgenticos(configDir) || {};
  const vault = opts.vault || process.env.AOS_VAULT || cfg.vault;
  if (!vault) throw new Error('no vault configured (run `aos init` first)');
  return {
    configDir, vault,
    node: opts.node || cfg.node || 'node',
    defaultModel: opts.defaultModel || (cfg.claude && cfg.claude.model) || 'haiku',
    codex: !!(cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.enabled),
  };
}

/** The Codex duty model lives where lib/headless.js reads it: persona.codexModel in <vault>/brain/config.json. */
function writeCodexModel(vault, model) {
  const file = path.join(vault, 'brain', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  cfg.persona = { ...(cfg.persona || {}), codexModel: model || null };
  const tmp = `${file}.${process.pid}.tmp`; // tmp + rename (spec 2026-09-24-aos-config D5)
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const SKIP_MSG = 'persona: no --persona-json and no terminal interview (--yes, or stdin is not a TTY) and no stored persona/answers.json; skipping the interview (run `aos persona` later)';

async function runInterview(opts = {}) {
  const io = opts.io || console;
  const { configDir, vault, node, defaultModel, codex } = resolveCtx(opts);
  const interview = interviewModule(vault);
  const ctx = { defaultModel, codex, exampleName: opts.exampleName || 'Atlas' };
  let raw;
  if (opts.answersFile) raw = JSON.parse(fs.readFileSync(opts.answersFile, 'utf8'));
  else {
    const stored = interview.readAnswers(vault);
    const interactive = !!opts.streams || (!opts.yes && !!process.stdin.isTTY);
    if (interactive) raw = await interview.ask(ctx, stored, opts.streams);
    else if (stored) raw = stored;                       // --yes, or no terminal: reuse the last answers
    else { io.log(SKIP_MSG); return { skipped: true, reason: 'no-answers' }; }   // never block on readline
  }
  const answers = interview.normalizeAnswers(raw, ctx);
  if (opts.dryRun) {
    io.log(`[dry-run] would write ${path.join(vault, 'persona')} for agent "${answers.name}" (schedule duties: ${answers.schedule})`);
    return { answers, dryRun: true };
  }
  const r = interview.writePersona({ vault, configDir, templatesDir: opts.templatesDir || templatesDir(), answers, node });
  io.log(`persona: wrote ${r.written.join(', ')}${r.kept.length ? ` (kept ${r.kept.join(', ')})` : ''}`);
  if (codex) writeCodexModel(vault, answers.dutyCodexModel);
  let sched = null;
  if (answers.schedule && opts.schedule !== false) {
    const vars = schedule.scheduleVars({ vault, configDir, node, model: answers.dutyModel, effort: answers.dutyEffort, agentName: answers.name });
    // execution amendment 2026-09-15 (A30): schedule.js collects a failed `launchctl load` into `warnings` and calls `warn`;
    // route it through io.error so `aos` prints it on stderr and the tests can see it. Never aborts the interview.
    sched = (opts.installSchedules || schedule.installSchedules)({ vars, platform: opts.platform || process.platform, warn: (m) => io.error(`warning: ${m}`) });
    io.log(sched.unsupported
      ? `persona: duty scheduling is not supported on ${sched.platform}; run duties by hand: sh ${vault}/brain/scripts/persona/run-duty.sh <duty>`
      : `persona: scheduled ${sched.labels.join(', ')}`);
  }
  return { answers, written: r.written, kept: r.kept, schedule: sched };
}

async function rename(newName, opts = {}) {
  const io = opts.io || console;
  const { configDir, vault, node } = resolveCtx(opts);
  const r = interviewModule(vault).renameAgent({ vault, newName });   // throws 'no persona to rename' before any write
  io.log(`persona: renamed ${r.from} → ${r.to} in ${r.changed.join(', ') || 'no files'}`);
  const platform = opts.platform || process.platform;
  if ((opts.isInstalled || schedule.isInstalled)({ platform })) {
    const vars = schedule.scheduleVars({ vault, configDir, node, model: r.answers.dutyModel, effort: r.answers.dutyEffort, agentName: r.answers.name });
    (opts.installSchedules || schedule.installSchedules)({ vars, platform, warn: (m) => io.error(`warning: ${m}`) });   // execution amendment 2026-09-15 (A30)
    io.log('persona: schedules re-rendered');
  }
  return r;
}

function setEnabled(on, opts = {}) {
  const io = opts.io || console;
  const { vault } = resolveCtx(opts);
  const flag = path.join(vault, 'persona', 'DISABLED');
  if (on) { fs.rmSync(flag, { force: true }); io.log('persona: on (DISABLED removed)'); }
  else {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, `disabled ${new Date().toISOString()}\n`);
    io.log(`persona: off (${flag}); \`aos persona on\` re-enables`);
  }
  return { enabled: on, flag };
}

/** `aos persona …`. `args` is Plan 3's positional `sub` array (flags already parsed into opts); a raw `--yes` is tolerated. */
async function run(args, opts = {}) {
  const io = opts.io || console;
  const positional = args.filter(a => !a.startsWith('--'));
  const [sub, ...rest] = positional;
  try {
    if (!sub) {
      const r = await runInterview({ ...opts, yes: opts.yes || args.includes('--yes') });
      return r.skipped ? 1 : 0;                       // an explicit `aos persona` that could not interview is a failure
    }
    if (sub === 'rename') {
      if (!rest[0]) { io.error('usage: aos persona rename <name>'); return 2; }
      await rename(rest[0], opts); return 0;
    }
    if (sub === 'on') { setEnabled(true, opts); return 0; }
    if (sub === 'off') { setEnabled(false, opts); return 0; }
    io.error('usage: aos persona [rename <name> | on | off] [--persona-json <file>] [--yes]');
    return 2;
  } catch (e) {
    io.error(`persona: ${e.message}`);
    return 1;
  }
}

module.exports = { TEMPLATE_DIRS, SKIP_MSG, templatesDir, interviewModule, resolveCtx, runInterview, rename, setEnabled, run };
