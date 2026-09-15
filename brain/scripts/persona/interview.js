#!/usr/bin/env node
'use strict';
/**
 * interview.js — Chief of Staff identity interview → <vault>/persona/.
 * Writes IDENTITY.md (always), STATE.md (kept on re-run), PLAYBOOK.md (generated once via
 * build-playbook.js), duties/*.md (always), proposals/README.md and autoapply.json (kept),
 * journal/logs/ and answers.json. Pure file work: no model call, and no dependency on
 * lib/paths.js when --vault is given (cli/persona-cmd.js always gives it).
 *
 *   node persona/interview.js --vault <dir> --config-dir <dir> [--templates <dir>]
 *        [--answers <file>] [--yes] [--node <path>] [--default-model <m>] [--example-name <n>]
 *   node persona/interview.js [--vault <dir>] rename <name>
 *        (contract §4.3: the positional form; `aos interview rename <name>` through the launcher,
 *         which exports AOS_VAULT — no templates, no questions, prints the renameAgent result)
 * Answers file: { name, addressAs, voice, priorities, dutyModel, dutyEffort, schedule }
 * Templates default to ./templates next to this file (the copy `aos init` vendors into
 * <vault>/brain/scripts/persona/templates) and otherwise to <repo>/vault-template/persona.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { buildPlaybook } = require('./build-playbook.js');

const DUTIES = ['monitor', 'reflect', 'sitrep'];
const EFFORTS = ['low', 'medium', 'high'];
const DEFAULT_LAYOUT = '{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md';
const TEMPLATE_DIRS = [path.join(__dirname, 'templates'), path.join(__dirname, '..', '..', '..', 'vault-template', 'persona')];
/** Flags that take a value; everything else starting with -- is a boolean flag (--yes). */
const VALUE_FLAGS = ['--vault', '--config-dir', '--templates', '--answers', '--node', '--default-model', '--example-name'];

/** First template dir that exists: vendored (<vault>/brain/scripts/persona/templates) or the repo checkout. */
function defaultTemplatesDir() {
  return TEMPLATE_DIRS.find(d => fs.existsSync(path.join(d, 'identity.template.md'))) || null;
}

/** argv minus flags and their values, in order — e.g. ['--vault', v, 'rename', 'Beacon'] → ['rename', 'Beacon']. */
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (String(argv[i]).startsWith('--')) continue;
    out.push(argv[i]);
  }
  return out;
}

const QUESTIONS = [
  { key: 'name', prompt: (c) => `Agent name (required; e.g. ${c.exampleName || 'Atlas'})`, required: true },
  { key: 'addressAs', prompt: () => 'How should the agent address you? (name or title)', def: () => 'you' },
  { key: 'voice', prompt: () => 'Voice, in one line', def: () => 'concise, direct, dry' },
  { key: 'priorities', prompt: () => 'What should it watch most? (comma-separated)', def: () => '' },
  { key: 'dutyModel', prompt: () => 'Model for background duties', def: (c) => c.defaultModel || 'haiku' },
  { key: 'dutyEffort', prompt: () => 'Effort for background duties (low|medium|high)', def: () => 'medium' },
  { key: 'schedule', prompt: () => 'Schedule daily duties? (yes/no)', def: () => 'yes' },
];

function toBool(v, dflt = true) {
  if (typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return !['n', 'no', 'false', '0', 'off'].includes(s);
}
function toList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

function normalizeAnswers(raw, ctx = {}) {
  const a = raw || {};
  const name = String(a.name || '').trim();
  if (!name) throw new Error('answers.name is required');
  // execution amendment 2026-09-15 (A28): at least 2 chars — renameAgent's \b<old>\b replace would mangle duty prose for a one-letter name.
  if (!/^[A-Za-z][A-Za-z0-9 _-]{1,39}$/.test(name)) throw new Error(`invalid agent name ${JSON.stringify(name)}: letters, digits, space, - and _ only, 2 to 40 characters`);
  const dutyEffort = String(a.dutyEffort || 'medium').trim().toLowerCase();
  if (!EFFORTS.includes(dutyEffort)) throw new Error(`dutyEffort must be one of ${EFFORTS.join('|')}`);
  return {
    name,
    addressAs: String(a.addressAs || '').trim() || 'you',
    voice: String(a.voice || '').trim() || 'concise, direct, dry',
    priorities: toList(a.priorities),
    dutyModel: String(a.dutyModel || '').trim() || ctx.defaultModel || 'haiku',
    dutyEffort,
    schedule: toBool(a.schedule, true),
  };
}

function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

function dailyNoteLayout(vault) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(vault, 'brain', 'config.json'), 'utf8'));
    if (c && c.dailyNote && typeof c.dailyNote.layout === 'string') return c.dailyNote.layout;
  } catch { /* no vault config → default */ }
  return DEFAULT_LAYOUT;
}

function templateVars(answers, { vault, node, logDir, now = new Date() }) {
  return {
    AGENT_NAME: answers.name,
    ADDRESS_AS: answers.addressAs,
    VOICE: answers.voice,
    PRIORITIES: answers.priorities.length ? answers.priorities.map(p => `- ${p}`).join('\n') : '- (none set — edit this list)',
    DUTY_MODEL: answers.dutyModel,
    DUTY_EFFORT: answers.dutyEffort,
    DATE: now.toISOString().slice(0, 10),
    VAULT: vault,
    NODE: node || 'node',
    LOG_DIR: logDir || path.join(vault, 'persona', 'journal', 'logs'),
    DAILY_NOTE_LAYOUT: dailyNoteLayout(vault),
  };
}

function writePersona({ vault, configDir, templatesDir, answers, node, logDir, now = new Date() }) {
  if (!vault || !configDir || !templatesDir) throw new Error('writePersona needs vault, configDir and templatesDir');
  const persona = path.join(vault, 'persona');
  const vars = templateVars(answers, { vault, node, logDir, now });
  const written = []; const kept = [];
  const put = (rel, body, keep = false) => {
    const file = path.join(persona, rel);
    if (keep && fs.existsSync(file)) { kept.push(rel); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    written.push(rel);
  };
  const tmpl = (rel) => fs.readFileSync(path.join(templatesDir, rel), 'utf8');
  put('IDENTITY.md', renderTemplate(tmpl('identity.template.md'), vars));
  put('STATE.md', renderTemplate(tmpl('STATE.template.md'), vars), true);
  for (const d of DUTIES) put(`duties/${d}.md`, renderTemplate(tmpl(path.join('duties', `${d}.md`)), vars));
  put('proposals/README.md', renderTemplate(tmpl(path.join('proposals', 'README.md')), vars), true);
  put('autoapply.json', JSON.stringify({ classes: [] }, null, 2) + '\n', true);
  fs.mkdirSync(path.join(persona, 'journal', 'logs'), { recursive: true });
  if (fs.existsSync(path.join(persona, 'PLAYBOOK.md'))) kept.push('PLAYBOOK.md');
  else { buildPlaybook({ configDir, vault, name: answers.name, now }); written.push('PLAYBOOK.md'); }
  put('answers.json', JSON.stringify(answers, null, 2) + '\n');
  return { persona, written, kept };
}

function readAnswers(vault) {
  try { return JSON.parse(fs.readFileSync(path.join(vault, 'persona', 'answers.json'), 'utf8')); } catch { return null; }
}
function currentName(vault) {
  const a = readAnswers(vault);
  if (a && a.name) return a.name;
  try {
    const m = fs.readFileSync(path.join(vault, 'persona', 'IDENTITY.md'), 'utf8').match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* no identity */ }
  return null;
}

function renameAgent({ vault, newName }) {
  const old = currentName(vault);
  if (!old) throw new Error('no persona to rename (run the interview first)');
  const answers = normalizeAnswers({ ...(readAnswers(vault) || {}), name: newName });
  const persona = path.join(vault, 'persona');
  const re = new RegExp(`\\b${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const changed = [];
  for (const rel of ['IDENTITY.md', 'PLAYBOOK.md', 'STATE.md', ...DUTIES.map(d => `duties/${d}.md`)]) {
    const file = path.join(persona, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(re, answers.name);
    if (after !== before) { fs.writeFileSync(file, after); changed.push(rel); }
  }
  fs.writeFileSync(path.join(persona, 'answers.json'), JSON.stringify(answers, null, 2) + '\n');
  return { from: old, to: answers.name, changed, answers };
}

/**
 * Interactive prompts. prefill values become the defaults shown in brackets.
 * Lines are buffered as they arrive rather than read through rl.question(): readline emits
 * 'line' whether or not a question is pending, so answers that land early — a piped stdin
 * (`aos persona < answers.txt`), a pasted block, or a test writing every line at once — would
 * otherwise be dropped between prompts and the next question would wait forever. Input that
 * closes before a required answer throws (exit 1 from the CLI) instead of hanging.
 */
async function ask(ctx = {}, prefill = null, streams = { input: process.stdin, output: process.stdout }) {
  const rl = readline.createInterface({ input: streams.input, output: streams.output });
  const pending = []; const waiters = []; let closed = false;
  rl.on('line', (line) => { const w = waiters.shift(); if (w) w(line); else pending.push(line); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  /** Prints the prompt and resolves with the next line, or null when the input has closed. */
  const q = (text) => {
    streams.output.write(text);
    if (pending.length) return Promise.resolve(pending.shift());
    if (closed) return Promise.resolve(null);
    return new Promise(res => waiters.push(res));
  };
  const out = {};
  try {
    for (const item of QUESTIONS) {
      const pre = prefill && prefill[item.key] != null ? prefill[item.key] : null;
      const def = pre != null ? (Array.isArray(pre) ? pre.join(', ') : String(pre)) : (item.def ? item.def(ctx) : '');
      let v = '';
      do {
        const line = await q(`${item.prompt(ctx)}${def ? ` [${def}]` : ''}: `);
        if (line == null) {
          if (item.required && !def) throw new Error(`input ended before "${item.key}" was answered`);
          v = def; break;
        }
        v = String(line).trim() || def;
      } while (item.required && !v);
      out[item.key] = v;
    }
  } finally { rl.close(); }
  return out;
}

async function main(argv) {
  const arg = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
  const vault = arg('--vault') || process.env.AOS_VAULT;
  if (!vault) { console.error('interview: --vault <dir> is required'); return 2; }
  // Positional `rename <name>` (contract §4.3/§6) — pure file work: no templates, no config dir,
  // never ask(), so `aos interview rename <name>` cannot hang on readline in a non-TTY.
  const pos = positionals(argv);
  if (pos[0] === 'rename') {
    if (!pos[1]) { console.error('usage: interview.js [--vault <dir>] rename <name>'); return 2; }
    const r = renameAgent({ vault, newName: pos[1] });   // throws 'no persona to rename' → exit 1 below
    console.log(JSON.stringify(r));
    return 0;
  }
  if (pos.length) { console.error(`interview: unknown argument ${JSON.stringify(pos[0])}`); return 2; }
  const configDir = arg('--config-dir') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const templatesDir = arg('--templates') || defaultTemplatesDir();
  if (!templatesDir) { console.error(`interview: no persona templates found (looked in ${TEMPLATE_DIRS.join(', ')}); pass --templates <dir>`); return 2; }
  const ctx = { defaultModel: arg('--default-model') || 'haiku', exampleName: arg('--example-name') || 'Atlas' };
  const answersFile = arg('--answers');
  let raw;
  if (answersFile) raw = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
  else if (argv.includes('--yes')) {
    raw = readAnswers(vault);
    if (!raw) { console.error('interview: --yes needs --answers <file> or an existing persona/answers.json'); return 2; }
  } else raw = await ask(ctx, readAnswers(vault));
  const answers = normalizeAnswers(raw, ctx);
  const r = writePersona({ vault, configDir, templatesDir, answers, node: arg('--node') });
  console.log(JSON.stringify({ persona: r.persona, written: r.written, kept: r.kept, schedule: answers.schedule }));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(`interview: ${e.message}`); process.exit(1); });
}
module.exports = { QUESTIONS, DUTIES, EFFORTS, DEFAULT_LAYOUT, TEMPLATE_DIRS, VALUE_FLAGS, defaultTemplatesDir, positionals, normalizeAnswers, renderTemplate, templateVars, writePersona, readAnswers, currentName, renameAgent, ask, toBool, toList };
